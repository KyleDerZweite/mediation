// Alpha milestone: private projects + membership. Adversarial by design, since the
// sweeps below drive every project route from one list, so a route added later
// is covered automatically (deny-by-default in the middleware).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeUser, bootstrap, cookieOf, ctx, jb, pair, PW } from './helpers.ts';

// Every route under /api/projects/:p/. Bodies are irrelevant: authorization is
// decided before any handler runs.
const ROUTES: [method: string, suffix: string][] = [
  ['POST', '/sessions'],
  ['POST', '/sessions/sid/heartbeat'],
  ['DELETE', '/sessions/sid'],
  ['POST', '/sessions/sid/repo'],
  ['POST', '/claims'],
  ['PATCH', '/claims/cid'],
  ['POST', '/claims/cid/complete'],
  ['POST', '/bugs'],
  ['PATCH', '/bugs/bid'],
  ['GET', '/state'],
  ['GET', '/check'],
  ['GET', '/members'],
  ['POST', '/members'],
  ['PATCH', '/members/uid'],
  ['DELETE', '/members/uid'],
  ['DELETE', ''], // the project itself
];

// alice owns project "acme"; bob is a stranger. Both have a device bearer.
async function fixture() {
  const { store, req } = ctx();
  const adminCookie = await bootstrap(req);
  const alice = await activeUser(req, adminCookie, 'alice');
  const bob = await activeUser(req, adminCookie, 'bob');
  const aliceToken = await pair(req, alice.cookie, 'alice-agent');
  const bobToken = await pair(req, bob.cookie, 'bob-agent');
  const adminToken = await pair(req, adminCookie, 'admin-agent');
  assert.equal((await req('POST', '/api/projects', { id: 'acme' }, { cookie: alice.cookie })).status, 200);
  return { store, req, adminCookie, adminToken, alice, bob, aliceToken, bobToken };
}

test('non-member user is 403 with a hint on every project route', async () => {
  const { req, bob } = await fixture();
  for (const [method, suffix] of ROUTES) {
    const res = await req(method, `/api/projects/acme${suffix}`, method === 'GET' ? undefined : {}, { cookie: bob.cookie });
    const body = await jb(res);
    assert.equal(res.status, 403, `${method} ${suffix}`);
    assert.equal(body.error, 'not a member of project "acme"', `${method} ${suffix}`);
    assert.match(body.hint, /Ask a project owner/);
    assert.equal(body.docs, '/auth.md');
  }
});

test("another user's agent credential is 403 on every project route", async () => {
  const { req, bobToken } = await fixture();
  for (const [method, suffix] of ROUTES) {
    const res = await req(method, `/api/projects/acme${suffix}`, method === 'GET' ? undefined : {}, { token: bobToken });
    const body = await jb(res);
    assert.equal(res.status, 403, `${method} ${suffix}`);
    // members/delete are human-only surfaces; the rest report non-membership
    assert.match(body.error, /not a member|human-only/, `${method} ${suffix}`);
  }
});

test('agents can never touch member administration, not even as owner', async () => {
  const { req, aliceToken } = await fixture();
  for (const [method, suffix] of [['GET', '/members'], ['POST', '/members'],
    ['PATCH', '/members/uid'], ['DELETE', '/members/uid'], ['DELETE', '']] as [string, string][]) {
    const res = await req(method, `/api/projects/acme${suffix}`,
      method === 'GET' ? undefined : { username: 'bob' }, { token: aliceToken });
    assert.equal(res.status, 403, `${method} ${suffix}`);
    assert.equal((await jb(res)).error, 'project administration is human-only');
  }
});

test('unknown project → 404 with the accessible-project hint (session create auto-creates)', async () => {
  const { req, alice } = await fixture();
  for (const [method, suffix] of ROUTES) {
    if (method === 'POST' && suffix === '/sessions') continue;
    const res = await req(method, `/api/projects/ghost${suffix}`, method === 'GET' ? undefined : {}, { cookie: alice.cookie });
    const body = await jb(res);
    assert.equal(res.status, 404, `${method} ${suffix}`);
    assert.equal(body.error, 'project not found');
    assert.equal(body.project, 'ghost');
    assert.match(body.hint, /Projects you can access: acme/);
  }
});

