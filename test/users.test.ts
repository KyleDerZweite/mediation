// User auth + admin tests: in-process Hono fetch (app.request), ':memory:' store.
// Each test gets a fresh store/app so admin-count state stays isolated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { buildApp } from '../src/server/app.ts';

const PW = 'password123';

interface Opts { token?: string; cookie?: string }

function ctx() {
  const store = new Store({ dbPath: ':memory:' });
  const app = buildApp(store);
  const req = (method: string, path: string, body?: unknown, { token, cookie }: Opts = {}) =>
    app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { store, app, req };
}

const cookieOf = (res: Response): string =>
  (res.headers.get('set-cookie') ?? '').match(/mediation_user=[^;]+/)?.[0] ?? '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jb = async (r: Response): Promise<any> => r.json();

// Register a user and return the public user object.
async function register(req: ReturnType<typeof ctx>['req'], username: string) {
  return (await jb(await req('POST', '/api/users/register', { username, password: PW }))).user;
}

// Bootstrap the first (admin) account and return its session cookie.
async function bootstrap(req: ReturnType<typeof ctx>['req']) {
  await req('POST', '/api/users/register', { username: 'admin', password: PW });
  return cookieOf(await req('POST', '/api/users/login', { username: 'admin', password: PW }));
}

test('bootstrap: first register is active admin, later ones are pending users', async () => {
  const { req } = ctx();
  const first = await jb(await req('POST', '/api/users/register', { username: 'Alice', password: PW }));
  assert.equal(first.bootstrap, true);
  assert.equal(first.user.role, 'admin');
  assert.equal(first.user.status, 'active');
  assert.equal(first.user.username, 'alice'); // normalized
  assert.equal(first.user.password_hash, undefined); // never leaked

  const second = await jb(await req('POST', '/api/users/register', { username: 'bob', password: PW }));
  assert.equal(second.bootstrap, false);
  assert.equal(second.user.role, 'user');
  assert.equal(second.user.status, 'pending');
});

test('username normalization + uniqueness: "Alice " collides with "alice" (409)', async () => {
  const { req } = ctx();
  assert.equal((await req('POST', '/api/users/register', { username: 'alice', password: PW })).status, 200);
  assert.equal((await req('POST', '/api/users/register', { username: 'Alice ', password: PW })).status, 409);
});

test('invalid username shape → 400; weak password → 400', async () => {
  const { req } = ctx();
  assert.equal((await req('POST', '/api/users/register', { username: 'ab', password: PW })).status, 400);
  assert.equal((await req('POST', '/api/users/register', { username: 'bad name', password: PW })).status, 400);
  assert.equal((await req('POST', '/api/users/register', { username: 'alice', password: 'short' })).status, 400);
});

test('pending user: correct creds → 403 pending, no cookie, no access', async () => {
  const { req } = ctx();
  await bootstrap(req);
  await register(req, 'bob');
  const res = await req('POST', '/api/users/login', { username: 'bob', password: PW });
  assert.equal(res.status, 403);
  assert.equal((await jb(res)).status, 'pending');
  assert.equal(cookieOf(res), ''); // pending never gets a session cookie
});

test('admin approves pending → login works → me returns the user', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const bob = await register(req, 'bob');
  assert.equal((await req('PATCH', `/api/users/${bob.id}`, { status: 'active' }, { cookie: adminCookie })).status, 200);
  const login = await req('POST', '/api/users/login', { username: 'bob', password: PW });
  assert.equal(login.status, 200);
  const me = await req('GET', '/api/users/me', undefined, { cookie: cookieOf(login) });
  assert.equal(me.status, 200);
  assert.equal((await jb(me)).user.username, 'bob');
});

