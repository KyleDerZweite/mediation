// End-to-end: spawns the real server process and drives it over TCP with fetch.
// (The other suites use in-process app.request; this one exercises the wire.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://${HOST}:${PORT}`;
const P = `${BASE}/api/projects/e2e-proj`;

let child: ChildProcess;
let tmp: string;

// Tiny local helpers mirroring the other suites' `json()` / `jb()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jb = async (r: Response): Promise<any> => r.json();

const json = (method: string, url: string, body?: unknown, token?: string, cookie?: string, capability?: string) =>
  fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(capability ? { 'x-mediation-session': capability } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const cookieOf = (r: Response): string =>
  (r.headers.get('set-cookie') ?? '').match(/mediation_user=[^;]+/)?.[0] ?? '';

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'mediation-e2e-'));
  child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/server/index.ts'],
    {
      cwd: ROOT,
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST,
        DB_PATH: path.join(tmp, 'e2e.db'),
        SESSION_TTL_MS: '5000',
      },
    },
  );
  // Wait for readiness by polling /api/health.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('server did not become ready');
    await new Promise((res) => setTimeout(res, 100));
  }
});

after(() => {
  child?.kill('SIGKILL');
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('health responds ok and reports the version', async () => {
  const r = await json('GET', `${BASE}/api/health`);
  assert.equal(r.status, 200);
  const body = await jb(r);
  assert.equal(body.ok, true);
  assert.match(body.version, /^\d+\.\d+\.\d+/);
});

// Shared across the ordered flow below.
let token = '';
let credId = '';
let firstClaimId = '';
let adminCookie = '';
const capabilities = new Map<string, string>();

test('user auth: bootstrap admin, pending approval, login/me/logout over TCP', async () => {
  // First registration bootstraps an active admin.
  const first = await jb(await json('POST', `${BASE}/api/users/register`, { username: 'admin', password: 'password123' }));
  assert.equal(first.bootstrap, true);
  assert.equal(first.user.role, 'admin');
  assert.equal(first.user.status, 'active');

  const adminLogin = await json('POST', `${BASE}/api/users/login`, { username: 'admin', password: 'password123' });
  assert.equal(adminLogin.status, 200);
  adminCookie = cookieOf(adminLogin);
  assert.ok(adminCookie);

  // Second registration is a pending user.
  const bob = (await jb(await json('POST', `${BASE}/api/users/register`, { username: 'bob', password: 'password123' }))).user;
  assert.equal(bob.status, 'pending');

  // Pending login is rejected 403 (no cookie) — doubles as the agent status check.
  const pending = await json('POST', `${BASE}/api/users/login`, { username: 'bob', password: 'password123' });
  assert.equal(pending.status, 403);
  assert.equal((await jb(pending)).status, 'pending');
  assert.equal(cookieOf(pending), '');

  // Admin approves via PATCH with the admin cookie.
  const approve = await json('PATCH', `${BASE}/api/users/${bob.id}`, { status: 'active' }, undefined, adminCookie);
  assert.equal(approve.status, 200);

  // Bob can now log in, hit /me, then log out.
  const bobLogin = await json('POST', `${BASE}/api/users/login`, { username: 'bob', password: 'password123' });
  assert.equal(bobLogin.status, 200);
  const bobCookie = cookieOf(bobLogin);
  assert.equal((await jb(await json('GET', `${BASE}/api/users/me`, undefined, undefined, bobCookie))).user.username, 'bob');
  assert.equal((await json('POST', `${BASE}/api/users/logout`, undefined, undefined, bobCookie)).status, 200);
  assert.equal((await json('GET', `${BASE}/api/users/me`, undefined, undefined, bobCookie)).status, 401);
});

test('device login issues a bearer after account activation; bogus bearer 401', async () => {
  const deviceLogin = await jb(await json('POST', `${BASE}/api/auth/device-login`, {
    username: 'admin', password: 'password123', machine: 'box',
  }));
  token = deviceLogin.token;
  assert.ok(token.length > 30);

  const me = await json('GET', `${BASE}/api/auth/me`, undefined, token);
  assert.equal(me.status, 200);
  assert.equal((await jb(me)).ownerUsername, 'admin');

  // bogus bearer is rejected on a normal /api route
  assert.equal((await json('GET', `${BASE}/api/projects`, undefined, 'not-a-real-token')).status, 401);
});

test('session + claim flow surfaces overlap conflicts', async () => {
  const a = await jb(await json('POST', `${P}/sessions`, { agent: 'agent-a' }, token));
  assert.ok(a.id);
  capabilities.set(a.id, a.capability);

  const hb = await json('POST', `${P}/sessions/${a.id}/heartbeat`, { activity: 'exploring' }, token, undefined, capabilities.get(a.id));
  assert.equal(hb.status, 200);

  const first = await jb(await json('POST', `${P}/claims`, {
    sessionId: a.id, intent: 'Fix crash in tokenizer', files: ['src/tokenizer.ts'],
  }, token, undefined, capabilities.get(a.id)));
  firstClaimId = first.claim.id;
  assert.equal(first.conflicts.length, 0);

  const b = await jb(await json('POST', `${P}/sessions`, { agent: 'agent-b' }, token));
  capabilities.set(b.id, b.capability);
  const second = await jb(await json('POST', `${P}/claims`, {
    sessionId: b.id, intent: 'Investigate tokenizer crash', files: ['src/tokenizer.ts'],
  }, token, undefined, capabilities.get(b.id)));
  assert.ok(second.conflicts.length >= 1, 'overlapping claim warns');
  assert.equal(second.conflicts[0].claimId, firstClaimId);
});

test('check endpoint reports overlap', async () => {
  const r = await json('GET', `${P}/check?files=src/tokenizer.ts`, undefined, token);
  assert.equal(r.status, 200);
  const body = await jb(r);
  assert.ok(body.conflicts.length >= 1);
});

test('complete claim then state shows it done', async () => {
  const done = await jb(await json('POST', `${P}/claims/${firstClaimId}/complete`, {
    commits: ['abc1234'], summary: 'fixed lookahead',
  }, token, undefined, capabilities.get([...capabilities.keys()][0])));
  assert.equal(done.status, 'done');

  const state = await jb(await json('GET', `${P}/state`, undefined, token));
  assert.ok(state.completed.some((c: { id: string }) => c.id === firstClaimId));
  assert.ok(!state.claims.some((c: { id: string }) => c.id === firstClaimId));
});

test('projects: dashboard create, member gate, add-by-username over TCP', async () => {
  const created = await json('POST', `${BASE}/api/projects`, { id: 'e2e-private' }, undefined, adminCookie);
  assert.equal(created.status, 200);
  assert.equal((await json('POST', `${BASE}/api/projects`, { id: 'e2e-private' }, undefined, adminCookie)).status, 409);
  assert.equal((await json('POST', `${BASE}/api/projects`, { id: 'agent-made' }, token)).status, 403); // human-only

  // A second human: register → admin approves → login.
  const carol = (await jb(await json('POST', `${BASE}/api/users/register`,
    { username: 'carol', password: 'password123' }))).user;
  await json('PATCH', `${BASE}/api/users/${carol.id}`, { status: 'active' }, undefined, adminCookie);
  const carolCookie = cookieOf(await json('POST', `${BASE}/api/users/login`,
    { username: 'carol', password: 'password123' }));
  assert.ok(carolCookie);

  // Not a member yet: 403 with a hint, and the project is invisible in her list.
  const denied = await json('GET', `${BASE}/api/projects/e2e-private/state`, undefined, undefined, carolCookie);
  assert.equal(denied.status, 403);
  const deniedBody = await jb(denied);
  assert.match(deniedBody.error, /not a member/);
  assert.ok(deniedBody.hint);
  assert.deepEqual(await jb(await json('GET', `${BASE}/api/projects`, undefined, undefined, carolCookie)), []);

  // Owner adds her by username → access flips to 200.
  assert.equal((await json('POST', `${BASE}/api/projects/e2e-private/members`,
    { username: 'carol' }, undefined, adminCookie)).status, 200);
  assert.equal((await json('GET', `${BASE}/api/projects/e2e-private/state`,
    undefined, undefined, carolCookie)).status, 200);
  const mine = await jb(await json('GET', `${BASE}/api/projects`, undefined, undefined, carolCookie));
  assert.deepEqual(mine.map((p: { id: string; role: string }) => [p.id, p.role]), [['e2e-private', 'member']]);
});

test('agent auto-creates an unknown project and attribution is the credential owner', async () => {
  const s = await jb(await json('POST', `${BASE}/api/projects/e2e-fresh/sessions`,
    { agent: 'auto-agent', developer: 'someone-else' }, token));
  assert.ok(s.id);
  assert.equal(s.developer, 'admin'); // self-declared value overridden by the verified owner

  const projects = await jb(await json('GET', `${BASE}/api/projects`, undefined, token));
  assert.equal(projects.find((p: { id: string }) => p.id === 'e2e-fresh').role, 'owner');
});

test('static assets serve over http', async () => {
  const dash = await json('GET', `${BASE}/`);
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /<html/i);

  const doc = await json('GET', `${BASE}/AGENT.md`);
  assert.equal(doc.status, 200);
  assert.match(doc.headers.get('content-type') ?? '', /markdown/);

  const installer = await json('GET', `${BASE}/install.sh`);
  assert.equal(installer.status, 200);
  assert.match(await installer.text(), new RegExp(`${HOST}:${PORT}`));

  const helper = await json('GET', `${BASE}/install/mediation-installer.mjs`);
  assert.equal(helper.status, 200);
  assert.match(helper.headers.get('content-type') ?? '', /javascript/);

  const powershell = await json('GET', `${BASE}/install.ps1`);
  assert.equal(powershell.status, 200);
  assert.match(await powershell.text(), new RegExp(`${HOST}:${PORT}`));
});

// Served verbatim (no URL templating) — the uninstaller only touches local paths.
test('uninstaller serves over http', async () => {
  const res = await json('GET', `${BASE}/uninstall.sh`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /shellscript/);
  const script = await res.text();
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /mediation-installer\.mjs/);

  const powershell = await json('GET', `${BASE}/uninstall.ps1`);
  assert.equal(powershell.status, 200);
  assert.match(await powershell.text(), /mediation-installer\.mjs/);
});

test('revoking the credential invalidates the token', async () => {
  const creds = await jb(await json('GET', `${BASE}/api/auth/credentials`, undefined, undefined, adminCookie));
  const cred = creds.find((c: { agent: string }) => c.agent === 'device');
  assert.ok(cred);
  credId = cred.id;

  assert.equal((await json('DELETE', `${BASE}/api/auth/credentials/${credId}`, undefined, undefined, adminCookie)).status, 200);
  assert.equal((await json('GET', `${BASE}/api/auth/me`, undefined, token)).status, 401);
});
