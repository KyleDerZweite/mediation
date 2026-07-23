// Overlap rules — the heart of the product. Pure functions over Claim[].
//
// A proposed piece of work overlaps an active claim when:
//  - a file path matches exactly or by directory prefix, or
//  - a component name matches case-insensitively, or
//  - the task/intent descriptions share >= 2 significant tokens.

import type { Claim, ConflictWarning, OverlapReason, PairConflict, WorkScope } from './types.ts';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'be', 'fix', 'bug', 'add', 'update', 'change', 'when',
  'that', 'this', 'it', 'from', 'by', 'at', 'as', 'not', 'no', 'my', 'our',
]);

export function tokenize(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function pathsOverlap(a: string, b: string): boolean {
  a = normalizePath(a);
  b = normalizePath(b);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function overlapReasons(scope: WorkScope, claim: Claim): OverlapReason[] {
  const reasons: OverlapReason[] = [];

  const files = (scope.files ?? []).map(normalizePath);
  const fileHits: { mine: string; theirs: string }[] = [];
  for (const mine of files) {
    for (const theirs of claim.files) {
      if (pathsOverlap(mine, theirs)) fileHits.push({ mine, theirs });
    }
  }
  if (fileHits.length) reasons.push({ type: 'files', detail: fileHits });

  const components = new Set((scope.components ?? []).map((c) => c.toLowerCase()));
  const componentHits = claim.components.filter((c) => components.has(c.toLowerCase()));
  if (componentHits.length) reasons.push({ type: 'components', detail: componentHits });

  const mine = tokenize(`${scope.task ?? ''} ${scope.intent ?? ''}`);
  const theirs = tokenize(`${claim.task ?? ''} ${claim.intent ?? ''}`);
  const shared = [...mine].filter((t) => theirs.has(t));
  if (shared.length >= 2) reasons.push({ type: 'task', detail: shared });

  return reasons;
}

/** Warn about active claims that overlap the proposed work. Own session's claims are excluded. */
export function checkOverlap(activeClaims: Claim[], scope: WorkScope): ConflictWarning[] {
  const warnings: ConflictWarning[] = [];
  for (const claim of activeClaims) {
    if (scope.sessionId && claim.sessionId === scope.sessionId) continue;
    const reasons = overlapReasons(scope, claim);
    if (reasons.length) {
      warnings.push({
        claimId: claim.id,
        agent: claim.agent,
        developer: claim.developer,
        intent: claim.intent,
        status: claim.status,
        reasons,
      });
    }
  }
  return warnings;
}

/** Pairwise conflicts between active claims of different sessions, for the dashboard. */
export function pairConflicts(activeClaims: Claim[]): PairConflict[] {
  const conflicts: PairConflict[] = [];
  for (let i = 0; i < activeClaims.length; i++) {
    for (let j = i + 1; j < activeClaims.length; j++) {
      const a = activeClaims[i];
      const b = activeClaims[j];
      if (a.sessionId === b.sessionId) continue;
      const reasons = overlapReasons(
        { files: b.files, components: b.components, task: b.task, intent: b.intent },
        a,
      );
      if (reasons.length) {
        conflicts.push({
          between: [
            { claimId: a.id, agent: a.agent, intent: a.intent },
            { claimId: b.id, agent: b.agent, intent: b.intent },
          ],
          reasons,
        });
      }
    }
  }
  return conflicts;
}