test('wrong password and unknown user both 401 with identical body', async () => {
  const { req } = ctx();
  await register(req, 'alice');
  const wrong = await req('POST', '/api/users/login', { username: 'alice', password: 'wrongpassword' });
  const unknown = await req('POST', '/api/users/login', { username: 'ghost', password: 'wrongpassword' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await jb(wrong), await jb(unknown)); // no user-enumeration
});

test('disable kills existing sessions and blocks login; reactivate restores', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const bob = await register(req, 'bob');
  await req('PATCH', `/api/users/${bob.id}`, { status: 'active' }, { cookie: adminCookie });
  const bobCookie = cookieOf(await req('POST', '/api/users/login', { username: 'bob', password: PW }));
  assert.equal((await req('GET', '/api/users/me', undefined, { cookie: bobCookie })).status, 200);

  await req('PATCH', `/api/users/${bob.id}`, { status: 'disabled' }, { cookie: adminCookie });
  assert.equal((await req('GET', '/api/users/me', undefined, { cookie: bobCookie })).status, 401); // session revoked
  const blocked = await req('POST', '/api/users/login', { username: 'bob', password: PW });
  assert.equal(blocked.status, 403);
  assert.equal((await jb(blocked)).status, 'disabled');

  await req('PATCH', `/api/users/${bob.id}`, { status: 'active' }, { cookie: adminCookie });
  assert.equal((await req('POST', '/api/users/login', { username: 'bob', password: PW })).status, 200);
});

test('final-admin protection: last active admin cannot be demoted/disabled/deleted (incl. self)', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const admin = (await jb(await req('GET', '/api/users', undefined, { cookie: adminCookie })))
    .find((u: { username: string }) => u.username === 'admin');

  assert.equal((await req('PATCH', `/api/users/${admin.id}`, { role: 'user' }, { cookie: adminCookie })).status, 409);
  assert.equal((await req('PATCH', `/api/users/${admin.id}`, { status: 'disabled' }, { cookie: adminCookie })).status, 409);
  assert.equal((await req('DELETE', `/api/users/${admin.id}`, undefined, { cookie: adminCookie })).status, 409);
  assert.equal((await req('PATCH', '/api/users/nope', { role: 'user' }, { cookie: adminCookie })).status, 404);

  // Promote a second admin — now the protection lifts.
  const bob = await register(req, 'bob');
  await req('PATCH', `/api/users/${bob.id}`, { status: 'active', role: 'admin' }, { cookie: adminCookie });
  assert.equal((await req('PATCH', `/api/users/${admin.id}`, { role: 'user' }, { cookie: adminCookie })).status, 200);
  const me = await jb(await req('GET', '/api/users/me', undefined, { cookie: adminCookie }));
  assert.equal(me.user.role, 'user'); // demotion took effect, session still valid
});

test('non-admin user → 403 on admin routes; unauthenticated → 401', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const bob = await register(req, 'bob');
  await req('PATCH', `/api/users/${bob.id}`, { status: 'active' }, { cookie: adminCookie });
  const bobCookie = cookieOf(await req('POST', '/api/users/login', { username: 'bob', password: PW }));

  const forbidden = await req('GET', '/api/users', undefined, { cookie: bobCookie });
  assert.equal(forbidden.status, 403);
  assert.equal((await jb(forbidden)).error, 'admin required');
  assert.equal((await req('GET', '/api/users')).status, 401);
});

test('project route: 401 with WWW-Authenticate when unauthenticated', async () => {
  const { req } = ctx();
  const res = await req('GET', '/api/projects');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="\/auth\.md"/);
  assert.equal((await jb(res)).auth, '/auth.md');
});

test('project route works with a paired agent bearer token', async () => {
  const { req, store } = ctx();
  const { requestId } = store.createPairRequest({ agent: 'claude' });
  const code = store.listPendingPairRequests().find((r) => r.id === requestId)!.code;
  const token = store.redeemPairCode(code).token;
  assert.equal((await req('GET', '/api/projects', undefined, { token })).status, 200);
});

test('project route works with an active user session cookie', async () => {
  const { req } = ctx();
  const cookie = await bootstrap(req);
  assert.equal((await req('GET', '/api/projects', undefined, { cookie })).status, 200);
});

