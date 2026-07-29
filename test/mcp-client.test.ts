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
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const claimPosts: any[] = [];
const completions: any[] = [];
const beats: any[] = [];
let bigState = false; // when set, the stub answers with a busy project
// When set, the stub answers a completion the way the server does for a claim
// it had to adopt from an ended session.
let stubNote: string | null = null;
let stubIssueUrl: string | null = ISSUE; // what the stub says a patched bug is linked to
// Destroy the sockets of the next N /check requests before responding. Scoped
// to /check because stray heartbeats from a dying child of an earlier test
// would otherwise absorb the destruction (their failures are tolerated).
let destroyCheckSockets = 0;
// Never answer /check requests, so the client's own request budget expires.
let hangCheck = false;

before(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url?.split('?')[0]}`);
    if (destroyCheckSockets > 0 && req.url?.includes('/check')) {
      destroyCheckSockets -= 1;
      return req.socket.destroy();
    }
    if (hangCheck && req.url?.includes('/check')) return;
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
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { try { beats.push(JSON.parse(raw || '{}')); } catch { /* ignore */ } });
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
    if (req.url?.startsWith(`/api/projects/${PROJECT_ID}/state`)) {
      return send({
        sessions: [], conflicts: [], recentFiles: [],
        claims: bigState
          ? Array.from({ length: 14 }, (_, i) => ({
            id: `claim-${i}`, agent: `agent-${i}`, intent: `work ${i}`, status: 'in-progress',
            files: Array.from({ length: 8 }, (_, f) => `src/file-${i}-${f}.ts`), blockedOn: null,
          }))
          : [],
        completed: bigState
          ? [{ id: 'old-1', intent: 'earlier work', summary: 'the parser eats CRLF', commits: [] }]
          : [],
        bugs: [{ id: 'bug-1', title: 'flaky billing test', severity: 'high', status: 'open', issueUrl: ISSUE }],
        news: [{ seq: 7, type: 'finding', at: Date.now() - 60_000, agent: 'codex@acme',
          reason: 'overlap', message: 'codex@acme found (api-change): proj() now returns a base path' }],
      });
    }
    if (req.url === `/api/projects/${PROJECT_ID}/claims`) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      return req.on('end', () => {
        claimPosts.push(JSON.parse(raw || '{}'));
        send({ claim: { id: 'claim-1', intent: 'test work', status: 'investigating' }, conflicts: [], news: [] });
      });
    }
    if (req.url?.endsWith('/complete')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      return req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        completions.push(body);
        send({ id: 'claim-1', intent: 'test work', status: body.status ?? 'done', commits: body.commits ?? [],
          ...(stubNote ? { note: stubNote } : {}) });
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

// The tool surface is five tools. Anything more is context every agent pays for
// on every call, and one more decision it can get wrong.
test('the client exposes exactly the five consolidated tools', async () => {
  const names = await new Promise<string[]>((resolve, reject) => {
    const child = spawn('node', [CLIENT], {
      env: { ...process.env, MEDIATION_URL: origin, MEDIATION_DIR: repo, MEDIATION_AUTH_HOME: authHome },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, 15_000);
    child.stdout!.on('data', (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result.tools.map((t: { name: string }) => t.name));
        }
      }
    });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
  });
  assert.deepEqual(names.sort(),
    ['mediation_bug', 'mediation_claim', 'mediation_init', 'mediation_setup', 'mediation_state']);
});

test('mediation_claim binds a GitHub session and publishes the claim', async () => {
  claimPosts.length = 0;
  const out = await callTool('mediation_claim', { intent: 'test work', files: ['src/app.ts'] });
  assert.match(out, /Claim created: claim-1/);
  assert.ok(seen.includes('POST /api/repositories/github/session'), seen.join(', '));
  assert.equal(claimPosts.at(-1)?.intent, 'test work');
});

// Claiming IS checking: the create response carries the same overlap warnings,
// so a separate look-first call was a round trip that published nothing.
test('mediation_claim dryRun checks for overlap without publishing anything', async () => {
  claimPosts.length = 0;
  const out = await callTool('mediation_claim', { files: ['src/app.ts'], intent: 'test', dryRun: true });
  assert.match(out, /No overlapping work detected/);
  assert.match(out, /Nothing was published/);
  assert.ok(seen.includes(`GET /api/projects/${PROJECT_ID}/check`), seen.join(', '));
  assert.equal(claimPosts.length, 0, 'dryRun must not create a claim');
});

// Backing off a conflict has to be expressible, or the claim lingers as a
// phantom warning for everyone else until it idles out.
test('mediation_claim abandons a claim without pretending work was delivered', async () => {
  completions.length = 0;
  const out = await callTool('mediation_claim', { claimId: 'claim-1', status: 'abandoned' });
  assert.match(out, /Abandoned: "test work"/);
  assert.match(out, /kept out of the completed feed/);
  assert.equal(completions.at(-1)?.status, 'abandoned');
});

test('mediation_claim finishes a claim with its commits', async () => {
  completions.length = 0;
  const out = await callTool('mediation_claim',
    { claimId: 'claim-1', status: 'done', commits: ['abc1234'], summary: 'fixed it' });
  assert.match(out, /Completed: "test work" \(abc1234\)/);
  assert.deepEqual(completions.at(-1)?.commits, ['abc1234']);
});

test('mediation_setup reports the resolved repository and sign-in state', async () => {
  const out = await callTool('mediation_setup');
  assert.match(out, /github\.com\/acme\/widgets/);
});

// News rides back on a call the agent was making anyway. That is the whole
// mechanism: MCP cannot push into a model's context, so there is no other
// moment to hand it over without making the agent poll.
test('news relevant to this agent rides back on the response', async () => {
  const out = await callTool('mediation_state', {}, { PATH: `${ghDeadBin}:${process.env.PATH}` });
  assert.match(out, /NEWS \(1, relevant to files you claimed\)/);
  assert.match(out, /\[touches your work\] codex@acme found \(api-change\)/);
});

// mediation_state is the most expensive response in the system, and it is most
// expensive exactly when the project is busiest: five agents holding claims over
// real file lists. Counted, not printed.
test('mediation_state caps a busy project instead of dumping it', async () => {
  bigState = true;
  try {
    const out = await callTool('mediation_state', {}, { PATH: `${ghDeadBin}:${process.env.PATH}` });
    assert.match(out, /Active claims \(14\)/);
    assert.match(out, /\.\.\.and 4 more/, 'claims past the cap must be counted, not listed');
    assert.match(out, /src\/file-0-4\.ts \+3 more/, 'a long file list is truncated inline');
    assert.ok(!out.includes('work 12'), 'a capped claim must not be printed');
    // Summaries are the highest-signal thing on the board and used to be hidden.
    assert.match(out, /earlier work: the parser eats CRLF/);
  } finally {
    bigState = false;
  }
});

// The beat is the only thing that fires while the agent is heads-down coding
// and calling no tools, which is exactly when overlap data goes stale.
test('the heartbeat reports what the working tree actually has dirty', async () => {
  beats.length = 0;
  writeFileSync(join(repo, 'scratch.txt'), 'uncommitted work\n');
  try {
    const child = await new Promise<ChildProcess>((resolve, reject) => {
      const c = spawnClient('mediation_claim', { dryRun: true }, () => resolve(c));
      c.on('error', reject);
    });
    try {
      const deadline = Date.now() + 12_000;
      while (!beats.some((b) => b.dirtyFiles?.length) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      child.kill();
    }
    const carried = beats.find((b) => b.dirtyFiles?.length);
    assert.ok(carried, `no beat carried dirty files, saw ${JSON.stringify(beats)}`);
    assert.ok(carried.dirtyFiles.includes('scratch.txt'), JSON.stringify(carried));
    assert.equal(carried.branch, 'main');
  } finally {
    rmSync(join(repo, 'scratch.txt'), { force: true });
  }
});

/* A resumed agent finishing a claim the server had to adopt or revive must be
   told, or the tool quietly reports something other than what happened. */
test('what the server had to do to honour the call comes back with it', async () => {
  stubNote = 'Your previous session had ended; this claim is attached to your current one.';
  try {
    const out = await callTool('mediation_claim', { claimId: 'claim-1', status: 'done', commits: ['abc1234'] });
    assert.match(out, /Completed: "test work"/);
    assert.match(out, /previous session had ended/);
  } finally {
    stubNote = null;
  }
});

/* Session creation carries no repo state, so before this an agent that
   connected and then coded without claiming was invisible to everyone for a
   whole heartbeat interval: exactly the window the dashboard needs it. */
test('the working tree goes out at session start, not one interval later', async () => {
  beats.length = 0;
  writeFileSync(join(repo, 'immediate.txt'), 'uncommitted work\n');
  const started = Date.now();
  try {
    await callTool('mediation_claim', { dryRun: true });
    // The stub's 8 s TTL makes the interval 2 s, so a beat inside this window
    // can only be the one fired when the session was created.
    const deadline = started + 1_500;
    while (!beats.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(beats.length, 'no working-tree report arrived before the first heartbeat interval');
    assert.ok(beats[0].dirtyFiles?.includes('immediate.txt'), JSON.stringify(beats[0]));
  } finally {
    rmSync(join(repo, 'immediate.txt'), { force: true });
  }
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

// Merging file-a-bug and resolve-a-bug has exactly one way to go silently
// wrong, and it is worth an explicit error: an agent meaning to close a bug,
// forgetting the id but still sending a title, would file a duplicate.
test('mediation_bug refuses an ambiguous call rather than filing a duplicate', async () => {
  const out = await callTool('mediation_bug', { bugId: 'bug-1', title: 'flaky billing test' });
  assert.match(out, /send either bugId .* or title .* never both/);
});

test('mediation_bug closes a bug this session did not report, and its issue', async () => {
  const out = await callTool('mediation_bug', { bugId: 'bug-1', status: 'fixed' },
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
test('mediation_bug opens an issue for a bug escalated to high', async () => {
  patches.length = 0;
  stubIssueUrl = null; // not linked yet
  try {
    const out = await callTool('mediation_bug', { bugId: 'bug-1', severity: 'high' },
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
    const c = spawnClient('mediation_claim', { dryRun: true }, () => resolve(c));
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

// A pooled keep-alive socket the edge has already closed dies before any HTTP
// response exists. undici reports that as a bare "fetch failed" and never
// retries a request with a body, so the client must retry once itself.
test('a request whose socket dies is retried once and succeeds', async () => {
  destroyCheckSockets = 1;
  const out = await callTool('mediation_claim', { files: ['src/app.ts'], intent: 'retry', dryRun: true });
  assert.match(out, /No overlapping work detected/);
  assert.equal(destroyCheckSockets, 0, 'the doomed request never reached the server');
});

test('a persistent connection failure names the socket error, not bare "fetch failed"', async () => {
  destroyCheckSockets = 1000; // the attempt and its retry both die
  try {
    const out = await callTool('mediation_claim', { files: ['src/app.ts'], intent: 'retry', dryRun: true });
    assert.match(out, /error: fetch failed \((ECONNRESET|EPIPE|UND_ERR_SOCKET)\) on GET \/api\/projects\/[0-9a-f-]+\/check/);
  } finally {
    destroyCheckSockets = 0;
  }
});

// A repo and credential store bound to an origin other than the stub's, for
// tests that need the client to talk to a dead or unroutable server.
function repoFor(server: string): { dir: string, home: string, drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mediation-mcp-repo2-'));
  const g = (...args: string[]) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' });
  g('init', '-b', 'main');
  g('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  writeFileSync(join(dir, '.mediation.json'), JSON.stringify({
    server, repository: { owner: 'acme', repository: 'widgets' },
  }));
  const home = mkdtempSync(join(tmpdir(), 'mediation-mcp-auth2-'));
  writeFileSync(join(home, 'credentials.json'),
    JSON.stringify({ [server]: { token: 'device-token', username: 'gh-acme' } }));
  return { dir, home, drop: () => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

// A local port that nothing listens on: bind, read the number, close.
async function deadPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

// Node's Happy Eyeballs abandons each connect attempt after 250ms by default.
// On a network advertising IPv6 it cannot reach, every request rides the IPv4
// fallback, and a Cloudflare TCP connect that spikes past 250ms fails the
// whole fetch with ETIMEDOUT (measured: 5 of 20 requests). The client must
// raise the attempt timeout at load, before any fetch.
test('the client widens the Happy Eyeballs attempt timeout at load', () => {
  const probe = `import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
    await import(${JSON.stringify(pathToFileURL(resolve(CLIENT)).href)});
    console.log(getDefaultAutoSelectFamilyAttemptTimeout());
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
    { env: { ...process.env, MEDIATION_URL: origin }, encoding: 'utf8' as const, input: '', timeout: 10_000 });
  assert.equal(r.stdout.trim(), '2000');
});

