import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { buildApp } from '../src/server/app.ts';
import { bootstrap, cookieOf, ctx, jb, PW } from './helpers.ts';

test('device login is global, waits for approval, and sessions cannot cross-control', async () => {
  const { req, app } = ctx();
  const admin = await bootstrap(req);
  const registered = await jb(await req('POST', '/api/users/register', { username: 'alice', password: PW }));
  assert.equal((await req('POST', '/api/auth/device-login', { username: 'alice', password: PW })).status, 403);
  await req('PATCH', `/api/users/${registered.user.id}`, { status: 'active' }, { cookie: admin });
  const alice = { cookie: cookieOf(await req('POST', '/api/users/login', { username: 'alice', password: PW })) };
  const login = await req('POST', '/api/auth/device-login', { username: 'alice', password: PW, machine: 'box' });
  const token = (await jb(login)).token;
  assert.ok(token.length > 30);
  await req('POST', '/api/projects', { id: 'private' }, { cookie: alice.cookie });
  const lifecycle = {
    eventId: 'alice-lifecycle', runId: 'alice-run', agentId: 'worker', harness: 'codex', state: 'active',
    occurredAt: Date.now(),
  };
  const cookieOnly = await req('POST', '/api/projects/private/agent-events', lifecycle, { cookie: alice.cookie });
  assert.equal(cookieOnly.status, 403);
  assert.match((await jb(cookieOnly)).error, /device Bearer/);

  const mixedLifecycle = await jb(await req('POST', '/api/projects/private/agent-events', lifecycle,
    { token, cookie: admin }));
  assert.equal(mixedLifecycle.developer, 'alice', 'event attribution comes only from the credential owner');
  const adminToken = (await jb(await req('POST', '/api/auth/device-login', {
    username: 'admin', password: PW, machine: 'admin-box',
  }))).token;
  assert.equal((await req('POST', '/api/projects/private/agent-events', {
    ...lifecycle, eventId: 'admin-lifecycle', runId: 'admin-run',
  }, { token: adminToken, cookie: alice.cookie })).status, 403,
  'a member cookie cannot lend its project access to another user credential');

  const first = await jb(await req('POST', '/api/projects/private/sessions', { agent: 'claude-code' }, { token }));
  const second = await jb(await req('POST', '/api/projects/private/sessions', { agent: 'claude-code' }, { token }));
  assert.match(first.agent, /^claude-code-[0-9a-f]{8}@alice$/);
  assert.notEqual(first.id, second.id);
  assert.equal((await req('POST', `/api/projects/private/sessions/${first.id}/heartbeat`,
    { agentState: 'failed', agentStateReason: 'forged' }, { token })).status, 403);
  assert.equal((await jb(await req('GET', '/api/projects/private/state', undefined, { token })))
    .sessions.find((s: { id: string }) => s.id === first.id).agentState, null);
  const owned = await app.request(`/api/projects/private/sessions/${first.id}/heartbeat`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-mediation-session': first.capability },
    body: JSON.stringify({ agentState: 'waiting', agentStateReason: 'owned update' }),
  });
  assert.equal(owned.status, 200);

  const mixed = await jb(await req('POST', '/api/projects/private/sessions',
    { agent: 'codex', developer: 'forged' }, { token, cookie: admin }));
  assert.equal(mixed.developer, 'admin'); // cookie actor wins consistently over a second user's Bearer
});

test('device credential survives restart before the first project is created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mediation-device-restart-'));
  const dbPath = join(dir, 'mediation.db');
  let store = new Store({ dbPath });
  let app = buildApp(store);
  await app.request('/api/users/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PW }),
  });
  const login = await app.request('/api/auth/device-login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PW }),
  });
  const token = (await jb(login)).token;
  store.close();

  store = new Store({ dbPath });
  app = buildApp(store);
  assert.equal((await app.request('/api/auth/me', {
    headers: { authorization: `Bearer ${token}` },
  })).status, 200);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