test('agent session create on an unknown id creates it and makes the owner an owner', async () => {
  const { req, store, aliceToken, alice, bob } = await fixture();
  const res = await req('POST', '/api/projects/brand-new/sessions', { agent: 'a' }, { token: aliceToken });
  assert.equal(res.status, 200);
  assert.equal((await jb(res)).developer, 'alice'); // verified attribution
  assert.equal(store.memberRole('brand-new', alice.id), 'owner');

  // ...and it is private immediately: bob's agent is locked out.
  const other = await req('GET', '/api/projects/brand-new/state', undefined, { cookie: bob.cookie });
  assert.equal(other.status, 403);
});

test('path shapes that could bypass the project check are 404, never a bypass', async () => {
  const { req, alice } = await fixture();
  const evil = ['foo%2Fbar', '..%2F..', 'a%20b', 'x%00y', '%2e%2e', 'acme%2f..%2fghost', 'a'.repeat(300), '.hidden'];
  for (const pid of evil) {
    const res = await req('GET', `/api/projects/${pid}/state`, undefined, { cookie: alice.cookie });
    assert.equal(res.status, 404, pid); // never 200, never someone else's project
    assert.ok(!(await res.text()).includes('"sessions"'), pid);
  }
});

test('membership: add by username (404 unknown, 409 dup), promote, demote, remove', async () => {
  const { req, alice, bob } = await fixture();
  const M = '/api/projects/acme/members';

  assert.equal((await req('POST', M, { username: 'nobody' }, { cookie: alice.cookie })).status, 404);
  const added = await req('POST', M, { username: 'bob' }, { cookie: alice.cookie });
  assert.equal(added.status, 200);
  assert.equal((await jb(added)).role, 'member');
  assert.equal((await req('POST', M, { username: 'bob' }, { cookie: alice.cookie })).status, 409);

  // members may read the list, not change it
  const list = await jb(await req('GET', M, undefined, { cookie: bob.cookie }));
  assert.deepEqual(list.map((m: { username: string; role: string }) => [m.username, m.role]).sort(),
    [['alice', 'owner'], ['bob', 'member']]);
  assert.equal((await req('POST', M, { username: 'admin' }, { cookie: bob.cookie })).status, 403);

  assert.equal((await req('PATCH', `${M}/${bob.id}`, { role: 'owner' }, { cookie: alice.cookie })).status, 200);
  assert.equal((await req('PATCH', `${M}/${bob.id}`, { role: 'member' }, { cookie: bob.cookie })).status, 200); // now owner
  assert.equal((await req('PATCH', `${M}/nope`, { role: 'member' }, { cookie: alice.cookie })).status, 404);
  assert.equal((await req('DELETE', `${M}/${bob.id}`, undefined, { cookie: alice.cookie })).status, 200);
});

test('a member can remove themselves (leave) but not others', async () => {
  const { req, alice, bob } = await fixture();
  await req('POST', '/api/projects/acme/members', { username: 'bob' }, { cookie: alice.cookie });
  assert.equal((await req('DELETE', `/api/projects/acme/members/${alice.id}`, undefined, { cookie: bob.cookie })).status, 403);
  assert.equal((await req('DELETE', `/api/projects/acme/members/${bob.id}`, undefined, { cookie: bob.cookie })).status, 200);
  assert.equal((await req('GET', '/api/projects/acme/state', undefined, { cookie: bob.cookie })).status, 403);
});

