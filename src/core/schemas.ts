// Wire protocol: Zod schemas for every request body.
// Server validates with these; the CLI builds requests against the same types.
// This file is the single source of truth for what agents may send.

import { z } from 'zod';

const str = z.string().min(1);
const optStr = z.string().min(1).nullish();
const files = z.array(z.string()).default([]);

export const activeClaimStatus = z.enum(['investigating', 'in-progress', 'testing', 'blocked']);
export const bugSeverity = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);
export const bugStatus = z.enum(['open', 'claimed', 'fixed']);

export const sessionCreate = z.object({
  agent: str,
  developer: optStr,
  machine: optStr,
});

export const heartbeat = z.object({
  activity: optStr,
});

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
});

export const claimPatch = z.object({
  intent: optStr,
  task: optStr,
  files: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  branch: optStr,
  baseRevision: optStr,
  status: activeClaimStatus.optional(),
  finding: optStr,
});

export const claimComplete = z.object({
  commits: z.array(z.string()).default([]),
  prs: z.array(z.string()).default([]),
  summary: optStr,
});

export const bugCreate = z.object({
  sessionId: str,
  title: str,
  description: optStr,
  files,
  severity: bugSeverity.default('unknown'),
});

export const bugPatch = z.object({
  status: bugStatus.optional(),
  severity: bugSeverity.optional(),
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
});

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
