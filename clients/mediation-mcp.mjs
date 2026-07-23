#!/usr/bin/env node
// Mediation MCP server — single file, zero dependencies, Node >= 20.
//
// Installed on user machines by install.sh and launched by an agent harness
// (claude-code, codex) over stdio. Speaks newline-delimited JSON-RPC 2.0 per
// the MCP spec and talks HTTP to a Mediation server (env MEDIATION_URL).
//
// Per-project pairing state lives in .mediation.json next to the project
// (found by walking up from cwd). Created by mediation_init + mediation_confirm.

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

function findStateFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const p = path.join(dir, STATE_FILE);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readState() {
  const p = findStateFile();
  if (!p) return null;
  try {
    return { path: p, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return null;
  }
}

function writeState(data) {
  const p = path.join(process.cwd(), STATE_FILE);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return p;
}

/* ---------------- http ---------------- */

let sessionId = null; // lazily created, heartbeated below

async function api(method, apiPath, body, { auth = true } = {}) {
  const state = readState();
  const headers = { 'content-type': 'application/json' };
  if (auth && state?.token) headers.authorization = `Bearer ${state.token}`;
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
    throw err;
  }
  return data;
}

async function ensureSession() {
  if (sessionId) return sessionId;
  const state = readState();
  if (!state?.project) throw new Error('not initialized — call mediation_init first');
  const session = await api('POST', `/api/projects/${encodeURIComponent(state.project)}/sessions`, {
    agent: state.agent || `agent@${os.hostname()}`,
    developer: state.developer || null,
    machine: os.hostname(),
  });
  sessionId = session.id;
  const beat = setInterval(() => {
    api('POST', `/api/projects/${encodeURIComponent(state.project)}/sessions/${sessionId}/heartbeat`, {})
      .catch(() => { sessionId = null; clearInterval(beat); });
  }, 45_000);
  beat.unref?.();
  return sessionId;
}

async function endSession() {
  const state = readState();
  if (!sessionId || !state?.project) return;
  await api('DELETE', `/api/projects/${encodeURIComponent(state.project)}/sessions/${sessionId}`)
    .catch(() => {});
  sessionId = null;
}

const proj = () => {
  const state = readState();
  if (!state?.project) throw new Error('not initialized — call mediation_init first');
  return { state, base: `/api/projects/${encodeURIComponent(state.project)}` };
};

/* ---------------- rendering helpers ---------------- */

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

function renderConflicts(conflicts) {
  if (!conflicts.length) return 'No overlapping work detected — clear to proceed.';
  const lines = conflicts.map((w) => {
    const reasons = w.reasons.map((r) =>
      r.type === 'files' ? `files: ${r.detail.map((d) => `${d.mine}<->${d.theirs}`).join(', ')}`
      : r.type === 'components' ? `components: ${r.detail.join(', ')}`
      : `similar task (${r.detail.join(', ')})`).join('; ');
    return `- ${w.agent}${w.developer ? ` (for ${w.developer})` : ''} is "${w.status}" on: ${w.intent}\n  overlap: ${reasons}\n  claimId: ${w.claimId}`;
  });
  return `WARNING: ${conflicts.length} overlapping claim(s). Conflicts are warnings, not locks — stop, coordinate with the owner, narrow scope, or continue explicitly.\n${lines.join('\n')}`;
}

/* ---------------- tools ---------------- */

const str = { type: 'string' };
const strArr = { type: 'array', items: { type: 'string' } };