// The request budget expiring says nothing about the server, and the request
// may even have been executed: the server has no idempotency key on writes,
// so repeating it can duplicate one. Not retried, not reported as a down
// server — the agent is told to check mediation_state instead.
test('a timed-out request reads as slow, not unreachable, and is never sent twice', async () => {
  hangCheck = true;
  seen.length = 0;
  try {
    const out = await callTool('mediation_claim', { files: ['src/app.ts'], intent: 'slow', dryRun: true });
    assert.match(out, /no answer from .+ within 5s on GET \/api\/projects\/[0-9a-f-]+\/check/);
    assert.doesNotMatch(out, /unreachable/);
    assert.equal(seen.filter((s) => s.includes('/check')).length, 1, 'a timed-out request must not be repeated');
  } finally {
    hangCheck = false;
  }
});

// A refusal is an answer, not an accident: nothing listens there. It is the
// one code (with ENOTFOUND) that keeps the "unreachable" verdict, and
// retrying it would only double the wait before the human is told.
test('a refused connection still reads as unreachable and fails fast', async () => {
  const dead = `http://127.0.0.1:${await deadPort()}`;
  const bound = repoFor(dead);
  try {
    const started = Date.now();
    const out = await callTool('mediation_state', {},
      { MEDIATION_URL: dead, MEDIATION_DIR: bound.dir, MEDIATION_AUTH_HOME: bound.home });
    assert.match(out, /\(ECONNREFUSED\) on GET \/api\/health/);
    assert.match(out, /unreachable/);
    assert.ok(Date.now() - started < 5000, 'a refusal must fail fast, not burn retries or timeouts');
  } finally {
    bound.drop();
  }
});

