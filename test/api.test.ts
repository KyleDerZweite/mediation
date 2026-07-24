// API-level tests: in-memory Hono fetch (app.request), ':memory:' store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Hono } from 'hono';
import { Store } from '../src/server/store.ts';
import { buildApp } from '../src/server/app.ts';

let store: Store;
let app: Hono;
let token = ''; // agent bearer — project routes now require an identity
const P = '/api/projects/api-test';
const auth = () => ({ authorization: `Bearer ${token}` });

before(() => {
  store = new Store({ dbPath: ':memory:', sessionTtlMs: 60_000 });
  app = buildApp(store);
  // Pair an agent directly through the store for a valid bearer credential.
  const { requestId } = store.createPairRequest({ agent: 'api-test-agent' });
  const code = store.listPendingPairRequests().find((r) => r.id === requestId)!.code;
  token = store.redeemPairCode(code).token;
});
after(() => store.close());

// Responses are intentionally untyped (any): the tests assert the wire shape.
async function post(path: string, body: unknown, method = 'POST'): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { headers: auth() });
  return { status: res.status, body: await res.json() };
}

test('health', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.now > 0);
});

test('session lifecycle: create, heartbeat, repo, end', async () => {
  const created = await post(`${P}/sessions`, { agent: 'alpha', developer: 'ada' });
  assert.equal(created.status, 200);
  assert.ok(created.body.id);
  assert.equal(created.body.agent, 'alpha');

  const hb = await post(`${P}/sessions/${created.body.id}/heartbeat`, { activity: 'exploring' });
  assert.equal(hb.status, 200);

  const repo = await post(`${P}/sessions/${created.body.id}/repo`, {
    branch: 'main', revision: 'abc', dirtyFiles: ['src/x.ts'],
  });
  assert.equal(repo.status, 200);
  assert.equal(repo.body.branch, 'main');

  const ended = await post(`${P}/sessions/${created.body.id}`, undefined, 'DELETE');
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.body, { ok: true });

  const gone = await post(`${P}/sessions/${created.body.id}/heartbeat`, {});
  assert.equal(gone.status, 404);
});

