// Wire protocol: Zod schemas for every request body.
// Server validates with these; the CLI builds requests against the same types.
// This file is the single source of truth for what agents may send.

import { z } from 'zod';

const str = z.string().min(1);
const optStr = z.string().min(1).nullish();
const files = z.array(z.string()).default([]);
const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/,
  'must contain only ASCII letters, digits, dot, underscore, colon, or hyphen');
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const displayText = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => !unsafeText.test(value), 'must not contain control or bidirectional formatting characters');

export const agentState = z.enum([
  'starting', 'active', 'waiting', 'blocked', 'needs-input', 'completed', 'failed', 'cancelled',
]);
export const agentProvenance = z.enum(['harness-reported', 'environment-reported']);

const agentLineageFields = {
  runId: opaqueId.nullish(),
  agentId: opaqueId.nullish(),
  parentAgentId: opaqueId.nullish(),
  agentName: displayText(80).nullish(),
  agentRole: displayText(64).nullish(),
  agentTask: displayText(280).nullish(),
  agentState: agentState.nullish(),
  agentStateReason: displayText(280).nullish(),
};

const validateAgentLineage = (value: { runId?: string | null; agentId?: string | null; parentAgentId?: string | null },
  ctx: z.RefinementCtx): void => {
  if (value.agentId && !value.runId) {
    ctx.addIssue({ code: 'custom', path: ['agentId'], message: 'agentId requires runId' });
  }
  if (value.parentAgentId && !value.agentId) {
    ctx.addIssue({ code: 'custom', path: ['parentAgentId'], message: 'parentAgentId requires agentId' });
  }
  if (value.agentId && value.parentAgentId === value.agentId) {
    ctx.addIssue({ code: 'custom', path: ['parentAgentId'], message: 'an agent cannot be its own parent' });
  }
};

export const activeClaimStatus = z.enum(['investigating', 'in-progress', 'testing', 'blocked']);
// How a claim ends. `done` is finished work and enters the completed feed;
// `abandoned` is work that was claimed and dropped, which closes the claim
// without pretending anything was delivered.
export const terminalClaimStatus = z.enum(['done', 'abandoned']);
export const findingKind = z.enum(['root-cause', 'gotcha', 'decision', 'api-change']);
export const bugSeverity = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);
export const bugStatus = z.enum(['open', 'claimed', 'fixed']);

export const sessionCreate = z.object({
  agent: str,
  developer: optStr,
  machine: optStr,
  worktree: optStr,
  ...agentLineageFields,
}).strict().superRefine(validateAgentLineage);

// Repo state rides ALONG with the beat rather than needing its own call: the
// beat already fires on a timer, so real touched files keep flowing while the
// agent is heads-down coding and calling no tools at all.
export const heartbeat = z.object({
  activity: optStr,
  branch: optStr,
  revision: optStr,
  dirtyFiles: z.array(z.string()).optional(),
  agentTask: agentLineageFields.agentTask,
  agentState: agentLineageFields.agentState,
  agentStateReason: agentLineageFields.agentStateReason,
}).strict();

// Native harness hook. Provenance is deliberately absent: the authenticated
// endpoint determines whether this was harness- or environment-reported.
export const agentEvent = z.object({
  eventId: opaqueId,
  runId: opaqueId,
  agentId: opaqueId,
  parentAgentId: opaqueId.nullish(),
  harness: displayText(64),
  name: displayText(80).nullish(),
  role: displayText(64).nullish(),
  task: displayText(280).nullish(),
  state: agentState,
  stateReason: displayText(280).nullish(),
  occurredAt: z.number().int().safe().nonnegative(),
}).strict().superRefine(validateAgentLineage);

export const repoReport = z.object({
  branch: optStr,
  revision: optStr,
  dirtyFiles: files,
});

export const claimCreate = z.object({
  sessionId: str,
  intent: str,
  task: optStr,
  files,
  components: z.array(z.string()).default([]),
  branch: optStr,
  baseRevision: optStr,
  status: activeClaimStatus.default('investigating'),
  blockedOn: optStr,
});

