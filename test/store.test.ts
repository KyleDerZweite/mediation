import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { agentEvent, bugCreate, claimComplete, claimCreate, claimPatch, sessionCreate } from '../src/core/schemas.ts';
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

test('session metadata creates a durable execution, heartbeat updates it, and transport end only detaches', () => {
  const s = new Store({ dbPath: ':memory:' });
  const session = s.startSession('crew-session', sessionCreate.parse({
    agent: 'codex', runId: 'run-1', agentId: 'worker-1', parentAgentId: 'root-1',
    agentName: 'Worker', agentRole: 'tester', agentTask: 'Run focused tests', agentState: 'starting',
  }), 'cap', 'user-1');
  let state = s.getState('crew-session');
  assert.equal(state.sessions[0]?.runId, 'run-1');
  assert.equal(state.sessions[0]?.agentProvenance, 'environment-reported');
  assert.equal(state.agents[0]?.sessionId, session.id);
  assert.equal(state.agents[0]?.state, 'starting');
  assert.equal(state.agents[0]?.parentId, null, 'a missing parent stays unresolved');
  assert.equal(state.agents[0]?.parentUnavailable, true);

  s.heartbeat('crew-session', session.id, {
    agentTask: 'Wait for server', agentState: 'waiting', agentStateReason: 'another task owns the API',
  });
  state = s.getState('crew-session');
  assert.equal(state.agents[0]?.task, 'Wait for server');
  assert.equal(state.agents[0]?.state, 'waiting');
  assert.equal(state.agents[0]?.stateReason, 'another task owns the API');

  s.heartbeat('crew-session', session.id, { agentState: 'active' });
  assert.equal(s.getState('crew-session').agents[0]?.stateReason, null,
    'a new state without a reason clears the obsolete reason');
  s.endSession('crew-session', session.id);
  state = s.getState('crew-session');
  assert.equal(state.agents[0]?.sessionId, null);
  assert.equal(state.agents[0]?.state, 'active', 'transport shutdown is not logical completion');
  s.close();
});

test('native agent events are idempotent, ordered by occurredAt, and heal child-first parentage', () => {
  const s = new Store({ dbPath: ':memory:', sessionTtlMs: 1000 });
  const now = Date.now();
  const childInput = agentEvent.parse({
    eventId: 'child-start', runId: 'run-tree', agentId: 'child', parentAgentId: 'root', harness: 'codex',
    name: 'Child', state: 'active', occurredAt: now - 100,
  });
  const child = s.reportAgentEvent('crew-events', 'user-1', 'Ada', childInput);
  assert.equal(child.parentId, null);
  assert.equal(child.parentUnavailable, true);
  assert.ok(!('parentAgentId' in child), 'raw external parent ids never reach the read model');

  const duplicate = s.reportAgentEvent('crew-events', 'user-1', 'Ada',
    { ...childInput, state: 'failed' });
  assert.equal(duplicate.id, child.id);
  assert.equal(duplicate.state, 'active', 'the same event id is processed once');

  const root = s.reportAgentEvent('crew-events', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'root-start', runId: 'run-tree', agentId: 'root', harness: 'codex', state: 'active',
    occurredAt: now,
  }));
  assert.equal(root.parentUnavailable, false);
  assert.equal(s.getState('crew-events').agents.find((a) => a.id === child.id)?.parentId, root.id,
    'a parent arriving later backfills unresolved children');

  s.reportAgentEvent('crew-events', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'child-stop', runId: 'run-tree', agentId: 'child', parentAgentId: 'root', harness: 'codex',
    state: 'completed', occurredAt: now + 100,
  }));
  const afterOlder = s.reportAgentEvent('crew-events', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'child-late-old', runId: 'run-tree', agentId: 'child', parentAgentId: 'root', harness: 'codex',
    state: 'waiting', occurredAt: now - 50,
  }));
  assert.equal(afterOlder.state, 'completed');
  assert.ok(afterOlder.endedAt);
  assert.equal(afterOlder.stale, false, 'terminal executions are never stale');

  assert.throws(() => s.reportAgentEvent('crew-events', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'child-start', runId: 'other-run', agentId: 'other', harness: 'codex', state: 'active',
  })), (error: any) => error.statusCode === 409);

  const receivedAfter = Date.now();
  const secondsScale = s.reportAgentEvent('crew-events', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'seconds-clock', runId: 'clock-run', agentId: 'clock-agent', harness: 'codex',
    state: 'active', occurredAt: 1_700_000_000,
  }));
  assert.ok(secondsScale.updatedAt >= receivedAfter && secondsScale.updatedAt <= Date.now(),
    'timestamps outside the skew window use server receipt time');
  s.close();
});

