import assert from 'node:assert/strict';
import test from 'node:test';
import { agentEvent, githubRepositorySession, heartbeat, sessionCreate } from '../src/core/schemas.ts';

const lineage = {
  runId: 'run-42',
  agentId: 'agent-child',
  parentAgentId: 'agent-root',
  agentName: 'schema researcher',
  agentRole: 'researcher',
  agentTask: 'Inspect the wire contract',
  agentState: 'active' as const,
  agentStateReason: 'reading schemas',
};

test('session schemas accept optional harness lineage without changing legacy payloads', () => {
  assert.deepEqual(sessionCreate.parse({ agent: 'codex' }), { agent: 'codex' });
  assert.deepEqual(sessionCreate.parse({ agent: 'codex', ...lineage }), { agent: 'codex', ...lineage });
  assert.deepEqual(githubRepositorySession.parse({ owner: 'acme', repository: 'widget', agent: 'codex', ...lineage }),
    { owner: 'acme', repository: 'widget', agent: 'codex', ...lineage });
});

test('session lineage rejects unscoped agents, impossible parents, and oversized metadata', () => {
  assert.throws(() => sessionCreate.parse({ agent: 'codex', agentId: 'child' }), /agentId requires runId/);
  assert.throws(() => sessionCreate.parse({ agent: 'codex', runId: 'run', parentAgentId: 'root' }),
    /parentAgentId requires agentId/);
  assert.throws(() => sessionCreate.parse({ agent: 'codex', runId: 'run', agentId: 'same', parentAgentId: 'same' }),
    /cannot be its own parent/);
  assert.throws(() => sessionCreate.parse({ agent: 'codex', runId: 'x'.repeat(129) }));
  assert.throws(() => sessionCreate.parse({ agent: 'codex', runId: 'two words' }), /ASCII letters/);
  assert.throws(() => sessionCreate.parse({ agent: 'codex', agentTask: 'x'.repeat(281) }));
  assert.throws(() => sessionCreate.parse({ agent: 'codex', agentProvenance: 'harness-reported' }),
    /Unrecognized key/);
});

test('heartbeat updates only mutable agent activity metadata', () => {
  assert.deepEqual(heartbeat.parse({
    agentTask: 'Run focused tests', agentState: 'waiting', agentStateReason: 'waiting for another claim',
  }), {
    agentTask: 'Run focused tests', agentState: 'waiting', agentStateReason: 'waiting for another claim',
  });
  assert.throws(() => heartbeat.parse({ agentState: 'lost' }));
  assert.throws(() => heartbeat.parse({ runId: 'run-42' }), /Unrecognized key/);
  assert.throws(() => heartbeat.parse({ agentStateReason: 'x'.repeat(501) }));
});

test('agent events are bounded, strict lifecycle reports without caller-selected provenance', () => {
  const event = {
    eventId: 'evt-1', runId: 'run-42', agentId: 'agent-child', parentAgentId: 'agent-root',
    harness: 'codex', name: 'schema researcher', role: 'researcher', task: 'Inspect schemas',
    state: 'active' as const, stateReason: 'reading', occurredAt: 1_725_000_000_000,
  };
  assert.deepEqual(agentEvent.parse(event), event);
  assert.throws(() => agentEvent.parse({ ...event, provenance: 'harness-reported' }), /Unrecognized key/);
  assert.throws(() => agentEvent.parse({ ...event, agentId: 'agent child' }), /ASCII letters/);
  assert.throws(() => agentEvent.parse({ ...event, parentAgentId: 'agent-child', agentId: 'agent-child' }),
    /cannot be its own parent/);
  assert.throws(() => agentEvent.parse({ ...event, task: 'safe\u202ebut misleading' }), /bidirectional/);
  assert.throws(() => agentEvent.parse({ ...event, stateReason: 'line one\nline two' }), /control/);
});