// The real-world failure shape end to end: the first address black-holes, so
// Happy Eyeballs abandons it and falls through to a refused local port, and
// fetch fails with an AggregateError whose code is the FIRST attempt's. That
// is a path failure the server never saw: retried, and never called a down
// server. (A sandbox with no default route fails the first address instantly
// with ENETUNREACH instead — same classification, hence the alternation.)
test('a connect-phase timeout is a retried path failure, not a down server', async () => {
  const bh = `http://blackhole.invalid:${await deadPort()}`;
  const bound = repoFor(bh);
  try {
    const started = Date.now();
    const out = await callTool('mediation_state', {}, {
      MEDIATION_URL: bh, MEDIATION_DIR: bound.dir, MEDIATION_AUTH_HOME: bound.home,
      NODE_OPTIONS: `--import ${pathToFileURL(resolve('test/dns-blackhole.mjs')).href}`,
    });
    assert.match(out, /\((ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\) on GET \/api\/health/);
    assert.match(out, /server itself may be fine/);
    assert.doesNotMatch(out, /unreachable\)/);
    // Two attempts of ~2s each when the first address truly black-holes; the
    // guard exists because the instant-ENETUNREACH sandbox has no such floor.
    if (/ETIMEDOUT/.test(out)) {
      assert.ok(Date.now() - started >= 3500, 'expected the timed-out connect to be retried once');
    }
  } finally {
    bound.drop();
  }
});