test('execution identity and parent resolution are isolated by authenticated user', () => {
  const s = new Store({ dbPath: ':memory:' });
  const root = s.reportAgentEvent('crew-users', 'alice', 'Alice', agentEvent.parse({
    eventId: 'alice-root', runId: 'same-run', agentId: 'root', harness: 'codex', state: 'active',
  }));
  const sameExternal = s.reportAgentEvent('crew-users', 'bob', 'Bob', agentEvent.parse({
    eventId: 'bob-root', runId: 'same-run', agentId: 'root', harness: 'codex', state: 'active',
  }));
  const child = s.reportAgentEvent('crew-users', 'bob', 'Bob', agentEvent.parse({
    eventId: 'bob-child', runId: 'same-run', agentId: 'child', parentAgentId: 'missing',
    harness: 'codex', state: 'active',
  }));
  assert.notEqual(root.id, sameExternal.id);
  assert.equal(child.parentId, null);
  assert.equal(child.parentUnavailable, true);

  const self = s.reportAgentEvent('crew-users', 'bob', 'Bob', {
    eventId: 'self', runId: 'same-run', agentId: 'self', parentAgentId: 'self',
    harness: 'codex', state: 'active', occurredAt: Date.now(),
  });
  assert.equal(self.parentId, null, 'store resolution remains defensive even if validation is bypassed');
  assert.equal(self.parentUnavailable, true);
  assert.equal(s.getState('crew-users').agentCount, 4);
  s.close();
});

test('a root hook event attaches a unique run-only session without inventing an agent id', () => {
  const s = new Store({ dbPath: ':memory:' });
  const session = s.startSession('crew-run-only', sessionCreate.parse({ agent: 'codex', runId: 'thread-1' }),
    'cap', 'user-1');
  assert.equal(s.getState('crew-run-only').agents.length, 0);
  const root = s.reportAgentEvent('crew-run-only', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'hook-root', runId: 'thread-1', agentId: 'root', harness: 'codex', state: 'active',
  }));
  assert.equal(root.sessionId, session.id);
  assert.equal(s.getState('crew-run-only').sessions[0]?.agentId, null);
  s.close();
});

test('environment session metadata never overwrites native harness lifecycle', () => {
  const s = new Store({ dbPath: ':memory:' });
  s.reportAgentEvent('crew-precedence', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'native-start', runId: 'run-native', agentId: 'worker', harness: 'codex-hook',
    task: 'Native task', state: 'active', stateReason: 'hook says active',
  }));
  const session = s.startSession('crew-precedence', sessionCreate.parse({
    agent: 'codex-mcp', runId: 'run-native', agentId: 'worker', agentName: 'Useful display name',
    agentTask: 'Environment task', agentState: 'waiting', agentStateReason: 'static environment',
  }), 'cap', 'user-1');
  s.heartbeat('crew-precedence', session.id, {
    agentTask: 'Heartbeat task', agentState: 'failed', agentStateReason: 'transport guess',
  });
  const execution = s.getState('crew-precedence').agents[0]!;
  assert.equal(execution.harness, 'codex-hook');
  assert.equal(execution.name, 'Useful display name', 'missing display data may be filled');
  assert.equal(execution.task, 'Native task');
  assert.equal(execution.state, 'active');
  assert.equal(execution.stateReason, 'hook says active');
  assert.equal(execution.provenance, 'harness-reported');
  s.close();
});

