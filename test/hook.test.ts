import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'mediation-hook-'));
const repo = join(root, 'repo');
const nested = join(repo, 'nested');
const auth = join(root, 'auth');
const debounceState = join(root, 'state');
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
      env: { ...process.env, MEDIATION_AUTH_HOME: auth, MEDIATION_STATE_HOME: debounceState, ...extra },
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

test('maps observed Claude activity onto the shared state enum', async () => {
  seen.length = 0;
  const cases: [Record<string, unknown>, string, string][] = [
    [{ hook_event_name: 'UserPromptSubmit', prompt: 'do not send me' }, 'active', 'processing prompt'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 'active', 'running a command'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Write' }, 'active', 'editing files'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Grep' }, 'active', 'reading code'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Task' }, 'active', 'delegating to a subagent'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'mcp__mediation__mediation_claim' }, 'active', 'using an MCP tool'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'WebFetch' }, 'active', 'browsing'],
    [{ hook_event_name: 'PreToolUse', tool_name: 'SecretInternalTool' }, 'active', 'using a tool'],
    [{ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 'active', 'working'],
    [{ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' },
      'needs-input', 'waiting for approval'],
    [{ hook_event_name: 'Notification', message: 'still here?' }, 'needs-input', 'needs attention'],
    [{ hook_event_name: 'Stop' }, 'waiting', 'idle'],
    [{ hook_event_name: 'PreCompact' }, 'active', 'compacting context'],
  ];
  for (const [index, [input, state, reason]] of cases.entries()) {
    // A distinct session per case keeps each mapping isolated from the debounce.
    const result = await run({ ...input, session_id: `observed-${index}`, cwd: nested }, {}, 'claude-code');
    assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
    assert.equal(seen[index]!.body.state, state, `${input.hook_event_name} ${input.tool_name ?? ''}`);
    assert.equal(seen[index]!.body.stateReason, reason);
    assert.equal(seen[index]!.body.agentId, seen[index]!.body.runId);
  }
  assert.equal(seen.length, cases.length);
});

test('tool activity never carries the tool name, its input, or a notification message', async () => {
  seen.length = 0;
  const result = await run({
    hook_event_name: 'PreToolUse', session_id: 'private-tools', cwd: nested, tool_name: 'Edit',
    tool_input: { file_path: '/home/dev/.env', old_string: 'API_KEY=live', command: 'rm -rf /' },
    prompt: 'do not send me', transcript_path: '/secret/transcript.jsonl',
  }, {}, 'claude-code');
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.body.stateReason, 'editing files');
  assert.doesNotMatch(JSON.stringify(seen[0]!.body),
    /Edit|\.env|API_KEY|rm -rf|do not send me|transcript|private-tools|tool_name|tool_input/);
});

test('only observed state changes reach the network, each as a fresh occurrence', async () => {
  seen.length = 0;
  const base = { session_id: 'debounced-run', cwd: nested };
  await run({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read' }, {}, 'claude-code');
  await run({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read' }, {}, 'claude-code');
  await run({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Glob' }, {}, 'claude-code');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.body.stateReason, 'reading code');
  // Same state, different phrase, inside the rate window: still nothing.
  await run({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, {}, 'claude-code');
  assert.equal(seen.length, 1);
  // A changed state always goes out, and repeats of it do not.
  await run({ ...base, hook_event_name: 'Stop' }, {}, 'claude-code');
  await run({ ...base, hook_event_name: 'Stop' }, {}, 'claude-code');
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.body.state, 'waiting');
  assert.notEqual(seen[0]!.body.eventId, seen[1]!.body.eventId);
  // Lifecycle events are never debounced: they carry structure a repeat still
  // has to deliver, and SessionEnd retires the cache for the run.
  await run({ ...base, hook_event_name: 'SessionEnd' }, {}, 'claude-code');
  await run({ ...base, hook_event_name: 'SessionEnd' }, {}, 'claude-code');
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen.map((request) => request.body.eventId)).size, 4);
});

test('the first observed activity after a lifecycle event is not rate limited away', async () => {
  seen.length = 0;
  const base = { session_id: 'fresh-reason', cwd: nested };
  // A lifecycle report carries no reason, so gaining one is worth a post even
  // though the state is unchanged and the rate window has not elapsed.
  await run({ ...base, hook_event_name: 'SessionStart' }, {}, 'claude-code');
  await run({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read' }, {}, 'claude-code');
  assert.deepEqual(seen.map((request) => [request.body.state, request.body.stateReason]),
    [['active', undefined], ['active', 'reading code']]);
});

test('the debounce cache is a private scratch file that holds no harness content', async () => {
  seen.length = 0;
  const scratch = join(root, 'scratch');
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'ORIGINAL');
  const input = { hook_event_name: 'PreToolUse', session_id: 'cache-privacy', cwd: nested, tool_name: 'Edit',
    tool_input: { file_path: '/home/dev/.env' }, prompt: 'do not send me' };
  await run(input, { MEDIATION_STATE_HOME: scratch }, 'claude-code');
  assert.equal(statSync(scratch).mode & 0o777, 0o700);
  const files = readdirSync(scratch);
  assert.equal(files.length, 1, 'one cache file per run and no temp file left behind');
  const cache = join(scratch, files[0]!);
  assert.match(files[0]!, /^native-[a-f0-9]{32}\.json$/);
  assert.equal(lstatSync(cache).isFile(), true);
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(cache, 'utf8'),
    /cache-privacy|Edit|\.env|do not send me|nested|Bearer|device-secret/);
  // The scratch directory is predictable and may be owned by another local
  // user: a symlink planted on the cache path is replaced, never written
  // through, and the temp file it is renamed from is never an existing path.
  rmSync(cache);
  symlinkSync(outside, cache);
  await run({ ...input, tool_name: 'Bash' }, { MEDIATION_STATE_HOME: scratch }, 'claude-code');
  assert.equal(readFileSync(outside, 'utf8'), 'ORIGINAL');
  assert.equal(lstatSync(cache).isSymbolicLink(), false);
  assert.deepEqual(readdirSync(scratch), files);
});

test('an unreported harness event is ignored without a request', async () => {
  seen.length = 0;
  for (const event of ['SessionResumed', 'PreToolUseExtra', 'notification', '']) {
    const result = await run({ hook_event_name: event, session_id: 'unknown-run', cwd: nested }, {}, 'claude-code');
    assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  }
  assert.equal(seen.length, 0);
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
