// SQLite-backed coordination store. Arrays/objects are stored as JSON text
// columns; rows are hydrated back into the core domain types. All domain rules
// (overlap, tokenize, normalizePath) come from src/core/overlap.ts.

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { checkOverlap, normalizePath, pairConflicts } from '../core/overlap.ts';
import type {
  Bug, Claim, ConflictWarning, EventEntry, EventType, MemberRole, ProjectState,
  ProjectSummary, RecentFile, RepoState, Session, WorkScope,
} from '../core/types.ts';
import type {
  BugCreate, BugPatch, ClaimComplete, ClaimCreate, ClaimPatch,
  Heartbeat, RepoReport, SessionCreate, UserPatch, UserRegister,
} from '../core/schemas.ts';

export const DEFAULT_SESSION_TTL_MS = 300_000;
export const DEFAULT_CLAIM_IDLE_TTL_MS = 45 * 60_000;

const EVENTS_CAP = 200;

// Project ids are slugs. Enforced on CREATION only — ids created before the
// Alpha milestone are grandfathered and keep working.
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Additive column migrations for live databases. node:sqlite throws on a
// duplicate ADD COLUMN, so each is guarded by a PRAGMA table_info check.
// Future columns are one line here.
const ADD_COLUMNS: [table: string, column: string, decl: string][] = [
  ['credentials', 'user_id', 'TEXT'],
  ['pair_requests', 'approved_by', 'TEXT'],
  ['pair_requests', 'approved_at', 'INTEGER'],
  ['sessions', 'capability_hash', 'TEXT'],
  ['users', 'auth_provider', 'TEXT'],
  ['users', 'github_user_id', 'TEXT'],
  ['users', 'github_login', 'TEXT'],
  ['users', 'github_authorization_status', 'TEXT'],
  ['projects', 'provider', 'TEXT'],
  ['projects', 'external_repository_id', 'TEXT'],
  ['projects', 'full_name', 'TEXT'],
  ['projects', 'installation_id', 'TEXT'],
  ['projects', 'visibility', 'TEXT'],
  ['projects', 'authorization_source', 'TEXT'],
  ['sessions', 'user_id', 'TEXT'],
  ['sessions', 'authorization_source', 'TEXT'],
  ['sessions', 'github_user_id', 'TEXT'],
  ['sessions', 'github_repository_id', 'TEXT'],
  ['sessions', 'github_permission', 'TEXT'],
  ['sessions', 'authorization_verified_at', 'INTEGER'],
  ['sessions', 'authorization_expires_at', 'INTEGER'],
  ['credentials', 'authorization_source', 'TEXT'],
  ['credentials', 'github_user_id', 'TEXT'],
  ['project_members', 'authorization_source', 'TEXT'],
  ['project_members', 'repository_permission', 'TEXT'],
  ['project_members', 'authorization_expires_at', 'INTEGER'],
];

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
  displayName: string; // what humans are shown: the GitHub login, original case
  role: 'user' | 'admin';
  status: 'pending' | 'active' | 'disabled';
  createdAt: number;
}

// `username` stays the normalized, case-insensitive handle the API matches on
// (`gh-octocat`); humans only ever see the GitHub login they know (`octocat`).
const displayName = (r: Row): string => (r.github_login as string) || (r.username as string);

function publicUser(r: Row): PublicUser {
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: displayName(r),
    role: r.role as PublicUser['role'],
    status: r.status as PublicUser['status'],
    createdAt: Number(r.created_at),
  };
}

export type LoginResult =
  | { ok: true; user: PublicUser; token: string }
  | { ok: false; code: 401 | 403; error: string; status?: 'pending' | 'disabled' };

export interface CredentialInfo {
  id: string;
  agent: string;
  machine: string | null;
  developer: string | null;
  userId: string; // owning user — a credential without an ACTIVE owner never resolves
  ownerUsername: string;
  ownerDisplayName: string; // GitHub login of the owner, original case
  createdAt: number;
  lastUsedAt: number;
  authorizationSource: 'manual' | 'github-app';
  githubUserId: string | null;
}

const capabilityHash = (value: string) => createHash('sha256').update(value).digest('base64url');

export interface ProjectMember {
  userId: string;
  username: string;
  displayName: string;
  role: MemberRole;
  createdAt: number;
  authorizationSource?: 'manual' | 'github-app';
  repositoryPermission?: string | null;
  authorizationExpiresAt?: number | null;
}

export interface GithubIdentity {
  githubUserId: string; // GitHub IDs are decimal strings: never JS numbers.
  login: string;
  authorizationStatus: 'authorized' | 'revoked' | 'pending';
}

export interface GithubProjectInput {
  externalRepositoryId: string;
  fullName: string;
  installationId: string;
  visibility: 'public' | 'private' | 'internal';
  authorizationSource: 'github-app';
  createdBy?: string | null;
}

export interface GithubProjectMetadata extends GithubProjectInput {
  id: string;
  provider: 'github';
  createdAt: number;
}

export interface GithubDeviceActivation {
  requestId: string;
  secret: string; // Returned once to the initiating device; only its hash is stored.
  userCode: string;
  expiresAt: number;
}