test('stale is derived from lifecycle age and a fresh session for the same actor and run', () => {
  const s = new Store({ dbPath: ':memory:', sessionTtlMs: 1000 });
  const execution = s.reportAgentEvent('crew-stale', 'user-1', 'Ada', agentEvent.parse({
    eventId: 'stale-start', runId: 'run-stale', agentId: 'worker', harness: 'codex', state: 'active',
  }));
  s.db.prepare('UPDATE agent_executions SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 2000, execution.id);
  assert.equal(s.getState('crew-stale').agents[0]?.stale, true);

  s.startSession('crew-stale', sessionCreate.parse({ agent: 'codex', runId: 'run-stale' }), 'cap', 'user-1');
  assert.equal(s.getState('crew-stale').agents[0]?.stale, false);
  s.close();
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
  assert.ok(!conflicts2[0].reasons.some((r) => r.type === 'task'));
  assert.equal(conflicts2[0].updatedAt, claim.updatedAt);
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
  const summary = store.listProjects(null, true).find((p) => p.id === Q); // instance-admin view
  assert.ok(summary);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.claims, 2);
  assert.equal(summary.openBugs, 1);
  assert.equal(summary.conflicts, 1);
  assert.deepEqual(summary.agents.sort(), ['agent-x', 'agent-y']);
  assert.ok(summary.lastActivityAt);
});

// A session dying is a transport event: the harness recycles the MCP client
// freely, and the work is still in the working tree. Deleting the claim with it
// left live work uncovered by the overlap engine, which only widens CLAIMS by
// dirty files, so a session holding none contributes nothing to any check.
test('sessions expire without heartbeat; their claims stand until they expire themselves', async () => {
  const Q = 'expiry-project';
  const a = store.startSession(Q, { agent: 'agent-k' });
  store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'temporary work', files: ['tmp.js'] }));
  await new Promise((r) => setTimeout(r, 1100));
  const state = store.getState(Q); // getState triggers sweep
  assert.equal(state.sessions.length, 0);
  assert.equal(state.claims.length, 1, 'the claim outlives the session that made it');
  assert.equal(state.claims[0].intent, 'temporary work');
  assert.ok(state.events.some((e) => e.message.includes('session expired')));
  assert.ok(state.events.some((e) => e.message.includes('unattended')));
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

test('endSession leaves the claim standing so the agent can resume it', () => {
  const Q = 'release-project';
  const a = store.startSession(Q, { agent: 'agent-l' });
  const { claim: done } = store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'finished thing' }));
  store.completeClaim(Q, done.id, claimComplete.parse({}));
  store.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'some work' }));
  store.endSession(Q, a.id);
  const state = store.getState(Q);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.claims.length, 1);
  assert.equal(state.claims[0].intent, 'some work');
  assert.equal(state.completed.length, 1);
});

/* The resume path. An agent whose MCP process was recycled comes back with a
   new session and the old claimId still in its context; the claim is handed
   over on the identity the server set, never on the client-declared worktree
   alone. */
test('a new session of the same developer and worktree adopts an orphaned claim', () => {
  const s = new Store({ dbPath: ':memory:' });
  const Q = 'adopt';
  const first = s.startSession(Q, { agent: 'claude-code', developer: 'Kyle', worktree: 'w1' }, 'cap-one');
  const { claim } = s.createClaim(Q, mkClaim({ sessionId: first.id, intent: 'ship the thing', files: ['src/a.ts'] }));
  s.endSession(Q, first.id);

  const second = s.startSession(Q, { agent: 'claude-code', developer: 'Kyle', worktree: 'w1' }, 'cap-two');
  const { note } = s.authorizeClaimTouch(Q, claim.id, 'cap-two', 'complete');
  assert.match(note!, /previous session had ended/);
  const finished = s.completeClaim(Q, claim.id, claimComplete.parse({ commits: ['abc1234'] }));
  assert.equal(finished.sessionId, second.id, 'the claim now belongs to the live session');
  assert.deepEqual(s.getState(Q).completed.map((c) => c.intent), ['ship the thing']);
  s.close();
});

