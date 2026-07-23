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

const json = (method: string, url: string, body?: unknown, token?: string) =>
  fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

test('health responds ok', async () => {
  const r = await json('GET', `${BASE}/api/health`);
  assert.equal(r.status, 200);
  const body = await jb(r);
  assert.equal(body.ok, true);
});

// Shared across the ordered flow below.
let token = '';
let credId = '';
let firstClaimId = '';

test('pairing: request -> pending -> redeem -> me; bogus bearer 401', async () => {
  const { requestId } = await jb(await json('POST', `${BASE}/api/auth/request`, {
    agent: 'e2e-agent@box', machine: 'box', developer: 'kyle',
  }));
  assert.ok(requestId);

  const pending = await jb(await json('GET', `${BASE}/api/auth/pending`));
  const mine = pending.find((p: { id: string }) => p.id === requestId);
  assert.ok(mine, 'request appears in pending');

  const redeemed = await jb(await json('POST', `${BASE}/api/auth/redeem`, { code: mine.code }));
  token = redeemed.token;
  assert.ok(token.length > 30);

  const me = await json('GET', `${BASE}/api/auth/me`, undefined, token);
  assert.equal(me.status, 200);
  assert.equal((await jb(me)).developer, 'kyle');

  // bogus bearer is rejected on a normal /api route
  assert.equal((await json('GET', `${BASE}/api/projects`, undefined, 'not-a-real-token')).status, 401);
});

test('session + claim flow surfaces overlap conflicts', async () => {
  const a = await jb(await json('POST', `${P}/sessions`, { agent: 'agent-a' }, token));
  assert.ok(a.id);

  const hb = await json('POST', `${P}/sessions/${a.id}/heartbeat`, { activity: 'exploring' }, token);
  assert.equal(hb.status, 200);

  const first = await jb(await json('POST', `${P}/claims`, {
    sessionId: a.id, intent: 'Fix crash in tokenizer', files: ['src/tokenizer.ts'],
  }, token));
  firstClaimId = first.claim.id;
  assert.equal(first.conflicts.length, 0);

  const b = await jb(await json('POST', `${P}/sessions`, { agent: 'agent-b' }));
  const second = await jb(await json('POST', `${P}/claims`, {
    sessionId: b.id, intent: 'Investigate tokenizer crash', files: ['src/tokenizer.ts'],
  }));
  assert.ok(second.conflicts.length >= 1, 'overlapping claim warns');
  assert.equal(second.conflicts[0].claimId, firstClaimId);
});

test('check endpoint reports overlap', async () => {
  const r = await json('GET', `${P}/check?files=src/tokenizer.ts`);
  assert.equal(r.status, 200);
  const body = await jb(r);
  assert.ok(body.conflicts.length >= 1);
});

test('complete claim then state shows it done', async () => {
  const done = await jb(await json('POST', `${P}/claims/${firstClaimId}/complete`, {
    commits: ['abc1234'], summary: 'fixed lookahead',
  }, token));
  assert.equal(done.status, 'done');

  const state = await jb(await json('GET', `${P}/state`));
  assert.ok(state.completed.some((c: { id: string }) => c.id === firstClaimId));
  assert.ok(!state.claims.some((c: { id: string }) => c.id === firstClaimId));
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
});

test('revoking the credential invalidates the token', async () => {
  const creds = await jb(await json('GET', `${BASE}/api/auth/credentials`));
  const cred = creds.find((c: { agent: string }) => c.agent === 'e2e-agent@box');
  assert.ok(cred);
  credId = cred.id;

  assert.equal((await json('DELETE', `${BASE}/api/auth/credentials/${credId}`)).status, 200);
  assert.equal((await json('GET', `${BASE}/api/auth/me`, undefined, token)).status, 401);
});