test('logout clears the session; me → 401 afterwards', async () => {
  const { req } = ctx();
  const cookie = await bootstrap(req);
  assert.equal((await req('POST', '/api/users/logout', undefined, { cookie })).status, 200);
  assert.equal((await req('GET', '/api/users/me', undefined, { cookie })).status, 401);
});

test('expired user session → 401 (backdated expires_at)', async () => {
  const { req, store } = ctx();
  const cookie = await bootstrap(req);
  const token = cookie.split('=')[1];
  store.db.prepare('UPDATE user_sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1, token);
  assert.equal((await req('GET', '/api/users/me', undefined, { cookie })).status, 401);
});

// Mint a paired agent bearer token.
function agentToken(store: ReturnType<typeof ctx>['store']): string {
  const { requestId } = store.createPairRequest({ agent: 'claude' });
  const code = store.listPendingPairRequests().find((r) => r.id === requestId)!.code;
  return store.redeemPairCode(code).token;
}

test('agent bearer never grants user/admin surfaces: GET /api/users and /api/auth/pending → 401', async () => {
  const { req, store } = ctx();
  const token = agentToken(store);
  assert.equal((await req('GET', '/api/users', undefined, { token })).status, 401);
  assert.equal((await req('GET', '/api/auth/pending', undefined, { token })).status, 401);
});

test('anonymous GET /api/auth/pending → 401 (pairing-code leak guard)', async () => {
  const { req } = ctx();
  assert.equal((await req('GET', '/api/auth/pending')).status, 401);
});

test('HEAD /api/users matches GET tier: plain user → 403, anonymous → 401', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const bob = await register(req, 'bob');
  await req('PATCH', `/api/users/${bob.id}`, { status: 'active' }, { cookie: adminCookie });
  const bobCookie = cookieOf(await req('POST', '/api/users/login', { username: 'bob', password: PW }));
  assert.equal((await req('HEAD', '/api/users', undefined, { cookie: bobCookie })).status, 403);
  assert.equal((await req('HEAD', '/api/users')).status, 401);
});

test('extra fields are ignored on PATCH and register (no privilege smuggling)', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const bob = await register(req, 'bob');
  await req('PATCH', `/api/users/${bob.id}`,
    { status: 'active', username: 'hax', password: 'x', id: 'other-id' }, { cookie: adminCookie });
  const list = await jb(await req('GET', '/api/users', undefined, { cookie: adminCookie }));
  const after = list.find((u: { id: string }) => u.id === bob.id);
  assert.equal(after.username, 'bob'); // username unchanged, not 'hax'
  assert.equal(after.status, 'active');

  const reg = await jb(await req('POST', '/api/users/register',
    { username: 'mallory', password: PW, role: 'admin', status: 'active' }));
  assert.equal(reg.user.role, 'user'); // smuggled role ignored
  assert.equal(reg.user.status, 'pending'); // smuggled status ignored
});

test('final-admin: a DISABLED second admin does not count → A still protected (409)', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const admin = (await jb(await req('GET', '/api/users', undefined, { cookie: adminCookie })))
    .find((u: { username: string }) => u.username === 'admin');
  const bob = await register(req, 'bob');
  await req('PATCH', `/api/users/${bob.id}`, { status: 'active', role: 'admin' }, { cookie: adminCookie });
  await req('PATCH', `/api/users/${bob.id}`, { status: 'disabled' }, { cookie: adminCookie }); // B disabled

  assert.equal((await req('PATCH', `/api/users/${admin.id}`, { role: 'user' }, { cookie: adminCookie })).status, 409);
  assert.equal((await req('PATCH', `/api/users/${admin.id}`, { status: 'disabled' }, { cookie: adminCookie })).status, 409);
  assert.equal((await req('DELETE', `/api/users/${admin.id}`, undefined, { cookie: adminCookie })).status, 409);
});