const TOOLS = [
  {
    name: 'mediation_status',
    description: 'Check the Mediation setup for the current project directory: server reachability, pairing state, and active session. Use this first if unsure whether mediation is initialized here.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      let health = 'unreachable';
      try { await api('GET', '/api/health', undefined, { auth: false }); health = 'ok'; } catch {}
      const state = readState();
      if (!state) return `server ${SERVER}: ${health}. No .mediation.json found — not initialized for this directory. Call mediation_init with the project name.`;
      let identity = 'token INVALID or revoked — re-run mediation_init';
      try {
        const me = await api('GET', '/api/auth/me');
        identity = `paired as ${me.agent}${me.developer ? ` (developer: ${me.developer})` : ''}`;
      } catch {}
      return `server ${SERVER}: ${health}. Project "${state.project}" (state: ${state.path}). ${identity}. Session: ${sessionId ? 'active' : 'none yet (created on first use)'}.`;
    },
  },
  {
    name: 'mediation_init',
    description: 'Initialize Mediation for this project directory (one-time). Requests a pairing credential; the human must then read a 6-character approval code from the Mediation dashboard and give it to you — pass it to mediation_confirm. If already initialized, reports that instead.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { ...str, description: 'Mediation project id to join, e.g. "mediation"' },
        agent: { ...str, description: 'Name identifying this agent, defaults to claude-code@<hostname>' },
        developer: { ...str, description: 'Human developer this agent works for' },
      },
      required: ['project'],
    },
    async run({ project, agent, developer }) {
      const existing = readState();
      if (existing?.token) {
        try {
          const me = await api('GET', '/api/auth/me');
          if (existing.project === project) return `Already initialized: project "${project}", paired as ${me.agent}. Nothing to do.`;
          writeState({ ...existing, project });
          return `Credential already paired as ${me.agent}; switched project to "${project}".`;
        } catch { /* stale token — fall through to fresh pairing */ }
      }
      const agentName = agent || `claude-code@${os.hostname()}`;
      pendingInit = { project, agent: agentName, developer: developer || null };
      const req = await api('POST', '/api/auth/request', {
        agent: agentName,
        machine: os.hostname(),
        developer: developer || null,
      }, { auth: false });
      const mins = Math.round((req.expiresAt - Date.now()) / 60000);
      return `Pairing requested for "${agentName}".\nASK THE USER: open ${SERVER}/#/agents, find the pending request "${agentName}", and tell me the 6-character approval code (valid ~${mins} min).\nThen call mediation_confirm with that code.`;
    },
  },
  {
    name: 'mediation_confirm',
    description: 'Complete pairing with the 6-character approval code the human read from the Mediation dashboard. Stores the credential in .mediation.json (persistent for this project directory) and connects a session.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { ...str, description: 'The 6-character code from the dashboard' },
        project: { ...str, description: 'Project id (only needed if mediation_init was not called in this process)' },
      },
      required: ['code'],
    },
    async run({ code, project }) {
      const target = project || pendingInit?.project;
      if (!target) throw new Error('no project known — pass project or call mediation_init first');
      const red = await api('POST', '/api/auth/redeem', { code: code.trim().toUpperCase() }, { auth: false });
      const statePath = writeState({
        server: SERVER,
        project: target,
        token: red.token,
        agent: pendingInit?.agent || red.agent,
        developer: pendingInit?.developer ?? red.developer,
      });
      pendingInit = null;
      await ensureSession();
      return `Connected. Credential for "${red.agent}" stored at ${statePath} (add .mediation.json to .gitignore if it is not). Project "${target}" needs no setup here again. Use mediation_check before starting any work.`;
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
      const { base } = proj();
      const sid = await ensureSession();
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
      const { base } = proj();
      const sid = await ensureSession();
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
      const { base } = proj();
      await ensureSession();
      const claim = await api('PATCH', `${base}/claims/${encodeURIComponent(claimId)}`, patch);
      return `Claim updated: ${claim.intent} — ${claim.status}${claim.findings.length ? `, ${claim.findings.length} finding(s) recorded` : ''}.`;
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
      const { base } = proj();
      await ensureSession();
      const claim = await api('POST', `${base}/claims/${encodeURIComponent(claimId)}/complete`, body);
      return `Completed: "${claim.intent}"${claim.commits.length ? ` (${claim.commits.join(', ')})` : ''}.`;
    },
  },
  {
    name: 'mediation_bug',
    description: 'Report a bug you discovered — even one you will not fix — so other agents see it and do not re-discover it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str, description: str, files: strArr,
        severity: { ...str, enum: ['low', 'medium', 'high', 'critical', 'unknown'] },
      },
      required: ['title'],
    },
    async run(input) {
      const { base } = proj();
      const sid = await ensureSession();
      const bug = await api('POST', `${base}/bugs`, { sessionId: sid, ...input });
      return `Bug filed: "${bug.title}" (${bug.severity}, id ${bug.id}).`;
    },
  },
  {
    name: 'mediation_state',
    description: 'Full live picture of the project: active sessions, claims, conflicts, bugs, recently touched files, completed work. Use to orient before picking a task.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const { base } = proj();
      const s = await api('GET', `${base}/state`);
      const out = [];
      out.push(`Sessions (${s.sessions.length}): ${s.sessions.map((x) => `${x.agent} (${ago(x.lastSeenAt)} ago)`).join(', ') || 'none'}`);
      out.push(`Active claims (${s.claims.length}):${s.claims.map((cl) => `\n- [${cl.status}] ${cl.agent}: ${cl.intent}${cl.files.length ? ` — ${cl.files.join(', ')}` : ''} (id ${cl.id})`).join('') || ' none'}`);
      if (s.conflicts.length) out.push(`CONFLICTS (${s.conflicts.length}):${s.conflicts.map((k) => `\n- ${k.between[0].agent} <-> ${k.between[1].agent}: ${k.between[0].intent} / ${k.between[1].intent}`).join('')}`);
      out.push(`Open bugs (${s.bugs.filter((b) => b.status !== 'fixed').length}):${s.bugs.filter((b) => b.status !== 'fixed').map((b) => `\n- [${b.severity}] ${b.title}`).join('') || ' none'}`);
      if (s.completed.length) out.push(`Recently completed: ${s.completed.slice(0, 5).map((cl) => cl.intent).join('; ')}`);
      return out.join('\n');
    },
  },
];

let pendingInit = null; // {project, agent, developer} between init and confirm

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
        serverInfo: { name: 'mediation', version: '0.2.0' },
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
        const hint = err.status === 401
          ? ' (credential invalid or revoked — run mediation_init again)'
          : err.name === 'TimeoutError' || err.cause?.code === 'ECONNREFUSED'
            ? ` (mediation server ${SERVER} unreachable)` : '';
        return reply({ content: [{ type: 'text', text: `error: ${err.message}${hint}` }], isError: true });
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
