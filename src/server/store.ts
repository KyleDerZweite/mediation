// SQLite-backed coordination store. Arrays/objects are stored as JSON text
// columns; rows are hydrated back into the core domain types. All domain rules
// (overlap, tokenize, normalizePath) come from src/core/overlap.ts.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkOverlap, normalizePath, pairConflicts } from '../core/overlap.ts';
import type {
  Bug, Claim, ConflictWarning, EventEntry, EventType, ProjectState,
  ProjectSummary, RecentFile, RepoState, Session, WorkScope,
} from '../core/types.ts';
import type {
  BugCreate, BugPatch, ClaimComplete, ClaimCreate, ClaimPatch,
  Heartbeat, RepoReport, SessionCreate,
} from '../core/schemas.ts';

export const DEFAULT_SESSION_TTL_MS = 120_000;
export const DEFAULT_CLAIM_IDLE_TTL_MS = 30 * 60_000;

const EVENTS_CAP = 200;

interface StoreOptions {
  dbPath: string;
  sessionTtlMs?: number;
  claimIdleTtlMs?: number;
}

function notFound(message: string): never {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = 404;
  throw err;
}

type Row = Record<string, unknown>;

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
