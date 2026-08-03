#!/usr/bin/env node
// Fail-open lifecycle bridge for Codex and Claude Code. It deliberately reads
// only stable identity fields from hook stdin; prompts, transcripts, tool data,
// assistant messages, and the original input never leave this process.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const take = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const harness = take('--harness');
const rawServer = take('--server') || process.env.MEDIATION_URL;
const allowedHarnesses = new Set(['codex', 'claude-code']);
const allowedEvents = new Set(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
const idPattern = /^[A-Za-z0-9._:-]+$/;
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

async function request(server, token, method, apiPath, body) {
  try {
    const response = await fetch(`${server}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
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

function payload(input, event, root = false) {
  const runId = safeId(input.session_id);
  const childId = safeId(input.agent_id);
  const agentId = root || !event.startsWith('Subagent') ? runId : childId;
  if (!runId || !agentId) return null;
  const state = event.endsWith('Start') ? 'active' : 'completed';
  const key = root && event.startsWith('Subagent')
    ? ['root-observed', event, runId, childId]
    : [event, runId, agentId];
  return {
    eventId: eventId(harness, ...key),
    runId,
    agentId,
    ...(root || agentId === runId ? {} : { parentAgentId: runId }),
    harness,
    ...(root ? {} : { role: safeRole(input.agent_type) }),
    state: root && event === 'SubagentStop' ? 'active' : state,
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
  if (!input || !allowedEvents.has(event)) return;
  const agent = payload(input, event);
  if (!agent) return;
  const token = credential(server);
  if (!token) return;
  const state = findState(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!state) return;
  if (state.server) {
    try { if (new URL(state.server).origin !== server) return; } catch { return; }
  }
  const projects = await request(server, token, 'GET', '/api/projects');
  const project = projectId(state, projects);
  if (!project) return;
  const endpoint = `/api/projects/${encodeURIComponent(project)}/agent-events`;
  if (event.startsWith('Subagent')) {
    const root = payload(input, event, true);
    if (root) await request(server, token, 'POST', endpoint, root);
  }
  await request(server, token, 'POST', endpoint, agent);
}

await main().catch(() => {});
