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
  assert.deepEqual(seen[0]!.body, {
    eventId: seen[0]!.body.eventId, runId: 'run-1', agentId: 'run-1', harness: 'codex', role: 'root-role', state: 'active',
  });
  assert.deepEqual(seen[1]!.body, {
    eventId: seen[1]!.body.eventId, runId: 'run-1', agentId: 'run-1', harness: 'codex', state: 'active',
  });
  assert.deepEqual(seen[2]!.body, {
    eventId: seen[2]!.body.eventId, runId: 'run-1', agentId: 'child-1', parentAgentId: 'run-1',
    harness: 'codex', role: 'Explore', state: 'active',
  });
  assert.doesNotMatch(JSON.stringify(seen.map((request) => request.body)), /\/secret\/transcript|private answer|cat \.env|prompt|transcript|tool_input/);
});

test('repeated stop delivery has stable event ids and keeps the observed root active', async () => {
  seen.length = 0;
  const input = { hook_event_name: 'SubagentStop', session_id: 'run-2', agent_id: 'child-2', cwd: nested, agent_type: 'Plan' };
  await run(input); await run(input);
  assert.equal(seen.length, 4);
  assert.equal(seen[0]!.body.eventId, seen[2]!.body.eventId);
  assert.equal(seen[1]!.body.eventId, seen[3]!.body.eventId);
  assert.equal(seen[0]!.body.state, 'active');
  assert.equal(seen[1]!.body.state, 'completed');
});

test('maps Claude root completion without reading Claude-only private output', async () => {
  seen.length = 0;
  const result = await run({ hook_event_name: 'SessionEnd', session_id: 'claude-run', cwd: nested,
    last_assistant_message: 'must stay local', transcript_path: '/private.jsonl' }, {}, 'claude-code');
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(seen[0]!.body, {
    eventId: seen[0]!.body.eventId, runId: 'claude-run', agentId: 'claude-run', harness: 'claude-code', state: 'completed',
  });
  assert.doesNotMatch(JSON.stringify(seen[0]!.body), /must stay local|private\.jsonl/);
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
