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

// Definitive answer, not a guess: git itself decides whether the file is ignored.
/* ---------------- http ---------------- */

let session = null; // { id, capability, project, heartbeat }; never persisted
let sessionPromise = null;
let authMode = null;
// Beat well inside the server's session TTL: an agent that claims work and then
// codes for ten minutes without calling another tool has only these beats
// keeping its claims alive, so several must be able to drop without expiring
// the session. /api/health reports the real TTL; this is the fallback.
let heartbeatMs = 60_000;

async function api(method, apiPath, body, { auth = true, sessionCapability = session?.capability } = {}) {
  const credential = readCredentials();
  const headers = { 'content-type': 'application/json' };
  if (auth && credential?.token) headers.authorization = `Bearer ${credential.token}`;
  if (sessionCapability) headers['x-mediation-session'] = sessionCapability;
  const res = await fetch(`${SERVER}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} on ${apiPath}`);
    err.status = res.status;
    err.hint = data.hint || null; // server-authored instruction for the human
    throw err;
  }
  return data;
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
  if (!readCredentials()?.token) throw new Error('not signed in. Call mediation_login first');
  const created = await ((await serverAuthMode()) === 'github-app'
    ? githubSession(state)
    : api('POST', `/api/projects/${encodeURIComponent(state.project)}/sessions`, {
      agent: process.env.MEDIATION_HARNESS || 'claude-code', machine: os.hostname(),
    }));
  const current = { id: created.id, capability: created.capability, project: created.project || state.project, heartbeat: null };
  session = current;
  current.heartbeat = setInterval(() => {
    api('POST', `/api/projects/${encodeURIComponent(current.project)}/sessions/${current.id}/heartbeat`, {},
      { sessionCapability: current.capability })
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
  }, heartbeatMs);
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
  if (err.status === 401) out.push('(device credential is missing, invalid, or revoked. Run mediation_login again)');
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
    return `- ${w.agent}${w.developer ? ` (for ${w.developer})` : ''} is "${w.status}" on: ${w.intent}\n  overlap: ${reasons}\n  claimId: ${w.claimId}`;
  });
  return `WARNING: ${conflicts.length} overlapping claim(s). Conflicts are warnings, not locks. Stop, coordinate with the owner, narrow scope, or continue explicitly.\n${lines.join('\n')}`;
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

