// SQLite-backed coordination store. Arrays/objects are stored as JSON text
// columns; rows are hydrated back into the core domain types. All domain rules
// (overlap, tokenize, normalizePath) come from src/core/overlap.ts.

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { checkOverlap, filesOverlap, normalizePath, pairConflicts } from '../core/overlap.ts';
import {
  DURABLE_EVENT_TYPES, NEWS_BLOCKED_PREFIX, NEWS_UNBLOCKED_PREFIX, TERMINAL_CLAIM_STATUSES,
} from '../core/types.ts';
import type {
  Bug, Claim, ConflictWarning, EventEntry, EventType, Finding, MemberRole, NewsItem,
  ProjectState, ProjectSummary, RecentFile, RepoState, Session, WorkScope,
} from '../core/types.ts';
import type {
  BugCreate, BugPatch, ClaimComplete, ClaimCreate, ClaimPatch,
  Heartbeat, RepoReport, SessionCreate, UserPatch, UserRegister,
} from '../core/schemas.ts';

export const DEFAULT_SESSION_TTL_MS = 300_000;
export const DEFAULT_CLAIM_IDLE_TTL_MS = 45 * 60_000;
// A project nobody has touched for this long drops out of the dashboard list.
// It is only HIDDEN: the row, its history and its membership all stay, and it
// reappears the moment an agent connects again. Projects are never deleted
// automatically; only an owner's explicit DELETE removes one.
export const PROJECT_IDLE_HIDE_MS = 7 * 24 * 60 * 60_000;

const EVENTS_CAP = 200;
const DURABLE_EVENTS_CAP = 1000;
// News older than this is never delivered, however far behind a session's cursor
// is. A restarted harness gets a fresh session with no cursor history, so this
// window is what bounds the catch-up it receives instead of the whole feed.
const NEWS_WINDOW_MS = 30 * 60_000;
const NEWS_LIMIT = 3;

// Project ids are slugs. Enforced on CREATION only, because ids created before the
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
  ['events', 'agent', 'TEXT'],
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
  ['bugs', 'issue_url', 'TEXT'],
  ['events', 'claimId', 'TEXT'],
  ['events', 'files', 'TEXT'],
  ['events', 'sessionId', 'TEXT'],
  ['sessions', 'worktree', 'TEXT'],
  ['sessions', 'news_cursor', 'INTEGER'],
  ['claims', 'worktree', 'TEXT'],
  ['claims', 'blockedOn', 'TEXT'],
];

interface StoreOptions {
  dbPath: string;
  sessionTtlMs?: number;
  claimIdleTtlMs?: number;
}

// `done` and `abandoned` both close a claim; neither is active work.
const TERMINAL_SQL = TERMINAL_CLAIM_STATUSES.map((s) => `'${s}'`).join(', ');

function fail(message: string, statusCode: number): never {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  throw err;
}

function notFound(message: string): never {
  return fail(message, 404);
}

// Coarse on purpose: these ages are read by an agent deciding what to do next,
// where "20m" and "3h" are different decisions and "20m14s" is neither.
function agoText(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
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
  avatarUrl: string | null; // GitHub profile picture, by immutable user id
  role: 'user' | 'admin';
  status: 'pending' | 'active' | 'disabled';
  createdAt: number;
}

// `username` stays the normalized, case-insensitive handle the API matches on
// (`gh-octocat`); humans only ever see the GitHub login they know (`octocat`).
const displayName = (r: Row): string => (r.github_login as string) || (r.username as string);
// Keyed by the numeric GitHub id, so a rename or a new picture still resolves.
const avatarUrl = (r: Row): string | null =>
  (r.github_user_id ? `https://avatars.githubusercontent.com/u/${r.github_user_id as string}?v=4` : null);

function publicUser(r: Row): PublicUser {
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: displayName(r),
    avatarUrl: avatarUrl(r),
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
  userId: string; // owning user; a credential without an ACTIVE owner never resolves
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
  avatarUrl: string | null;
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
    worktree: (r.worktree as string) ?? null,
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
    blockedOn: (r.blockedOn as string) ?? null,
    // Findings written before they carried scope hydrate with empty defaults, so
    // old rows display normally and simply never route.
    findings: (JSON.parse(r.findings as string) as Partial<Finding>[])
      .map((f) => ({ text: f.text ?? '', at: Number(f.at ?? 0), files: f.files ?? [], kind: f.kind ?? null })),
    commits: JSON.parse(r.commits as string),
    prs: JSON.parse(r.prs as string),
    summary: (r.summary as string) ?? null,
    worktree: (r.worktree as string) ?? null,
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
    issueUrl: (r.issue_url as string) ?? null,
  };
}