test('last owner cannot be demoted or removed, and instance admin does not bypass it', async () => {
  const { req, adminCookie, alice } = await fixture();
  const M = `/api/projects/acme/members/${alice.id}`;
  assert.equal((await req('PATCH', M, { role: 'member' }, { cookie: alice.cookie })).status, 409);
  assert.equal((await req('DELETE', M, undefined, { cookie: alice.cookie })).status, 409);
  const asAdmin = await req('DELETE', M, undefined, { cookie: adminCookie });
  assert.equal(asAdmin.status, 409);
  assert.match((await jb(asAdmin)).error, /last owner/);

  // with a second owner the protection lifts
  await req('POST', '/api/projects/acme/members', { username: 'bob', role: 'owner' }, { cookie: alice.cookie });
  assert.equal((await req('DELETE', M, undefined, { cookie: alice.cookie })).status, 200);
});

test('DELETE project cascades sessions/claims/bugs/events/members', async () => {
  const { req, store, alice, aliceToken } = await fixture();
  const s = await jb(await req('POST', '/api/projects/acme/sessions', { agent: 'a' }, { token: aliceToken }));
  await req('POST', '/api/projects/acme/claims', { sessionId: s.id, intent: 'do a thing' }, { token: aliceToken });
  await req('POST', '/api/projects/acme/bugs', { sessionId: s.id, title: 'a bug' }, { token: aliceToken });

  assert.equal((await req('DELETE', '/api/projects/acme', undefined, { cookie: alice.cookie })).status, 200);
  for (const [table, col] of [['sessions', 'projectId'], ['claims', 'projectId'], ['bugs', 'projectId'],
    ['events', 'projectId'], ['project_members', 'project_id'], ['projects', 'id']] as [string, string][]) {
    const n = (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 'acme'`).get() as { n: number }).n;
    assert.equal(Number(n), 0, table);
  }
  assert.equal((await req('GET', '/api/projects/acme/state', undefined, { cookie: alice.cookie })).status, 404);
});

test('GET /api/projects is scoped: own projects, admin sees all, agent sees its owner\'s', async () => {
  const { req, adminCookie, adminToken, alice, bob, aliceToken } = await fixture();
  await req('POST', '/api/projects', { id: 'bobs-thing' }, { cookie: bob.cookie });

  const ids = async (opts: { cookie?: string; token?: string }) =>
    (await jb(await req('GET', '/api/projects', undefined, opts)))
      .map((p: { id: string; role: string | null }) => `${p.id}:${p.role}`).sort();

  assert.deepEqual(await ids({ cookie: alice.cookie }), ['acme:owner']);
  assert.deepEqual(await ids({ cookie: bob.cookie }), ['bobs-thing:owner']);
  assert.deepEqual(await ids({ token: aliceToken }), ['acme:owner']);
  assert.deepEqual(await ids({ cookie: adminCookie }), ['acme:null', 'bobs-thing:null']); // admin sees all, member of none
  assert.deepEqual(await ids({ token: adminToken }), []); // the admin's AGENT gets no admin powers
});

test('instance admin overrides membership by cookie only, never through its own agent', async () => {
  const { req, adminCookie, adminToken } = await fixture();
  assert.equal((await req('GET', '/api/projects/acme/state', undefined, { cookie: adminCookie })).status, 200);
  const asAgent = await req('GET', '/api/projects/acme/state', undefined, { token: adminToken });
  assert.equal(asAgent.status, 403);
  assert.match((await jb(asAgent)).error, /not a member/);
});

test('revocation is immediate: removing a member 403s their very next request', async () => {
  const { req, alice, bob } = await fixture();
  await req('POST', '/api/projects/acme/members', { username: 'bob' }, { cookie: alice.cookie });
  assert.equal((await req('GET', '/api/projects/acme/state', undefined, { cookie: bob.cookie })).status, 200);
  await req('DELETE', `/api/projects/acme/members/${bob.id}`, undefined, { cookie: alice.cookie });
  assert.equal((await req('GET', '/api/projects/acme/state', undefined, { cookie: bob.cookie })).status, 403);
});

test('disabling the owning user kills their agent credential (401)', async () => {
  const { req, store, adminCookie, alice, aliceToken } = await fixture();
  assert.equal((await req('GET', '/api/projects/acme/state', undefined, { token: aliceToken })).status, 200);
  assert.equal((await req('PATCH', `/api/users/${alice.id}`, { status: 'disabled' }, { cookie: adminCookie })).status, 200);
  const res = await req('GET', '/api/projects/acme/state', undefined, { token: aliceToken });
  assert.equal(res.status, 401);
  assert.equal((await jb(res)).error, 'credential owner is unavailable; sign in again after reactivation');
  assert.equal(store.getCredentialByToken(aliceToken), null);
});

test('orphaned credential (user_id NULL) is 401 everywhere', async () => {
  const { req, store, aliceToken } = await fixture();
  store.db.prepare('UPDATE credentials SET user_id = NULL').run();
  for (const path of ['/api/projects', '/api/projects/acme/state', '/api/auth/me']) {
    const res = await req('GET', path, undefined, { token: aliceToken });
    assert.equal(res.status, 401, path);
  }
  const res = await req('GET', '/api/projects', undefined, { token: aliceToken });
  assert.equal((await jb(res)).error, 'credential owner is unavailable; sign in again after reactivation');
});

test('project id slug rule applies to creation only', async () => {
  const { req, alice } = await fixture();
  for (const id of ['Bad Name', 'x/y', '-leading', '', 'a'.repeat(65), 'weird!']) {
    assert.equal((await req('POST', '/api/projects', { id }, { cookie: alice.cookie })).status, 400, id);
  }
  const ok = await req('POST', '/api/projects', { id: '  My.Project_1  ' }, { cookie: alice.cookie });
  assert.equal(ok.status, 200);
  assert.equal((await jb(ok)).id, 'my.project_1'); // trimmed + lowercased
});

test('credentials are personal: everyone including an admin sees only their own; revoke is owner-or-admin', async () => {
  const { req, adminCookie, alice, bob } = await fixture();
  const mine = await jb(await req('GET', '/api/auth/credentials', undefined, { cookie: alice.cookie }));
  assert.deepEqual(mine.map((c: { agent: string }) => c.agent), ['device']);
  assert.equal(mine[0].ownerUsername, 'alice');

  // An admin's list is their own devices, not the instance's.
  const adminSees = await jb(await req('GET', '/api/auth/credentials', undefined, { cookie: adminCookie }));
  assert.equal(adminSees.every((c: { ownerUsername: string }) => c.ownerUsername === 'admin'), true);
  assert.equal(adminSees.some((c: { id: string }) => c.id === mine[0].id), false);

  assert.equal((await req('DELETE', `/api/auth/credentials/${mine[0].id}`, undefined, { cookie: bob.cookie })).status, 403);
  assert.equal((await req('DELETE', `/api/auth/credentials/${mine[0].id}`, undefined, { cookie: adminCookie })).status, 200);
});

test('a fresh user with no projects sees an empty list and a helpful 404', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  const carol = await activeUser(req, adminCookie, 'carol');
  assert.deepEqual(await jb(await req('GET', '/api/projects', undefined, { cookie: carol.cookie })), []);
  const res = await req('GET', '/api/projects/nothing/state', undefined, { cookie: carol.cookie });
  assert.equal(res.status, 404);
  assert.match((await jb(res)).hint, /Projects you can access: none yet/);
});

test('pending users and logged-out sessions never reach project routes', async () => {
  const { req } = ctx();
  const adminCookie = await bootstrap(req);
  await req('POST', '/api/users/register', { username: 'dave', password: PW }); // pending
  assert.equal(cookieOf(await req('POST', '/api/users/login', { username: 'dave', password: PW })), '');
  await req('POST', '/api/projects', { id: 'private' }, { cookie: adminCookie });
  assert.equal((await req('GET', '/api/projects/private/state')).status, 401);
});
