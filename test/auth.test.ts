import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { buildApp } from '../src/server/app.ts';

const store = new Store({ dbPath: ':memory:' });
const app = buildApp(store);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jb = async (r: Response): Promise<any> => r.json();

const json = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('pairing: request -> pending shows code -> redeem -> me', async () => {
  const req = await json('POST', '/api/auth/request', { agent: 'claude-code@box', machine: 'box', developer: 'kyle' });
  assert.equal(req.status, 200);
  const { requestId, expiresAt } = await jb(req);
  assert.ok(requestId);
  assert.ok(expiresAt > Date.now());

  const pending = await jb(await json('GET', '/api/auth/pending'));
  const mine = pending.find((p: { id: string }) => p.id === requestId);
  assert.ok(mine, 'request appears in pending list');
  assert.match(mine.code, /^[A-HJ-NP-Z2-9]{6}$/);

  const redeem = await json('POST', '/api/auth/redeem', { code: mine.code });
  assert.equal(redeem.status, 200);
  const { token, agent } = await jb(redeem);
  assert.ok(token.length > 30);
  assert.equal(agent, 'claude-code@box');

  const me = await json('GET', '/api/auth/me', undefined, token);
  assert.equal(me.status, 200);
  assert.equal((await jb(me)).developer, 'kyle');

  // one-time: same code fails now
  assert.equal((await json('POST', '/api/auth/redeem', { code: mine.code })).status, 404);
});

test('redeem: wrong code is 404', async () => {
  assert.equal((await json('POST', '/api/auth/redeem', { code: 'ZZZZZZ' })).status, 404);
});

test('expired requests are pruned and not redeemable', async () => {
  const { requestId } = await jb(await json('POST', '/api/auth/request', { agent: 'stale-agent' }));
  const pending = await jb(await json('GET', '/api/auth/pending'));
  const code = pending.find((p: { id: string }) => p.id === requestId).code;
  // reach into the store to expire it — TTL is not configurable by design
  (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } })
    .db.prepare('UPDATE pair_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1, requestId);
  assert.equal((await json('POST', '/api/auth/redeem', { code })).status, 404);
  const after = await jb(await json('GET', '/api/auth/pending'));
  assert.equal(after.find((p: { id: string }) => p.id === requestId), undefined);
});

test('bearer enforcement: invalid token 401 on any /api route, absent stays open', async () => {
  assert.equal((await json('GET', '/api/projects', undefined, 'bogus')).status, 401);
  assert.equal((await json('GET', '/api/projects')).status, 200);
  assert.equal((await json('GET', '/api/auth/me')).status, 401);
});

test('credentials: list hides tokens; revoke invalidates', async () => {
  const { requestId } = await jb(await json('POST', '/api/auth/request', { agent: 'revoke-me' }));
  const pending = await jb(await json('GET', '/api/auth/pending'));
  const code = pending.find((p: { id: string }) => p.id === requestId).code;
  const { token } = await jb(await json('POST', '/api/auth/redeem', { code }));

  const creds = await jb(await json('GET', '/api/auth/credentials'));
  const cred = creds.find((c: { agent: string }) => c.agent === 'revoke-me');
  assert.ok(cred);
  assert.equal(cred.token, undefined, 'token value never exposed');

  assert.equal((await json('DELETE', `/api/auth/credentials/${cred.id}`)).status, 200);
  assert.equal((await json('GET', '/api/auth/me', undefined, token)).status, 401);
  assert.equal((await json('DELETE', `/api/auth/credentials/${cred.id}`)).status, 404);
});

test('validation: bad auth bodies are 400', async () => {
  assert.equal((await json('POST', '/api/auth/request', {})).status, 400);
  assert.equal((await json('POST', '/api/auth/redeem', { code: 'x' })).status, 400);
});