// The worktree is client-declared and every member can read it out of the
// project state, so it narrows to the right checkout and never authorizes.
test('a stranger cannot take over an orphaned claim', () => {
  const s = new Store({ dbPath: ':memory:' });
  const Q = 'steal';
  const mine = s.startSession(Q, { agent: 'claude-code', developer: 'Kyle', worktree: 'w1' }, 'cap-mine');
  const { claim } = s.createClaim(Q, mkClaim({ sessionId: mine.id, intent: 'my work', files: ['src/a.ts'] }));
  s.endSession(Q, mine.id);
  s.startSession(Q, { agent: 'codex', developer: 'Someone Else', worktree: 'w1' }, 'cap-theirs');

  assert.throws(() => s.authorizeClaimTouch(Q, claim.id, 'cap-theirs', 'patch'),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /cannot be taken over/);
      assert.match(err.message, /mediation_claim/, 'a refusal must still name the way forward');
      return true;
    });
  s.close();
});

test('an expired claim is revived by its own agent, not lost', async () => {
  const s = new Store({ dbPath: ':memory:', sessionTtlMs: 60_000, claimIdleTtlMs: 50 });
  const Q = 'revive';
  const a = s.startSession(Q, { agent: 'claude-code', developer: 'Kyle', worktree: 'w1' }, 'cap-a');
  const { claim } = s.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'long job', files: ['src/a.ts'] }));
  await new Promise((r) => setTimeout(r, 80));
  s.sweep();
  assert.equal(s.getState(Q).claims.length, 0, 'an expired claim stops warning anyone');

  const { note } = s.authorizeClaimTouch(Q, claim.id, 'cap-a', 'patch');
  assert.match(note!, /had expired/);
  assert.match(note!, /live again/);
  const revived = s.updateClaim(Q, claim.id, claimPatch.parse({ finding: 'still on it' }));
  assert.equal(revived.status, 'in-progress');
  assert.equal(s.getState(Q).claims.length, 1);
  s.close();
});

// Losing finished work from the history because a process restarted is worse
// than a strict error, and the commits are verifiable in Git either way.
test('an expired claim can still be completed with its commits', async () => {
  const s = new Store({ dbPath: ':memory:', sessionTtlMs: 60_000, claimIdleTtlMs: 50 });
  const Q = 'late-finish';
  const a = s.startSession(Q, { agent: 'claude-code', developer: 'Kyle', worktree: 'w1' }, 'cap-a');
  const { claim } = s.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'the work', files: ['src/a.ts'] }));
  await new Promise((r) => setTimeout(r, 80));
  s.sweep();

  s.authorizeClaimTouch(Q, claim.id, 'cap-a', 'complete');
  s.completeClaim(Q, claim.id, claimComplete.parse({ commits: ['deadbee'], summary: 'landed' }));
  const state = s.getState(Q);
  assert.equal(state.completed.length, 1);
  assert.deepEqual(state.completed[0].commits, ['deadbee']);
  s.close();
});

// A resumed agent replaying its last step must not enter the history twice.
test('completing an already completed claim merges instead of duplicating', () => {
  const s = new Store({ dbPath: ':memory:' });
  const Q = 'replay';
  const a = s.startSession(Q, { agent: 'claude-code', developer: 'Kyle', worktree: 'w1' }, 'cap-a');
  const { claim } = s.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'the work' }));
  s.completeClaim(Q, claim.id, claimComplete.parse({ commits: ['aaa1111'] }));
  const { note } = s.authorizeClaimTouch(Q, claim.id, 'cap-a', 'complete');
  assert.match(note!, /already completed/);
  s.completeClaim(Q, claim.id, claimComplete.parse({ commits: ['bbb2222'] }));

  const state = s.getState(Q);
  assert.equal(state.completed.length, 1, 'one piece of work, one history entry');
  assert.deepEqual(state.completed[0].commits, ['aaa1111', 'bbb2222']);
  assert.equal(state.events.filter((e) => e.type === 'completed').length, 1);
  s.close();
});

test('a completed claim cannot be reopened, and the refusal says what to do', () => {
  const s = new Store({ dbPath: ':memory:' });
  const Q = 'reopen';
  const a = s.startSession(Q, { agent: 'claude-code', developer: 'Kyle', worktree: 'w1' }, 'cap-a');
  const { claim } = s.createClaim(Q, mkClaim({ sessionId: a.id, intent: 'the work' }));
  s.completeClaim(Q, claim.id, claimComplete.parse({ commits: ['aaa1111'] }));
  assert.throws(() => s.authorizeClaimTouch(Q, claim.id, 'cap-a', 'patch'),
    (err: Error & { statusCode?: number }) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /cannot be reopened/);
      assert.match(err.message, /mediation_claim \{intent, files\}/);
      return true;
    });
  s.close();
});

