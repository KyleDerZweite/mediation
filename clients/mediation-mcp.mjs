#!/usr/bin/env node
// Mediation MCP server: single file, zero dependencies, Node >= 20.
//
// Installed on user machines by install.sh and launched by an agent harness
// (claude-code, codex, kimi) over stdio. Speaks newline-delimited JSON-RPC 2.0
// per the MCP spec and talks HTTP to a Mediation server (env MEDIATION_URL).
// Env MEDIATION_DIR pins the project directory for harnesses that spawn the
// server outside the project.
//
// Project state is secret-free. The one device bearer for this Mediation server
// lives in the OS configuration directory, not in a repository.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER = (process.env.MEDIATION_URL || '').replace(/\/+$/, '');
if (!SERVER) {
  console.error('mediation-mcp: MEDIATION_URL env var is required (set by install.sh)');
  process.exit(1);
}

/* ---------------- per-project state ---------------- */

const STATE_FILE = '.mediation.json';

/* Every state read/write, and every git question, resolves against ONE base
   directory instead of whatever cwd the harness happened to spawn us in. A
   client spawned in /tmp used to write the credential there. Precedence:
   a tool's `directory` argument > $MEDIATION_DIR > the git toplevel of cwd >
   cwd. Sticky per process: one client serves one project. */
let BASE = null; // { dir, repo, explicit }

function setBase(dir, explicit) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`directory does not exist: ${abs}`);
  }
  const top = git(['rev-parse', '--show-toplevel'], abs);
  const resolved = top || abs;
  if (BASE && BASE.dir !== resolved) {
    throw new Error(`this MCP process is already bound to ${BASE.dir}; restart the harness to use ${resolved}`);
  }
  // One MCP process is permanently bound to one repository. This also makes
  // concurrent tool calls unable to switch one another's base directory.
  BASE = BASE || { dir: resolved, repo: !!top, explicit };
  return BASE;
}

function baseDir(directory) {
  if (directory) return setBase(directory, true);
  if (BASE) return BASE;
  return process.env.MEDIATION_DIR
    ? setBase(process.env.MEDIATION_DIR, true)
    : setBase(process.cwd(), false);
}

function configDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
const AUTH_ROOT = process.env.MEDIATION_AUTH_HOME || path.join(configDir(), 'mediation');
const CREDENTIAL_FILE = path.join(AUTH_ROOT, 'credentials.json');
const SERVER_KEY = new URL(SERVER).origin;
function readCredentials() {
  try { return JSON.parse(fs.readFileSync(CREDENTIAL_FILE, 'utf8'))?.[SERVER_KEY] || null; } catch { return null; }
}
function writeCredentials(value) {
  fs.mkdirSync(path.dirname(CREDENTIAL_FILE), { recursive: true, mode: 0o700 });
  let all = {};
  if (fs.existsSync(CREDENTIAL_FILE)) {
    try { all = JSON.parse(fs.readFileSync(CREDENTIAL_FILE, 'utf8')); }
    catch { throw new Error(`global credential file is malformed; refusing to overwrite ${CREDENTIAL_FILE}`); }
    if (!all || Array.isArray(all) || typeof all !== 'object') {
      throw new Error(`global credential file is invalid; refusing to overwrite ${CREDENTIAL_FILE}`);
    }
  }
  all[SERVER_KEY] = value;
  const tmp = `${CREDENTIAL_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  if (process.platform === 'win32' && fs.existsSync(CREDENTIAL_FILE)) {
    const backup = `${tmp}.bak`;
    fs.renameSync(CREDENTIAL_FILE, backup);
    try {
      fs.renameSync(tmp, CREDENTIAL_FILE);
      fs.rmSync(backup, { force: true });
    } catch (error) {
      try { fs.renameSync(backup, CREDENTIAL_FILE); } catch {}
      throw error;
    }
  } else {
    fs.renameSync(tmp, CREDENTIAL_FILE);
  }
  try { fs.chmodSync(CREDENTIAL_FILE, 0o600); } catch {}
  return CREDENTIAL_FILE;
}

function readState() {
  const p = path.join(baseDir().dir, STATE_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return { path: p, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return null;
  }
}

function stateMatchesServer(state) {
  if (!state?.server) return true; // grandfathered pre-Alpha mapping
  try { return new URL(state.server).origin === SERVER_KEY; } catch { return false; }
}

function writeState(data) {
  const p = path.join(baseDir().dir, STATE_FILE);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return p;
}

/* ---------------- git-derived project id ----------------
   The project id identifies a REPO, not a directory: it comes from the git
   remote so every clone of the same repo lands in the same Mediation project.
   Directory names are never used, because they are stale, renamed, or generic.
   (The CLI has a copy of push-remote resolution in src/cli/mediation-agent.ts; this
   file must stay standalone, so the duplication is deliberate.) */

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd: cwd || baseDir().dir,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch {
    return null; // no git, not a repo, or too slow; caller falls back
  }
}

/* GitHub issues are a NICE-TO-HAVE built on whatever `gh` the developer already
   has. Every call here may fail (no gh, not signed in, issues disabled on the
   repository, offline) and every failure is silent: Mediation is the source of
   truth and filing a bug must never depend on GitHub being reachable. */
function gh(args, { timeout = 15_000 } = {}) {
  try {
    return execFileSync('gh', args, {
      cwd: baseDir().dir,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout,
    }).trim();
  } catch {
    return null;
  }
}

/* Only work worth tracking in public earns an issue. Agents are told to file
   bugs liberally, "even small ones", which is right for a coordination feed and
   wrong for a repository's issue list: promote everything and the tracker fills
   with drive-by observations until nobody reads it. Low, medium and the
   `unknown` default stay in Mediation, where cheap and chatty is the point. */
const ISSUE_WORTHY = new Set(['high', 'critical']);

let ghReady = null; // null = not asked yet; sticky for the life of the process
function ghAuthenticated() {
  // `gh auth token` answers from local config without a network round trip.
  // Its output is a secret, so only the exit status is ever used.
  if (ghReady === null) ghReady = gh(['auth', 'token'], { timeout: 5_000 }) !== null;
  return ghReady;
}

function repoSlug() {
  const r = readState()?.repository;
  return r?.owner && r?.repository ? `${r.owner}/${r.repository}` : null;
}

function parseGitHubRemote(raw) {
  const value = String(raw || '').trim();
  let owner;
  let repo;
  const scp = /^(?:[^@]+@)?github\.com:([^/]+)\/(.+)$/i.exec(value);
  if (scp) {
    [, owner, repo] = scp;
  } else {
    try {
      const u = new URL(value);
      if (u.hostname.toLowerCase() !== 'github.com') return null;
      const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length !== 2) return null;
      [owner, repo] = parts;
    } catch {
      return null;
    }
  }
  repo = repo.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

// Compatibility only for AUTH_MODE=manual, whose existing server routes still
// require a path id. GitHub App mode never persists or exposes this value.
function manualProject(owner, repository) {
  const raw = `gh-${owner.toLowerCase()}--${repository.toLowerCase()}`;
  if (raw.length <= 64) return raw;
  const hash = createHash('sha256').update(`${owner}/${repository}`.toLowerCase()).digest('hex').slice(0, 10);
  return `${raw.slice(0, 53).replace(/[._-]+$/g, '')}-${hash}`;
}

// Follow Git's push-remote precedence and identify the actual fork/upstream
// this checkout pushes to. Never guesses from the directory name or fetch URL.
function derivedProject() {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const remote = (branch && git(['config', '--get', `branch.${branch}.pushRemote`]))
    || git(['config', '--get', 'remote.pushDefault'])
    || (branch && git(['config', '--get', `branch.${branch}.remote`]))
    || 'origin';
  if (remote === '.') return { error: 'the Git push remote is the local repository, not GitHub' };
  const pushUrls = (git(['config', '--get-all', `remote.${remote}.pushurl`])
    || git(['config', '--get-all', `remote.${remote}.url`]) || '')
    .split('\n').map((x) => x.trim()).filter(Boolean);
  const urls = [...new Set(pushUrls)];
  if (!urls.length) return { error: `Git remote "${remote}" has no push URL` };
  if (urls.length > 1) return { error: `Git remote "${remote}" has multiple distinct push URLs; choose one for Alpha` };
  const repository = parseGitHubRemote(urls[0]);
  if (!repository) return { error: `Git push remote "${remote}" is not a supported github.com repository` };
  return {
    source: `derived from Git push remote ${remote}: github.com/${repository.owner}/${repository.repo}`,
    repository: { owner: repository.owner, repository: repository.repo },
  };
}

/* Identifies the CHECKOUT, not the machine: two harnesses started in one
   directory share a working tree, so their dirty files are identical by
   construction and the server must not read that as a collision. Hashed because
   equality is the only thing anyone needs, and a local path is nobody's
   business on a shared server. */
function worktreeId() {
  return createHash('sha256').update(`${os.hostname()} ${baseDir().dir}`).digest('base64url').slice(0, 22);
}

/* What the working tree ACTUALLY has open, which is the one honest answer to
   "which files is this agent touching". Agents predict their own file lists
   badly and often leave them empty; git does not guess. Capped because a
   generated-file sweep or a fresh clone can dirty thousands of paths and none
   of that belongs in an overlap check. */
const DIRTY_FILES_CAP = 100;
function dirtyFiles() {
  const out = git(['status', '--porcelain', '--untracked-files=normal']);
  if (out === null) return null; // not a repo, no git, or too slow: report nothing
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    // Renames read `old -> new`; the new path is the one being worked on.
    const file = (raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw).replace(/^"|"$/g, '');
    if (file) files.push(file);
    if (files.length >= DIRTY_FILES_CAP) break;
  }
  return files;
}

function repoReport() {
  const files = dirtyFiles();
  if (files === null) return {};
  return {
    // symbolic-ref, not rev-parse: a repository before its first commit has an
    // unborn branch, which rev-parse cannot name but symbolic-ref reports fine.
    branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']) || null,
    revision: git(['rev-parse', 'HEAD']) || null,
    dirtyFiles: files,
  };
}

/* ---------------- http ---------------- */

let session = null; // { id, capability, project, heartbeat }; never persisted
let sessionPromise = null;
let authMode = null;
// Beat well inside the server's session TTL: an agent that claims work and then
// codes for ten minutes without calling another tool has only these beats
// keeping its claims alive, so several must be able to drop without expiring
// the session. /api/health reports the real TTL; this is the fallback.
let heartbeatMs = 60_000;

// Connection-level failures where the request may never have reached the
// server: typically a pooled keep-alive socket the edge (Cloudflare) already
// closed. undici surfaces these as a bare "fetch failed" TypeError and never
// retries a request with a body, so one immediate retry on a fresh socket is
// ours to do. Worst case is a rare duplicate write, better than a lost one.
const RETRYABLE_CAUSES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

async function api(method, apiPath, body, { auth = true, sessionCapability = session?.capability } = {}) {
  const credential = readCredentials();
  const headers = { 'content-type': 'application/json' };
  if (auth && credential?.token) headers.authorization = `Bearer ${credential.token}`;
  if (sessionCapability) headers['x-mediation-session'] = sessionCapability;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${SERVER}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      const code = error.cause?.code || error.cause?.cause?.code;
      if (attempt === 0 && RETRYABLE_CAUSES.has(code)) continue;
      if (code) error.message = `${error.message} (${code}) on ${method} ${apiPath}`;
      throw error;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `${res.status} on ${apiPath}`);
      err.status = res.status;
      err.hint = data.hint || null; // server-authored instruction for the human
      throw err;
    }
    return data;
  }
}

async function serverAuthMode() {
  if (authMode) return authMode;
  const health = await api('GET', '/api/health', undefined, { auth: false });
  authMode = health.authMode || 'manual';
  const ttl = Number(health.sessionTtlMs);
  if (Number.isFinite(ttl) && ttl > 0) heartbeatMs = Math.min(60_000, Math.max(2_000, Math.round(ttl / 4)));
  return authMode;
}

async function githubSession(state) {
  const repository = state?.repository;
  if (!repository?.owner || !repository?.repository) throw new Error('repository mapping is missing; call mediation_init again');
  const current = derivedProject();
  if (!current?.repository) throw new Error(current?.error || 'current GitHub push remote cannot be resolved');
  if (current.repository.owner.toLowerCase() !== repository.owner.toLowerCase()
    || current.repository.repository.toLowerCase() !== repository.repository.toLowerCase()) {
    throw new Error(`Git push target changed from github.com/${repository.owner}/${repository.repository} `
      + `to github.com/${current.repository.owner}/${current.repository.repository}; call mediation_init to confirm the new binding`);
  }
  const created = await api('POST', '/api/repositories/github/session', {
    owner: current.repository.owner,
    repository: current.repository.repository,
    agent: process.env.MEDIATION_HARNESS || 'claude-code',
    machine: os.hostname(),
    worktree: worktreeId(),
  });
  const project = typeof created.project === 'string' ? created.project : created.project?.id;
  const id = typeof created.session === 'string' ? created.session : created.session?.id;
  if (!project || !id || !created.capability) throw new Error('server returned an invalid repository session binding');
  return { id, capability: created.capability, project, heartbeat: null };
}

async function ensureSession() {
  const state = readState();
  if (session && stateMatchesServer(state)) return session.id;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
  if (session) await endSession();
  if (!state?.repository && !state?.project) throw new Error('not initialized. Call mediation_init first');
  if (!readCredentials()?.token) throw new Error('not signed in. Call mediation_setup first');
  const created = await ((await serverAuthMode()) === 'github-app'
    ? githubSession(state)
    : api('POST', `/api/projects/${encodeURIComponent(state.project)}/sessions`, {
      agent: process.env.MEDIATION_HARNESS || 'claude-code', machine: os.hostname(), worktree: worktreeId(),
    }));
  const current = { id: created.id, capability: created.capability, project: created.project || state.project, heartbeat: null };
  session = current;
  /* The beat carries what the working tree says. It is the ONLY thing that
     fires while the agent is heads-down coding and calling no tools, so it is
     the only channel that keeps overlap data fresh through exactly the window
     where a collision is most likely to form unnoticed. */
  const beat = () =>
    api('POST', `/api/projects/${encodeURIComponent(current.project)}/sessions/${current.id}/heartbeat`,
      repoReport(), { sessionCapability: current.capability })
      .catch((error) => {
        // A dropped beat is a network event, not a verdict. Giving up on the
        // first one leaves the agent working under a session the server then
        // expires, releasing its claims to everyone else. Only the server
        // saying this session is gone or refused ends it here.
        console.error(`mediation: heartbeat failed: ${error.message}`);
        if (error.status !== 401 && error.status !== 403 && error.status !== 404) return;
        if (session === current) session = null;
        clearInterval(current.heartbeat);
      });
  /* Beat once immediately: session creation carries no repo state, so an agent
     that connects and then codes without claiming was invisible for a whole
     heartbeat interval, which is exactly the window the dashboard needs it. */
  beat();
  current.heartbeat = setInterval(beat, heartbeatMs);
  current.heartbeat.unref?.();
  return current.id;
  })();
  try { return await sessionPromise; } finally { sessionPromise = null; }
}

async function endSession() {
  const current = session;
  if (!current) return;
  clearInterval(current.heartbeat);
  await api('DELETE', `/api/projects/${encodeURIComponent(current.project)}/sessions/${current.id}`, undefined,
    { sessionCapability: current.capability })
    .catch(() => {});
  if (session === current) session = null;
}

const proj = () => {
  const state = readState();
  if (!state?.repository && !state?.project) throw new Error('not initialized. Call mediation_init first');
  if (!stateMatchesServer(state)) {
    throw new Error(`this repository is mapped to ${state.server || 'an invalid server'}, not ${SERVER}; call mediation_init`);
  }
  if (!session?.project) throw new Error('session binding is not established');
  return { state, base: `/api/projects/${encodeURIComponent(session.project)}` };
};

/* Opens the tracking issue for a bug that has earned one and links it back.
   Returns null whenever GitHub is unavailable for any reason: the caller has
   already filed the bug, which is the part that must not fail. */
async function openTrackingIssue(base, sessionId, bug) {
  const slug = repoSlug();
  if (!slug || !ghAuthenticated()) return null;
  const body = [
    bug.description,
    bug.files?.length ? `Files: ${bug.files.join(', ')}` : null,
    `Severity: ${bug.severity}. Reported by ${bug.reporter} via Mediation (bug ${bug.id}).`,
  ].filter(Boolean).join('\n\n');
  const printed = gh(['issue', 'create', '--repo', slug, '--title', bug.title, '--body', body]);
  const issueUrl = /^https:\/\/github\.com\/\S+\/issues\/\d+$/m.exec(printed || '')?.[0];
  if (!issueUrl) return null;
  await api('PATCH', `${base}/bugs/${encodeURIComponent(bug.id)}`, { sessionId, issueUrl }).catch(() => {});
  return issueUrl;
}

/* A PR that says "Closes #12" closes the GitHub issue, and nothing tells
   Mediation. So whenever an agent orients itself, let the closed issues resolve
   their bugs: without this the two lists drift apart and the bug feed goes back
   to listing work that is already done. One `gh` call, skipped entirely when no
   open bug carries an issue. */
async function reconcileClosedIssues(base, state, sessionId) {
  const linked = state.bugs.filter((b) => b.status !== 'fixed' && b.issueUrl);
  const slug = repoSlug();
  if (!linked.length || !slug || !ghAuthenticated()) return 0;
  let closed;
  try {
    closed = new Set(JSON.parse(gh(['issue', 'list', '--repo', slug, '--state', 'closed',
      '--limit', '100', '--json', 'url']) || '[]').map((i) => i.url));
  } catch {
    return 0;
  }
  let n = 0;
  for (const bug of linked) {
    if (!closed.has(bug.issueUrl)) continue;
    const ok = await api('PATCH', `${base}/bugs/${encodeURIComponent(bug.id)}`,
      { sessionId, status: 'fixed' }).then(() => true, () => false);
    if (ok) { bug.status = 'fixed'; n += 1; }
  }
  return n;
}

/* ---------------- rendering helpers ---------------- */

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

// Server-authored `hint` fields are instructions for the human, so pass them
// through verbatim and stop the agent from retrying its way around them.
function renderError(err) {
  const out = [`error: ${err.message}`];
  if (err.status === 401) out.push('(device credential is missing, invalid, or revoked. Run mediation_setup again)');
  else if (err.name === 'TimeoutError' || err.cause?.code === 'ECONNREFUSED') out.push(`(mediation server ${SERVER} unreachable)`);
  if (err.hint) {
    out.push(`\nNEXT STEP, tell your user verbatim: ${err.hint}`);
    if (err.status === 403) {
      out.push('Do NOT retry, do NOT switch project ids, do NOT create a new project. Wait for the human to act.');
    }
  }
  return out.join(' ');
}

function renderConflicts(conflicts) {
  if (!conflicts.length) return 'No overlapping work detected. Clear to proceed.';
  const lines = conflicts.map((w) => {
    const reasons = w.reasons.map((r) =>
      r.type === 'files' ? `files: ${r.detail.map((d) => `${d.mine}<->${d.theirs}`).join(', ')}`
      : r.type === 'components' ? `components: ${r.detail.join(', ')}`
      : `similar task (${r.detail.join(', ')})`).join('; ');
    // The age is the difference between "someone is in this file right now" and
    // "someone touched it half an hour ago"; without it both read as urgent.
    const age = w.updatedAt ? `, last touched ${ago(w.updatedAt)} ago` : '';
    return `- ${w.agent}${w.developer ? ` (for ${w.developer})` : ''} is "${w.status}"${age} on: ${w.intent}\n  overlap: ${reasons}\n  claimId: ${w.claimId}`;
  });
  return `WARNING: ${conflicts.length} overlapping claim(s). Conflicts are warnings, not locks. Stop, coordinate with the owner, narrow scope, or continue explicitly.\n${lines.join('\n')}`;
}

// What the server had to do to honour the call, when that is not what the agent
// asked for: a claim adopted from an ended session, or revived after expiring.
const note = (payload) => (payload?.note ? ` ${payload.note}` : '');

/* News rides back on a call the agent was already making. Kept deliberately
   short: this text is spent out of the agent's context on every write, so it
   earns its place only by staying a few lines. */
function renderNews(news) {
  if (!news?.length) return '';
  const label = {
    'waiting-on-you': 'SOMEONE IS WAITING ON YOU',
    unblocked: 'YOUR WAIT IS OVER',
    blocker: 'on the work you are waiting for',
    overlap: 'touches your work',
  };
  return `\n\nNEWS (${news.length}, relevant to files you claimed):\n`
    + news.map((n) => `- [${label[n.reason] || n.reason}] ${n.message} (${ago(n.at)} ago)`).join('\n');
}

// Where this directory stands: mapped, mapped elsewhere, or not initialized.
// Shared by setup and state so both answer the question the same way.
function describeMapping(state) {
  if (!state) {
    const guess = derivedProject();
    return guess?.repository
      ? `This directory is NOT initialized. Resolved repository: github.com/${guess.repository.owner}/${guess.repository.repository} (${guess.source}). Call mediation_init only if the user asked to set up Mediation here.`
      : `This directory is NOT initialized, and ${guess?.error || 'no Git push remote is configured here'}, so it cannot be. Configure the GitHub push remote; never guess from the directory name.`;
  }
  if (!stateMatchesServer(state)) {
    return `The mapping at ${state.path} belongs to ${state.server || 'an invalid server'}, not ${SERVER}. Call mediation_init to remap it.`;
  }
  const repository = state.repository
    ? `github.com/${state.repository.owner}/${state.repository.repository}`
    : `legacy project "${state.project}"`;
  return `Repository ${repository} (mapping: ${state.path}).`;
}

// Response budget. These strings are charged to the agent's context on every
// call, so long lists get counted rather than printed.
function capped(items, limit, render) {
  const shown = items.slice(0, limit).map(render).join('');
  return items.length > limit ? `${shown}\n  ...and ${items.length - limit} more` : shown;
}

/* ---------------- tools ---------------- */

const str = { type: 'string' };
const strArr = { type: 'array', items: { type: 'string' } };
const dirArg = {
  ...str,
  description: 'Absolute path of the project directory .mediation.json belongs to. Optional: '
    + 'defaults to the git toplevel of the directory this client was started in (or $MEDIATION_DIR). '
    + 'Pass it whenever your harness may have started the MCP server somewhere other than the project.',
};

/* Five tools, not eleven. Each tool description is context an agent pays for on
   every single call, and each is a decision point it can get wrong; folding a
   lifecycle into one tool removes both. The split that survives is by OBJECT
   (a claim, a bug, the project) plus the two setup steps, because that is the
   split a model already reasons in. `mediation_init` deliberately stays its own
   tool: it is the one action with a policy boundary ("never initialize unless
   the user asked") and the only one that writes into the repository, so a
   harness must be able to deny it on its own. */
const TOOLS = [
  {
    name: 'mediation_setup',
    description: 'Sign this machine in to Mediation, and report setup state. Idempotent and resumable: call it, do what it says, call it again. GitHub App mode drives browser device authorization (never accept or store a GitHub token); manual mode takes username/password, and registers a new account only when register: true.',
    inputSchema: {
      type: 'object',
      properties: {
        username: str,
        password: str,
        register: { type: 'boolean', description: 'Manual mode only: create a NEW account instead of signing in. Never set this to recover from a failed sign-in.' },
        directory: dirArg,
      },
    },
    async run({ username, password, register, directory }) {
      const b = baseDir(directory);
      let health = 'unreachable';
      try { await api('GET', '/api/health', undefined, { auth: false }); health = 'ok'; } catch {}
      const where = `Directory: ${b.dir}${b.repo ? '' : ' (NOT a git repository)'}${b.explicit ? ' (given)' : ''}.`;

      // Signed in already: this is the report, and no credential is touched.
      if (readCredentials()?.token && !register && !password) {
        let identity = 'device credential present but not accepted; sign in again';
        try {
          const me = await api('GET', '/api/auth/me');
          identity = `signed in as ${me.ownerUsername}`;
        } catch {}
        return `server ${SERVER}: ${health}. ${where} ${identity}. ${describeMapping(readState())}`;
      }

      if ((await serverAuthMode()) === 'github-app') {
        const current = readCredentials();
        const begin = async () => {
          const started = await api('POST', '/api/auth/device/start', { machine: os.hostname() }, { auth: false });
          writeCredentials({ activation: {
            requestId: started.requestId, secret: started.secret, expiresAt: started.expiresAt,
          } });
          return `Open ${started.verificationUri} and confirm code ${started.userCode}. `
            + 'GitHub signs the human into Mediation; no GitHub token is given to this agent. '
            + 'After an administrator approves the Mediation account, call mediation_setup again.';
        };
        if (!current?.activation?.requestId || !current.activation.secret) return begin();
        let redeemed;
        try {
          redeemed = await api('POST', '/api/auth/device/redeem', {
            requestId: current.activation.requestId, secret: current.activation.secret,
          }, { auth: false });
        } catch (error) {
          if (error.status === 404) return begin();
          throw error;
        }
        if (!redeemed.token) {
          return redeemed.status === 'waiting-for-approval'
            ? 'GitHub identity confirmed. A Mediation administrator must approve the account; then call mediation_setup again.'
            : 'Browser GitHub authorization is not complete yet. Open the previously shown verification URL, then call mediation_setup again.';
        }
        const credentialPath = writeCredentials({ token: redeemed.token, username: redeemed.user.username });
        return `Signed in as ${redeemed.user.username}. Device credential stored at ${credentialPath}. ${describeMapping(readState())}`;
      }

      if (!username || !password) {
        return `server ${SERVER}: ${health}. ${where} Not signed in. Manual mode: ask the user for their Mediation `
          + 'username and password and call mediation_setup with them. Do NOT invent credentials.';
      }
      /* Registering is an explicit request, never a fallback from a failed
         sign-in: a typo'd username would silently create a junk pending account
         and leave the real one untouched. */
      if (register) {
        const r = await api('POST', '/api/users/register', { username, password }, { auth: false });
        return r.bootstrap
          ? `Account ${r.user.username} registered as the initial admin. Call mediation_setup with the same credentials to sign in.`
          : `Account ${r.user.username} registered and is awaiting admin approval. Ask an admin to approve it, then call mediation_setup with the same credentials.`;
      }
      const r = await api('POST', '/api/auth/device-login', { username, password, machine: os.hostname() }, { auth: false });
      const credentialPath = writeCredentials({ token: r.token, username: r.user.username });
      return `Signed in as ${r.user.username}. Device credential stored at ${credentialPath}. ${describeMapping(readState())}`;
    },
  },
  {
    name: 'mediation_init',
    description: 'Bind the current repository’s GitHub push target. Call ONLY when the user explicitly asks to set up or connect Mediation here. It independently resolves owner/repository once; models cannot supply a project id and no credential is stored in the repository.',
    inputSchema: { type: 'object', properties: { directory: dirArg } },
    async run({ directory }) {
      const b = baseDir(directory);
      const guess = derivedProject();
      if (!guess?.repository) {
        return `${guess?.error || `No Git push remote exists in ${b.dir}`}. Configure this repository's GitHub push remote `
          + 'and call mediation_init again. Do NOT guess or supply a project name.';
      }

      const mode = await serverAuthMode();
      // ponytail: manual routes are path-based; remove this compatibility field
      // once manual mode receives the repository-binding integration point.
      const statePath = writeState({ server: SERVER, repository: guess.repository,
        ...(mode === 'manual' ? { project: manualProject(guess.repository.owner, guess.repository.repository) } : {}) });
      const repository = `github.com/${guess.repository.owner}/${guess.repository.repository}`;
      if (!readCredentials()?.token) return `Repository "${repository}" mapped at ${statePath}. Sign in with mediation_setup before working.`;
      await ensureSession();
      // Said here because this is the one moment the file exists and nobody has
      // decided its fate yet. Sharing the mapping binds every clone to one
      // person's server, and a fork pushes elsewhere, so githubSession() refuses
      // the binding until someone re-runs init: on a tracked file, that is a
      // dirty tree and a merge conflict for the next person.
      return `Repository "${repository}" bound at ${statePath} (${guess.source}). Gitignore ${STATE_FILE}: the mapping is `
        + 'per-checkout. Publish work with mediation_claim before you start editing.';
    },
  },
  {
    /* One tool for the whole life of a claim, because a claim IS one object
       moving through states, and a separate tool per transition only gave the
       model more chances to skip one. Creating a claim is also how you check:
       POST /claims runs the same overlap computation the old check call did and
       returns the same warnings, so checking first was a round trip that bought
       nothing except the ability to look without publishing, and staying
       invisible is the opposite of what a coordination server is for. */
    name: 'mediation_claim',
    description: 'REQUIRED before you start editing: publish what you are about to work on. Returns overlap warnings for anyone already on it (warnings, not locks). Then reuse the SAME tool with the returned claimId to record findings, change status, and finish: status "done" with commits when the work is committed, or "abandoned" if you drop it so the claim stops warning others.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { ...str, description: 'Omit to create a new claim; pass it to update or finish an existing one.' },
        intent: { ...str, description: 'What you are doing, e.g. "Fix login redirect loop". Required when creating.' },
        status: {
          ...str,
          enum: ['investigating', 'in-progress', 'testing', 'blocked', 'done', 'abandoned'],
          description: '"done" needs commits; "abandoned" retires a claim you did not do, e.g. after backing off a conflict.',
        },
        finding: { ...str, description: 'One important discovery (root cause, gotcha, decision). Other agents read these live.' },
        findingFiles: { ...strArr, description: 'Files this finding is about, so it reaches the agents working on them.' },
        findingKind: { ...str, enum: ['root-cause', 'gotcha', 'decision', 'api-change'] },
        blockedOn: { ...str, description: 'claimId you are waiting on. That agent is told someone is waiting, and you are told when it clears.' },
        files: { ...strArr, description: 'Files/dirs you intend to touch' },
        components: { ...strArr, description: 'Logical components, e.g. ["auth"]' },
        task: { ...str, description: 'Ticket/task reference, e.g. BUG-142' },
        branch: str,
        baseRevision: str,
        commits: { ...strArr, description: 'Commit SHAs, with status "done"' },
        prs: { ...strArr, description: 'PR URLs' },
        summary: str,
        dryRun: {
          type: 'boolean',
          description: 'Check for overlap WITHOUT publishing a claim. Prefer publishing: an unpublished agent is invisible to everyone else.',
        },
      },
    },
    async run({ claimId, dryRun, ...input }) {
      const sid = await ensureSession();
      const { base } = proj();

      if (dryRun) {
        const q = new URLSearchParams({
          sessionId: sid, files: (input.files ?? []).join(','), components: (input.components ?? []).join(','),
        });
        if (input.task) q.set('task', input.task);
        if (input.intent) q.set('intent', input.intent);
        const { conflicts } = await api('GET', `${base}/check?${q}`);
        return `${renderConflicts(conflicts)}\nNothing was published. Call mediation_claim without dryRun to claim this work.`;
      }

      if (!claimId) {
        if (!input.intent) throw new Error('intent is required to create a claim (or pass claimId to update one)');
        const { claim, conflicts, news } = await api('POST', `${base}/claims`, { sessionId: sid, ...input });
        const head = `Claim created: ${claim.id} ("${claim.intent}", ${claim.status}). Reuse mediation_claim with this `
          + 'claimId to add findings, and again with status "done" (plus commits) or "abandoned" when you stop.';
        return `${conflicts.length ? `${head}\n\n${renderConflicts(conflicts)}` : head}${renderNews(news)}`;
      }

      const id = encodeURIComponent(claimId);
      // `done` and `abandoned` are terminal, so they go to the endpoint that
      // closes a claim; every other status is an ordinary patch.
      if (input.status === 'done' || input.status === 'abandoned') {
        const { commits = [], prs = [], summary, status } = input;
        const claim = await api('POST', `${base}/claims/${id}/complete`, { commits, prs, summary, status });
        const head = claim.status === 'abandoned'
          ? `Abandoned: "${claim.intent}". The claim no longer warns anyone and is kept out of the completed feed.`
          : `Completed: "${claim.intent}"${claim.commits.length ? ` (${claim.commits.join(', ')})` : ''}.`;
        return `${head}${note(claim)}${renderNews(claim.news)}`;
      }
      const claim = await api('PATCH', `${base}/claims/${id}`, input);
      const head = `Claim updated: ${claim.intent}, now ${claim.status}`
        + `${claim.findings.length ? `, ${claim.findings.length} finding(s) recorded` : ''}.`;
      return `${head}${note(claim)}${renderNews(claim.news)}`;
    },
  },
  {
    name: 'mediation_bug',
    description: 'File a bug you found (even one you will not fix), or resolve one: pass bugId with status "fixed" once the fix is committed, or "claimed" while you work on it. Any agent may resolve any bug in the project, including one someone else reported; ids come from mediation_state.',
    inputSchema: {
      type: 'object',
      properties: {
        bugId: { ...str, description: 'Omit to file a new bug; pass it (from mediation_state) to update an existing one.' },
        title: { ...str, description: 'Required when filing. Never send it together with bugId.' },
        description: str,
        files: strArr,
        severity: {
          ...str,
          enum: ['low', 'medium', 'high', 'critical', 'unknown'],
          description: 'high and critical also open a linked GitHub issue when gh is signed in here.',
        },
        status: { ...str, enum: ['open', 'claimed', 'fixed'] },
      },
    },
    async run({ bugId, ...input }) {
      const sid = await ensureSession();
      const { base } = proj();
      /* Guard the one way this merge can silently do the wrong thing: an agent
         meaning to resolve a bug, forgetting the id but still sending a title,
         would file a duplicate instead of erroring. Refusing the ambiguous call
         costs a retry; a silent duplicate costs the bug list its credibility. */
      if (bugId && input.title) {
        throw new Error('send either bugId (to update a bug) or title (to file a new one), never both');
      }

      if (!bugId) {
        if (!input.title) throw new Error('title is required to file a bug (or pass bugId to update one)');
        // The bug is filed first and unconditionally: the issue is decoration on
        // top of it, and its id gives the issue something to point back at.
        const bug = await api('POST', `${base}/bugs`, { sessionId: sid, ...input });
        const head = `Bug filed: "${bug.title}" (${bug.severity}, id ${bug.id}).`;
        const news = renderNews(bug.news);
        if (!ISSUE_WORTHY.has(bug.severity)) {
          return `${head} Tracked in Mediation only; ${bug.severity} severity does not open a GitHub issue.${news}`;
        }
        if (!ghAuthenticated()) return `${head} No GitHub issue: gh is not signed in here.${news}`;
        const issueUrl = await openTrackingIssue(base, sid, bug);
        return `${head} ${issueUrl ? `Tracking issue: ${issueUrl}` : 'GitHub issue could not be created; the bug is filed either way.'}${news}`;
      }

      const bug = await api('PATCH', `${base}/bugs/${encodeURIComponent(bugId)}`, { sessionId: sid, ...input });
      const head = `Bug "${bug.title}" is now ${bug.status} (${bug.severity}).`;
      // Raising a bug to high is the same judgement as filing it high, so it
      // earns the same tracking issue; the rule is about severity, not timing.
      if (bug.status !== 'fixed' && !bug.issueUrl && ISSUE_WORTHY.has(bug.severity)) {
        const issueUrl = await openTrackingIssue(base, sid, bug);
        if (issueUrl) return `${head} Now ${bug.severity}, so it has a tracking issue: ${issueUrl}`;
      }
      // Keep the tracking issue in step, so the two lists never disagree.
      if (bug.status !== 'fixed' || !bug.issueUrl || !ghAuthenticated()) return head;
      const closed = gh(['issue', 'close', bug.issueUrl]) !== null;
      return `${head} ${closed ? `Closed ${bug.issueUrl}.` : `Could not close ${bug.issueUrl}; close it by hand.`}`;
    },
  },
  {
    name: 'mediation_state',
    description: 'Full live picture of the project: active sessions, claims, conflicts, open bugs with their ids, and recent completed work. Use to orient before picking a task. If this directory is not set up yet, it reports what is missing instead.',
    inputSchema: { type: 'object', properties: { directory: dirArg } },
    async run({ directory }) {
      const b = baseDir(directory);
      const state = readState();
      /* An agent that calls state in an unconfigured directory used to get an
         error telling it to go call a different tool. Answering the question it
         could not know to ask is the whole reason the status tool is gone. */
      if (!state || !stateMatchesServer(state) || !readCredentials()?.token) {
        let health = 'unreachable';
        try { await api('GET', '/api/health', undefined, { auth: false }); health = 'ok'; } catch {}
        const signedIn = readCredentials()?.token ? '' : ' Not signed in: call mediation_setup.';
        return `Not ready for coordination. server ${SERVER}: ${health}. Directory: ${b.dir}`
          + `${b.repo ? '' : ' (NOT a git repository)'}. ${describeMapping(state)}${signedIn}`;
      }

      const sid = await ensureSession();
      const { base } = proj();
      const s = await api('GET', `${base}/state?sessionId=${encodeURIComponent(sid)}`);
      const reconciled = await reconcileClosedIssues(base, s, sid);
      const out = [];
      if (reconciled) out.push(`Resolved ${reconciled} bug(s) whose GitHub issue has been closed.`);
      out.push(`Sessions (${s.sessions.length}): ${s.sessions.map((x) => `${x.agent} (${ago(x.lastSeenAt)} ago)`).join(', ') || 'none'}`);
      // Everything below is capped. With five agents holding claims over real
      // file lists this is the single most expensive response in the system,
      // and it is most expensive exactly when the project is busiest.
      const files = (list) => (list.length > 5
        ? `${list.slice(0, 5).join(', ')} +${list.length - 5} more`
        : list.join(', '));
      out.push(`Active claims (${s.claims.length}):${capped(s.claims, 10, (cl) =>
        `\n- [${cl.status}] ${cl.agent}: ${cl.intent}${cl.files.length ? ` (${files(cl.files)})` : ''}`
        + `${cl.blockedOn ? ` [blocked on ${cl.blockedOn}]` : ''} (id ${cl.id})`) || ' none'}`);
      if (s.conflicts.length) {
        out.push(`CONFLICTS (${s.conflicts.length}):${capped(s.conflicts, 5, (k) =>
          `\n- ${k.between[0].agent} <-> ${k.between[1].agent}: ${k.between[0].intent} / ${k.between[1].intent}`)}`);
      }
      // Ids are printed because resolving a bug needs them.
      const open = s.bugs.filter((bug) => bug.status !== 'fixed');
      out.push(`Open bugs (${open.length}):${capped(open, 15, (bug) =>
        `\n- [${bug.severity}] ${bug.title} (${bug.status}, id ${bug.id})${bug.issueUrl ? ` ${bug.issueUrl}` : ''}`) || ' none'}`);
      // Summaries, not bare intents: what someone learned finishing a job is the
      // highest-signal thing on the board and used to be collected and hidden.
      if (s.completed.length) {
        out.push(`Recently completed:${capped(s.completed, 5, (cl) =>
          `\n- ${cl.intent}${cl.summary ? `: ${cl.summary}` : ''}`)}`);
      }
      return `${out.join('\n')}${renderNews(s.news)}`;
    },
  },
];

/* ---------------- MCP over stdio (newline-delimited JSON-RPC 2.0) ---------------- */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const { id, method, params } = req;
  const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mediation', version: '0.5.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
      try {
        const text = await tool.run(params?.arguments || {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: renderError(err) }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

let buffer = '';
const inflight = new Set(); // drain these before exiting on stdin close
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = handle(msg).catch(() => {});
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }
});

async function shutdown() {
  await Promise.allSettled([...inflight]);
  await endSession();
  process.exit(0);
}
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
