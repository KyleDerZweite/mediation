// In-memory coordination store with JSON-file persistence.
// Holds sessions, work claims, repo state, and bug reports per project.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SESSION_TTL_MS = 120_000; // sessions die without heartbeat
export const DEFAULT_CLAIM_IDLE_TTL_MS = 30 * 60_000; // claims die if never updated

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'be', 'fix', 'bug', 'add', 'update', 'change', 'when',
  'that', 'this', 'it', 'from', 'by', 'at', 'as', 'not', 'no', 'my', 'our',
]);

function now() {
  return Date.now();
}

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function pathsOverlap(a, b) {
  a = normalizePath(a);
  b = normalizePath(b);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

export class Store {
  constructor({ dataDir = null, sessionTtlMs = DEFAULT_SESSION_TTL_MS, claimIdleTtlMs = DEFAULT_CLAIM_IDLE_TTL_MS } = {}) {
    this.dataDir = dataDir;
    this.sessionTtlMs = sessionTtlMs;
    this.claimIdleTtlMs = claimIdleTtlMs;
    this.projects = new Map(); // projectId -> { sessions, claims, bugs, completed, events }
    this._saveTimer = null;
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this._loadAll();
    }
  }

  _project(projectId) {
    if (!this.projects.has(projectId)) {
      this.projects.set(projectId, {
        id: projectId,
        sessions: new Map(),
        claims: new Map(),
        bugs: new Map(),
        completed: [], // completed claims (with attached commits/prs), newest first
        events: [], // activity feed, newest first, capped
      });
    }
    return this.projects.get(projectId);
  }

  _emit(projectId, type, message, meta = {}) {
    const p = this._project(projectId);
    p.events.unshift({ id: randomUUID(), type, message, meta, at: now() });
    if (p.events.length > 200) p.events.length = 200;
    this._scheduleSave();
  }

  // ---- sessions ----

  startSession(projectId, { agent, developer = null, machine = null, task = null } = {}) {
    if (!agent) throw Object.assign(new Error('agent name is required'), { statusCode: 400 });
    const p = this._project(projectId);
    const session = {
      id: randomUUID(),
      projectId,
      agent,
      developer,
      machine,
      task,
      repo: null, // { branch, revision, dirtyFiles[], reportedAt }
      createdAt: now(),
      lastSeenAt: now(),
      status: 'active',
    };
    p.sessions.set(session.id, session);
    this._emit(projectId, 'session', `${agent} connected`, { sessionId: session.id });
    this._scheduleSave();
    return session;
  }

  heartbeat(projectId, sessionId, { status, activity, task } = {}) {
    const session = this._requireSession(projectId, sessionId);
    session.lastSeenAt = now();
    if (status) session.status = status;
    if (task !== undefined) session.task = task;
    if (activity) {
      this._emit(projectId, 'activity', `${session.agent}: ${activity}`, { sessionId });
    }
    this._scheduleSave();
    return session;
  }

  endSession(projectId, sessionId, { reason = 'ended by agent' } = {}) {
    const p = this._project(projectId);
    const session = this._requireSession(projectId, sessionId);
    p.sessions.delete(sessionId);
    // active claims owned by this session expire with it
    for (const claim of [...p.claims.values()]) {
      if (claim.sessionId === sessionId && claim.status !== 'done') {
        p.claims.delete(claim.id);
        this._emit(projectId, 'claim', `claim "${claim.intent}" released (${reason})`, { claimId: claim.id });
      }
    }
    this._emit(projectId, 'session', `${session.agent} disconnected (${reason})`, { sessionId });
    this._scheduleSave();
    return { ok: true };
  }

  reportRepoState(projectId, sessionId, { branch, revision, dirtyFiles = [] } = {}) {
    const session = this._requireSession(projectId, sessionId);
    session.repo = { branch: branch ?? null, revision: revision ?? null, dirtyFiles, reportedAt: now() };
    session.lastSeenAt = now();
    this._scheduleSave();
    return session.repo;
  }

  // ---- claims ----

  createClaim(projectId, sessionId, {
    intent,
    task = null,
    files = [],
    components = [],
    branch = null,
    baseRevision = null,
    status = 'investigating',
    findings = [],
  } = {}) {
    if (!intent) throw Object.assign(new Error('intent is required'), { statusCode: 400 });
    const session = this._requireSession(projectId, sessionId);
    session.lastSeenAt = now();
    const p = this._project(projectId);
    const claim = {
      id: randomUUID(),
      projectId,
      sessionId,
      agent: session.agent,
      developer: session.developer,
      intent,
      task,
      files: files.map(normalizePath),
      components,
      branch,
      baseRevision,
      status, // investigating | in-progress | testing | blocked | done
      findings,
      activity: [],
      commits: [],
      prs: [],
      createdAt: now(),
      updatedAt: now(),
    };
    p.claims.set(claim.id, claim);
    const conflicts = this.checkOverlap(projectId, { sessionId, files, components, task, intent });
    this._emit(projectId, 'claim', `${session.agent} claimed: ${intent}`, { claimId: claim.id });
    this._scheduleSave();
    return { claim, conflicts };
  }

  updateClaim(projectId, claimId, patch = {}) {
    const p = this._project(projectId);
    const claim = p.claims.get(claimId);
    if (!claim) throw Object.assign(new Error('claim not found'), { statusCode: 404 });
    const session = p.sessions.get(claim.sessionId);
    if (session) session.lastSeenAt = now();
    const fields = ['intent', 'task', 'branch', 'baseRevision', 'status'];
    for (const f of fields) {
      if (patch[f] !== undefined) claim[f] = patch[f];
    }
    if (patch.files) claim.files = patch.files.map(normalizePath);
    if (patch.components) claim.components = patch.components;
    if (patch.finding) claim.findings.push({ text: patch.finding, at: now() });
    if (patch.activity) claim.activity.push({ text: patch.activity, at: now() });
    claim.updatedAt = now();
    if (patch.finding) {
      this._emit(projectId, 'finding', `${claim.agent} found: ${patch.finding}`, { claimId });
    }
    if (patch.status && patch.status !== 'done') {
      this._emit(projectId, 'claim', `${claim.agent} → ${patch.status}: ${claim.intent}`, { claimId });
    }
    this._scheduleSave();
    return claim;
  }

  completeClaim(projectId, claimId, { commits = [], prs = [], summary = null } = {}) {
    const p = this._project(projectId);
    const claim = p.claims.get(claimId);
    if (!claim) throw Object.assign(new Error('claim not found'), { statusCode: 404 });
    claim.status = 'done';
    claim.commits = commits;
    claim.prs = prs;
    claim.summary = summary;
    claim.completedAt = now();
    claim.updatedAt = now();
    p.claims.delete(claimId);
    p.completed.unshift(claim);
    if (p.completed.length > 100) p.completed.length = 100;
    this._emit(
      projectId,
      'completed',
      `${claim.agent} completed: ${claim.intent}${commits.length ? ` (${commits.join(', ')})` : ''}`,
      { claimId }
    );
    this._scheduleSave();
    return claim;
  }

  // ---- bugs ----

  reportBug(projectId, sessionId, { title, description = null, files = [], severity = 'unknown' } = {}) {
    if (!title) throw Object.assign(new Error('title is required'), { statusCode: 400 });
    const session = this._requireSession(projectId, sessionId);
    session.lastSeenAt = now();
    const p = this._project(projectId);
    const bug = {
      id: randomUUID(),
      projectId,
      sessionId,
      reporter: session.agent,
      title,
      description,
      files: files.map(normalizePath),
      severity,
      status: 'open', // open | claimed | fixed
      claimId: null,
      createdAt: now(),
    };
    p.bugs.set(bug.id, bug);
    this._emit(projectId, 'bug', `${session.agent} reported bug: ${title}`, { bugId: bug.id });
    this._scheduleSave();
    return bug;
  }

  updateBug(projectId, bugId, patch = {}) {
    const p = this._project(projectId);
    const bug = p.bugs.get(bugId);
    if (!bug) throw Object.assign(new Error('bug not found'), { statusCode: 404 });
    if (patch.status) bug.status = patch.status;
    if (patch.claimId !== undefined) bug.claimId = patch.claimId;
    if (patch.severity) bug.severity = patch.severity;
    this._scheduleSave();
    return bug;
  }

  // ---- queries ----

  checkOverlap(projectId, { sessionId = null, files = [], components = [], task = null, intent = null } = {}) {
    const p = this._project(projectId);
    const warnings = [];
    const myTokens = tokenize(`${task || ''} ${intent || ''}`);
    const myFiles = files.map(normalizePath);
    const myComponents = new Set(components.map((c) => String(c).toLowerCase()));

    for (const claim of p.claims.values()) {
      if (sessionId && claim.sessionId === sessionId) continue;
      const reasons = [];
      const overlappingFiles = [];
      for (const f of myFiles) {
        for (const cf of claim.files) {
          if (pathsOverlap(f, cf)) overlappingFiles.push({ mine: f, theirs: cf });
        }
      }
      if (overlappingFiles.length) reasons.push({ type: 'files', detail: overlappingFiles });

      const sharedComponents = claim.components.filter((c) => myComponents.has(String(c).toLowerCase()));
      if (sharedComponents.length) reasons.push({ type: 'components', detail: sharedComponents });

      const theirTokens = tokenize(`${claim.task || ''} ${claim.intent || ''}`);
      const sharedTokens = [...myTokens].filter((t) => theirTokens.has(t));
      if (sharedTokens.length >= 2) reasons.push({ type: 'task', detail: sharedTokens });

      if (reasons.length) {
        warnings.push({
          claimId: claim.id,
          agent: claim.agent,
          developer: claim.developer,
          intent: claim.intent,
          status: claim.status,
          reasons,
        });
      }
    }
    return warnings;
  }

  getState(projectId) {
    this.sweep();
    const p = this._project(projectId);
    const sessions = [...p.sessions.values()];
    const claims = [...p.claims.values()];
    const bugs = [...p.bugs.values()];

    // conflicts between pairs of active claims
    const conflicts = [];
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i];
        const b = claims[j];
        if (a.sessionId === b.sessionId) continue;
        const w = this.checkOverlap(projectId, {
          sessionId: b.sessionId,
          files: b.files,
          components: b.components,
          task: b.task,
          intent: b.intent,
        }).find((x) => x.claimId === a.id);
        if (w) {
          conflicts.push({
            between: [
              { claimId: a.id, agent: a.agent, intent: a.intent },
              { claimId: b.id, agent: b.agent, intent: b.intent },
            ],
            reasons: w.reasons,
          });
        }
      }
    }

    // recently changed files (from claims' activity + repo dirty files)
    const recentFiles = new Map();
    for (const claim of claims) {
      for (const f of claim.files) {
        const e = recentFiles.get(f) || { file: f, agents: new Set(), updatedAt: 0 };
        e.agents.add(claim.agent);
        e.updatedAt = Math.max(e.updatedAt, claim.updatedAt);
        recentFiles.set(f, e);
      }
    }
    for (const s of sessions) {
      for (const f of s.repo?.dirtyFiles || []) {
        const nf = normalizePath(f);
        const e = recentFiles.get(nf) || { file: nf, agents: new Set(), updatedAt: 0 };
        e.agents.add(s.agent);
        e.updatedAt = Math.max(e.updatedAt, s.repo.reportedAt);
        recentFiles.set(nf, e);
      }
    }

    return {
      project: projectId,
      now: now(),
      sessions,
      claims,
      bugs,
      completed: p.completed.slice(0, 20),
      conflicts,
      recentFiles: [...recentFiles.values()]
        .map((e) => ({ file: e.file, agents: [...e.agents], updatedAt: e.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50),
      events: p.events.slice(0, 50),
    };
  }

  // ---- expiry ----

  sweep() {
    const t = now();
    for (const [projectId, p] of this.projects) {
      for (const [sid, session] of [...p.sessions]) {
        if (t - session.lastSeenAt > this.sessionTtlMs) {
          p.sessions.delete(sid);
          this._emit(projectId, 'session', `${session.agent} session expired (no heartbeat)`, { sessionId: sid });
          for (const claim of [...p.claims.values()]) {
            if (claim.sessionId === sid) {
              p.claims.delete(claim.id);
              this._emit(projectId, 'claim', `claim "${claim.intent}" expired with session`, { claimId: claim.id });
            }
          }
        }
      }
      for (const [cid, claim] of [...p.claims]) {
        if (t - claim.updatedAt > this.claimIdleTtlMs) {
          p.claims.delete(cid);
          this._emit(projectId, 'claim', `claim "${claim.intent}" expired (idle)`, { claimId: cid });
        }
      }
    }
  }

  // ---- helpers ----

  _requireSession(projectId, sessionId) {
    const session = this._project(projectId).sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found or expired'), { statusCode: 404 });
    return session;
  }

  _fileFor(projectId) {
    return path.join(this.dataDir, `${encodeURIComponent(projectId)}.json`);
  }

  _scheduleSave() {
    if (!this.dataDir || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveAll();
    }, 250);
    this._saveTimer.unref?.();
  }

  saveAll() {
    if (!this.dataDir) return;
    for (const [projectId, p] of this.projects) {
      const data = {
        id: projectId,
        sessions: [...p.sessions.values()],
        claims: [...p.claims.values()],
        bugs: [...p.bugs.values()],
        completed: p.completed,
        events: p.events,
      };
      fs.writeFileSync(this._fileFor(projectId), JSON.stringify(data, null, 2));
    }
  }

  _loadAll() {
    for (const file of fs.readdirSync(this.dataDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
        const p = this._project(data.id);
        // stale sessions are not resurrected; claims/bugs/completed survive restarts
        p.bugs = new Map((data.bugs || []).map((b) => [b.id, b]));
        p.completed = data.completed || [];
        p.events = data.events || [];
      } catch {
        // ignore corrupt project files
      }
    }
  }
}