test('claim create returns conflict warnings; complete keeps history', async () => {
  const a = (await post(`${P}/sessions`, { agent: 'agent-a' })).body;
  const b = (await post(`${P}/sessions`, { agent: 'agent-b' })).body;

  const first = await post(`${P}/claims`, {
    sessionId: a.id, intent: 'Fix crash in tokenizer', files: ['src/tokenizer.ts'],
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.conflicts.length, 0);
  assert.equal(first.body.claim.status, 'investigating');

  const second = await post(`${P}/claims`, {
    sessionId: b.id, intent: 'Investigate tokenizer crash', files: ['src/tokenizer.ts'],
  });
  assert.equal(second.status, 200); // conflicts warn, never block
  assert.equal(second.body.conflicts.length, 1);
  assert.equal(second.body.conflicts[0].claimId, first.body.claim.id);
  assert.ok(second.body.conflicts[0].reasons.some((r: { type: string }) => r.type === 'files'));

  const patched = await post(`${P}/claims/${first.body.claim.id}`, {
    status: 'in-progress', finding: 'off-by-one in lookahead',
  }, 'PATCH');
  assert.equal(patched.status, 200);
  assert.equal(patched.body.findings.length, 1);

  const done = await post(`${P}/claims/${first.body.claim.id}/complete`, {
    commits: ['abc123'], summary: 'fixed lookahead',
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'done');

  const state = (await get(`${P}/state`)).body;
  assert.equal(state.completed[0].id, first.body.claim.id);
  assert.ok(!state.claims.some((c: { id: string }) => c.id === first.body.claim.id));
});

test('bugs: report and patch', async () => {
  const s = (await post(`${P}/sessions`, { agent: 'agent-c' })).body;
  const bug = await post(`${P}/bugs`, {
    sessionId: s.id, title: 'flaky billing test', severity: 'high', files: ['test/billing.ts'],
  });
  assert.equal(bug.status, 200);
  assert.equal(bug.body.status, 'open');
  assert.equal(bug.body.reporter, 'agent-c');

  const patched = await post(`${P}/bugs/${bug.body.id}`, { status: 'claimed' }, 'PATCH');
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'claimed');
});

test('check endpoint returns conflicts array from query params', async () => {
  const Q = '/api/projects/check-test';
  const a = (await post(`${Q}/sessions`, { agent: 'agent-d' })).body;
  const b = (await post(`${Q}/sessions`, { agent: 'agent-e' })).body;
  await post(`${Q}/claims`, {
    sessionId: a.id, intent: 'Rework payment flow', files: ['src/pay'], components: ['payments'],
  });

  const hit = await get(
    `${Q}/check?sessionId=${b.id}&files=src/pay/stripe.ts,README.md&components=Payments&intent=payment+flow+rework`);
  assert.equal(hit.status, 200);
  assert.ok(Array.isArray(hit.body.conflicts));
  assert.equal(hit.body.conflicts.length, 1);
  const types = hit.body.conflicts[0].reasons.map((r: { type: string }) => r.type).sort();
  assert.deepEqual(types, ['components', 'files', 'task']);

  // own session's claims are excluded
  const own = await get(`${Q}/check?sessionId=${a.id}&files=src/pay/stripe.ts`);
  assert.equal(own.body.conflicts.length, 0);

  const miss = await get(`${Q}/check?sessionId=${b.id}&files=docs/notes.md`);
  assert.equal(miss.body.conflicts.length, 0);
});

test('state has the ProjectState shape', async () => {
  const { status, body } = await get(`${P}/state`);
  assert.equal(status, 200);
  assert.equal(body.project, 'api-test');
  assert.ok(body.now > 0);
  for (const key of ['sessions', 'claims', 'bugs', 'completed', 'conflicts', 'recentFiles', 'events']) {
    assert.ok(Array.isArray(body[key]), `${key} is an array`);
  }
  assert.ok(body.events.length > 0);
  assert.ok(body.events[0].at >= body.events[body.events.length - 1].at); // newest first
});

test('projects list includes summaries', async () => {
  const { status, body } = await get('/api/projects');
  assert.equal(status, 200);
  const p = body.find((x: { id: string }) => x.id === 'api-test');
  assert.ok(p);
  assert.ok(p.sessions >= 1);
  assert.ok(Array.isArray(p.agents));
});

test('404s: unknown session, claim, bug, route', async () => {
  const s = await post(`${P}/sessions/nope/heartbeat`, {});
  assert.equal(s.status, 404);
  assert.ok(s.body.error);

  const c = await post(`${P}/claims/nope`, { status: 'testing' }, 'PATCH');
  assert.equal(c.status, 404);

  const b = await post(`${P}/bugs/nope`, { status: 'fixed' }, 'PATCH');
  assert.equal(b.status, 404);

  const r = await app.request('/api/nope', { headers: auth() });
  assert.equal(r.status, 404);
});

test('validation failures are 400 with zod issues', async () => {
  const noAgent = await post(`${P}/sessions`, { developer: 'ada' });
  assert.equal(noAgent.status, 400);
  assert.ok(Array.isArray(noAgent.body.issues));
  assert.ok(noAgent.body.issues.some((i: { path: unknown[] }) => i.path.includes('agent')));

  const s = (await post(`${P}/sessions`, { agent: 'agent-v' })).body;
  const badStatus = await post(`${P}/claims`, { sessionId: s.id, intent: 'x y z', status: 'done' });
  assert.equal(badStatus.status, 400); // 'done' only reachable via /complete

  const noIntent = await post(`${P}/claims`, { sessionId: s.id });
  assert.equal(noIntent.status, 400);
});