test('unknown session/claim/bug ids produce 404 errors', () => {
  const is404 = (re: RegExp) => (err: Error & { statusCode?: number }) => {
    assert.match(err.message, re);
    assert.equal(err.statusCode, 404);
    return true;
  };
  assert.throws(() => store.heartbeat(P, 'nope', {}), is404(/session not found/));
  assert.throws(() => store.updateClaim(P, 'nope', {}), is404(/no claim with this id exists/));
  assert.throws(() => store.updateBug(P, 'nope', {}), is404(/bug not found/));
  assert.throws(() => store.endSession(P, 'nope'), is404(/session not found/));
});

test('events record the agent that caused them, so a feed can be filtered by one', () => {
  const s = new Store({ dbPath: ':memory:' });
  const session = s.startSession('proj', { agent: 'codex', machine: 'box', developer: 'Kyle' }, 'cap');
  const { claim } = s.createClaim('proj', mkClaim({ sessionId: session.id, intent: 'ship it', files: ['a.ts'] }));
  s.updateClaim('proj', claim.id, claimPatch.parse({ finding: 'found a thing' }));
  s.reportBug('proj', bugCreate.parse({ sessionId: session.id, title: 'broken', severity: 'low' }));

  // The recorded agent is the session identity the feed displays,
  // `codex-<session8>@Kyle`, not the bare harness name.
  const byKind = new Map(s.getState('proj').events.map((e) => [e.type, e.agent]));
  assert.match(session.agent, /^codex-[0-9a-f]{8}@Kyle$/);
  for (const kind of ['session', 'claim', 'finding', 'bug'] as const) {
    assert.equal(byKind.get(kind), session.agent, kind);
  }
  s.close();
});

// ---- dirty files as overlap evidence ----

// Agents predict their own file lists badly and often leave them empty, which
// silently defeats the entire overlap engine. The working tree does not guess.
test('a session dirty file collides even when nobody claimed it', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('dirt', { agent: 'agent-a', worktree: 'boxA' });
  const b = s.startSession('dirt', { agent: 'agent-b', worktree: 'boxB' });
  // agent-a claims a vague intent with no files at all, then actually edits one.
  s.createClaim('dirt', mkClaim({ sessionId: a.id, intent: 'poke at billing' }));
  assert.equal(s.check('dirt', { sessionId: b.id, files: ['src/billing.ts'] }).length, 0);

  s.heartbeat('dirt', a.id, { dirtyFiles: ['src/billing.ts'] });
  const conflicts = s.check('dirt', { sessionId: b.id, files: ['src/billing.ts'] });
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].reasons.some((r) => r.type === 'files'));
  s.close();
});

// Two harnesses in ONE checkout share a working tree, so their dirty files are
// identical by construction. Reporting that back as a conflict would make the
// warnings worthless in exactly the setup they matter most in.
test('two sessions in one worktree never conflict over their shared tree', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('wt', { agent: 'tab-a', worktree: 'same-checkout' });
  const b = s.startSession('wt', { agent: 'tab-b', worktree: 'same-checkout' });
  const c = s.startSession('wt', { agent: 'elsewhere', worktree: 'other-checkout' });
  s.createClaim('wt', mkClaim({ sessionId: a.id, intent: 'edit parser', files: ['src/parser.ts'] }));

  assert.equal(s.check('wt', { sessionId: b.id, files: ['src/parser.ts'] }).length, 0);
  assert.equal(s.check('wt', { sessionId: c.id, files: ['src/parser.ts'] }).length, 1);
  s.close();
});

