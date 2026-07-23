// Domain model. Pure data shapes — no I/O, no HTTP, no persistence here.
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
  repo: RepoState | null;
  createdAt: number;
  lastSeenAt: number;
}

export type ClaimStatus = 'investigating' | 'in-progress' | 'testing' | 'blocked' | 'done';

export interface Finding {
  text: string;
  at: number;
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
  findings: Finding[];
  commits: string[];
  prs: string[];
  summary: string | null;
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
}

export type EventType = 'session' | 'claim' | 'finding' | 'bug' | 'completed' | 'activity';

export interface EventEntry {
  id: string;
  projectId: string;
  type: EventType;
  message: string;
  at: number;
}

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
}

// ---- API read models ----

export interface ProjectSummary {
  id: string;
  sessions: number;
  claims: number;
  openBugs: number;
  conflicts: number;
  agents: string[];
  lastActivityAt: number | null;
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
