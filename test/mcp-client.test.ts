// Drives clients/mediation-mcp.mjs the way a harness does, over stdio, with a
// stub Mediation server. The other suites test the server; nothing tested the
// client's own tool calls, which is how an unawaited session-creation promise
// shipped and broke every coordination tool in both auth modes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT_ID = '0f9a2f5c-1111-2222-3333-444455556666';
const ISSUE = 'https://github.com/acme/widgets/issues/12';
const CLIENT = 'clients/mediation-mcp.mjs';

let server: Server;
let origin = '';
let repo = '';
let authHome = '';
const seen: string[] = [];
let heartbeats = 0;
let failNextHeartbeat = false;
let ghBin = '';        // fake `gh` that answers as if signed in
let ghDeadBin = '';    // fake `gh` that fails every call, like a signed-out one
const patches: any[] = [];
let stubIssueUrl: string | null = ISSUE; // what the stub says a patched bug is linked to

before(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url?.split('?')[0]}`);
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // A short TTL makes the client beat every 2 s (TTL/4, floored), so the
    // heartbeat test below runs in seconds rather than minutes.
    if (req.url === '/api/health') return send({ ok: true, authMode: 'github-app', sessionTtlMs: 8_000 });
    if (req.url === '/api/repositories/github/session') {
      return send({ project: { id: PROJECT_ID }, session: { id: 'sess-1' }, capability: 'cap-1' });
    }
    if (req.url?.endsWith('/heartbeat')) {
      heartbeats += 1;
      if (failNextHeartbeat) {
        failNextHeartbeat = false;
        return send({ error: 'upstream hiccup' }, 502);
      }
      return send({ ok: true });
    }
    if (req.url === `/api/projects/${PROJECT_ID}/bugs`) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      return req.on('end', () => send({
        id: 'bug-1', title: 'flaky billing test', status: 'open', reporter: 'codex@acme',
        description: null, files: [],
        severity: (JSON.parse(raw || '{}').severity as string) || 'unknown',
      }));
    }
    if (req.url?.startsWith(`/api/projects/${PROJECT_ID}/bugs/`)) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      return req.on('end', () => {
        patches.push({ url: req.url, body: JSON.parse(raw || '{}') });
        const body = JSON.parse(raw || '{}');
        send({
          id: 'bug-1', title: 'flaky billing test', description: null, files: [],
          severity: body.severity || 'high',
          status: body.status || 'open',
          issueUrl: body.issueUrl ?? stubIssueUrl,
        });
      });
    }
    if (req.url === `/api/projects/${PROJECT_ID}/state`) {
      return send({
        sessions: [], claims: [], conflicts: [], completed: [], recentFiles: [],
        bugs: [{ id: 'bug-1', title: 'flaky billing test', severity: 'high', status: 'open', issueUrl: ISSUE }],
      });
    }
    if (req.url?.startsWith(`/api/projects/${PROJECT_ID}/check`)) return send({ conflicts: [] });
    if (req.url?.startsWith(`/api/projects/${PROJECT_ID}/sessions/`)) return send({ ok: true });
    return send({ error: 'not found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  repo = mkdtempSync(join(tmpdir(), 'mediation-mcp-repo-'));
  authHome = mkdtempSync(join(tmpdir(), 'mediation-mcp-auth-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  writeFileSync(join(repo, '.mediation.json'), JSON.stringify({
    server: origin, repository: { owner: 'acme', repository: 'widgets' },
  }));
  // A fake `gh` on PATH: the client must never need a real GitHub to work.
  ghBin = mkdtempSync(join(tmpdir(), 'mediation-mcp-gh-'));
  writeFileSync(join(ghBin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "auth token") echo gho_fake ;;
  "issue create") echo ${ISSUE} ;;
  "issue list") echo '[{"url":"${ISSUE}"}]' ;;
  "issue close") ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  chmodSync(join(ghBin, 'gh'), 0o755);
  ghDeadBin = mkdtempSync(join(tmpdir(), 'mediation-mcp-nogh-'));
  writeFileSync(join(ghDeadBin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  chmodSync(join(ghDeadBin, 'gh'), 0o755);

  mkdirSync(authHome, { recursive: true });
  writeFileSync(join(authHome, 'credentials.json'),
    JSON.stringify({ [origin]: { token: 'device-token', username: 'gh-acme' } }));
});

after(() => {
  server.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(authHome, { recursive: true, force: true });
  rmSync(ghBin, { recursive: true, force: true });
  rmSync(ghDeadBin, { recursive: true, force: true });
});

// Minimal MCP client: initialize, then one tools/call, then hand the reply to
// `onReply`. The caller owns the child, so a test can keep it running and watch
// what it does on its own timers.
function spawnClient(name: string, args: Record<string, unknown>, onReply: (text: string) => void,
  extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn('node', [CLIENT], {
    env: {
      ...process.env,
      MEDIATION_URL: origin, MEDIATION_DIR: repo, MEDIATION_AUTH_HOME: authHome,
      // Never let a test reach the developer's real `gh`: the default is one
      // that fails every call, and a test opts in to the working stub.
      PATH: `${ghDeadBin}:${process.env.PATH}`,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  child.stdout!.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`);
      } else if (msg.id === 2) {
        onReply(msg.result?.content?.map((c: { text: string }) => c.text).join('\n') ?? `ERROR ${JSON.stringify(msg.error)}`);
      }
    }
  });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
  return child;
}