const TOOLS = [
  {
    name: 'mediation_status',
    description: 'Check the Mediation setup for a project directory: resolved directory, server reachability, device login, project mapping, and active session.',
    inputSchema: { type: 'object', properties: { directory: dirArg } },
    async run({ directory }) {
      const b = baseDir(directory);
      let health = 'unreachable';
      try { await api('GET', '/api/health', undefined, { auth: false }); health = 'ok'; } catch {}
      const state = readState();
      const where = `Directory: ${b.dir}${b.repo ? '' : ' (NOT a git repository)'}${b.explicit ? ' (given)' : ''}.`;
      if (!state) {
        const guess = derivedProject();
        return `server ${SERVER}: ${health}. ${where} No .mediation.json found, so this directory is not initialized.\n`
          + (guess?.repository
            ? `Resolved repository: github.com/${guess.repository.owner}/${guess.repository.repository} (${guess.source}). Call mediation_init.`
            : `${guess?.error || 'No Git push remote is configured here'}, so this repository cannot be initialized. Configure its GitHub push remote; never guess from the directory name.`);
      }
      if (!stateMatchesServer(state)) {
        return `server ${SERVER}: ${health}. ${where} The mapping at ${state.path} belongs to `
          + `${state.server || 'an invalid server'}. Run mediation_init to remap this repository.`;
      }
      let identity = 'not signed in. Call mediation_login';
      try {
        const me = await api('GET', '/api/auth/me');
        identity = `signed in as ${me.ownerUsername}`;
      } catch {}
      const repository = state.repository ? `github.com/${state.repository.owner}/${state.repository.repository}` : `legacy project "${state.project}"`;
      return `server ${SERVER}: ${health}. ${where} Repository ${repository} (state: ${state.path}). ${identity}. Session: ${session ? 'active' : 'none yet (created on first use)'}.`;
    },
  },
  {
    name: 'mediation_register',
    description: 'Register a Mediation account. The first account is active admin; later accounts wait for an admin to approve them. Never store the password.',
    inputSchema: {
      type: 'object',
      properties: {
        username: str, password: str,
      },
      required: ['username', 'password'],
    },
    async run({ username, password }) {
      const r = await api('POST', '/api/users/register', { username, password }, { auth: false });
      return r.bootstrap ? `Account ${r.user.username} registered as the initial admin. Call mediation_login.`
        : `Account ${r.user.username} registered and is awaiting admin approval. Ask an admin to approve it, then call mediation_login.`;
    },
  },
  {
    name: 'mediation_login',
    description: 'Manual mode: sign in once with username/password and store a narrow device bearer. GitHub App mode: guides the human to complete browser device authorization; never accept or store a GitHub token.',
    inputSchema: { type: 'object', properties: { username: str, password: str } },
    async run({ username, password }) {
      if ((await serverAuthMode()) === 'github-app') {
        const current = readCredentials();
        const begin = async () => {
          const started = await api('POST', '/api/auth/device/start', { machine: os.hostname() }, { auth: false });
          writeCredentials({ activation: {
            requestId: started.requestId, secret: started.secret, expiresAt: started.expiresAt,
          } });
          return `Open ${started.verificationUri} and confirm code ${started.userCode}. `
            + 'GitHub signs the human into Mediation; no GitHub token is given to this agent. '
            + 'After an administrator approves the Mediation account, call mediation_login again.';
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
            ? 'GitHub identity confirmed. A Mediation administrator must approve the account; then call mediation_login again.'
            : 'Browser GitHub authorization is not complete yet. Open the previously shown verification URL, then call mediation_login again.';
        }
        const credentialPath = writeCredentials({ token: redeemed.token, username: redeemed.user.username });
        return `Signed in as ${redeemed.user.username}. Device credential stored at ${credentialPath}.`;
      }
      if (!username || !password) throw new Error('manual mode requires username and password');
      const r = await api('POST', '/api/auth/device-login', { username, password, machine: os.hostname() }, { auth: false });
      const credentialPath = writeCredentials({ token: r.token, username: r.user.username });
      return `Signed in as ${r.user.username}. Device credential stored at ${credentialPath}.`;
    },
  },
  {
    name: 'mediation_init',
    description: 'Bind the current repository’s GitHub push target. It independently resolves owner/repository once; models cannot supply a project id and no credential is stored in the repository.',
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
      if (!readCredentials()?.token) return `Repository "${repository}" mapped at ${statePath}. Sign in with mediation_login before working.`;
      await ensureSession();
      return `Repository "${repository}" bound at ${statePath} (${guess.source}). Use mediation_check before starting work.`;
    },
  },
  {
    name: 'mediation_check',
    description: 'REQUIRED before starting any coding task: check whether other developers/agents already work on the same files, components, or a similar task. Conflicts are warnings, not locks.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { ...strArr, description: 'Files/dirs you intend to touch' },
        components: { ...strArr, description: 'Logical components, e.g. ["auth"]' },
        task: { ...str, description: 'Ticket/task reference, e.g. BUG-142' },
        intent: { ...str, description: 'Short description of what you plan to do' },
      },
    },
    async run({ files = [], components = [], task, intent }) {
      const sid = await ensureSession();
      const { base } = proj();
      const q = new URLSearchParams({ sessionId: sid, files: files.join(','), components: components.join(',') });
      if (task) q.set('task', task);
      if (intent) q.set('intent', intent);
      const { conflicts } = await api('GET', `${base}/check?${q}`);
      return renderConflicts(conflicts);
    },
  },
  {
    name: 'mediation_claim',
    description: 'Publish a work claim before you start editing, so other agents see the work is taken. Returns overlap warnings alongside the claim.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { ...str, description: 'What you are doing, e.g. "Fix login redirect loop"' },
        task: str, files: strArr, components: strArr,
        branch: str, baseRevision: str,
        status: { ...str, enum: ['investigating', 'in-progress', 'testing', 'blocked'] },
      },
      required: ['intent'],
    },
    async run(input) {
      const sid = await ensureSession();
      const { base } = proj();
      const { claim, conflicts } = await api('POST', `${base}/claims`, { sessionId: sid, ...input });
      const head = `Claim created: ${claim.id} ("${claim.intent}", ${claim.status}). Update it with findings via mediation_update; finish with mediation_complete.`;
      return conflicts.length ? `${head}\n\n${renderConflicts(conflicts)}` : head;
    },
  },
  {
    name: 'mediation_update',
    description: 'Update your claim: status changes and important findings as you discover them (other agents read these live).',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: str,
        status: { ...str, enum: ['investigating', 'in-progress', 'testing', 'blocked'] },
        finding: { ...str, description: 'One important discovery, e.g. the root cause' },
        files: strArr, components: strArr, task: str, intent: str, branch: str, baseRevision: str,
      },
      required: ['claimId'],
    },
    async run({ claimId, ...patch }) {
      await ensureSession();
      const { base } = proj();
      const claim = await api('PATCH', `${base}/claims/${encodeURIComponent(claimId)}`, patch);
      return `Claim updated: ${claim.intent}, now ${claim.status}${claim.findings.length ? `, ${claim.findings.length} finding(s) recorded` : ''}.`;
    },
  },
  {
    name: 'mediation_complete',
    description: 'Mark your claim done and attach commits/PRs, moving it to the completed feed. Call when the work is committed.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: str,
        commits: { ...strArr, description: 'Commit SHAs' },
        prs: { ...strArr, description: 'PR URLs' },
        summary: str,
      },
      required: ['claimId'],
    },
    async run({ claimId, ...body }) {
      await ensureSession();
      const { base } = proj();
      const claim = await api('POST', `${base}/claims/${encodeURIComponent(claimId)}/complete`, body);
      return `Completed: "${claim.intent}"${claim.commits.length ? ` (${claim.commits.join(', ')})` : ''}.`;
    },
  },
  {
    name: 'mediation_bug',
    description: 'Report a bug you discovered, even one you will not fix, so other agents see it and do not re-discover it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str, description: str, files: strArr,
        severity: { ...str, enum: ['low', 'medium', 'high', 'critical', 'unknown'] },
      },
      required: ['title'],
    },
    async run(input) {
      const sid = await ensureSession();
      const { base } = proj();
      // The bug is filed first and unconditionally: the issue is decoration on
      // top of it, and its id gives the issue something to point back at.
      const bug = await api('POST', `${base}/bugs`, { sessionId: sid, ...input });
      const head = `Bug filed: "${bug.title}" (${bug.severity}, id ${bug.id}).`;
      const slug = repoSlug();
      if (!slug || !ghAuthenticated()) return `${head} No GitHub issue: gh is not signed in here.`;
      const body = [
        input.description,
        input.files?.length ? `Files: ${input.files.join(', ')}` : null,
        `Severity: ${bug.severity}. Reported by ${bug.reporter} via Mediation (bug ${bug.id}).`,
      ].filter(Boolean).join('\n\n');
      const url = gh(['issue', 'create', '--repo', slug, '--title', bug.title, '--body', body]);
      const issueUrl = /^https:\/\/github\.com\/\S+\/issues\/\d+$/m.exec(url || '')?.[0];
      if (!issueUrl) return `${head} GitHub issue could not be created; the bug is filed either way.`;
      await api('PATCH', `${base}/bugs/${encodeURIComponent(bug.id)}`, { sessionId: sid, issueUrl })
        .catch(() => {});
      return `${head} Tracking issue: ${issueUrl}`;
    },
  },
  {
    name: 'mediation_bug_resolve',
    description: 'Close a bug once it is fixed, or claim one you are about to fix. Any agent may resolve any bug in the project, including one another agent reported: get ids from mediation_state.',
    inputSchema: {
      type: 'object',
      properties: {
        bugId: { ...str, description: 'Bug id from mediation_state' },
        status: { ...str, enum: ['open', 'claimed', 'fixed'], description: 'fixed once the fix is committed; claimed while you work on it' },
        severity: { ...str, enum: ['low', 'medium', 'high', 'critical', 'unknown'], description: 'Correct the severity if the reporter misjudged it' },
      },
      required: ['bugId'],
    },
    async run({ bugId, ...patch }) {
      const sid = await ensureSession();
      const { base } = proj();
      const bug = await api('PATCH', `${base}/bugs/${encodeURIComponent(bugId)}`, { sessionId: sid, ...patch });
      const head = `Bug "${bug.title}" is now ${bug.status} (${bug.severity}).`;
      // Keep the tracking issue in step, so the two lists never disagree.
      if (bug.status !== 'fixed' || !bug.issueUrl || !ghAuthenticated()) return head;
      const closed = gh(['issue', 'close', bug.issueUrl]) !== null;
      return `${head} ${closed ? `Closed ${bug.issueUrl}.` : `Could not close ${bug.issueUrl}; close it by hand.`}`;
    },
  },
  {
    name: 'mediation_state',
    description: 'Full live picture of the project: active sessions, claims, conflicts, bugs, recently touched files, completed work. Use to orient before picking a task.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const sid = await ensureSession();
      const { base } = proj();
      const s = await api('GET', `${base}/state`);
      const reconciled = await reconcileClosedIssues(base, s, sid);
      const out = [];
      if (reconciled) out.push(`Resolved ${reconciled} bug(s) whose GitHub issue has been closed.`);
      out.push(`Sessions (${s.sessions.length}): ${s.sessions.map((x) => `${x.agent} (${ago(x.lastSeenAt)} ago)`).join(', ') || 'none'}`);
      out.push(`Active claims (${s.claims.length}):${s.claims.map((cl) => `\n- [${cl.status}] ${cl.agent}: ${cl.intent}${cl.files.length ? ` (${cl.files.join(', ')})` : ''} (id ${cl.id})`).join('') || ' none'}`);
      if (s.conflicts.length) out.push(`CONFLICTS (${s.conflicts.length}):${s.conflicts.map((k) => `\n- ${k.between[0].agent} <-> ${k.between[1].agent}: ${k.between[0].intent} / ${k.between[1].intent}`).join('')}`);
      // Ids are printed because mediation_bug_resolve needs them to close a bug.
      const open = s.bugs.filter((b) => b.status !== 'fixed');
      out.push(`Open bugs (${open.length}):${open.map((b) => `\n- [${b.severity}] ${b.title} (${b.status}, id ${b.id})${b.issueUrl ? ` ${b.issueUrl}` : ''}`).join('') || ' none'}`);
      if (s.completed.length) out.push(`Recently completed: ${s.completed.slice(0, 5).map((cl) => cl.intent).join('; ')}`);
      return out.join('\n');
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
        serverInfo: { name: 'mediation', version: '0.4.0-alpha' },
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
