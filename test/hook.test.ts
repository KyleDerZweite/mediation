import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'mediation-hook-'));
const repo = join(root, 'repo');
const nested = join(repo, 'nested');
const auth = join(root, 'auth');
const hook = resolve('clients/mediation-hook.mjs');
mkdirSync(nested, { recursive: true });
mkdirSync(auth, { recursive: true });

const seen: { path: string; auth?: string; body: Record<string, unknown> }[] = [];
let responseStatus = 200;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url === '/api/projects') {
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    res.end(responseStatus === 200 ? JSON.stringify([{ id: 'project-1', name: 'Acme/Widgets' }]) : '{}');
    return;
  }
  seen.push({ path: req.url || '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
  res.writeHead(responseStatus, { 'content-type': 'application/json' });
  res.end('{}');
});
let origin = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(join(repo, '.mediation.json'), JSON.stringify({ server: origin, repository: { owner: 'acme', repository: 'widgets' } }));
  writeFileSync(join(auth, 'credentials.json'), JSON.stringify({ [origin]: { token: 'device-secret' } }));
});
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

function run(input: Record<string, unknown>, extra: Record<string, string> = {}, harness = 'codex') {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [hook, '--harness', harness, '--server', origin], {
      cwd: nested,
      env: { ...process.env, MEDIATION_AUTH_HOME: auth, ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('maps root and child lifecycle without exporting private hook fields', async () => {
  seen.length = 0;
  const privateFields = {
    transcript_path: '/secret/transcript.jsonl', prompt: 'do not send me',
    last_assistant_message: 'private answer', tool_input: { command: 'cat .env' },
  };
  let result = await run({ hook_event_name: 'SessionStart', session_id: 'run-1', cwd: nested, agent_type: 'root-role', ...privateFields });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  result = await run({ hook_event_name: 'SubagentStart', session_id: 'run-1', agent_id: 'child-1', cwd: nested,
    agent_type: 'Explore', ...privateFields });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((request) => request.path), Array(3).fill('/api/projects/project-1/agent-events'));
  assert.equal(seen.every((request) => request.auth === 'Bearer device-secret'), true);
  const runId = seen[0]!.body.runId;
  const childId = seen[2]!.body.agentId;
  const rootAt = seen[0]!.body.occurredAt;
  const childAt = seen[1]!.body.occurredAt;
  assert.match(String(runId), /^native-[a-f0-9]{32}$/);
  assert.match(String(childId), /^native-[a-f0-9]{32}$/);
  assert.equal(typeof rootAt, 'number');
  assert.equal(typeof childAt, 'number');
  assert.equal(seen[2]!.body.occurredAt, childAt);
  assert.deepEqual(seen[0]!.body, {
    eventId: seen[0]!.body.eventId, runId, agentId: runId, harness: 'codex', role: 'root-role', state: 'active',
    occurredAt: rootAt,
  });
  assert.deepEqual(seen[1]!.body, {
    eventId: seen[1]!.body.eventId, runId, agentId: runId, harness: 'codex', state: 'active', occurredAt: childAt,
  });
  assert.deepEqual(seen[2]!.body, {
    eventId: seen[2]!.body.eventId, runId, agentId: childId, parentAgentId: runId,
    harness: 'codex', role: 'Explore', state: 'active', occurredAt: childAt,
  });
  assert.doesNotMatch(JSON.stringify(seen.map((request) => request.body)),
    /run-1|child-1|\/secret\/transcript|private answer|cat \.env|prompt|transcript|tool_input/);
});

test('each stop occurrence is distinct and never reopens the root', async () => {
  seen.length = 0;
  const input = { hook_event_name: 'SubagentStop', session_id: 'run-2', agent_id: 'child-2', cwd: nested, agent_type: 'Plan' };
  await run(input); await run(input);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]!.body.eventId, seen[1]!.body.eventId);
  assert.equal(seen.every((request) => request.body.state === 'completed'), true);
  assert.equal(seen.every((request) => request.body.agentId !== request.body.runId), true);
});

test('a resumed native session gets a new Start occurrence after completion', async () => {
  seen.length = 0;
  const base = { session_id: 'resumed-run', cwd: nested };
  await run({ ...base, hook_event_name: 'SessionStart' });
  await run({ ...base, hook_event_name: 'SessionEnd' });
  await run({ ...base, hook_event_name: 'SessionStart' });
  assert.deepEqual(seen.map((request) => request.body.state), ['active', 'completed', 'active']);
  assert.equal(new Set(seen.map((request) => request.body.eventId)).size, 3);
  assert.equal(seen.every((request) => typeof request.body.occurredAt === 'number'), true);
});

test('maps Claude root completion without reading Claude-only private output', async () => {
  seen.length = 0;
  const result = await run({ hook_event_name: 'SessionEnd', session_id: 'claude-run', cwd: nested,
    last_assistant_message: 'must stay local', transcript_path: '/private.jsonl' }, {}, 'claude-code');
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  const runId = seen[0]!.body.runId;
  const occurredAt = seen[0]!.body.occurredAt;
  assert.deepEqual(seen[0]!.body, {
    eventId: seen[0]!.body.eventId, runId, agentId: runId, harness: 'claude-code', state: 'completed', occurredAt,
  });
  assert.doesNotMatch(JSON.stringify(seen[0]!.body), /claude-run|must stay local|private\.jsonl/);
});

test('is silent and fail-open when offline, unconfigured, or given unsafe identity', async () => {
  seen.length = 0;
  responseStatus = 503;
  let result = await run({ hook_event_name: 'SessionEnd', session_id: 'run-3', cwd: nested });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  responseStatus = 200;
  result = await run({ hook_event_name: 'SubagentStart', session_id: 'unsafe/id', agent_id: 'child', cwd: nested });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  result = await run({ hook_event_name: 'SessionStart', session_id: 'run-4', cwd: join(root, 'missing') });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  assert.equal(seen.length, 0);
});