function callTool(name: string, args: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnClient(name, args, (text) => {
      clearTimeout(timer);
      child.kill();
      resolve(text);
    }, extraEnv);
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, 15_000);
    child.on('error', reject);
  });
}

test('mediation_check binds a GitHub session and reports no overlap', async () => {
  const out = await callTool('mediation_check', { files: ['src/app.ts'], intent: 'test' });
  assert.equal(out, 'No overlapping work detected. Clear to proceed.');
  assert.ok(seen.includes('POST /api/repositories/github/session'), seen.join(', '));
  assert.ok(seen.includes(`GET /api/projects/${PROJECT_ID}/check`), seen.join(', '));
});

test('mediation_status reports the resolved repository and sign-in state', async () => {
  const out = await callTool('mediation_status');
  assert.match(out, /github\.com\/acme\/widgets/);
});

// GitHub coupling is a nice-to-have layered on the developer's own `gh`. It
// must never be load-bearing: the bug is filed first and stands on its own.
test('mediation_bug opens and links a GitHub issue when gh is signed in', async () => {
  patches.length = 0;
  const out = await callTool('mediation_bug', { title: 'flaky billing test', severity: 'high' },
    { PATH: `${ghBin}:${process.env.PATH}` });
  assert.match(out, /Bug filed/);
  assert.match(out, /Tracking issue: https:\/\/github\.com\/acme\/widgets\/issues\/12/);
  assert.equal(patches.at(-1)?.body.issueUrl, ISSUE, JSON.stringify(patches));
});

// Agents are told to file even small bugs; promoting all of them would bury the
// repository's issue list, so only high and critical earn an issue.
test('mediation_bug leaves a low-severity bug in Mediation only', async () => {
  patches.length = 0;
  const out = await callTool('mediation_bug', { title: 'flaky billing test', severity: 'low' },
    { PATH: `${ghBin}:${process.env.PATH}` });
  assert.match(out, /Bug filed/);
  assert.match(out, /Tracked in Mediation only; low severity does not open a GitHub issue/);
  assert.equal(patches.length, 0, 'a low-severity bug must not be linked to an issue');
});

test('mediation_bug still files the bug when gh is not signed in', async () => {
  patches.length = 0;
  const out = await callTool('mediation_bug', { title: 'flaky billing test', severity: 'high' },
    { PATH: `${ghDeadBin}:${process.env.PATH}` });
  assert.match(out, /Bug filed/);
  assert.match(out, /gh is not signed in/);
  assert.equal(patches.length, 0, 'nothing should be linked when there is no issue');
});

// A merged PR closes the issue and tells Mediation nothing, so orientation is
// where the two lists are brought back together.
test('mediation_state resolves bugs whose GitHub issue has been closed', async () => {
  patches.length = 0;
  const out = await callTool('mediation_state', {}, { PATH: `${ghBin}:${process.env.PATH}` });
  assert.match(out, /Resolved 1 bug\(s\) whose GitHub issue has been closed/);
  assert.equal(patches.at(-1)?.body.status, 'fixed');
  assert.match(out, /Open bugs \(0\)/);
});

test('mediation_bug_resolve closes a bug this session did not report, and its issue', async () => {
  const out = await callTool('mediation_bug_resolve', { bugId: 'bug-1', status: 'fixed' },
    { PATH: `${ghBin}:${process.env.PATH}` });
  assert.match(out, /Bug "flaky billing test" is now fixed \(high\)\./);
  assert.match(out, /Closed https:\/\/github\.com\/acme\/widgets\/issues\/12\./);
  assert.ok(seen.includes(`PATCH /api/projects/${PROJECT_ID}/bugs/bug-1`), seen.join(', '));
});

// The client used to clear its own heartbeat interval on the first failed beat,
// so one hiccup on the link expired the session and released the agent's claims
// while it was still working.
// Severity is a judgement that can change: a bug raised to high afterwards
// earns the same issue as one filed that way, or the rule would depend on the
// order events happened in.
test('mediation_bug_resolve opens an issue for a bug escalated to high', async () => {
  patches.length = 0;
  stubIssueUrl = null; // not linked yet
  try {
    const out = await callTool('mediation_bug_resolve', { bugId: 'bug-1', severity: 'high' },
      { PATH: `${ghBin}:${process.env.PATH}` });
    assert.match(out, /Now high, so it has a tracking issue: https:\/\/github\.com\/acme\/widgets\/issues\/12/);
    assert.equal(patches.at(-1)?.body.issueUrl, ISSUE);
  } finally {
    stubIssueUrl = ISSUE;
  }
});

test('a failed heartbeat does not stop the beats after it', async () => {
  heartbeats = 0;
  failNextHeartbeat = true;
  const child = await new Promise<ChildProcess>((resolve, reject) => {
    const c = spawnClient('mediation_check', {}, () => resolve(c));
    c.on('error', reject);
  });
  try {
    const deadline = Date.now() + 12_000;
    while (heartbeats < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  } finally {
    child.kill();
  }
  assert.equal(failNextHeartbeat, false, 'the first beat never reached the server');
  assert.ok(heartbeats >= 3, `expected beats to continue past the failure, saw ${heartbeats}`);
});
