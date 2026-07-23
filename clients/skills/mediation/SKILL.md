---
name: mediation
description: Coordinate work through the Mediation live-coordination server so you never duplicate another developer's or agent's in-flight work. Use BEFORE starting any coding task (check for overlapping claims), when starting work (claim it), when discovering findings or bugs (report them), and when finishing (complete with commits). Also use when the user says "set up mediation", "connect to mediation", or asks what others are working on.
---

# Mediation — live work coordination

Mediation shows what every developer and agent is working on *right now*,
before anything reaches Git. The `mediation_*` MCP tools talk to it. Conflicts
are **warnings, not locks** — never refuse work because of one; surface it and
let the user decide.

## One-time setup per project directory

If `mediation_status` says the directory is not initialized (no `.mediation.json`):

1. Call `mediation_init` with the project id (ask the user which project if unclear).
2. Relay its instructions verbatim: the user must open the dashboard's Agents
   page and read you a 6-character approval code.
3. When the user gives you the code, call `mediation_confirm`. The credential
   is stored in `.mediation.json` — ensure it is gitignored. Setup never needs
   repeating for this directory.

## Every coding task

1. **Before starting**: `mediation_check` with the files/components you intend
   to touch plus a short intent. If it warns about overlap: tell the user who
   is already on it and what they found, then stop, narrow scope, or continue
   only if the user (or the situation clearly) says so.
2. **When you start**: `mediation_claim` with intent, files, components, task
   reference, and branch. Keep the returned `claimId`.
3. **While working**: push important discoveries with
   `mediation_update {claimId, finding}` — root causes, gotchas, decisions.
   Other agents read these live; a good finding saves someone else the same
   investigation. Update `status` as you move (investigating → in-progress →
   testing; blocked when stuck).
4. **Side discoveries**: file bugs you notice but won't fix with
   `mediation_bug` — even small ones.
5. **When done**: `mediation_complete {claimId, commits, summary}` with the
   real commit SHAs after committing.

## Orientation

`mediation_state` shows the whole live project: sessions, claims, conflicts,
open bugs, recent files, completed work. Use it when picking what to work on,
and prefer tasks nobody has claimed.
