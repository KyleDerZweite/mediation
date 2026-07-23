import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { bugCreate, claimComplete, claimCreate, claimPatch } from '../src/core/schemas.ts';
import type { ClaimCreate } from '../src/core/schemas.ts';

let store: Store;
const P = 'test-project';

// Store methods take zod output types; parse builds them with defaults filled.
const mkClaim = (input: Record<string, unknown>): ClaimCreate => claimCreate.parse(input);

before(() => {
  store = new Store({ dbPath: ':memory:', sessionTtlMs: 1000, claimIdleTtlMs: 60_000 });
});
after(() => store.close());

test('sessions: start, heartbeat, repo state', () => {
  const s = store.startSession(P, { agent: 'agent-a', developer: 'ada', machine: 'box1' });
  assert.ok(s.id);
  store.heartbeat(P, s.id, { activity: 'reading code' });
  store.reportRepoState(P, s.id, { branch: 'main', revision: 'abc123', dirtyFiles: ['x.js'] });
  const state = store.getState(P);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].repo?.branch, 'main');
  assert.deepEqual(state.sessions[0].repo?.dirtyFiles, ['x.js']);
});

test('claims: create, overlap warning on files and task', () => {
  const a = store.startSession(P, { agent: 'agent-b' });
  const b = store.startSession(P, { agent: 'agent-c' });

  const { claim, conflicts } = store.createClaim(P, mkClaim({
    sessionId: a.id,
    intent: 'Fix crash in parser',
    files: ['src/parser.js'],
    components: ['parser'],
  }));
  assert.equal(conflicts.length, 0);

  const { conflicts: conflicts2 } = store.createClaim(P, mkClaim({
    sessionId: b.id,
    intent: 'Investigate parser crash',
    files: ['src/parser.js'],
  }));
  assert.equal(conflicts2.length, 1);
  assert.equal(conflicts2[0].claimId, claim.id);
  assert.ok(conflicts2[0].reasons.some((r) => r.type === 'files'));
  assert.ok(conflicts2[0].reasons.some((r) => r.type === 'task'));
});

test('check: own claims are excluded', () => {
  const a = store.startSession(P, { agent: 'agent-d' });
  store.createClaim(P, mkClaim({ sessionId: a.id, intent: 'Refactor auth module', files: ['src/auth/login.js'] }));
  assert.equal(store.check(P, { sessionId: a.id, files: ['src/auth/login.js'] }).length, 0);
});

test('overlap by component and directory prefix', () => {
  const a = store.startSession(P, { agent: 'agent-e' });
  const b = store.startSession(P, { agent: 'agent-f' });
  store.createClaim(P, mkClaim({
    sessionId: a.id, intent: 'Rework ui components', files: ['web/ui'], components: ['ui-kit'],
  }));
  const w = store.check(P, { sessionId: b.id, files: ['web/ui/button.tsx'], components: ['UI-Kit'] });
  assert.equal(w.length, 1);
  assert.ok(w[0].reasons.some((r) => r.type === 'files'));
  assert.ok(w[0].reasons.some((r) => r.type === 'components'));
});

test('claims: update findings, complete with commits; row kept as done', () => {
  const a = store.startSession(P, { agent: 'agent-g' });
  const { claim } = store.createClaim(P, mkClaim({ sessionId: a.id, intent: 'Fix memory leak in cache' }));
  const updated = store.updateClaim(P, claim.id,
    claimPatch.parse({ finding: 'cache never evicts expired entries', status: 'in-progress' }));
  assert.equal(updated.status, 'in-progress');
  assert.equal(updated.findings.length, 1);
  assert.equal(updated.findings[0].text, 'cache never evicts expired entries');
  assert.ok(updated.findings[0].at > 0);

  const done = store.completeClaim(P, claim.id,
    claimComplete.parse({ commits: ['deadbeef'], summary: 'added eviction' }));
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt);
  const state = store.getState(P);
  assert.equal(state.completed[0].commits[0], 'deadbeef');
  assert.equal(state.completed[0].summary, 'added eviction');
  assert.equal(state.claims.find((c) => c.id === claim.id), undefined);
});

test('completed list is newest first', () => {
  const Q = 'completed-order';
  const a = store.startSession(Q, { agent: 'agent-o' });
  const { claim: c1 } = store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'first task item' }));
  const { claim: c2 } = store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'second task item' }));
  store.completeClaim(Q, c1.id, claimComplete.parse({}));
  store.completeClaim(Q, c2.id, claimComplete.parse({}));
  const state = store.getState(Q);
  assert.deepEqual(state.completed.map((c) => c.id), [c2.id, c1.id]);
});

