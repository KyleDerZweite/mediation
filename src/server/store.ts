// SQLite-backed coordination store. Arrays/objects are stored as JSON text
// columns; rows are hydrated back into the core domain types. All domain rules
// (overlap, tokenize, normalizePath) come from src/core/overlap.ts.

import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { checkOverlap, normalizePath, pairConflicts } from '../core/overlap.ts';
import type {
  Bug, Claim, ConflictWarning, EventEntry, EventType, ProjectState,
  ProjectSummary, RecentFile, RepoState, Session, WorkScope,
} from '../core/types.ts';
import type {
  BugCreate, BugPatch, ClaimComplete, ClaimCreate, ClaimPatch,
  Heartbeat, RepoReport, SessionCreate, UserPatch, UserRegister,
} from '../core/schemas.ts';

export const DEFAULT_SESSION_TTL_MS = 120_000;
export const DEFAULT_CLAIM_IDLE_TTL_MS = 30 * 60_000;

const EVENTS_CAP = 200;

// Pairing codes: short-lived, human-relayed. Unambiguous alphabet (no I/O/0/1);
// 32 chars divides 256 evenly, so byte % 32 is unbiased.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_REQUEST_TTL_MS = 15 * 60_000;

interface StoreOptions {
  dbPath: string;
  sessionTtlMs?: number;
  claimIdleTtlMs?: number;
}

function fail(message: string, statusCode: number): never {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  throw err;
}

function notFound(message: string): never {
  return fail(message, 404);
}

type Row = Record<string, unknown>;

// ---- user auth (see docs/auth.md) ----
// Passwords: async scrypt (login must not block the event loop), stored as a
// self-describing `scrypt:N:r:p:saltB64:hashB64` string, verified constant-time.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer, salt: string | Buffer, keylen: number, options?: ScryptOptions,
) => Promise<Buffer>;
const SCRYPT_N = 16_384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;
const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60_000; // fixed 7 days
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
// Well-formed but wrong hash: login verifies against it for unknown users so
// timing doesn't reveal whether a username exists.
const DUMMY_HASH = `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${randomBytes(16).toString('base64')}:${randomBytes(SCRYPT_KEYLEN).toString('base64')}`;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, saltB64, hashB64] = stored.split(':');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function normalizeUsername(raw: string): string {
  const u = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) {
    fail('invalid username: 3-32 chars, letters/digits/_/- and must start with a letter or digit', 400);
  }
  return u;
}

export interface PublicUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
  status: 'pending' | 'active' | 'disabled';
  createdAt: number;
}

function publicUser(r: Row): PublicUser {
  return {
    id: r.id as string,
    username: r.username as string,
    role: r.role as PublicUser['role'],
    status: r.status as PublicUser['status'],
    createdAt: Number(r.created_at),
  };
}

export type LoginResult =
  | { ok: true; user: PublicUser; token: string }
  | { ok: false; code: 401 | 403; error: string; status?: 'pending' | 'disabled' };

// Pairing/credential shapes are server-local (not part of the wire protocol
// in core): the dashboard and /api/auth routes are their only consumers.
export interface PairRequest {
  id: string;
  code: string;
  agent: string;
  machine: string | null;
  developer: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface CredentialInfo {
  id: string;
  agent: string;
  machine: string | null;
  developer: string | null;
  createdAt: number;
  lastUsedAt: number;
}

interface PairRequestInput {
  agent: string;
  machine?: string | null;
  developer?: string | null;
}

function sessionFromRow(r: Row): Session {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    agent: r.agent as string,
    developer: (r.developer as string) ?? null,
    machine: (r.machine as string) ?? null,
    repo: r.repo ? (JSON.parse(r.repo as string) as RepoState) : null,
    createdAt: Number(r.createdAt),
    lastSeenAt: Number(r.lastSeenAt),
  };
}

function claimFromRow(r: Row): Claim {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    sessionId: r.sessionId as string,
    agent: r.agent as string,
    developer: (r.developer as string) ?? null,
    intent: r.intent as string,
    task: (r.task as string) ?? null,
    files: JSON.parse(r.files as string),
    components: JSON.parse(r.components as string),
    branch: (r.branch as string) ?? null,
    baseRevision: (r.baseRevision as string) ?? null,
    status: r.status as Claim['status'],
    findings: JSON.parse(r.findings as string),
    commits: JSON.parse(r.commits as string),
    prs: JSON.parse(r.prs as string),
    summary: (r.summary as string) ?? null,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
    completedAt: r.completedAt == null ? null : Number(r.completedAt),
  };
}

