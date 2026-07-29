// Domain model. Pure data shapes with no I/O, no HTTP, no persistence here.
// All timestamps are epoch milliseconds.

export interface RepoState {
  branch: string | null;
  revision: string | null;
  dirtyFiles: string[];
  reportedAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  agent: string;
  developer: string | null;
  machine: string | null;
  // Opaque id of the checkout this session runs in (machine + directory).
  // Sessions sharing one are looking at the same files on disk.
  worktree: string | null;
  repo: RepoState | null;
  createdAt: number;
  lastSeenAt: number;
}

// `abandoned` is the terminal status for work that was claimed and then dropped
// (usually because the claim surfaced a conflict and the agent backed off). It
// closes the claim like `done` does, but stays out of the completed feed: work
// nobody did is not history worth reading.
// `expired` (idle past the claim TTL) and `released` (access revoked) are set by
// the server, never by an agent. They end a claim like the agent-set terminal
// states, but the row is KEPT: an agent resuming an old chat with a claimId in
// its context has to be told what happened to it, and "claim not found" is a
// dead end that teaches it to stop coordinating.
export type ClaimStatus = 'investigating' | 'in-progress' | 'testing' | 'blocked'
  | 'done' | 'abandoned' | 'expired' | 'released';

export const TERMINAL_CLAIM_STATUSES = ['done', 'abandoned', 'expired', 'released'] as const;

// The two an agent can recover from by touching the claim again.
export const RESUMABLE_CLAIM_STATUSES = ['expired', 'released'] as const;

// What a finding is about, so the delivery filter can route it. `api-change` is
// the one that matters most to strangers: a changed signature breaks another
// agent silently, where a root cause only ever saves them time.
export type FindingKind = 'root-cause' | 'gotcha' | 'decision' | 'api-change';

export interface Finding {
  text: string;
  at: number;
  files: string[];
  kind: FindingKind | null;
}

export interface Claim {
  id: string;
  projectId: string;
  sessionId: string;
  agent: string;
  developer: string | null;
  intent: string;
  task: string | null;
  files: string[];
  components: string[];
  branch: string | null;
  baseRevision: string | null;
  status: ClaimStatus;
  // Another claim this one waits on. Set with status 'blocked'; it turns a dead
  // enum value into a routable edge, so the blocker learns someone is waiting
  // and the waiter learns the moment it clears.
  blockedOn: string | null;
  findings: Finding[];
  commits: string[];
  prs: string[];
  summary: string | null;
  // Identifies the checkout this claim was made from (machine + directory).
  // Two harnesses in ONE worktree share a working tree, so their dirty files are
  // identical by construction and must not be read as a conflict.
  worktree: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type BugStatus = 'open' | 'claimed' | 'fixed';
export type BugSeverity = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface Bug {
  id: string;
  projectId: string;
  sessionId: string;
  reporter: string;
  title: string;
  description: string | null;
  files: string[];
  severity: BugSeverity;
  status: BugStatus;
  createdAt: number;
  // Set when the reporting client had an authenticated `gh` and opened a
  // tracking issue; null when it did not, which is not an error.
  issueUrl: string | null;
}

export type EventType = 'session' | 'claim' | 'finding' | 'bug' | 'completed' | 'activity';

// Types worth keeping when the per-project event cap evicts. Findings and
// completions are the durable record: a claim row is DELETED when its session
// dies or it idles out, so without this its findings would vanish with it.
export const DURABLE_EVENT_TYPES: EventType[] = ['finding', 'completed', 'bug'];

export interface EventEntry {
  id: string;
  projectId: string;
  type: EventType;
  message: string;
  at: number;
  agent: string | null; // who caused it; null on rows written before this existed
  // Scope, so an event can be routed to the sessions it actually concerns.
  // Null/empty on rows written before delivery existed: those are never routed,
  // only displayed.
  claimId: string | null;
  files: string[];
  sessionId: string | null; // author, so news is never delivered back to them
  seq: number; // monotonic per project; the cursor delivery reads against
}

/** One piece of news routed to a session because it overlaps that session's work. */
export interface NewsItem {
  seq: number;
  type: EventType;
  message: string;
  at: number;
  agent: string | null;
  // Why it reached you, which is what decides how loudly it should read:
  // someone is stuck behind you, your own wait is over, something happened on
  // the claim you are waiting on, or it simply touches your files.
  reason: 'waiting-on-you' | 'unblocked' | 'blocker' | 'overlap';
}

// Prefixes that make a routed event self-classifying, so the reason survives
// the trip through the events table without a column per relationship.
export const NEWS_BLOCKED_PREFIX = 'BLOCKED:';
export const NEWS_UNBLOCKED_PREFIX = 'UNBLOCKED:';

// ---- overlap detection ----

export type OverlapReason =
  | { type: 'files'; detail: { mine: string; theirs: string }[] }
  | { type: 'components'; detail: string[] }
  | { type: 'task'; detail: string[] };

/** One existing claim that overlaps with proposed work. */
export interface ConflictWarning {
  claimId: string;
  agent: string;
  developer: string | null;
  intent: string;
  status: ClaimStatus;
  reasons: OverlapReason[];
  // A warning about work touched 30 seconds ago and one about work last touched
  // 40 minutes ago deserve different reactions; without the age they read alike.
  updatedAt: number;
}

/** Overlap between two already-active claims, for the dashboard. */
export interface PairConflict {
  between: [
    { claimId: string; agent: string; intent: string },
    { claimId: string; agent: string; intent: string },
  ];
  reasons: OverlapReason[];
}

/** What a proposed piece of work looks like for overlap checking. */
export interface WorkScope {
  sessionId?: string | null;
  files?: string[];
  components?: string[];
  task?: string | null;
  intent?: string | null;
  worktree?: string | null; // claims from the same checkout are never conflicts
}

// ---- API read models ----

export type MemberRole = 'owner' | 'member';

export interface ProjectSummary {
  id: string;
  name: string; // display name: the GitHub repository (owner/name); the opaque id for manual projects
  role: MemberRole | null; // the requesting actor's role; null = instance admin viewing a project they are not a member of
  sessions: number;
  claims: number;
  openBugs: number;
  conflicts: number;
  agents: string[];
  lastActivityAt: number | null;
  lastUsedAt: number; // last event, else creation; drives the idle-hide rule
}

export interface RecentFile {
  file: string;
  agents: string[];
  updatedAt: number;
}

export interface ProjectState {
  project: string;
  now: number;
  sessions: Session[];
  claims: Claim[]; // active only (status !== 'done')
  bugs: Bug[];
  completed: Claim[]; // status === 'done', newest first, capped
  conflicts: PairConflict[];
  recentFiles: RecentFile[];
  events: EventEntry[];
}
