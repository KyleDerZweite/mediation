// Wire protocol — Zod schemas for every request body.
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

export const userPatch = z.object({
  role: z.enum(['user', 'admin']).optional(),
  status: z.enum(['active', 'disabled']).optional(), // approving = 'active'; 'pending' is never settable
});

// ---- agent pairing (device-flow-lite; see AGENTS.md "Pairing") ----

export const authRequest = z.object({
  agent: str,
  machine: optStr,
  developer: optStr,
});

export const authRedeem = z.object({
  code: z.string().min(4).max(12),
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