export const claimPatch = z.object({
  intent: optStr,
  task: optStr,
  files: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  branch: optStr,
  baseRevision: optStr,
  status: activeClaimStatus.optional(),
  blockedOn: optStr,
  finding: optStr,
  // A finding about one file inherits the claim's whole file list otherwise,
  // which routes it to everyone the claim overlaps instead of the people the
  // finding is actually about.
  findingFiles: z.array(z.string()).optional(),
  findingKind: findingKind.optional(),
});

export const claimComplete = z.object({
  commits: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
  summary: optStr,
  status: terminalClaimStatus.default('done'),
});

export const bugCreate = z.object({
  sessionId: str,
  title: str,
  description: optStr,
  files,
  severity: bugSeverity.default('unknown'),
  issueUrl: optStr,
});

// A bug is shared project state, so any member may resolve it, not only the
// session that filed it. Agents identify themselves with their own live
// `sessionId`; a signed-in human sends none and is authorized by membership.
export const bugPatch = z.object({
  sessionId: optStr,
  status: bugStatus.optional(),
  severity: bugSeverity.optional(),
  issueUrl: optStr,
});

// ---- user accounts (see docs/auth.md) ----
// Username normalization (trim + lowercase) and its `^[a-z0-9][a-z0-9_-]{2,31}$`
// shape check happen server-side in the Store; here we only validate types.

export const userRegister = z.object({
  username: str,
  password: z.string().min(8).max(128),
});

export const userLogin = z.object({
  username: str,
  password: str,
});

// Exchanges a password once for a narrow, revocable device bearer. The client
// must discard the password; it is never persisted by Mediation.
export const deviceLogin = z.object({
  username: str,
  password: str,
  machine: optStr,
});

// GitHub App mode enrolls a machine through a browser-authenticated human.
// The opaque request secret is proof held by the initiating client; GitHub
// credentials never cross this protocol boundary.
export const deviceStart = z.object({
  machine: optStr,
});

export const deviceRedeem = z.object({
  requestId: str,
  secret: str,
});

// The official client derives these two names from Git's push remote. There
// is deliberately no project id in this request.
const githubName = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);
export const githubRepositorySession = z.object({
  owner: githubName,
  repository: githubName,
  agent: str,
  machine: optStr,
  worktree: optStr,
  ...agentLineageFields,
}).strict().superRefine(validateAgentLineage);

export const userPatch = z.object({
  role: z.enum(['user', 'admin']).optional(),
  status: z.enum(['active', 'disabled']).optional(), // approving = 'active'; 'pending' is never settable
});

// ---- projects + membership (see docs/auth.md) ----
// The project id slug rule (`^[a-z0-9][a-z0-9._-]{0,63}$`, creation only) and
// username normalization live in the Store; here we only validate types.

export const memberRole = z.enum(['owner', 'member']);

export const projectCreate = z.object({
  id: str,
});

export const memberAdd = z.object({
  username: str,
  role: memberRole.default('member'),
});

export const memberPatch = z.object({
  role: memberRole,
});

export type SessionCreate = z.infer<typeof sessionCreate>;
export type Heartbeat = z.infer<typeof heartbeat>;
export type AgentEvent = z.infer<typeof agentEvent>;
export type RepoReport = z.infer<typeof repoReport>;
export type ClaimCreate = z.infer<typeof claimCreate>;
export type ClaimPatch = z.infer<typeof claimPatch>;
export type ClaimComplete = z.infer<typeof claimComplete>;
export type BugCreate = z.infer<typeof bugCreate>;
export type BugPatch = z.infer<typeof bugPatch>;
export type UserRegister = z.infer<typeof userRegister>;
export type UserLogin = z.infer<typeof userLogin>;
export type UserPatch = z.infer<typeof userPatch>;
export type DeviceStart = z.infer<typeof deviceStart>;
export type DeviceRedeem = z.infer<typeof deviceRedeem>;
export type GithubRepositorySession = z.infer<typeof githubRepositorySession>;
export type ProjectCreate = z.infer<typeof projectCreate>;
export type MemberAdd = z.infer<typeof memberAdd>;
export type MemberPatch = z.infer<typeof memberPatch>;