export interface GithubSessionAuthorization {
  userId: string;
  githubUserId: string;
  githubRepositoryId: string;
  permission: 'write' | 'admin';
  verifiedAt: number;
  expiresAt: number;
  authorizationSource: 'github-app';
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
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, created_by TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_members (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (project_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_device_activations (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, user_code TEXT NOT NULL UNIQUE,
        machine TEXT, github_user_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        bound_at INTEGER, redeemed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId);
      CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(projectId);
      CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(projectId);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(projectId, at);
    `);
    for (const [table, column, decl] of ADD_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_user_id
        ON users(github_user_id) WHERE github_user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_provider_external_repository
        ON projects(provider, external_repository_id)
        WHERE provider IS NOT NULL AND external_repository_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_github_authorization
        ON sessions(authorization_source, github_user_id, github_repository_id);
      CREATE INDEX IF NOT EXISTS idx_credentials_github_authorization
        ON credentials(authorization_source, github_user_id);
      CREATE INDEX IF NOT EXISTS idx_project_members_github_authorization
        ON project_members(authorization_source, authorization_expires_at);
      CREATE INDEX IF NOT EXISTS idx_github_device_activations_github_user
        ON github_device_activations(github_user_id, expires_at);
    `);
    this.backfillAlpha();
  }

  // ---- one-shot pre-Alpha backfill ----
  // It waits for an active admin, records an explicit marker, and never relies
  // on "projects is empty" as its completion flag: a valid new installation
  // may have device credentials before its first project.
  private backfillAlpha(): void {
    const migrationId = 'global-device-auth-v1';
    if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(migrationId)) return;
    const admin = this.db.prepare(
      "SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at, rowid LIMIT 1")
      .get() as Row | undefined;
    if (!admin) return;
    const adminId = admin.id as string;
    const t = Date.now();

    // Only a database with no project rows needs the original ownership
    // adoption. Existing private-project databases already have intentional
    // owners and must not gain the oldest admin as a new owner.
    if (Number((this.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as Row).n) === 0) {
      const ids = this.db.prepare(`
        SELECT projectId, MIN(at) AS at FROM (
          SELECT projectId, createdAt AS at FROM sessions
          UNION ALL SELECT projectId, createdAt FROM claims
          UNION ALL SELECT projectId, createdAt FROM bugs
          UNION ALL SELECT projectId, at FROM events
        ) GROUP BY projectId`).all() as Row[];
      for (const row of ids) {
        this.db.prepare('INSERT OR IGNORE INTO projects (id, created_by, created_at) VALUES (?, ?, ?)')
          .run(row.projectId as string, adminId, row.at == null ? t : Number(row.at));
        this.addMemberRow(row.projectId as string, adminId, 'owner', t);
      }

      // Grandfather membership for known legacy contributors.
      const seen = this.db.prepare(`
        SELECT DISTINCT projectId, developer FROM (
          SELECT projectId, developer FROM sessions
          UNION SELECT projectId, developer FROM claims
        ) WHERE developer IS NOT NULL`).all() as Row[];
      for (const row of seen) {
        const user = this.db.prepare('SELECT id FROM users WHERE username = ?')
          .get(row.developer as string) as Row | undefined;
        if (user) this.addMemberRow(row.projectId as string, user.id as string, 'member', t);
      }
    }