test('bugs: report and update', () => {
  const a = store.startSession(P, { agent: 'agent-h' });
  const bug = store.reportBug(P, bugCreate.parse({
    sessionId: a.id, title: 'flaky test in billing', files: ['test/billing.test.js'], severity: 'medium',
  }));
  assert.equal(bug.status, 'open');
  assert.equal(bug.reporter, 'agent-h');
  store.updateBug(P, bug.id, { status: 'claimed' });
  const state = store.getState(P);
  assert.equal(state.bugs.find((b) => b.id === bug.id)?.status, 'claimed');
});

test('conflicts and recentFiles appear in project state', () => {
  const Q = 'conflict-project';
  const a = store.startSession(Q, { agent: 'agent-i' });
  const b = store.startSession(Q, { agent: 'agent-j' });
  store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'Fix login redirect loop', files: ['src/auth.js'] }));
  store.createClaim(Q, mkClaim({ sessionId: b.id, intent: 'Debug login redirect', files: ['src/auth.js'] }));
  const state = store.getState(Q);
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.recentFiles.find((f) => f.file === 'src/auth.js')?.agents.length, 2);
});

test('events are emitted and capped ordering is newest first', () => {
  const Q = 'events-project';
  const a = store.startSession(Q, { agent: 'agent-m' });
  store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'do a thing' }));
  const state = store.getState(Q);
  assert.ok(state.events.length >= 2);
  assert.equal(state.events[0].type, 'claim'); // newest first
  assert.equal(state.events[1].type, 'session');
});

test('listProjects summarizes sessions, claims, bugs, conflicts', () => {
  const Q = 'summary-project';
  const a = store.startSession(Q, { agent: 'agent-x' });
  const b = store.startSession(Q, { agent: 'agent-y' });
  store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'Fix search index rebuild', files: ['src/search.js'] }));
  store.createClaim(Q, mkClaim({ sessionId: b.id, intent: 'Debug search index', files: ['src/search.js'] }));
  store.reportBug(Q, bugCreate.parse({ sessionId: a.id, title: 'search broken' }));
  const summary = store.listProjects().find((p) => p.id === Q);
  assert.ok(summary);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.claims, 2);
  assert.equal(summary.openBugs, 1);
  assert.equal(summary.conflicts, 1);
  assert.deepEqual(summary.agents.sort(), ['agent-x', 'agent-y']);
  assert.ok(summary.lastActivityAt);
});

test('sessions expire without heartbeat; claims expire with them', async () => {
  const Q = 'expiry-project';
  const a = store.startSession(Q, { agent: 'agent-k' });
  store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'temporary work', files: ['tmp.js'] }));
  await new Promise((r) => setTimeout(r, 1100));
  const state = store.getState(Q); // getState triggers sweep
  assert.equal(state.sessions.length, 0);
  assert.equal(state.claims.length, 0);
  assert.ok(state.events.some((e) => e.message.includes('session expired')));
});

test('idle non-done claims expire; done claims survive sweep', async () => {
  const idleStore = new Store({ dbPath: ':memory:', sessionTtlMs: 60_000, claimIdleTtlMs: 50 });
  const Q = 'idle-project';
  const a = idleStore.startSession(Q, { agent: 'agent-n' });
  const { claim: kept } = idleStore.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'finished work' }));
  idleStore.completeClaim(Q, kept.id, claimComplete.parse({}));
  idleStore.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'stalled work' }));
  await new Promise((r) => setTimeout(r, 80));
  idleStore.sweep();
  const state = idleStore.getState(Q);
  assert.equal(state.claims.length, 0);
  assert.equal(state.completed.length, 1);
  idleStore.close();
});

test('endSession releases claims but keeps completed ones', () => {
  const Q = 'release-project';
  const a = store.startSession(Q, { agent: 'agent-l' });
  const { claim: done } = store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'finished thing' }));
  store.completeClaim(Q, done.id, claimComplete.parse({}));
  store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'some work' }));
  store.endSession(Q, a.id);
  const state = store.getState(Q);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.claims.length, 0);
  assert.equal(state.completed.length, 1);
});

test('unknown session/claim/bug ids produce 404 errors', () => {
  const is404 = (re: RegExp) => (err: Error & { statusCode?: number }) => {
    assert.match(err.message, re);
    assert.equal(err.statusCode, 404);
    return true;
  };
  assert.throws(() => store.heartbeat(P, 'nope', {}), is404(/session not found/));
  assert.throws(() => store.updateClaim(P, 'nope', {}), is404(/claim not found/));
  assert.throws(() => store.updateBug(P, 'nope', {}), is404(/bug not found/));
  assert.throws(() => store.endSession(P, 'nope'), is404(/session not found/));
});
