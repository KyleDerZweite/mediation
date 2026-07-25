import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, cookieOf, ctx, jb, PW } from './helpers.ts';

test('device login mints a revocable bearer only for an active user', async () => {
  const { req } = ctx();
  const admin = await bootstrap(req);
  const pending = await jb(await req('POST', '/api/users/register', { username: 'alice', password: PW }));
  assert.equal((await req('POST', '/api/auth/device-login', { username: 'alice', password: PW })).status, 403);
  await req('PATCH', `/api/users/${pending.user.id}`, { status: 'active' }, { cookie: admin });
  const alice = { cookie: cookieOf(await req('POST', '/api/users/login', { username: 'alice', password: PW })) };
  const login = await req('POST', '/api/auth/device-login', { username: 'alice', password: PW, machine: 'box' });
  assert.equal(login.status, 200);
  const { token } = await jb(login);
  assert.ok(token.length > 30);
  assert.equal((await req('GET', '/api/auth/me', undefined, { token })).status, 200);
  const credentials = await jb(await req('GET', '/api/auth/credentials', undefined, { cookie: alice.cookie }));
  assert.equal(credentials[0].agent, 'device');
  assert.equal(credentials[0].token, undefined);
  assert.equal((await req('DELETE', `/api/auth/credentials/${credentials[0].id}`, undefined, { cookie: alice.cookie })).status, 200);
  assert.equal((await req('GET', '/api/auth/me', undefined, { token })).status, 401);
  assert.equal((await req('POST', '/api/auth/device-login', { username: 'alice', password: 'wrong' })).status, 401);
});

test('legacy pairing endpoints are unavailable', async () => {
  const { req } = ctx();
  assert.equal((await req('POST', '/api/auth/request', {})).status, 401);
  assert.equal((await req('POST', '/api/auth/redeem', {})).status, 401);
});