    // Legacy bearer attribution was self-declared. Never turn it into authority.
    this.db.exec('DELETE FROM credentials');
    this.db.exec('DELETE FROM pair_requests');
    this.db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migrationId, t);
  }

  private addMemberRow(projectId: string, userId: string, role: MemberRole, at: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO project_members
      (project_id, user_id, role, created_at, authorization_source) VALUES (?, ?, ?, ?, 'manual')`)
      .run(projectId, userId, role, at);
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

  startSession(projectId: string, input: SessionCreate, capability?: string): Session {
    this.ensureProject(projectId, null); // no-op for the API (the middleware already created/authorized it)
    const t = Date.now();
    const session: Session = {
      id: randomUUID(),
      projectId,
      agent: input.developer ? `${input.agent}-${'pending'}@${input.developer}` : input.agent,
      developer: input.developer ?? null,
      machine: input.machine ?? null,
      repo: null,
      createdAt: t,
      lastSeenAt: t,
    };
    if (input.developer) session.agent = `${input.agent}-${session.id.slice(0, 8)}@${input.developer}`;
    this.db.prepare(`INSERT INTO sessions (id, projectId, agent, developer, machine, repo, createdAt, lastSeenAt, capability_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, projectId, session.agent, session.developer, session.machine, null, t, t,
        capability ? capabilityHash(capability) : null);
    this.emit(projectId, 'session', `${session.agent} connected`);
    return session;
  }

  assertSessionCapability(projectId: string, sessionId: string, capability: string | undefined,
    allowExpiredGithubAuthorization = false): void {
    const row = this.db.prepare(`SELECT capability_hash, authorization_source, authorization_expires_at
      FROM sessions WHERE projectId = ? AND id = ?`)
      .get(projectId, sessionId) as Row | undefined;
    if (!row) notFound('session not found or expired');
    if (!capability || !row.capability_hash || !timingSafeEqual(
      Buffer.from(capabilityHash(capability)), Buffer.from(row.capability_hash as string),
    )) fail('session capability required', 403);
    if (!allowExpiredGithubAuthorization && row.authorization_source === 'github-app'
      && Number(row.authorization_expires_at) <= Date.now()) {
      fail('GitHub session authorization expired', 403);
    }
  }

  setGithubSessionAuthorization(projectId: string, sessionId: string, authorization: GithubSessionAuthorization): void {
    if (!/^\d+$/.test(authorization.githubUserId) || !/^\d+$/.test(authorization.githubRepositoryId)) {
      fail('GitHub ids must be decimal strings', 400);
    }
    this.requireSession(projectId, sessionId);
    this.db.prepare(`UPDATE sessions SET user_id = ?, authorization_source = ?, github_user_id = ?,
      github_repository_id = ?, github_permission = ?, authorization_verified_at = ?, authorization_expires_at = ?
      WHERE id = ?`).run(authorization.userId, authorization.authorizationSource, authorization.githubUserId,
      authorization.githubRepositoryId, authorization.permission, authorization.verifiedAt, authorization.expiresAt, sessionId);
  }

  getGithubSessionAuthorization(projectId: string, sessionId: string): GithubSessionAuthorization | null {
    const row = this.db.prepare(`SELECT user_id, authorization_source, github_user_id, github_repository_id,
      github_permission, authorization_verified_at, authorization_expires_at FROM sessions
      WHERE projectId = ? AND id = ?`).get(projectId, sessionId) as Row | undefined;
    if (!row) notFound('session not found or expired');
    if (row.authorization_source !== 'github-app') return null;
    return {
      userId: row.user_id as string, githubUserId: row.github_user_id as string,
      githubRepositoryId: row.github_repository_id as string,
      permission: row.github_permission as GithubSessionAuthorization['permission'],
      verifiedAt: Number(row.authorization_verified_at), expiresAt: Number(row.authorization_expires_at),
      authorizationSource: 'github-app',
    };
  }

  assertGithubSessionAuthorization(projectId: string, sessionId: string, now = Date.now()): GithubSessionAuthorization {
    const authorization = this.getGithubSessionAuthorization(projectId, sessionId);
    if (!authorization || authorization.expiresAt <= now) fail('GitHub session authorization expired', 403);
    return authorization;
  }

  markCredentialGithubAuthorization(credentialId: string, githubUserId: string): void {
    if (!/^\d+$/.test(githubUserId)) fail('invalid GitHub user id', 400);
    const result = this.db.prepare(`UPDATE credentials SET authorization_source = 'github-app', github_user_id = ?
      WHERE id = ?`).run(githubUserId, credentialId);
    if (result.changes === 0) notFound('credential not found');
  }

  assertClaimCapability(projectId: string, claimId: string, capability: string | undefined): void {
    const row = this.db.prepare('SELECT sessionId FROM claims WHERE projectId = ? AND id = ?')
      .get(projectId, claimId) as Row | undefined;
    if (!row) notFound('claim not found');
    this.assertSessionCapability(projectId, row.sessionId as string, capability);
  }

  assertBugCapability(projectId: string, bugId: string, capability: string | undefined): void {
    const row = this.db.prepare('SELECT sessionId FROM bugs WHERE projectId = ? AND id = ?')
      .get(projectId, bugId) as Row | undefined;
    if (!row) notFound('bug not found');
    this.assertSessionCapability(projectId, row.sessionId as string, capability);
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

  invalidateGithubAuthorization({ userId, githubUserId, reason = 'GitHub authorization revoked' }: {
    userId?: string; githubUserId?: string | null; reason?: string;
  }): { sessions: number; credentials: number } {
    if (!userId && !githubUserId) return { sessions: 0, credentials: 0 };
    const sessions = (this.db.prepare(`SELECT * FROM sessions WHERE authorization_source = 'github-app'
      AND (${userId ? 'user_id = ?' : '0'} OR ${githubUserId ? 'github_user_id = ?' : '0'})`)
      .all(...([userId, githubUserId].filter(Boolean) as string[])) as Row[]).map(sessionFromRow);
    for (const session of sessions) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      this.releaseClaims(session.projectId, session.id, reason);
      this.emit(session.projectId, 'session', `${session.agent} disconnected (${reason})`);
    }
    const credentialSql = `DELETE FROM credentials WHERE authorization_source = 'github-app'
      AND (${userId ? 'user_id = ?' : '0'} OR ${githubUserId ? 'github_user_id = ?' : '0'})`;
    const credentials = this.db.prepare(credentialSql)
      .run(...([userId, githubUserId].filter(Boolean) as string[])).changes;
    if (userId) this.db.prepare(`DELETE FROM project_members WHERE user_id = ? AND authorization_source = 'github-app'`)
      .run(userId);
    return { sessions: sessions.length, credentials: Number(credentials) };
  }

  invalidateGithubRepository(externalRepositoryId: string, reason = 'GitHub repository access revoked'):
    { sessions: number; grants: number } {
    const project = this.getGithubProject(externalRepositoryId);
    if (!project) return { sessions: 0, grants: 0 };
    const sessions = (this.db.prepare(`SELECT * FROM sessions WHERE authorization_source = 'github-app'
      AND github_repository_id = ?`).all(externalRepositoryId) as Row[]).map(sessionFromRow);
    for (const session of sessions) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      this.releaseClaims(session.projectId, session.id, reason);
      this.emit(session.projectId, 'session', `${session.agent} disconnected (${reason})`);
    }
    const grants = this.db.prepare(`DELETE FROM project_members WHERE project_id = ?
      AND authorization_source = 'github-app'`).run(project.id).changes;
    return { sessions: sessions.length, grants: Number(grants) };
  }

  invalidateGithubInstallation(installationId: string, reason = 'GitHub App installation removed'):
    { sessions: number; grants: number } {
    const repositories = (this.db.prepare(`SELECT external_repository_id FROM projects
      WHERE provider = 'github' AND installation_id = ?`).all(installationId) as Row[])
      .map((row) => row.external_repository_id as string);
    return repositories.reduce((total, repositoryId) => {
      const invalidated = this.invalidateGithubRepository(repositoryId, reason);
      return { sessions: total.sessions + invalidated.sessions, grants: total.grants + invalidated.grants };
    }, { sessions: 0, grants: 0 });
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

  // ---- projects + membership (see docs/auth.md) ----

  projectExists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined;
  }

  memberRole(projectId: string, userId: string | null): MemberRole | null {
    if (!userId) return null;
    const row = this.db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?
      AND (authorization_source IS NULL OR authorization_source != 'github-app'
        OR authorization_expires_at IS NULL OR authorization_expires_at > ?)`)
      .get(projectId, userId, Date.now()) as Row | undefined;
    return row ? (row.role as MemberRole) : null;
  }

  githubMemberRole(projectId: string, userId: string | null): MemberRole | null {
    if (!userId) return null;
    const row = this.db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?
      AND authorization_source = 'github-app' AND authorization_expires_at > ?`)
      .get(projectId, userId, Date.now()) as Row | undefined;
    return row ? row.role as MemberRole : null;
  }

  memberProjectIds(userId: string | null): string[] {
    if (!userId) return [];
    return (this.db.prepare(`SELECT project_id FROM project_members WHERE user_id = ?
      AND (authorization_source IS NULL OR authorization_source != 'github-app'
        OR authorization_expires_at IS NULL OR authorization_expires_at > ?) ORDER BY project_id`)
      .all(userId, Date.now()) as Row[]).map((r) => r.project_id as string);
  }

  // Creation-time slug rule; legacy ids keep working but no new one can be odd.
  createProject(rawId: string, userId: string): { id: string; createdAt: number } {
    const id = rawId.trim().toLowerCase();
    if (!PROJECT_ID_RE.test(id)) {
      fail('invalid project id: 1-64 chars, lowercase letters/digits/._- and must start with a letter or digit', 400);
    }
    if (this.projectExists(id)) fail('project id already taken', 409);
    const t = Date.now();
    this.db.prepare('INSERT INTO projects (id, created_by, created_at) VALUES (?, ?, ?)').run(id, userId, t);
    this.addMemberRow(id, userId, 'owner', t);
    return { id, createdAt: t };
  }

  bindGithubIdentity(userId: string, identity: GithubIdentity): void {
    if (!/^\d+$/.test(identity.githubUserId)) fail('invalid GitHub user id', 400);
    const user = this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as Row | undefined;
    if (!user) notFound('user not found');
    const existing = this.db.prepare('SELECT id FROM users WHERE github_user_id = ? AND id != ?')
      .get(identity.githubUserId, userId) as Row | undefined;
    if (existing) fail('GitHub account is already linked to another user', 409);
    this.db.prepare(`UPDATE users SET auth_provider = 'github', github_user_id = ?, github_login = ?,
      github_authorization_status = ?, updated_at = ? WHERE id = ?`)
      .run(identity.githubUserId, identity.login, identity.authorizationStatus, Date.now(), userId);
  }

  getGithubIdentity(userId: string): GithubIdentity | null {
    const row = this.db.prepare(`SELECT github_user_id, github_login, github_authorization_status FROM users
      WHERE id = ?`).get(userId) as Row | undefined;
    if (!row) notFound('user not found');
    if (!row.github_user_id) return null;
    return {
      githubUserId: row.github_user_id as string,
      login: (row.github_login as string) ?? '',
      authorizationStatus: (row.github_authorization_status as GithubIdentity['authorizationStatus']) ?? 'pending',
    };
  }

  revokeGithubIdentity(userId: string, reason = 'GitHub authorization revoked'): { sessions: number; credentials: number } {
    const row = this.db.prepare('SELECT github_user_id FROM users WHERE id = ?').get(userId) as Row | undefined;
    if (!row) notFound('user not found');
    const githubUserId = row.github_user_id as string | null;
    this.db.prepare(`UPDATE users SET github_authorization_status = 'revoked', updated_at = ? WHERE id = ?`)
      .run(Date.now(), userId);
    this.clearUserSessions(userId);
    return this.invalidateGithubAuthorization({ userId, githubUserId, reason });
  }

  findOrCreateGithubUser(identity: GithubIdentity, bootstrapLogin?: string | null): PublicUser {
    if (!/^\d+$/.test(identity.githubUserId) || !identity.login) fail('invalid GitHub identity', 400);
    const existing = this.db.prepare('SELECT * FROM users WHERE github_user_id = ?')
      .get(identity.githubUserId) as Row | undefined;
    if (existing) {
      const bootstrap = !!bootstrapLogin && identity.login.toLowerCase() === bootstrapLogin.toLowerCase()
        && !this.db.prepare(`SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'
          AND auth_provider = 'github' AND github_authorization_status = 'authorized'`).get();
      const role = bootstrap ? 'admin' : existing.role as PublicUser['role'];
      const status = bootstrap ? 'active' : existing.status as PublicUser['status'];
      this.db.prepare(`UPDATE users SET auth_provider = 'github', github_login = ?,
        github_authorization_status = 'authorized', role = ?, status = ?, updated_at = ? WHERE id = ?`)
        .run(identity.login, role, status, Date.now(), existing.id as string);
      return publicUser({ ...existing, github_login: identity.login,
        github_authorization_status: 'authorized', role, status });
    }

    const base = `gh-${identity.login.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 24) || 'user'}`;
    let username = base;
    for (let n = 1; this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); n += 1) {
      const suffix = `-${identity.githubUserId.slice(-6)}-${n}`;
      username = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    }
    const bootstrap = !!bootstrapLogin && identity.login.toLowerCase() === bootstrapLogin.toLowerCase()
      && !this.db.prepare(`SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'
        AND auth_provider = 'github' AND github_authorization_status = 'authorized'`).get();
    const id = randomUUID();
    const t = Date.now();
    this.db.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at,
      auth_provider, github_user_id, github_login, github_authorization_status)
      VALUES (?, ?, 'github-only', ?, ?, ?, ?, 'github', ?, ?, 'authorized')`)
      .run(id, username, bootstrap ? 'admin' : 'user', bootstrap ? 'active' : 'pending',
        t, t, identity.githubUserId, identity.login);
    return { id, username, displayName: identity.login, role: bootstrap ? 'admin' : 'user',
      status: bootstrap ? 'active' : 'pending', createdAt: t };
  }

  getUserByGithubId(githubUserId: string): PublicUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE github_user_id = ?')
      .get(githubUserId) as Row | undefined;
    return row ? publicUser(row) : null;
  }

  createGithubUserSession(userId: string): { user: PublicUser; token: string } {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ? AND status = 'active'
      AND auth_provider = 'github' AND github_authorization_status = 'authorized'`)
      .get(userId) as Row | undefined;
    if (!row) fail('active approved GitHub account required', 403);
    return { user: publicUser(row), token: this.createUserSession(userId) };
  }

  resolveGithubProject(input: GithubProjectInput): GithubProjectMetadata {
    if (!/^\d+$/.test(input.externalRepositoryId) || !/^\d+$/.test(input.installationId)) {
      fail('GitHub repository and installation ids must be decimal strings', 400);
    }
    const existing = this.db.prepare(`SELECT * FROM projects
      WHERE provider = 'github' AND external_repository_id = ?`).get(input.externalRepositoryId) as Row | undefined;
    const t = Date.now();
    if (existing) {
      this.db.prepare(`UPDATE projects SET full_name = ?, installation_id = ?, visibility = ?, authorization_source = ?
        WHERE id = ?`).run(input.fullName, input.installationId, input.visibility, input.authorizationSource, existing.id as string);
      return { ...input, id: existing.id as string, provider: 'github', createdAt: Number(existing.created_at) };
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO projects (id, created_by, created_at, provider, external_repository_id,
      full_name, installation_id, visibility, authorization_source) VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?)`)
      .run(id, input.createdBy ?? null, t, input.externalRepositoryId, input.fullName,
        input.installationId, input.visibility, input.authorizationSource);
    return { ...input, id, provider: 'github', createdAt: t };
  }

  getGithubProject(externalRepositoryId: string): GithubProjectMetadata | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE provider = 'github' AND external_repository_id = ?`)
      .get(externalRepositoryId) as Row | undefined;
    if (!row) return null;
    return {
      id: row.id as string, provider: 'github', externalRepositoryId: row.external_repository_id as string,
      fullName: row.full_name as string, installationId: row.installation_id as string,
      visibility: row.visibility as GithubProjectInput['visibility'],
      authorizationSource: row.authorization_source as 'github-app', createdBy: (row.created_by as string) ?? null,
      createdAt: Number(row.created_at),
    };
  }

  getGithubProjectById(projectId: string): GithubProjectMetadata | null {
    const row = this.db.prepare(`SELECT external_repository_id FROM projects
      WHERE id = ? AND provider = 'github'`).get(projectId) as Row | undefined;
    return row ? this.getGithubProject(row.external_repository_id as string) : null;
  }

  grantGithubProjectAccess(projectId: string, userId: string, permission: string, expiresAt: number): ProjectMember {
    const role: MemberRole = permission.toUpperCase() === 'ADMIN' ? 'owner' : 'member';
    const user = this.db.prepare('SELECT username, github_login FROM users WHERE id = ? AND status = ?').get(userId, 'active') as Row | undefined;
    if (!user) notFound('user not found');
    const existing = this.db.prepare(`SELECT authorization_source, role, created_at FROM project_members
      WHERE project_id = ? AND user_id = ?`).get(projectId, userId) as Row | undefined;
    if (existing && existing.authorization_source !== 'github-app') {
      return { userId, username: user.username as string, displayName: displayName(user),
        role: existing.role as MemberRole,
        createdAt: Number(existing.created_at), authorizationSource: 'manual' };
    }
    const t = Date.now();
    this.db.prepare(`INSERT INTO project_members (project_id, user_id, role, created_at, authorization_source,
      repository_permission, authorization_expires_at) VALUES (?, ?, ?, ?, 'github-app', ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, authorization_source = 'github-app',
      repository_permission = excluded.repository_permission, authorization_expires_at = excluded.authorization_expires_at`)
      .run(projectId, userId, role, t, permission, expiresAt);
    return { userId, username: user.username as string, displayName: displayName(user),
      role, createdAt: t, authorizationSource: 'github-app',
      repositoryPermission: permission, authorizationExpiresAt: expiresAt };
  }

  // Auto-creation path for agents: first session on an unknown id creates it
  // with the acting user as owner. Never validates the slug — the id already
  // came from a client that may predate the rule.
  ensureProject(id: string, userId: string | null): void {
    if (this.projectExists(id)) return;
    const t = Date.now();
    this.db.prepare('INSERT INTO projects (id, created_by, created_at) VALUES (?, ?, ?)').run(id, userId, t);
    if (userId) this.addMemberRow(id, userId, 'owner', t);
  }

  listMembers(projectId: string): ProjectMember[] {
    return (this.db.prepare(`SELECT m.user_id, m.role, m.created_at, m.authorization_source,
      m.repository_permission, m.authorization_expires_at, u.username, u.github_login
      FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? ORDER BY m.role, u.username`).all(projectId) as Row[]).map((r) => ({
        userId: r.user_id as string,
        username: r.username as string,
        displayName: displayName(r),
        role: r.role as MemberRole,
        createdAt: Number(r.created_at),
        authorizationSource: r.authorization_source === 'github-app' ? 'github-app' : 'manual',
        repositoryPermission: (r.repository_permission as string) ?? null,
        authorizationExpiresAt: r.authorization_expires_at == null ? null : Number(r.authorization_expires_at),
      }));
  }

  addMember(projectId: string, rawUsername: string, role: MemberRole): ProjectMember {
    let username = '';
    try { username = normalizeUsername(rawUsername); } catch { /* may still be a GitHub login */ }
    // Humans type the name they see, which is the GitHub login, not the
    // normalized handle the account was created with.
    const user = this.db.prepare(`SELECT id, username, github_login FROM users
      WHERE (username = ? OR LOWER(github_login) = LOWER(?)) AND status = 'active'`)
      .get(username, rawUsername.trim()) as Row | undefined;
    if (!user) notFound('user not found'); // only active users can be added
    if (this.memberRole(projectId, user.id as string)) fail('user is already a member', 409);
    const t = Date.now();
    this.addMemberRow(projectId, user.id as string, role, t);
    return { userId: user.id as string, username: user.username as string,
      displayName: displayName(user), role, createdAt: t };
  }

  // The last remaining owner may not be demoted or removed — same shape as the
  // final-admin guard. An instance admin does not bypass it either.
  private isLastOwner(projectId: string, userId: string): boolean {
    if (this.memberRole(projectId, userId) !== 'owner') return false;
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'owner'")
      .get(projectId) as Row).n;
    return Number(n) === 1;
  }

  setMemberRole(projectId: string, userId: string, role: MemberRole): ProjectMember {
    const current = this.memberRole(projectId, userId);
    if (!current) notFound('member not found');
    if (role !== 'owner' && this.isLastOwner(projectId, userId)) {
      fail('cannot remove the last owner of the project', 409);
    }
    this.db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?')
      .run(role, projectId, userId);
    const row = this.db.prepare('SELECT username, github_login FROM users WHERE id = ?').get(userId) as Row | undefined;
    const username = (row?.username as string) ?? userId;
    return { userId, username, displayName: row ? displayName(row) : username, role, createdAt: Date.now() };
  }

  removeMember(projectId: string, userId: string): { ok: true } {
    if (!this.memberRole(projectId, userId)) notFound('member not found');
    if (this.isLastOwner(projectId, userId)) fail('cannot remove the last owner of the project', 409);
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    return { ok: true };
  }

  deleteProject(projectId: string): { ok: true } {
    for (const sql of [
      'DELETE FROM sessions WHERE projectId = ?', 'DELETE FROM claims WHERE projectId = ?',
      'DELETE FROM bugs WHERE projectId = ?', 'DELETE FROM events WHERE projectId = ?',
      'DELETE FROM project_members WHERE project_id = ?', 'DELETE FROM projects WHERE id = ?',
    ]) this.db.prepare(sql).run(projectId);
    return { ok: true };
  }

  // Resolves ONLY when the credential is bound to an ACTIVE user: orphaned or
  // disabled-owner credentials never authenticate (→ 401 "sign in again").
  getCredentialByToken(token: string): CredentialInfo | null {
    const row = this.db.prepare(`SELECT c.*, u.username AS owner_username, u.github_login FROM credentials c
      JOIN users u ON u.id = c.user_id AND u.status = 'active' WHERE c.token = ?`)
      .get(token) as Row | undefined;
    if (!row) return null;
    const t = Date.now();
    this.db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?').run(t, row.id as string);
    return {
      id: row.id as string,
      agent: row.agent as string,
      machine: (row.machine as string) ?? null,
      developer: (row.developer as string) ?? null,
      userId: row.user_id as string,
      ownerUsername: row.owner_username as string,
      ownerDisplayName: (row.github_login as string) || (row.owner_username as string),
      createdAt: Number(row.created_at),
      lastUsedAt: t,
      authorizationSource: row.authorization_source === 'github-app' ? 'github-app' : 'manual',
      githubUserId: (row.github_user_id as string) ?? null,
    };
  }

  // Only for telling "unknown token" apart from "known but unusable" in the 401.
  credentialTokenExists(token: string): boolean {
    return this.db.prepare('SELECT 1 FROM credentials WHERE token = ?').get(token) !== undefined;
  }

  // userId = null lists everything (instance admin); otherwise own credentials only.
  listCredentials(userId: string | null): CredentialInfo[] {
    // token values are never returned — a credential is only ever shown by id
    const sql = `SELECT c.id, c.agent, c.machine, c.developer, c.user_id, c.created_at, c.last_used_at,
        c.authorization_source, c.github_user_id,
        u.username AS owner_username, u.github_login
      FROM credentials c LEFT JOIN users u ON u.id = c.user_id
      ${userId ? 'WHERE c.user_id = ?' : ''} ORDER BY c.created_at`;
    const stmt = this.db.prepare(sql);
    return ((userId ? stmt.all(userId) : stmt.all()) as Row[]).map((r) => ({
      id: r.id as string,
      agent: r.agent as string,
      machine: (r.machine as string) ?? null,
      developer: (r.developer as string) ?? null,
      userId: (r.user_id as string) ?? '',
      ownerUsername: (r.owner_username as string) ?? '',
      ownerDisplayName: (r.github_login as string) || (r.owner_username as string) || '',
      createdAt: Number(r.created_at),
      lastUsedAt: Number(r.last_used_at),
      authorizationSource: r.authorization_source === 'github-app' ? 'github-app' : 'manual',
      githubUserId: (r.github_user_id as string) ?? null,
    }));
  }

  revokeCredential(id: string, actorId: string, isAdmin: boolean): { ok: true } {
    const row = this.db.prepare('SELECT user_id FROM credentials WHERE id = ?').get(id) as Row | undefined;
    if (!row) notFound('credential not found');
    if (!isAdmin && row.user_id !== actorId) fail('not your credential', 403);
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
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
    if (bootstrap) {
      // A legacy database whose users table was empty could not be backfilled at
      // open time; the first admin adopts its projects (and any ownerless one).
      this.backfillAlpha();
      this.db.prepare(`INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at)
        SELECT p.id, ?, 'owner', ? FROM projects p WHERE NOT EXISTS (
          SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.role = 'owner')`).run(id, t);
    }
    return { user: { id, username, displayName: username, role, status, createdAt: t }, bootstrap };
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

  async loginDevice(rawUsername: string, password: string, machine: string | null): Promise<
    { ok: true; token: string; user: PublicUser } | Exclude<LoginResult, { ok: true }>
  > {
    let username = '';
    try { username = normalizeUsername(rawUsername); } catch { /* dummy verify below */ }
    const row = username ? this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined : undefined;
    const ok = await verifyPassword(password, (row?.password_hash as string) ?? DUMMY_HASH);
    if (!row || !ok) return { ok: false, code: 401, error: 'invalid credentials' };
    if (row.status === 'pending') return { ok: false, code: 403, error: 'account pending approval', status: 'pending' };
    if (row.status === 'disabled') return { ok: false, code: 403, error: 'account disabled', status: 'disabled' };
    const t = Date.now();
    const token = randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO credentials (id, token, agent, machine, developer, user_id, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), token, 'device', machine, null, row.id as string, t, t);
    return { ok: true, token, user: publicUser(row) };
  }

  createGithubDeviceCredential(userId: string, machine: string | null): { token: string; credentialId: string } {
    const user = this.db.prepare(`SELECT github_user_id, github_authorization_status FROM users
      WHERE id = ? AND status = 'active'`).get(userId) as Row | undefined;
    if (!user || user.github_authorization_status !== 'authorized' || !user.github_user_id) {
      fail('active GitHub authorization required', 403);
    }
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const t = Date.now();
    this.db.prepare(`INSERT INTO credentials (id, token, agent, machine, developer, user_id, created_at, last_used_at,
      authorization_source, github_user_id) VALUES (?, ?, 'device', ?, NULL, ?, ?, ?, 'github-app', ?)`)
      .run(id, token, machine, userId, t, t, user.github_user_id as string);
    return { token, credentialId: id };
  }

  startGithubDeviceActivation(machine: string | null, ttlMs = 15 * 60_000): GithubDeviceActivation {
    this.db.prepare('DELETE FROM github_device_activations WHERE expires_at <= ? OR redeemed_at IS NOT NULL').run(Date.now());
    const requestId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const userCode = randomBytes(5).toString('hex').toUpperCase();
    const t = Date.now();
    const expiresAt = t + ttlMs;
    this.db.prepare(`INSERT INTO github_device_activations
      (id, secret_hash, user_code, machine, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(requestId, capabilityHash(secret), userCode, machine, t, expiresAt);
    return { requestId, secret, userCode, expiresAt };
  }

  bindGithubDeviceActivation(requestId: string, userCode: string, githubUserId: string): void {
    if (!/^\d+$/.test(githubUserId)) fail('invalid GitHub user id', 400);
    const result = this.db.prepare(`UPDATE github_device_activations SET github_user_id = ?, bound_at = ?
      WHERE id = ? AND user_code = ? AND expires_at > ? AND redeemed_at IS NULL`)
      .run(githubUserId, Date.now(), requestId, userCode.toUpperCase(), Date.now());
    if (result.changes === 0) notFound('device activation not found or expired');
  }

  githubDeviceActivationStatus(requestId: string, secret: string):
    'waiting-for-github' | 'waiting-for-approval' | 'ready' | 'invalid' {
    const row = this.db.prepare(`SELECT a.github_user_id, u.status, u.github_authorization_status
      FROM github_device_activations a LEFT JOIN users u ON u.github_user_id = a.github_user_id
      WHERE a.id = ? AND a.secret_hash = ? AND a.expires_at > ? AND a.redeemed_at IS NULL`)
      .get(requestId, capabilityHash(secret), Date.now()) as Row | undefined;
    if (!row) return 'invalid';
    if (!row.github_user_id) return 'waiting-for-github';
    if (row.status !== 'active' || row.github_authorization_status !== 'authorized') return 'waiting-for-approval';
    return 'ready';
  }

  redeemGithubDeviceActivation(requestId: string, secret: string): { token: string; credentialId: string; userId: string } {
    const row = this.db.prepare(`SELECT a.*, u.id AS user_id FROM github_device_activations a
      JOIN users u ON u.github_user_id = a.github_user_id
        AND u.status = 'active' AND u.github_authorization_status = 'authorized'
      WHERE a.id = ? AND a.secret_hash = ? AND a.expires_at > ? AND a.redeemed_at IS NULL`)
      .get(requestId, capabilityHash(secret), Date.now()) as Row | undefined;
    if (!row) fail('device activation is invalid, expired, or not authorized', 403);
    const redeemed = this.db.prepare(`UPDATE github_device_activations SET redeemed_at = ?
      WHERE id = ? AND redeemed_at IS NULL`).run(Date.now(), row.id as string);
    if (redeemed.changes === 0) fail('device activation already redeemed', 403);
    const credential = this.createGithubDeviceCredential(row.user_id as string, (row.machine as string) ?? null);
    return { ...credential, userId: row.user_id as string };
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
    if (status !== 'active') {
      this.clearUserSessions(id);
      if (row.github_user_id) {
        this.invalidateGithubAuthorization({
          userId: id, githubUserId: row.github_user_id as string, reason: 'Mediation account disabled',
        });
      }
    }
    if (role === 'admin' && status === 'active') this.backfillAlpha();
    return publicUser({ ...row, role, status });
  }

  deleteUser(id: string): { ok: true } {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!row) notFound('user not found');
    if (this.isLastActiveAdmin(row)) fail('cannot remove the last active admin', 409);
    this.clearUserSessions(id);
    if (row.github_user_id) {
      this.invalidateGithubAuthorization({
        userId: id, githubUserId: row.github_user_id as string, reason: 'Mediation account deleted',
      });
    }
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

  // Scoped to what the actor may see: their memberships, or everything for an
  // instance admin (rows they are not a member of come back with role: null).
  listProjects(userId: string | null, isAdmin: boolean): ProjectSummary[] {
    this.sweep();
    const ids = isAdmin
      ? (this.db.prepare('SELECT id FROM projects ORDER BY id').all() as Row[]).map((r) => r.id as string)
      : this.memberProjectIds(userId);
    return ids.map((id) => {
      const project = this.db.prepare('SELECT full_name FROM projects WHERE id = ?').get(id) as Row | undefined;
      const sessions = (this.db.prepare('SELECT agent FROM sessions WHERE projectId = ?').all(id) as Row[]);
      const claims = this.activeClaims(id);
      const openBugs = this.db.prepare("SELECT COUNT(*) AS n FROM bugs WHERE projectId = ? AND status != 'fixed'")
        .get(id) as Row;
      const lastEvent = this.db.prepare('SELECT MAX(at) AS at FROM events WHERE projectId = ?').get(id) as Row;
      return {
        id,
        // GitHub projects carry an opaque uuid id; humans know them by repository.
        name: (project?.full_name as string) || id,
        role: this.memberRole(id, userId),
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