test('the heartbeat carries repo state, so it flows while no tool is called', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('beat', { agent: 'agent-a' });
  s.heartbeat('beat', a.id, { branch: 'feature', revision: 'deadbee', dirtyFiles: ['src/a.ts', 'src/b.ts'] });
  const session = s.getState('beat').sessions[0];
  assert.equal(session.repo?.branch, 'feature');
  assert.deepEqual(session.repo?.dirtyFiles, ['src/a.ts', 'src/b.ts']);
  s.close();
});

// ---- terminal statuses ----

test('an abandoned claim stops warning others and stays out of the completed feed', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('ab', { agent: 'agent-a' });
  const b = s.startSession('ab', { agent: 'agent-b' });
  const { claim } = s.createClaim('ab', mkClaim({ sessionId: a.id, intent: 'risky refactor', files: ['src/x.ts'] }));
  assert.equal(s.check('ab', { sessionId: b.id, files: ['src/x.ts'] }).length, 1);

  s.completeClaim('ab', claim.id, claimComplete.parse({ status: 'abandoned' }));
  assert.equal(s.check('ab', { sessionId: b.id, files: ['src/x.ts'] }).length, 0, 'a dropped claim must not linger as a warning');
  const state = s.getState('ab');
  assert.equal(state.claims.length, 0);
  assert.equal(state.completed.length, 0, 'work nobody did is not history');
  s.close();
});

// ---- news delivery ----

test('news reaches the session whose files an event touches, and nobody else', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('news', { agent: 'agent-a', worktree: 'wA' });
  const b = s.startSession('news', { agent: 'agent-b', worktree: 'wB' });
  const c = s.startSession('news', { agent: 'agent-c', worktree: 'wC' });
  const { claim } = s.createClaim('news', mkClaim({ sessionId: a.id, intent: 'touch store', files: ['src/store.ts'] }));
  s.createClaim('news', mkClaim({ sessionId: b.id, intent: 'also store', files: ['src/store.ts'] }));
  s.createClaim('news', mkClaim({ sessionId: c.id, intent: 'docs only', files: ['docs/readme.md'] }));
  // Drain the claim-creation backlog so the finding below is the only news left.
  for (const id of [a.id, b.id, c.id]) s.newsFor('news', id);

  s.updateClaim('news', claim.id, claimPatch.parse({
    finding: 'saveClaim drops findings on release', findingFiles: ['src/store.ts'], findingKind: 'gotcha',
  }));

  const forB = s.newsFor('news', b.id);
  assert.equal(forB.length, 1);
  assert.match(forB[0].message, /saveClaim drops findings/);
  assert.equal(forB[0].reason, 'overlap');
  assert.equal(s.newsFor('news', c.id).length, 0, 'an unrelated file list must not be spammed');
  assert.equal(s.newsFor('news', a.id).length, 0, 'news is never handed back to its author');
  s.close();
});

test('news is delivered once: the cursor advances past what it hands over', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('once', { agent: 'agent-a', worktree: 'wA' });
  const b = s.startSession('once', { agent: 'agent-b', worktree: 'wB' });
  const { claim } = s.createClaim('once', mkClaim({ sessionId: a.id, intent: 'a', files: ['src/x.ts'] }));
  s.createClaim('once', mkClaim({ sessionId: b.id, intent: 'b', files: ['src/x.ts'] }));
  s.newsFor('once', b.id);

  s.updateClaim('once', claim.id, claimPatch.parse({ finding: 'the root cause', findingFiles: ['src/x.ts'] }));
  assert.equal(s.newsFor('once', b.id).length, 1);
  assert.equal(s.newsFor('once', b.id).length, 0, 'the same item must not be delivered twice');
  s.close();
});

