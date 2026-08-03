#!/usr/bin/env node
// Fail-open lifecycle bridge for Codex and Claude Code. It deliberately reads
// only stable identity fields from hook stdin; prompts, transcripts, tool data,
// assistant messages, and the original input never leave this process.
//
// Tool-level events extend that contract, they do not weaken it. `tool_name`
// and a notification `message` are read LOCALLY to pick one of the fixed
// phrases in ACTIVITY below; neither the tool name itself nor any tool input,
// path, command, URL, prompt, or notification text is ever sent. An unrecognised
// tool falls back to 'using a tool', so a custom or MCP tool name cannot leak
// through the mapping.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const take = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const harness = take('--harness');
const rawServer = take('--server') || process.env.MEDIATION_URL;
const allowedHarnesses = new Set(['codex', 'claude-code']);
const lifecycleEvents = new Set(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
const idPattern = /^[A-Za-z0-9._:-]+$/;
// Coarse categories, keyed by tool name only. Anything unlisted is 'using a
// tool': the fallback is what keeps an unknown tool name out of the payload.
const ACTIVITY = {
  Bash: 'running a command', BashOutput: 'running a command', KillShell: 'running a command',
  Edit: 'editing files', MultiEdit: 'editing files', Write: 'editing files', NotebookEdit: 'editing files',
  Read: 'reading code', Grep: 'reading code', Glob: 'reading code',
  Task: 'delegating to a subagent', Agent: 'delegating to a subagent',
  WebFetch: 'browsing', WebSearch: 'browsing',
};
// A reason-only change still costs a round trip, and read/edit/read alternation
// would post on every tool call. Gaining a reason where there was none is worth
// one post; after that, rephrasing within the same state is rate limited.
const REASON_INTERVAL_MS = 15_000;
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function safeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && idPattern.test(value)
    ? value : null;
}

function safeRole(value) {
  if (typeof value !== 'string') return undefined;
  const role = value.trim();
  return role && role.length <= 64 && !unsafeText.test(role) ? role : undefined;
}

function toolActivity(value) {
  if (typeof value !== 'string') return 'using a tool';
  if (value.startsWith('mcp__')) return 'using an MCP tool';
  return Object.hasOwn(ACTIVITY, value) ? ACTIVITY[value] : 'using a tool';
}

// Observed activity: what the agent is doing right now, mapped onto the shared
// AgentState enum. Claude Code emits these; Codex sends only the lifecycle four.
function observed(input, event) {
  switch (event) {
    case 'UserPromptSubmit': return { state: 'active', reason: 'processing prompt' };
    case 'PreToolUse': return { state: 'active', reason: toolActivity(input.tool_name) };
    case 'PostToolUse': return { state: 'active', reason: 'working' };
    case 'Notification': return {
      state: 'needs-input',
      reason: /permission|approv/i.test(typeof input.message === 'string' ? input.message : '')
        ? 'waiting for approval' : 'needs attention',
    };
    case 'Stop': return { state: 'waiting', reason: 'idle' };
    case 'PreCompact': return { state: 'active', reason: 'compacting context' };
    default: return null;
  }
}

function configDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function findState(start) {
  let dir;
  try { dir = path.resolve(start); } catch { return null; }
  while (true) {
    const file = path.join(dir, '.mediation.json');
    try {
      if (fs.statSync(file).isFile()) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function credential(server) {
  const root = process.env.MEDIATION_AUTH_HOME || path.join(configDir(), 'mediation');
  try {
    const token = JSON.parse(fs.readFileSync(path.join(root, 'credentials.json'), 'utf8'))?.[server]?.token;
    return typeof token === 'string' && token ? token : null;
  } catch { return null; }
}

// A hook is a fresh process per tool call, so the last posted state lives in a
// file. It is a cache, not a record: losing it costs one redundant post, which
// is why it sits in a scratch directory and every failure is swallowed. Two
// hooks racing on it is last-write-wins for the same reason.
function cacheFile(runId) {
  const root = process.env.MEDIATION_STATE_HOME
    || path.join(os.tmpdir(), `mediation-hook-${process.getuid?.() ?? 'user'}`);
  return path.join(root, `${runId}.json`);
}

function readCache(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeCache(file, value) {
  // The scratch directory sits at a predictable path, and `mkdir -p` accepts one
  // that already exists, so another local user may own it. 'wx' refuses any
  // existing path including a symlink, which is what stops a planted temp name
  // from turning this write into an arbitrary file write as the invoking user;
  // the unguessable suffix keeps a leftover temp file from wedging the cache.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

function changed(prior, activity, now) {
  if (!prior || prior.state !== activity.state) return true;
  if (prior.reason === activity.reason) return false;
  return !prior.reason || now - (Number(prior.at) || 0) >= REASON_INTERVAL_MS;
}

async function request(server, token, method, apiPath, body) {
  try {
    const response = await fetch(`${server}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return null;
    // Null means "did not reach the server". An accepted report with an
    // unreadable body still counts as delivered, or the cache never advances.
    return (await response.json().catch(() => null)) ?? {};
  } catch { return null; }
}

function projectId(state, projects) {
  if (!state || !Array.isArray(projects)) return null;
  if (safeId(state.project) && projects.some((project) => project?.id === state.project)) return state.project;
  const owner = state.repository?.owner;
  const repository = state.repository?.repository;
  if (typeof owner !== 'string' || typeof repository !== 'string') return null;
  const name = `${owner}/${repository}`.toLowerCase();
  return safeId(projects.find((project) => project?.name?.toLowerCase() === name)?.id);
}

function eventId(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function scopeId(server, state, value) {
  const id = safeId(value);
  const scope = state?.project
    ? `project:${state.project}`
    : state?.repository?.owner && state?.repository?.repository
      ? `github:${state.repository.owner.toLowerCase()}/${state.repository.repository.toLowerCase()}`
      : null;
  return id && scope
    ? `native-${createHash('sha256').update(`${server}\0${scope}\0${id}`).digest('hex').slice(0, 32)}`
    : null;
}

function payload(input, event, server, localState, occurrence, root = false, activity = null) {
  const runId = scopeId(server, localState, input.session_id);
  const childId = scopeId(server, localState, input.agent_id);
  const agentId = root || !event.startsWith('Subagent') ? runId : childId;
  if (!runId || !agentId) return null;
  const state = activity ? activity.state : event.endsWith('Start') ? 'active' : 'completed';
  const key = root && event.startsWith('Subagent')
    ? ['root-observed', event, runId, childId]
    : [event, runId, agentId];
  return {
    eventId: eventId(harness, occurrence.id, ...key),
    runId,
    agentId,
    ...(root || agentId === runId ? {} : { parentAgentId: runId }),
    harness,
    ...(root ? {} : { role: safeRole(input.agent_type) }),
    state,
    ...(activity ? { stateReason: activity.reason } : {}),
    occurredAt: occurrence.at,
  };
}

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1_000_000) return null;
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function main() {
  if (!allowedHarnesses.has(harness) || !rawServer) return;
  let server;
  try { server = new URL(rawServer).origin; } catch { return; }
  const input = await readInput();
  const event = input?.hook_event_name;
  const activity = input ? observed(input, event) : null;
  if (!input || (!lifecycleEvents.has(event) && !activity)) return;
  const token = credential(server);
  if (!token) return;
  const state = findState(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!state) return;
  if (state.server) {
    try { if (new URL(state.server).origin !== server) return; } catch { return; }
  }
  // One hook invocation is one lifecycle occurrence. Its nonce keeps a resumed
  // session's second Start distinct from the original Start, while a single
  // invocation gives every derived report the same ordering timestamp.
  const occurrence = { id: randomUUID(), at: Date.now() };
  const agent = payload(input, event, server, state, occurrence, false, activity);
  if (!agent) return;
  const file = cacheFile(agent.runId);
  const cache = readCache(file);
  const remember = (report) => {
    cache[report.agentId] = { state: report.state, reason: report.stateReason ?? null, at: occurrence.at };
  };
  // Only observed activity is debounced. Lifecycle events are rare and carry
  // structure a repeat still has to deliver: parent links, resumption, and the
  // terminal state that ends an execution. PreToolUse fires on every tool call
  // and the harness waits for this process, so an unchanged state must return
  // before the first request, not just before the POST.
  if (activity && !changed(cache[agent.agentId], activity, occurrence.at)) return;
  const projects = await request(server, token, 'GET', '/api/projects');
  const project = projectId(state, projects);
  if (!project) return;
  const endpoint = `/api/projects/${encodeURIComponent(project)}/agent-events`;
  if (event === 'SubagentStart') {
    const root = payload(input, event, server, state, occurrence, true);
    if (root && await request(server, token, 'POST', endpoint, root)) remember(root);
  }
  if (await request(server, token, 'POST', endpoint, agent)) remember(agent);
  if (event === 'SessionEnd') { try { fs.rmSync(file, { force: true }); } catch {} }
  else writeCache(file, cache);
}

await main().catch(() => {});