function eventFromRow(r: Row): EventEntry {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    type: r.type as EventType,
    message: r.message as string,
    at: Number(r.at),
    agent: (r.agent as string) ?? null, // null for rows written before the column
    claimId: (r.claimId as string) ?? null,
    files: r.files ? (JSON.parse(r.files as string) as string[]) : [],
    sessionId: (r.sessionId as string) ?? null,
    seq: Number(r.rowid ?? 0),
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
        message TEXT NOT NULL, at INTEGER NOT NULL, agent TEXT
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

  /* Scope (`claimId`, `files`, `sessionId`) is what makes an event routable:
     without it the feed can only be displayed, never delivered to the people it
     concerns. `sessionId` is the author, so news is never handed back to them. */
  private emit(projectId: string, type: EventType, message: string, agent: string | null = null,
    scope: { claimId?: string | null; files?: string[]; sessionId?: string | null } = {}): void {
    this.db.prepare(`INSERT INTO events (id, projectId, type, message, at, agent, claimId, files, sessionId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), projectId, type, message, Date.now(), agent,
        scope.claimId ?? null, JSON.stringify((scope.files ?? []).map(normalizePath)), scope.sessionId ?? null);
    /* Eviction spares the durable types. A claim's findings must outlive the
       claim itself: it can be abandoned, expire, or be released, and letting a
       burst of session churn evict them would throw away the one record of what
       an agent learned. Churny types (session/activity/claim) still ride the cap. */
    const durable = DURABLE_EVENT_TYPES.map(() => '?').join(', ');
    this.db.prepare(`
      DELETE FROM events WHERE projectId = ? AND type NOT IN (${durable}) AND rowid NOT IN (
        SELECT rowid FROM events WHERE projectId = ? AND type NOT IN (${durable})
        ORDER BY at DESC, rowid DESC LIMIT ?
      )`).run(projectId, ...DURABLE_EVENT_TYPES, projectId, ...DURABLE_EVENT_TYPES, EVENTS_CAP);
    // Spared from the churn cap, not from every cap: they still get a ceiling,
    // just a far higher one, so a long-lived project cannot grow without bound.
    this.db.prepare(`
      DELETE FROM events WHERE projectId = ? AND type IN (${durable}) AND rowid NOT IN (
        SELECT rowid FROM events WHERE projectId = ? AND type IN (${durable})
        ORDER BY at DESC, rowid DESC LIMIT ?
      )`).run(projectId, ...DURABLE_EVENT_TYPES, projectId, ...DURABLE_EVENT_TYPES, DURABLE_EVENTS_CAP);
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
    return (this.db.prepare(`SELECT * FROM claims WHERE projectId = ? AND status NOT IN (${TERMINAL_SQL}) ORDER BY createdAt`)
      .all(projectId) as Row[]).map(claimFromRow);
  }

  /* Overlap runs against claims WIDENED by what each session actually has dirty
     on disk. Agents predict their file lists badly (or leave them empty), which
     silently defeats the whole engine; the working tree does not guess. The
     union is computed on read and never written back, so a claim keeps saying
     what its agent meant to touch. */
  private effectiveClaims(projectId: string): Claim[] {
    const claims = this.activeClaims(projectId);
    if (!claims.length) return claims;
    const dirty = new Map<string, string[]>();
    for (const row of this.db.prepare('SELECT id, repo FROM sessions WHERE projectId = ?').all(projectId) as Row[]) {
      const repo = row.repo ? (JSON.parse(row.repo as string) as RepoState) : null;
      if (repo?.dirtyFiles?.length) dirty.set(row.id as string, repo.dirtyFiles.map(normalizePath));
    }
    if (!dirty.size) return claims;
    return claims.map((c) => {
      const extra = dirty.get(c.sessionId);
      return extra ? { ...c, files: [...new Set([...c.files, ...extra])] } : c;
    });
  }

  private getClaim(projectId: string, claimId: string): Claim {
    const row = this.db.prepare('SELECT * FROM claims WHERE projectId = ? AND id = ?')
      .get(projectId, claimId) as Row | undefined;
    // Every dead end here ends a resumed agent's coordination for the whole
    // task, so say what to do instead of only what went wrong.
    if (!row) {
      notFound('no claim with this id exists in this project. If you are resuming earlier work, '
        + 'create a new claim now with mediation_claim {intent, files} for what you are doing and finish it there: '
        + 're-claiming is the correct recovery, not a failure');
    }
    return claimFromRow(row);
  }

  private saveClaim(c: Claim): void {
    this.db.prepare(`
      UPDATE claims SET intent = ?, task = ?, files = ?, components = ?, branch = ?,
        baseRevision = ?, status = ?, blockedOn = ?, findings = ?, commits = ?, prs = ?, summary = ?,
        updatedAt = ?, completedAt = ? WHERE id = ?`)
      .run(c.intent, c.task, JSON.stringify(c.files), JSON.stringify(c.components), c.branch,
        c.baseRevision, c.status, c.blockedOn, JSON.stringify(c.findings), JSON.stringify(c.commits),
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
      worktree: input.worktree ?? null,
      repo: null,
      createdAt: t,
      lastSeenAt: t,
    };
    if (input.developer) session.agent = `${input.agent}-${session.id.slice(0, 8)}@${input.developer}`;
    this.db.prepare(`INSERT INTO sessions (id, projectId, agent, developer, machine, worktree, repo,
        createdAt, lastSeenAt, capability_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, projectId, session.agent, session.developer, session.machine, session.worktree, null, t, t,
        capability ? capabilityHash(capability) : null);
    this.emit(projectId, 'session', `${session.agent} connected`, session.agent);
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

  private sessionByCapability(projectId: string, capability: string | undefined): Session {
    if (!capability) fail('session capability required', 403);
    const row = this.db.prepare('SELECT * FROM sessions WHERE projectId = ? AND capability_hash = ?')
      .get(projectId, capabilityHash(capability)) as Row | undefined;
    if (!row) fail('session capability required', 403);
    return sessionFromRow(row);
  }

  /* Touching a claim is authorized against the CALLER, because the session that
     created it may be long gone: an agent whose MCP process was recycled, or
     whose chat is resumed hours later, still holds the work in its working tree
     and must be able to finish the claim rather than start again.

     Adoption is keyed on `developer`, which the server sets from the
     authenticated credential and never reads from a request body, and narrowed
     by the worktree so one person's two checkouts stay apart. Worktree alone
     would be a hijack: it is client-declared, not secret, and every member can
     read it out of the project state. */
  authorizeClaimTouch(projectId: string, claimId: string, capability: string | undefined,
    kind: 'patch' | 'complete'): { note: string | null } {
    const claim = this.getClaim(projectId, claimId);
    const alive = this.db.prepare('SELECT id FROM sessions WHERE projectId = ? AND id = ?')
      .get(projectId, claim.sessionId) as Row | undefined;
    if (alive) {
      this.assertSessionCapability(projectId, claim.sessionId, capability);
      return { note: this.resumeClaim(projectId, claim, kind) };
    }

    const caller = this.sessionByCapability(projectId, capability);
    this.assertSessionCapability(projectId, caller.id, capability);
    if (!claim.worktree || !caller.worktree
      || claim.worktree !== caller.worktree || claim.developer !== caller.developer) {
      fail(`claim ${claimId} belongs to ${claim.agent} and cannot be taken over from this session. `
        + 'Publish your own with mediation_claim {intent, files}', 403);
    }
    this.db.prepare('UPDATE claims SET sessionId = ?, agent = ? WHERE id = ?')
      .run(caller.id, caller.agent, claim.id);
    claim.sessionId = caller.id;
    claim.agent = caller.agent;
    const resumed = this.resumeClaim(projectId, claim, kind);
    const adopted = 'Your previous session had ended; this claim is attached to your current one.';
    return { note: resumed ? `${adopted} ${resumed}` : adopted };
  }

  /* What to do about the status the claim was found in. A tombstoned claim is
     revived rather than refused: the work is real and still on disk, and an
     agent told only "claim not found" stops coordinating for the whole task. */
  private resumeClaim(projectId: string, claim: Claim, kind: 'patch' | 'complete'): string | null {
    const when = agoText(claim.completedAt ?? claim.updatedAt);
    if (claim.status === 'done' || claim.status === 'abandoned') {
      if (kind === 'patch') {
        fail(`this claim was ${claim.status} ${when} ago and cannot be reopened. `
          + 'Create a new claim with mediation_claim {intent, files} for the follow-up work', 409);
      }
      return `Heads up: it was already completed ${when} ago, so this only added to that record.`;
    }
    const was = claim.status;
    if (was !== 'expired' && was !== 'released') return null;
    // Revived to in-progress; an explicit status in the same call overrides it.
    this.db.prepare('UPDATE claims SET status = ?, updatedAt = ? WHERE id = ?')
      .run('in-progress', Date.now(), claim.id);
    claim.status = 'in-progress';
    this.emit(projectId, 'claim', `${claim.agent} resumed: ${claim.intent}`, claim.agent,
      { claimId: claim.id, files: claim.files, sessionId: claim.sessionId });
    return was === 'released'
      ? `It had been released ${when} ago when project access changed; it is live again.`
      : `It had expired ${when} ago after that long without an update; it is live again.`;
  }

  heartbeat(projectId: string, sessionId: string, input: Heartbeat): Session {
    const session = this.requireSession(projectId, sessionId);
    session.lastSeenAt = Date.now();
    this.touchSession(sessionId);
    // The beat is the only thing that fires while an agent codes without calling
    // tools, so it is the right carrier for what the working tree actually says.
    if (input.dirtyFiles) {
      session.repo = this.reportRepoState(projectId, sessionId, {
        branch: input.branch ?? null, revision: input.revision ?? null, dirtyFiles: input.dirtyFiles,
      });
    }
    if (input.activity) this.emit(projectId, 'activity', `${session.agent}: ${input.activity}`, session.agent);
    return session;
  }

  endSession(projectId: string, sessionId: string, reason = 'ended by agent'): { ok: true } {
    const session = this.requireSession(projectId, sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    this.orphanClaims(projectId, sessionId, reason);
    this.emit(projectId, 'session', `${session.agent} disconnected (${reason})`, session.agent);
    return { ok: true };
  }

  private sessionClaims(projectId: string, sessionId: string): Claim[] {
    return (this.db.prepare(
      `SELECT * FROM claims WHERE projectId = ? AND sessionId = ? AND status NOT IN (${TERMINAL_SQL})`)
      .all(projectId, sessionId) as Row[]).map(claimFromRow);
  }

  /* A session dying is a TRANSPORT event, not the end of the work. The MCP
     client is a child process the harness recycles freely, and deleting its
     claims on stdin close threw away the coordination record of work still
     sitting in the working tree: the dashboard then showed a live agent
     claiming nothing, and the overlap engine covered none of its files, because
     dirty-file widening only ever widens a CLAIM. The claim now stands until it
     expires on its own, and `authorizeClaimTouch` hands it back to the agent
     when it returns.

     Waiters are still let go: the agent that vanished mid-block may never come
     back, and that permanent wait is the exact failure `blockedOn` prevents. */
  private orphanClaims(projectId: string, sessionId: string, reason: string): void {
    for (const claim of this.sessionClaims(projectId, sessionId)) {
      this.emit(projectId, 'claim', `${claim.agent} left "${claim.intent}" unattended (${reason})`, claim.agent,
        { claimId: claim.id, files: claim.files, sessionId });
      this.releaseBlockedOn(projectId, claim, `unattended (${reason})`);
    }
  }

  /* Forced release, for access that was revoked rather than a process that
     died: the claim must stop warning people, but the row is kept as a
     tombstone so its agent is told what happened instead of "claim not found". */
  private releaseClaims(projectId: string, sessionId: string, reason: string): void {
    for (const claim of this.sessionClaims(projectId, sessionId)) {
      claim.status = 'released';
      claim.updatedAt = Date.now();
      this.saveClaim(claim);
      this.emit(projectId, 'claim', `claim "${claim.intent}" released (${reason})`, claim.agent,
        { claimId: claim.id, files: claim.files, sessionId });
      this.releaseBlockedOn(projectId, claim, `gone (${reason})`);
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
      this.emit(session.projectId, 'session', `${session.agent} disconnected (${reason})`, session.agent);
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
      this.emit(session.projectId, 'session', `${session.agent} disconnected (${reason})`, session.agent);
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
      blockedOn: input.blockedOn ?? null,
      findings: [],
      commits: [],
      prs: [],
      summary: null,
      worktree: session.worktree,
      createdAt: t,
      updatedAt: t,
      completedAt: null,
    };
    // Warnings, not locks: conflicts are computed before insert and returned
    // alongside the claim; the claim is always created.
    const conflicts = checkOverlap(this.effectiveClaims(projectId), {
      sessionId: session.id,
      files: claim.files,
      components: claim.components,
      task: claim.task,
      intent: claim.intent,
      worktree: claim.worktree,
    });
    this.db.prepare(`INSERT INTO claims (id, projectId, sessionId, agent, developer, intent, task,
        files, components, branch, baseRevision, status, blockedOn, findings, commits, prs, summary,
        worktree, createdAt, updatedAt, completedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(claim.id, projectId, claim.sessionId, claim.agent, claim.developer, claim.intent,
        claim.task, JSON.stringify(claim.files), JSON.stringify(claim.components), claim.branch,
        claim.baseRevision, claim.status, claim.blockedOn, '[]', '[]', '[]', null, claim.worktree, t, t, null);
    this.emit(projectId, 'claim', `${session.agent} claimed: ${claim.intent}`, session.agent,
      { claimId: claim.id, files: claim.files, sessionId: session.id });
    if (claim.blockedOn) this.emitBlocked(projectId, claim);
    return { claim, conflicts };
  }

  /* A blocked claim is only useful if the claim it waits on hears about it. The
     event is scoped to the BLOCKER's id, so delivery reaches that agent on its
     next call without anyone having to poll. */
  private emitBlocked(projectId: string, claim: Claim): void {
    const blocker = this.db.prepare('SELECT intent FROM claims WHERE projectId = ? AND id = ?')
      .get(projectId, claim.blockedOn) as Row | undefined;
    if (!blocker) return;
    this.emit(projectId, 'claim',
      `${NEWS_BLOCKED_PREFIX} ${claim.agent} is waiting on your "${blocker.intent as string}" to do: ${claim.intent}`,
      claim.agent, { claimId: claim.blockedOn, files: claim.files, sessionId: claim.sessionId });
  }

  updateClaim(projectId: string, claimId: string, patch: ClaimPatch): Claim {
    const claim = this.getClaim(projectId, claimId);
    this.touchSession(claim.sessionId);
    if (patch.intent != null) claim.intent = patch.intent;
    if (patch.task !== undefined) claim.task = patch.task ?? null;
    if (patch.branch !== undefined) claim.branch = patch.branch ?? null;
    if (patch.baseRevision !== undefined) claim.baseRevision = patch.baseRevision ?? null;
    if (patch.status) claim.status = patch.status;
    if (patch.blockedOn !== undefined) claim.blockedOn = patch.blockedOn ?? null;
    if (patch.files) claim.files = patch.files.map(normalizePath);
    if (patch.components) claim.components = patch.components;
    // A finding scoped to its own files routes to the people it is about; with
    // no files of its own it falls back to the claim's, which is coarse but
    // still better than routing nowhere.
    const finding: Finding | null = patch.finding
      ? {
        text: patch.finding,
        at: Date.now(),
        files: (patch.findingFiles ?? claim.files).map(normalizePath),
        kind: patch.findingKind ?? null,
      }
      : null;
    if (finding) claim.findings.push(finding);
    claim.updatedAt = Date.now();
    this.saveClaim(claim);
    if (finding) {
      this.emit(projectId, 'finding',
        `${claim.agent} found${finding.kind ? ` (${finding.kind})` : ''}: ${finding.text}`, claim.agent,
        { claimId: claim.id, files: finding.files, sessionId: claim.sessionId });
    }
    if (patch.status) {
      this.emit(projectId, 'claim', `${claim.agent} → ${patch.status}: ${claim.intent}`, claim.agent,
        { claimId: claim.id, files: claim.files, sessionId: claim.sessionId });
    }
    if (patch.blockedOn) this.emitBlocked(projectId, claim);
    return claim;
  }

  completeClaim(projectId: string, claimId: string, input: ClaimComplete): Claim {
    const claim = this.getClaim(projectId, claimId);
    /* A resumed agent replaying its last step must not enter the history twice.
       Merging is the honest answer: it keeps the commits of both calls and the
       moment the work actually landed, and emits nothing new. */
    if (claim.status === 'done' && input.status === 'done') {
      claim.commits = [...new Set([...claim.commits, ...input.commits])];
      claim.prs = [...new Set([...claim.prs, ...input.prs])];
      claim.summary = input.summary ?? claim.summary;
      claim.updatedAt = Date.now();
      this.saveClaim(claim);
      return claim;
    }
    claim.status = input.status;
    claim.commits = input.commits;
    claim.prs = input.prs;
    claim.summary = input.summary ?? null;
    claim.completedAt = Date.now();
    claim.updatedAt = claim.completedAt;
    claim.blockedOn = null;
    this.saveClaim(claim); // row is kept: completed claims survive as history
    if (input.status === 'abandoned') {
      // Deliberately NOT a `completed` event: nothing was delivered, so it does
      // not belong in the history feed. It still clears the claim, which is the
      // point: an agent that backs off a conflict must be able to withdraw
      // instead of leaving a phantom warning behind for 45 minutes.
      this.emit(projectId, 'claim', `${claim.agent} abandoned: ${claim.intent}`, claim.agent,
        { claimId: claim.id, files: claim.files, sessionId: claim.sessionId });
    } else {
      this.emit(projectId, 'completed',
        `${claim.agent} completed: ${claim.intent}${input.commits.length ? ` (${input.commits.join(', ')})` : ''}`
          + `${claim.summary ? `. ${claim.summary}` : ''}`,
        claim.agent, { claimId: claim.id, files: claim.files, sessionId: claim.sessionId });
    }
    this.releaseBlockedOn(projectId, claim);
    return claim;
  }

  /* Whoever was waiting on this claim needs to hear that it cleared. Without
     this the classic failure stands: B waits on A's refactor, A finishes, and B
     never finds out. Delivery is lazy like everything else, so B learns at its
     next contact, not the instant it happens. */
  private releaseBlockedOn(projectId: string, claim: Claim, disposition: string = claim.status): void {
    const waiting = (this.db.prepare(
      `SELECT * FROM claims WHERE projectId = ? AND blockedOn = ? AND status NOT IN (${TERMINAL_SQL})`)
      .all(projectId, claim.id) as Row[]).map(claimFromRow);
    for (const w of waiting) {
      /* Clearing the field is not bookkeeping, it is the state change: the wait
         is genuinely over. It also keeps the waiter from being told twice, once
         because the blocker completed and once because it was unblocked. */
      w.blockedOn = null;
      w.updatedAt = Date.now();
      this.saveClaim(w);
      this.emit(projectId, 'claim',
        `${NEWS_UNBLOCKED_PREFIX} "${claim.intent}" (${claim.agent}) is ${disposition}; your "${w.intent}" was waiting on it`,
        claim.agent, { claimId: w.id, files: w.files, sessionId: claim.sessionId });
    }
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
      issueUrl: input.issueUrl ?? null,
    };
    this.db.prepare(`INSERT INTO bugs (id, projectId, sessionId, reporter, title, description, files, severity, status, createdAt, issue_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(bug.id, projectId, bug.sessionId, bug.reporter, bug.title, bug.description,
        JSON.stringify(bug.files), bug.severity, bug.status, bug.createdAt, bug.issueUrl);
    this.emit(projectId, 'bug', `${session.agent} reported ${bug.severity} bug: ${bug.title}`, session.agent,
      { files: bug.files, sessionId: session.id });
    return bug;
  }

  updateBug(projectId: string, bugId: string, patch: BugPatch): Bug {
    const row = this.db.prepare('SELECT * FROM bugs WHERE projectId = ? AND id = ?')
      .get(projectId, bugId) as Row | undefined;
    if (!row) notFound('bug not found');
    const bug = bugFromRow(row);
    if (patch.status) bug.status = patch.status;
    if (patch.severity) bug.severity = patch.severity;
    if (patch.issueUrl) bug.issueUrl = patch.issueUrl;
    this.db.prepare('UPDATE bugs SET status = ?, severity = ?, issue_url = ? WHERE id = ?')
      .run(bug.status, bug.severity, bug.issueUrl, bug.id);
    return bug;
  }

  // ---- projects + membership (see docs/auth.md) ----

  projectExists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) !== undefined;
  }

  memberRole(projectId: string, userId: string | null, { fresh = true } = {}): MemberRole | null {
    if (!userId) return null;
    const freshOnly = `AND (authorization_source IS NULL OR authorization_source != 'github-app'
        OR authorization_expires_at IS NULL OR authorization_expires_at > ?)`;
    const row = this.db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?
      ${fresh ? freshOnly : ''}`)
      .get(...(fresh ? [projectId, userId, Date.now()] : [projectId, userId])) as Row | undefined;
    return row ? (row.role as MemberRole) : null;
  }

  /* Membership and *freshness* are different questions. The row itself is the
     membership: it survives until GitHub says otherwise (a revocation webhook
     deletes it) or an owner removes it. `authorization_expires_at` only says
     how recently GitHub confirmed the permission, and gates AGENTS, since every
     agent session re-verifies against GitHub anyway. Humans reading their own
     dashboard must not lose their projects five minutes after the last agent
     disconnected, so they pass `fresh: false`. */
  githubMemberRole(projectId: string, userId: string | null, { fresh = true } = {}): MemberRole | null {
    if (!userId) return null;
    const row = this.db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?
      AND authorization_source = 'github-app'${fresh ? ' AND authorization_expires_at > ?' : ''}`)
      .get(...(fresh ? [projectId, userId, Date.now()] : [projectId, userId])) as Row | undefined;
    return row ? row.role as MemberRole : null;
  }

  memberProjectIds(userId: string | null, { fresh = true } = {}): string[] {
    if (!userId) return [];
    const freshOnly = `AND (authorization_source IS NULL OR authorization_source != 'github-app'
        OR authorization_expires_at IS NULL OR authorization_expires_at > ?)`;
    return (this.db.prepare(`SELECT project_id FROM project_members WHERE user_id = ?
      ${fresh ? freshOnly : ''} ORDER BY project_id`)
      .all(...(fresh ? [userId, Date.now()] : [userId])) as Row[]).map((r) => r.project_id as string);
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
    return { id, username, displayName: identity.login,
      avatarUrl: `https://avatars.githubusercontent.com/u/${identity.githubUserId}?v=4`,
      role: bootstrap ? 'admin' : 'user', status: bootstrap ? 'active' : 'pending', createdAt: t };
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
    const user = this.db.prepare('SELECT username, github_login, github_user_id FROM users WHERE id = ? AND status = ?').get(userId, 'active') as Row | undefined;
    if (!user) notFound('user not found');
    const existing = this.db.prepare(`SELECT authorization_source, role, created_at FROM project_members
      WHERE project_id = ? AND user_id = ?`).get(projectId, userId) as Row | undefined;
    if (existing && existing.authorization_source !== 'github-app') {
      return { userId, username: user.username as string, displayName: displayName(user),
        avatarUrl: avatarUrl(user), role: existing.role as MemberRole,
        createdAt: Number(existing.created_at), authorizationSource: 'manual' };
    }
    const t = Date.now();
    this.db.prepare(`INSERT INTO project_members (project_id, user_id, role, created_at, authorization_source,
      repository_permission, authorization_expires_at) VALUES (?, ?, ?, ?, 'github-app', ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, authorization_source = 'github-app',
      repository_permission = excluded.repository_permission, authorization_expires_at = excluded.authorization_expires_at`)
      .run(projectId, userId, role, t, permission, expiresAt);
    return { userId, username: user.username as string, displayName: displayName(user),
      avatarUrl: avatarUrl(user), role, createdAt: t, authorizationSource: 'github-app',
      repositoryPermission: permission, authorizationExpiresAt: expiresAt };
  }

  // Auto-creation path for agents: first session on an unknown id creates it
  // with the acting user as owner. Never validates the slug, because the id already
  // came from a client that may predate the rule.
  ensureProject(id: string, userId: string | null): void {
    if (this.projectExists(id)) return;
    const t = Date.now();
    this.db.prepare('INSERT INTO projects (id, created_by, created_at) VALUES (?, ?, ?)').run(id, userId, t);
    if (userId) this.addMemberRow(id, userId, 'owner', t);
  }

  listMembers(projectId: string): ProjectMember[] {
    return (this.db.prepare(`SELECT m.user_id, m.role, m.created_at, m.authorization_source,
      m.repository_permission, m.authorization_expires_at, u.username, u.github_login, u.github_user_id
      FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ? ORDER BY m.role, u.username`).all(projectId) as Row[]).map((r) => ({
        userId: r.user_id as string,
        username: r.username as string,
        displayName: displayName(r),
        avatarUrl: avatarUrl(r),
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
    const user = this.db.prepare(`SELECT id, username, github_login, github_user_id FROM users
      WHERE (username = ? OR LOWER(github_login) = LOWER(?)) AND status = 'active'`)
      .get(username, rawUsername.trim()) as Row | undefined;
    if (!user) notFound('user not found'); // only active users can be added
    if (this.memberRole(projectId, user.id as string)) fail('user is already a member', 409);
    const t = Date.now();
    this.addMemberRow(projectId, user.id as string, role, t);
    return { userId: user.id as string, username: user.username as string,
      displayName: displayName(user), avatarUrl: avatarUrl(user), role, createdAt: t };
  }

  // The last remaining owner may not be demoted or removed, the same shape as the
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
    const row = this.db.prepare('SELECT username, github_login, github_user_id FROM users WHERE id = ?').get(userId) as Row | undefined;
    const username = (row?.username as string) ?? userId;
    return { userId, username, displayName: row ? displayName(row) : username,
      avatarUrl: row ? avatarUrl(row) : null, role, createdAt: Date.now() };
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
    // token values are never returned; a credential is only ever shown by id
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
    return { user: { id, username, displayName: username, avatarUrl: null, role, status, createdAt: t }, bootstrap };
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
    // Whole row on purpose: publicUser() needs github_login and github_user_id
    // for the display name and avatar. It never returns password_hash.
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map(publicUser);
  }

  // The last user that is role=admin AND status=active may not be demoted,
  // disabled, or deleted, self-targeting included.
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
    // The worktree comes from the session, never from the caller: it decides
    // which claims are suppressed, so a client must not be able to assert one.
    const row = scope.sessionId
      ? this.db.prepare('SELECT worktree FROM sessions WHERE projectId = ? AND id = ?')
        .get(projectId, scope.sessionId) as Row | undefined
      : undefined;
    return checkOverlap(this.effectiveClaims(projectId), { ...scope, worktree: (row?.worktree as string) ?? null });
  }

  /* Piggyback delivery. Every tool response is already a text payload going back
     to an agent, so news relevant to THAT agent rides along on whatever call it
     was making anyway: no extra round trip, no poll, and nothing to interrupt.
     MCP cannot push into a model's context, so this is lazy by nature; an agent
     hears at its next contact, never sooner.

     Relevance is the overlap engine reused as a routing table. An event reaches
     a session only when it touches that session's files, or concerns a claim in
     its blocked/blocking chain. Without that filter this degenerates into
     broadcast spam and agents learn to skip the whole block. */
  newsFor(projectId: string, sessionId: string, limit = NEWS_LIMIT): NewsItem[] {
    const row = this.db.prepare('SELECT news_cursor, repo, worktree FROM sessions WHERE projectId = ? AND id = ?')
      .get(projectId, sessionId) as Row | undefined;
    if (!row) return [];

    const mine = this.activeClaims(projectId).filter((c) => c.sessionId === sessionId);
    const repo = row.repo ? (JSON.parse(row.repo as string) as RepoState) : null;
    const scope = [...new Set([
      ...mine.flatMap((c) => c.files),
      ...(repo?.dirtyFiles ?? []).map(normalizePath),
    ])];
    const myClaimIds = new Set(mine.map((c) => c.id));
    const blockers = new Set(mine.map((c) => c.blockedOn).filter(Boolean) as string[]);
    if (!scope.length && !myClaimIds.size) return [];

    /* A fresh session has no cursor, and sessions are swept, so a restarted
       harness always looks fresh. Bounding the catch-up by time rather than
       replaying the feed keeps that duplicate small and stale news out. */
    const cursor = row.news_cursor == null ? 0 : Number(row.news_cursor);
    const since = Date.now() - NEWS_WINDOW_MS;
    const candidates = (this.db.prepare(`SELECT rowid, * FROM events
      WHERE projectId = ? AND rowid > ? AND at >= ? AND (sessionId IS NULL OR sessionId != ?)
      ORDER BY rowid DESC LIMIT 200`)
      .all(projectId, cursor, since, sessionId) as Row[]).map(eventFromRow);

    const news: NewsItem[] = [];
    let highest = cursor;
    for (const e of candidates) {
      highest = Math.max(highest, e.seq);
      if (news.length >= limit) continue; // still advance the cursor past what we skip
      const reason: NewsItem['reason'] | null =
        e.message.startsWith(NEWS_BLOCKED_PREFIX) && e.claimId && myClaimIds.has(e.claimId) ? 'waiting-on-you'
        : e.message.startsWith(NEWS_UNBLOCKED_PREFIX) && e.claimId && myClaimIds.has(e.claimId) ? 'unblocked'
        : e.claimId && blockers.has(e.claimId) ? 'blocker'
        : e.claimId && myClaimIds.has(e.claimId) ? 'overlap'
        : e.files.length && filesOverlap(scope, e.files) ? 'overlap'
        : null;
      if (!reason) continue;
      news.push({ seq: e.seq, type: e.type, message: e.message, at: e.at, agent: e.agent, reason });
    }
    // The cursor advances past everything considered, delivered or not: news the
    // filter rejected once will not become relevant on a later pass.
    if (highest > cursor) {
      this.db.prepare('UPDATE sessions SET news_cursor = ? WHERE id = ?').run(highest, sessionId);
    }
    return news.reverse(); // oldest first: the block reads as a short timeline
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
      // Widened by dirty files like every other overlap check, so the dashboard
      // and the agents agree on what counts as a collision.
      conflicts: pairConflicts(this.effectiveClaims(projectId)),
      recentFiles,
      events,
    };
  }

  // Scoped to what the actor may see: their memberships, or everything for an
  // instance admin (rows they are not a member of come back with role: null).
  listProjects(userId: string | null, isAdmin: boolean, { fresh = true } = {}): ProjectSummary[] {
    this.sweep();
    const ids = isAdmin
      ? (this.db.prepare('SELECT id FROM projects ORDER BY id').all() as Row[]).map((r) => r.id as string)
      : this.memberProjectIds(userId, { fresh });
    const idleBefore = Date.now() - PROJECT_IDLE_HIDE_MS;
    return ids.map((id) => {
      const project = this.db.prepare('SELECT full_name, created_at FROM projects WHERE id = ?').get(id) as Row | undefined;
      const sessions = (this.db.prepare('SELECT agent FROM sessions WHERE projectId = ?').all(id) as Row[]);
      const claims = this.effectiveClaims(id);
      const openBugs = this.db.prepare("SELECT COUNT(*) AS n FROM bugs WHERE projectId = ? AND status != 'fixed'")
        .get(id) as Row;
      const lastEvent = this.db.prepare('SELECT MAX(at) AS at FROM events WHERE projectId = ?').get(id) as Row;
      return {
        id,
        // GitHub projects carry an opaque uuid id; humans know them by repository.
        name: (project?.full_name as string) || id,
        role: this.memberRole(id, userId, { fresh }),
        sessions: sessions.length,
        claims: claims.length,
        openBugs: Number(openBugs.n),
        conflicts: pairConflicts(claims).length,
        agents: [...new Set(sessions.map((r) => r.agent as string))],
        lastActivityAt: lastEvent.at == null ? null : Number(lastEvent.at),
        // A project with no events yet counts as used since it was created.
        lastUsedAt: lastEvent.at == null ? Number(project?.created_at ?? 0) : Number(lastEvent.at),
      };
    }).filter((p) => p.sessions > 0 || p.lastUsedAt >= idleBefore);
  }

  // ---- expiry ----

  sweep(): void {
    const t = Date.now();
    const stale = (this.db.prepare('SELECT * FROM sessions WHERE lastSeenAt < ?')
      .all(t - this.sessionTtlMs) as Row[]).map(sessionFromRow);
    for (const s of stale) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
      this.emit(s.projectId, 'session', `${s.agent} session expired (no heartbeat)`, s.agent);
      this.orphanClaims(s.projectId, s.id, 'session expired');
    }
    const idle = (this.db.prepare(`SELECT * FROM claims WHERE status NOT IN (${TERMINAL_SQL}) AND updatedAt < ?`)
      .all(t - this.claimIdleTtlMs) as Row[]).map(claimFromRow);
    for (const c of idle) {
      // Tombstoned, not deleted. `updatedAt` is only bumped by claim writes, so
      // this also fires on a live agent that has been heads-down for the whole
      // TTL; that agent's next call must get its claim back, not a 404.
      c.status = 'expired';
      c.updatedAt = t;
      this.saveClaim(c);
      this.emit(c.projectId, 'claim', `claim "${c.intent}" expired (idle)`, c.agent,
        { claimId: c.id, files: c.files, sessionId: c.sessionId });
      this.releaseBlockedOn(c.projectId, c, 'gone (expired idle)');
    }
  }

  close(): void {
    this.db.close();
  }
}