// `blocked` was a dead enum value: nothing read it, so nobody ever learned that
// someone was waiting on them, or that the wait was over.
test('blockedOn tells the blocker someone waits, and the waiter when it clears', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('block', { agent: 'agent-a', worktree: 'wA' });
  const b = s.startSession('block', { agent: 'agent-b', worktree: 'wB' });
  const { claim: blocker } = s.createClaim('block', mkClaim({ sessionId: a.id, intent: 'refactor api', files: ['src/api.ts'] }));
  s.newsFor('block', a.id);

  const { claim: waiter } = s.createClaim('block', mkClaim({
    sessionId: b.id, intent: 'use new api', files: ['src/caller.ts'], status: 'blocked', blockedOn: blocker.id,
  }));
  assert.equal(waiter.blockedOn, blocker.id);

  const forBlocker = s.newsFor('block', a.id);
  assert.equal(forBlocker.length, 1);
  assert.equal(forBlocker[0].reason, 'waiting-on-you');
  assert.match(forBlocker[0].message, /is waiting on your "refactor api"/);

  s.newsFor('block', b.id);
  s.completeClaim('block', blocker.id, claimComplete.parse({ commits: ['abc1234'] }));
  // Exactly one message, not one for "the blocker finished" and another for
  // "you are unblocked": the wait ending is a single fact.
  const forWaiter = s.newsFor('block', b.id);
  assert.equal(forWaiter.length, 1);
  assert.equal(forWaiter[0].reason, 'unblocked');
  assert.match(forWaiter[0].message, /UNBLOCKED/);
  s.close();
});

// Findings used to die with the claim row, which made them useless as the
// shared record Mediation asks agents to build. They now survive every way a
// claim can end: abandoned, expired, released, or its session simply vanishing.
test('findings outlive the claim they were recorded on', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('durable', { agent: 'agent-a' });
  const { claim } = s.createClaim('durable', mkClaim({ sessionId: a.id, intent: 'investigate', files: ['src/x.ts'] }));
  s.updateClaim('durable', claim.id, claimPatch.parse({ finding: 'the parser eats CRLF' }));
  s.completeClaim('durable', claim.id, claimComplete.parse({ status: 'abandoned' }));
  s.endSession('durable', a.id);

  const state = s.getState('durable');
  assert.equal(state.claims.length, 0, 'the claim itself is gone');
  assert.ok(state.events.some((e) => e.type === 'finding' && /eats CRLF/.test(e.message)),
    'what the agent learned must survive the claim it was learned under');
  s.close();
});

// Churn must not be able to evict the record. A busy project generates session
// and claim events constantly; findings are the part worth keeping.
test('a burst of churn cannot evict findings from the feed', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('flood', { agent: 'agent-a' });
  const { claim } = s.createClaim('flood', mkClaim({ sessionId: a.id, intent: 'work', files: ['src/x.ts'] }));
  s.updateClaim('flood', claim.id, claimPatch.parse({ finding: 'the one thing worth remembering' }));
  for (let i = 0; i < 400; i += 1) s.heartbeat('flood', a.id, { activity: `step ${i}` });

  const events = (s.db.prepare("SELECT message FROM events WHERE projectId = 'flood' AND type = 'finding'")
    .all() as { message: string }[]);
  assert.equal(events.length, 1);
  assert.match(events[0].message, /worth remembering/);
  s.close();
});

// A claim can vanish instead of completing. Blocking on a session that quietly
// dies would otherwise be a permanent wait, which is the failure blockedOn
// exists to prevent in the first place.
test('a waiter is released when the claim it waits on vanishes with its session', () => {
  const s = new Store({ dbPath: ':memory:' });
  const a = s.startSession('vanish', { agent: 'agent-a', worktree: 'wA' });
  const b = s.startSession('vanish', { agent: 'agent-b', worktree: 'wB' });
  const { claim: blocker } = s.createClaim('vanish', mkClaim({ sessionId: a.id, intent: 'refactor api', files: ['src/api.ts'] }));
  s.createClaim('vanish', mkClaim({
    sessionId: b.id, intent: 'use new api', files: ['src/caller.ts'], status: 'blocked', blockedOn: blocker.id,
  }));
  s.newsFor('vanish', b.id);

  s.endSession('vanish', a.id); // agent-a disappears without ever completing

  const forWaiter = s.newsFor('vanish', b.id);
  assert.equal(forWaiter.length, 1);
  assert.equal(forWaiter[0].reason, 'unblocked');
  // The claim now stands unattended instead of vanishing, but the waiter is
  // still let go: the agent that disappeared mid-block may never come back.
  assert.match(forWaiter[0].message, /unattended \(ended by agent\)/);
  assert.equal(s.getState('vanish').claims.find((c) => c.sessionId === b.id)?.blockedOn, null);
  s.close();
});
