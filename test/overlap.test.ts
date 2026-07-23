import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOverlap, normalizePath, pairConflicts, pathsOverlap, tokenize } from '../src/core/overlap.ts';
import type { Claim } from '../src/core/types.ts';

function claim(over: Partial<Claim> & { id: string; sessionId: string }): Claim {
  return {
    projectId: 'p',
    agent: 'agent',
    developer: null,
    intent: 'work',
    task: null,
    files: [],
    components: [],
    branch: null,
    baseRevision: null,
    status: 'in-progress',
    findings: [],
    commits: [],
    prs: [],
    summary: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...over,
  };
}

test('normalizePath: backslashes, ./ prefix, trailing slashes', () => {
  assert.equal(normalizePath('.\\src\\a.js'), 'src/a.js');
  assert.equal(normalizePath('./src/dir/'), 'src/dir');
  assert.equal(normalizePath('src//'), 'src');
});

test('tokenize drops stopwords and short tokens', () => {
  const t = tokenize('Fix the crash in JSON parser');
  assert.ok(t.has('crash'));
  assert.ok(t.has('parser'));
  assert.ok(t.has('json'));
  assert.ok(!t.has('fix'));
  assert.ok(!t.has('the'));
  assert.ok(!t.has('in'));
});

test('pathsOverlap: exact, parent dir, sibling no-match', () => {
  assert.ok(pathsOverlap('src/a.js', 'src/a.js'));
  assert.ok(pathsOverlap('src', 'src/a.js'));
  assert.ok(pathsOverlap('src/a.js', 'src/'));
  assert.ok(!pathsOverlap('src/a.js', 'src/b.js'));
  assert.ok(!pathsOverlap('src', 'lib'));
  assert.ok(!pathsOverlap('', 'src'));
});

test('checkOverlap: file, component, and task reasons', () => {
  const existing = [
    claim({
      id: 'c1', sessionId: 's1', agent: 'a1',
      intent: 'Fix crash in parser', files: ['src/parser.js'], components: ['parser'],
    }),
  ];
  const warnings = checkOverlap(existing, {
    sessionId: 's2',
    files: ['src/parser.js'],
    components: ['Parser'],
    intent: 'Investigate parser crash',
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].claimId, 'c1');
  const types = warnings[0].reasons.map((r) => r.type).sort();
  assert.deepEqual(types, ['components', 'files', 'task']);
});

test('checkOverlap: own session excluded', () => {
  const existing = [claim({ id: 'c1', sessionId: 's1', files: ['src/auth/login.js'] })];
  assert.equal(checkOverlap(existing, { sessionId: 's1', files: ['src/auth/login.js'] }).length, 0);
  assert.equal(checkOverlap(existing, { sessionId: 's2', files: ['src/auth/login.js'] }).length, 1);
});

test('checkOverlap: directory prefix matches file inside it', () => {
  const existing = [claim({ id: 'c1', sessionId: 's1', files: ['web/ui'] })];
  const w = checkOverlap(existing, { sessionId: 's2', files: ['web/ui/button.tsx'] });
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].reasons[0], {
    type: 'files',
    detail: [{ mine: 'web/ui/button.tsx', theirs: 'web/ui' }],
  });
});

test('checkOverlap: single shared task token is not enough', () => {
  const existing = [claim({ id: 'c1', sessionId: 's1', intent: 'Fix parser crash' })];
  assert.equal(checkOverlap(existing, { sessionId: 's2', intent: 'Improve parser docs' }).length, 0);
  assert.equal(checkOverlap(existing, { sessionId: 's2', intent: 'Debug parser crash' }).length, 1);
});

test('pairConflicts: cross-session pairs only', () => {
  const claims = [
    claim({ id: 'c1', sessionId: 's1', agent: 'a1', intent: 'Fix login redirect loop', files: ['src/auth.js'] }),
    claim({ id: 'c2', sessionId: 's2', agent: 'a2', intent: 'Debug login redirect', files: ['src/auth.js'] }),
    claim({ id: 'c3', sessionId: 's2', agent: 'a2', intent: 'Unrelated docs work', files: ['docs/x.md'] }),
  ];
  const conflicts = pairConflicts(claims);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].between.map((b) => b.claimId).sort(), ['c1', 'c2']);
  assert.ok(conflicts[0].reasons.some((r) => r.type === 'files'));
  assert.ok(conflicts[0].reasons.some((r) => r.type === 'task'));
});

test('pairConflicts: same-session claims never conflict', () => {
  const claims = [
    claim({ id: 'c1', sessionId: 's1', files: ['src/a.js'] }),
    claim({ id: 'c2', sessionId: 's1', files: ['src/a.js'] }),
  ];
  assert.equal(pairConflicts(claims).length, 0);
});
