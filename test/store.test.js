import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Store, pathsOverlap } from '../lib/store.js';

let store;
const P = 'test-project';

before(() => {
  store = new Store({ sessionTtlMs: 1000, claimIdleTtlMs: 60_000 });
});

test('pathsOverlap: exact, parent dir, sibling no-match', () => {
  assert.ok(pathsOverlap('src/a.js', 'src/a.js'));
  assert.ok(pathsOverlap('src', 'src/a.js'));
  assert.ok(pathsOverlap('src/a.js', 'src/'));
  assert.ok(!pathsOverlap('src/a.js', 'src/b.js'));
  assert.ok(!pathsOverlap('src', 'lib'));
  assert.ok(!pathsOverlap('', 'src'));
});

test('sessions: start, heartbeat, repo state', () => {
  const s = store.startSession(P, { agent: 'agent-a', developer: 'ada', machine: 'box1' });
  assert.ok(s.id);
  store.heartbeat(P, s.id, { activity: 'reading code' });
  store.reportRepoState(P, s.id, { branch: 'main', revision: 'abc123', dirtyFiles: ['x.js'] });
  const state = store.getState(P);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].repo.branch, 'main');
});

test('claims: create, overlap warning on files', () => {
  const a = store.startSession(P, { agent: 'agent-b' });
  const b = store.startSession(P, { agent: 'agent-c' });

  const { claim, conflicts } = store.createClaim(P, a.id, {
    intent: 'Fix crash in parser',
    files: ['src/parser.js'],
    components: ['parser'],
  });
  assert.equal(conflicts.length, 0);

  const { conflicts: conflicts2 } = store.createClaim(P, b.id, {
    intent: 'Investigate parser crash',
    files: ['src/parser.js'],
  });
  assert.equal(conflicts2.length, 1);
  assert.equal(conflicts2[0].claimId, claim.id);
  assert.equal(conflicts2[0].reasons.some((r) => r.type === 'files'), true);
  assert.equal(conflicts2[0].reasons.some((r) => r.type === 'task'), true);
});

test('checkOverlap: own claims are excluded', () => {
  const a = store.startSession(P, { agent: 'agent-d' });
  store.createClaim(P, a.id, { intent: 'Refactor auth module', files: ['src/auth/login.js'] });
  const w = store.checkOverlap(P, { sessionId: a.id, files: ['src/auth/login.js'] });
  assert.equal(w.length, 0);
});

test('overlap by component and directory prefix', () => {
  const a = store.startSession(P, { agent: 'agent-e' });
  const b = store.startSession(P, { agent: 'agent-f' });
  store.createClaim(P, a.id, { intent: 'Rework ui components', files: ['web/ui'], components: ['ui-kit'] });
  const w = store.checkOverlap(P, { sessionId: b.id, files: ['web/ui/button.tsx'], components: ['UI-Kit'] });
  assert.equal(w.length, 1);
  assert.ok(w[0].reasons.some((r) => r.type === 'files'));
  assert.ok(w[0].reasons.some((r) => r.type === 'components'));
});

test('claims: update findings, complete with commits', () => {
  const a = store.startSession(P, { agent: 'agent-g' });
  const { claim } = store.createClaim(P, a.id, { intent: 'Fix memory leak in cache' });
  store.updateClaim(P, claim.id, { finding: 'cache never evicts expired entries', status: 'in-progress' });
  const done = store.completeClaim(P, claim.id, { commits: ['deadbeef'], summary: 'added eviction' });
  assert.equal(done.status, 'done');
  const state = store.getState(P);
  assert.equal(state.completed[0].commits[0], 'deadbeef');
  assert.equal(state.claims.find((c) => c.id === claim.id), undefined);
});

test('bugs: report and update', () => {
  const a = store.startSession(P, { agent: 'agent-h' });
  const bug = store.reportBug(P, a.id, { title: 'flaky test in billing', files: ['test/billing.test.js'], severity: 'medium' });
  store.updateBug(P, bug.id, { status: 'claimed' });
  const state = store.getState(P);
  assert.equal(state.bugs.find((b) => b.id === bug.id).status, 'claimed');
});

test('conflicts appear in project state between two claims', () => {
  const Q = 'conflict-project';
  const a = store.startSession(Q, { agent: 'agent-i' });
  const b = store.startSession(Q, { agent: 'agent-j' });
  store.createClaim(Q, a.id, { intent: 'Fix login redirect loop', files: ['src/auth.js'] });
  store.createClaim(Q, b.id, { intent: 'Debug login redirect', files: ['src/auth.js'] });
  const state = store.getState(Q);
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.recentFiles.find((f) => f.file === 'src/auth.js').agents.length, 2);
});

test('sessions expire without heartbeat; claims expire with them', async () => {
  const Q = 'expiry-project';
  const a = store.startSession(Q, { agent: 'agent-k' });
  store.createClaim(Q, a.id, { intent: 'temporary work', files: ['tmp.js'] });
  await new Promise((r) => setTimeout(r, 1100));
  const state = store.getState(Q); // getState triggers sweep
  assert.equal(state.sessions.length, 0);
  assert.equal(state.claims.length, 0);
});

test('endSession releases claims', () => {
  const Q = 'release-project';
  const a = store.startSession(Q, { agent: 'agent-l' });
  store.createClaim(Q, a.id, { intent: 'some work' });
  store.endSession(Q, a.id);
  const state = store.getState(Q);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.claims.length, 0);
});

test('unknown session/claim ids produce 404 errors', () => {
  assert.throws(() => store.heartbeat(P, 'nope'), /session not found/);
  assert.throws(() => store.updateClaim(P, 'nope', {}), /claim not found/);
});