function bugFromRow(r: Row): Bug {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    sessionId: r.sessionId as string,
    reporter: r.reporter as string,
    title: r.title as string,
    description: (r.description as string) ?? null,
    files: JSON.parse(r.files as string),
    severity: r.severity as Bug['severity'],
    status: r.status as Bug['status'],
    createdAt: Number(r.createdAt),
  };
}

function eventFromRow(r: Row): EventEntry {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    type: r.type as EventType,
    message: r.message as string,
    at: Number(r.at),
  };
}

export class Store {
  db: DatabaseSync;
  sessionTtlMs: number;
  claimIdleTtlMs: number;

  constructor({ dbPath, sessionTtlMs = DEFAULT_SESSION_TTL_MS, claimIdleTtlMs = DEFAULT_CLAIM_IDLE_TTL_MS }: StoreOptions) {
    this.db = new DatabaseSync(dbPath);
    this.sessionTtlMs = sessionTtlMs;
    this.claimIdleTtlMs = claimIdleTtlMs;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, agent TEXT NOT NULL,
        developer TEXT, machine TEXT, repo TEXT,
        createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, sessionId TEXT NOT NULL,
        agent TEXT NOT NULL, developer TEXT, intent TEXT NOT NULL, task TEXT,
        files TEXT NOT NULL, components TEXT NOT NULL, branch TEXT, baseRevision TEXT,
        status TEXT NOT NULL, findings TEXT NOT NULL, commits TEXT NOT NULL,
        prs TEXT NOT NULL, summary TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, completedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS bugs (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, sessionId TEXT NOT NULL,
        reporter TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
        files TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, type TEXT NOT NULL,
        message TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_requests (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, agent TEXT NOT NULL,
        machine TEXT, developer TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, agent TEXT NOT NULL,
        machine TEXT, developer TEXT,
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId);
      CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(projectId);
      CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(projectId);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(projectId, at);
    `);
  }

  private emit(projectId: string, type: EventType, message: string): void {
    this.db.prepare('INSERT INTO events (id, projectId, type, message, at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, type, message, Date.now());
    this.db.prepare(`
      DELETE FROM events WHERE projectId = ? AND rowid NOT IN (
        SELECT rowid FROM events WHERE projectId = ? ORDER BY at DESC, rowid DESC LIMIT ?
      )`).run(projectId, projectId, EVENTS_CAP);
  }

  private requireSession(projectId: string, sessionId: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE projectId = ? AND id = ?')
      .get(projectId, sessionId) as Row | undefined;
    if (!row) notFound('session not found or expired');
    return sessionFromRow(row);
  }

  private touchSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET lastSeenAt = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  private activeClaims(projectId: string): Claim[] {
    return (this.db.prepare("SELECT * FROM claims WHERE projectId = ? AND status != 'done' ORDER BY createdAt")
      .all(projectId) as Row[]).map(claimFromRow);
  }

  private getClaim(projectId: string, claimId: string): Claim {
    const row = this.db.prepare('SELECT * FROM claims WHERE projectId = ? AND id = ?')
      .get(projectId, claimId) as Row | undefined;
    if (!row) notFound('claim not found');
    return claimFromRow(row);
  }

  private saveClaim(c: Claim): void {
    this.db.prepare(`
      UPDATE claims SET intent = ?, task = ?, files = ?, components = ?, branch = ?,
        baseRevision = ?, status = ?, findings = ?, commits = ?, prs = ?, summary = ?,
        updatedAt = ?, completedAt = ? WHERE id = ?`)
      .run(c.intent, c.task, JSON.stringify(c.files), JSON.stringify(c.components), c.branch,
        c.baseRevision, c.status, JSON.stringify(c.findings), JSON.stringify(c.commits),
        JSON.stringify(c.prs), c.summary, c.updatedAt, c.completedAt, c.id);
  }

  // ---- sessions ----

  startSession(projectId: string, input: SessionCreate): Session {
    const t = Date.now();
    const session: Session = {
      id: randomUUID(),
      projectId,
      agent: input.agent,
      developer: input.developer ?? null,
      machine: input.machine ?? null,
      repo: null,
      createdAt: t,
      lastSeenAt: t,
    };
    this.db.prepare(`INSERT INTO sessions (id, projectId, agent, developer, machine, repo, createdAt, lastSeenAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, projectId, session.agent, session.developer, session.machine, null, t, t);
    this.emit(projectId, 'session', `${session.agent} connected`);
    return session;
  }

  heartbeat(projectId: string, sessionId: string, input: Heartbeat): Session {
    const session = this.requireSession(projectId, sessionId);
    session.lastSeenAt = Date.now();
    this.touchSession(sessionId);
    if (input.activity) this.emit(projectId, 'activity', `${session.agent}: ${input.activity}`);
    return session;
  }

  endSession(projectId: string, sessionId: string, reason = 'ended by agent'): { ok: true } {
    const session = this.requireSession(projectId, sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    this.releaseClaims(projectId, sessionId, reason);
    this.emit(projectId, 'session', `${session.agent} disconnected (${reason})`);
    return { ok: true };
  }

  private releaseClaims(projectId: string, sessionId: string, reason: string): void {
    const claims = (this.db.prepare("SELECT * FROM claims WHERE projectId = ? AND sessionId = ? AND status != 'done'")
      .all(projectId, sessionId) as Row[]).map(claimFromRow);
    for (const claim of claims) {
      this.db.prepare('DELETE FROM claims WHERE id = ?').run(claim.id);
      this.emit(projectId, 'claim', `claim "${claim.intent}" released (${reason})`);
    }
  }

  reportRepoState(projectId: string, sessionId: string, input: RepoReport): RepoState {
    this.requireSession(projectId, sessionId);
    const repo: RepoState = {
      branch: input.branch ?? null,
      revision: input.revision ?? null,
      dirtyFiles: input.dirtyFiles,
      reportedAt: Date.now(),
    };
    this.db.prepare('UPDATE sessions SET repo = ?, lastSeenAt = ? WHERE id = ?')
      .run(JSON.stringify(repo), Date.now(), sessionId);
    return repo;
  }

  // ---- claims ----

  createClaim(projectId: string, input: ClaimCreate): { claim: Claim; conflicts: ConflictWarning[] } {
    const session = this.requireSession(projectId, input.sessionId);
    this.touchSession(session.id);
    const t = Date.now();
    const claim: Claim = {
      id: randomUUID(),
      projectId,
      sessionId: session.id,
      agent: session.agent,
      developer: session.developer,
      intent: input.intent,
      task: input.task ?? null,
      files: input.files.map(normalizePath),
      components: input.components,
      branch: input.branch ?? null,
      baseRevision: input.baseRevision ?? null,
      status: input.status,
      findings: [],
      commits: [],
      prs: [],
      summary: null,
      createdAt: t,
      updatedAt: t,
      completedAt: null,
    };
    // Warnings, not locks: conflicts are computed before insert and returned
    // alongside the claim; the claim is always created.
    const conflicts = checkOverlap(this.activeClaims(projectId), {
      sessionId: session.id,
      files: claim.files,
      components: claim.components,
      task: claim.task,
      intent: claim.intent,
    });
    this.db.prepare(`INSERT INTO claims (id, projectId, sessionId, agent, developer, intent, task,
        files, components, branch, baseRevision, status, findings, commits, prs, summary,
        createdAt, updatedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(claim.id, projectId, claim.sessionId, claim.agent, claim.developer, claim.intent,
        claim.task, JSON.stringify(claim.files), JSON.stringify(claim.components), claim.branch,
        claim.baseRevision, claim.status, '[]', '[]', '[]', null, t, t, null);
    this.emit(projectId, 'claim', `${session.agent} claimed: ${claim.intent}`);
    return { claim, conflicts };
  }

  updateClaim(projectId: string, claimId: string, patch: ClaimPatch): Claim {
    const claim = this.getClaim(projectId, claimId);
    this.touchSession(claim.sessionId);
    if (patch.intent != null) claim.intent = patch.intent;
    if (patch.task !== undefined) claim.task = patch.task ?? null;
    if (patch.branch !== undefined) claim.branch = patch.branch ?? null;
    if (patch.baseRevision !== undefined) claim.baseRevision = patch.baseRevision ?? null;
    if (patch.status) claim.status = patch.status;
    if (patch.files) claim.files = patch.files.map(normalizePath);
    if (patch.components) claim.components = patch.components;
    if (patch.finding) claim.findings.push({ text: patch.finding, at: Date.now() });
    claim.updatedAt = Date.now();
    this.saveClaim(claim);
    if (patch.finding) this.emit(projectId, 'finding', `${claim.agent} found: ${patch.finding}`);
    if (patch.status) this.emit(projectId, 'claim', `${claim.agent} → ${patch.status}: ${claim.intent}`);
    return claim;
  }

  completeClaim(projectId: string, claimId: string, input: ClaimComplete): Claim {
    const claim = this.getClaim(projectId, claimId);
    claim.status = 'done';
    claim.commits = input.commits;
    claim.prs = input.prs;
    claim.summary = input.summary ?? null;
    claim.completedAt = Date.now();
    claim.updatedAt = claim.completedAt;
    this.saveClaim(claim); // row is kept: completed claims survive as history
    this.emit(projectId, 'completed',
      `${claim.agent} completed: ${claim.intent}${input.commits.length ? ` (${input.commits.join(', ')})` : ''}`);
    return claim;
  }

  // ---- bugs ----

  reportBug(projectId: string, input: BugCreate): Bug {
    const session = this.requireSession(projectId, input.sessionId);
    this.touchSession(session.id);
    const bug: Bug = {
      id: randomUUID(),
      projectId,
      sessionId: session.id,
      reporter: session.agent,
      title: input.title,
      description: input.description ?? null,
      files: input.files.map(normalizePath),
      severity: input.severity,
      status: 'open',
      createdAt: Date.now(),
    };
    this.db.prepare(`INSERT INTO bugs (id, projectId, sessionId, reporter, title, description, files, severity, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(bug.id, projectId, bug.sessionId, bug.reporter, bug.title, bug.description,
        JSON.stringify(bug.files), bug.severity, bug.status, bug.createdAt);
    this.emit(projectId, 'bug', `${session.agent} reported bug: ${bug.title}`);
    return bug;
  }

  updateBug(projectId: string, bugId: string, patch: BugPatch): Bug {
    const row = this.db.prepare('SELECT * FROM bugs WHERE projectId = ? AND id = ?')
      .get(projectId, bugId) as Row | undefined;
    if (!row) notFound('bug not found');
    const bug = bugFromRow(row);
    if (patch.status) bug.status = patch.status;
    if (patch.severity) bug.severity = patch.severity;
    this.db.prepare('UPDATE bugs SET status = ?, severity = ? WHERE id = ?')
      .run(bug.status, bug.severity, bug.id);
    return bug;
  }

  // ---- pairing (device-flow-lite; see AGENTS.md "Pairing") ----

  private prunePairRequests(): void {
    this.db.prepare('DELETE FROM pair_requests WHERE expires_at < ?').run(Date.now());
  }

  createPairRequest(input: PairRequestInput): { requestId: string; expiresAt: number } {
    this.prunePairRequests();
    const t = Date.now();
    const id = randomUUID();
    const expiresAt = t + PAIR_REQUEST_TTL_MS;
    // code is UNIQUE; retry on the (vanishingly rare) collision
    for (let attempt = 0; ; attempt++) {
      const code = [...randomBytes(6)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      try {
        this.db.prepare(`INSERT INTO pair_requests (id, code, agent, machine, developer, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, code, input.agent, input.machine ?? null, input.developer ?? null, t, expiresAt);
        return { requestId: id, expiresAt };
      } catch (err) {
        if (attempt >= 5) throw err;
      }
    }
  }

  listPendingPairRequests(): PairRequest[] {
    this.prunePairRequests();
    // code included: the dashboard is trusted in the MVP and relays it to the human
    return (this.db.prepare('SELECT * FROM pair_requests ORDER BY created_at').all() as Row[]).map((r) => ({
      id: r.id as string,
      code: r.code as string,
      agent: r.agent as string,
      machine: (r.machine as string) ?? null,
      developer: (r.developer as string) ?? null,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    }));
  }

  redeemPairCode(code: string): { token: string; agent: string; developer: string | null } {
    this.prunePairRequests();
    const row = this.db.prepare('SELECT * FROM pair_requests WHERE code = ?').get(code) as Row | undefined;
    if (!row) notFound('invalid or expired pairing code');
    this.db.prepare('DELETE FROM pair_requests WHERE id = ?').run(row.id as string); // one-time
    const t = Date.now();
    const token = randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO credentials (id, token, agent, machine, developer, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), token, row.agent as string, (row.machine as string) ?? null,
        (row.developer as string) ?? null, t, t);
    return { token, agent: row.agent as string, developer: (row.developer as string) ?? null };
  }

  getCredentialByToken(token: string): CredentialInfo | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE token = ?').get(token) as Row | undefined;
    if (!row) return null;
    const t = Date.now();
    this.db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?').run(t, row.id as string);
    return {
      id: row.id as string,
      agent: row.agent as string,
      machine: (row.machine as string) ?? null,
      developer: (row.developer as string) ?? null,
      createdAt: Number(row.created_at),
      lastUsedAt: t,
    };
  }

  listCredentials(): CredentialInfo[] {
    // token values are never returned — a credential is only ever shown by id
    return (this.db.prepare('SELECT id, agent, machine, developer, created_at, last_used_at FROM credentials ORDER BY created_at')
      .all() as Row[]).map((r) => ({
        id: r.id as string,
        agent: r.agent as string,
        machine: (r.machine as string) ?? null,
        developer: (r.developer as string) ?? null,
        createdAt: Number(r.created_at),
        lastUsedAt: Number(r.last_used_at),
      }));
  }

  revokeCredential(id: string): { ok: true } {
    const res = this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    if (res.changes === 0) notFound('credential not found');
    return { ok: true };
  }

  // ---- users (see docs/auth.md) ----

  // First account to register (users table empty) becomes the active admin;
  // every later registration is a pending 'user' awaiting admin approval.
  async registerUser(input: UserRegister): Promise<{ user: PublicUser; bootstrap: boolean }> {
    const username = normalizeUsername(input.username);
    const password_hash = await hashPassword(input.password); // hash first, then the count+insert run in one sync tick (no bootstrap race)
    const bootstrap = Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n) === 0;
    const t = Date.now();
    const id = randomUUID();
    const role = bootstrap ? 'admin' : 'user';
    const status = bootstrap ? 'active' : 'pending';
    try {
      this.db.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, username, password_hash, role, status, t, t);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) fail('username taken', 409);
      throw err;
    }
    return { user: { id, username, role, status, createdAt: t }, bootstrap };
  }

  async loginUser(rawUsername: string, password: string): Promise<LoginResult> {
    // invalid-format username can't exist → treat as unknown user (don't 400/leak)
    let username = '';
    try { username = normalizeUsername(rawUsername); } catch { /* falls through to dummy verify */ }
    const row = username ? this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined : undefined;
    const ok = await verifyPassword(password, (row?.password_hash as string) ?? DUMMY_HASH);
    if (!row || !ok) return { ok: false, code: 401, error: 'invalid credentials' }; // same for unknown user vs wrong password
    if (row.status === 'pending') return { ok: false, code: 403, error: 'account pending approval', status: 'pending' };
    if (row.status === 'disabled') return { ok: false, code: 403, error: 'account disabled', status: 'disabled' };
    return { ok: true, user: publicUser(row), token: this.createUserSession(row.id as string) };
  }

  private createUserSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    const t = Date.now();
    this.db.prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, t, t + USER_SESSION_TTL_MS);
    return token;
  }

  // Resolve an ACTIVE user from a session token; prune expired sessions first.
  // A user disabled/deleted mid-session resolves to null (→ 401 everywhere).
  getUserBySession(token: string): PublicUser | null {
    this.db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(Date.now());
    const row = this.db.prepare(
      'SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
      .get(token) as Row | undefined;
    if (!row || row.status !== 'active') return null;
    return publicUser(row);
  }

  logoutSession(token: string): { ok: true } {
    this.db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
    return { ok: true };
  }

  private clearUserSessions(userId: string): void {
    this.db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  }

  listUsers(): PublicUser[] {
    return (this.db.prepare('SELECT id, username, role, status, created_at FROM users ORDER BY created_at')
      .all() as Row[]).map(publicUser);
  }

  // The last user that is role=admin AND status=active may not be demoted,
  // disabled, or deleted — self-targeting included.
  private isLastActiveAdmin(row: Row): boolean {
    if (row.role !== 'admin' || row.status !== 'active') return false;
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get() as Row).n;
    return Number(n) === 1;
  }

  patchUser(id: string, patch: UserPatch): PublicUser {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!row) notFound('user not found');
    const role = patch.role ?? (row.role as string);
    const status = patch.status ?? (row.status as string);
    if ((role !== 'admin' || status !== 'active') && this.isLastActiveAdmin(row)) {
      fail('cannot remove the last active admin', 409);
    }
    this.db.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(role, status, Date.now(), id);
    if (status !== 'active') this.clearUserSessions(id); // disabling kills existing sessions
    return publicUser({ ...row, role, status });
  }

  deleteUser(id: string): { ok: true } {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!row) notFound('user not found');
    if (this.isLastActiveAdmin(row)) fail('cannot remove the last active admin', 409);
    this.clearUserSessions(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  }

  // ---- queries ----

  check(projectId: string, scope: WorkScope): ConflictWarning[] {
    return checkOverlap(this.activeClaims(projectId), scope);
  }

  getState(projectId: string): ProjectState {
    this.sweep(); // reading state also reaps expired sessions/claims
    const sessions = (this.db.prepare('SELECT * FROM sessions WHERE projectId = ? ORDER BY createdAt')
      .all(projectId) as Row[]).map(sessionFromRow);
    const claims = this.activeClaims(projectId);
    const bugs = (this.db.prepare('SELECT * FROM bugs WHERE projectId = ? ORDER BY createdAt')
      .all(projectId) as Row[]).map(bugFromRow);
    const completed = (this.db.prepare(
      "SELECT * FROM claims WHERE projectId = ? AND status = 'done' ORDER BY completedAt DESC, rowid DESC LIMIT 20")
      .all(projectId) as Row[]).map(claimFromRow);
    const events = (this.db.prepare('SELECT * FROM events WHERE projectId = ? ORDER BY at DESC, rowid DESC LIMIT 50')
      .all(projectId) as Row[]).map(eventFromRow);

    const recent = new Map<string, { file: string; agents: Set<string>; updatedAt: number }>();
    const note = (file: string, agent: string, at: number) => {
      const f = normalizePath(file);
      if (!f) return;
      const e = recent.get(f) ?? { file: f, agents: new Set<string>(), updatedAt: 0 };
      e.agents.add(agent);
      e.updatedAt = Math.max(e.updatedAt, at);
      recent.set(f, e);
    };
    for (const c of claims) for (const f of c.files) note(f, c.agent, c.updatedAt);
    for (const s of sessions) for (const f of s.repo?.dirtyFiles ?? []) note(f, s.agent, s.repo!.reportedAt);
    const recentFiles: RecentFile[] = [...recent.values()]
      .map((e) => ({ file: e.file, agents: [...e.agents], updatedAt: e.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);

    return {
      project: projectId,
      now: Date.now(),
      sessions,
      claims,
      bugs,
      completed,
      conflicts: pairConflicts(claims),
      recentFiles,
      events,
    };
  }

  listProjects(): ProjectSummary[] {
    this.sweep();
    const ids = (this.db.prepare(`
      SELECT projectId FROM sessions UNION SELECT projectId FROM claims
      UNION SELECT projectId FROM bugs UNION SELECT projectId FROM events
      ORDER BY projectId`).all() as Row[]).map((r) => r.projectId as string);
    return ids.map((id) => {
      const sessions = (this.db.prepare('SELECT agent FROM sessions WHERE projectId = ?').all(id) as Row[]);
      const claims = this.activeClaims(id);
      const openBugs = this.db.prepare("SELECT COUNT(*) AS n FROM bugs WHERE projectId = ? AND status != 'fixed'")
        .get(id) as Row;
      const lastEvent = this.db.prepare('SELECT MAX(at) AS at FROM events WHERE projectId = ?').get(id) as Row;
      return {
        id,
        sessions: sessions.length,
        claims: claims.length,
        openBugs: Number(openBugs.n),
        conflicts: pairConflicts(claims).length,
        agents: [...new Set(sessions.map((r) => r.agent as string))],
        lastActivityAt: lastEvent.at == null ? null : Number(lastEvent.at),
      };
    });
  }

  // ---- expiry ----

  sweep(): void {
    const t = Date.now();
    const stale = (this.db.prepare('SELECT * FROM sessions WHERE lastSeenAt < ?')
      .all(t - this.sessionTtlMs) as Row[]).map(sessionFromRow);
    for (const s of stale) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
      this.emit(s.projectId, 'session', `${s.agent} session expired (no heartbeat)`);
      this.releaseClaims(s.projectId, s.id, 'session expired');
    }
    const idle = (this.db.prepare("SELECT * FROM claims WHERE status != 'done' AND updatedAt < ?")
      .all(t - this.claimIdleTtlMs) as Row[]).map(claimFromRow);
    for (const c of idle) {
      this.db.prepare('DELETE FROM claims WHERE id = ?').run(c.id);
      this.emit(c.projectId, 'claim', `claim "${c.intent}" expired (idle)`);
    }
  }

  close(): void {
    this.db.close();
  }
}
