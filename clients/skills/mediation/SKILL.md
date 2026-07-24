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

1. Call `mediation_init` — **without** a project id unless the user gave you
   one. It defaults to the repository name from the git remote (one project per
   repository, so every clone of the repo shares it). Never use the directory
   name.
2. **State the chosen project id and its source to the user in your reply**
   (the tool tells you both) and ask them to correct it *before* they approve —
   after pairing, a wrong id means a project nobody else can see.
3. Relay the rest verbatim: the user opens the dashboard's Agents page, clicks
   **Approve** on the pending request, and reads you the 8-character code that
   appears only after approval.
4. When the user gives you the code, call `mediation_confirm`. The credential
   is stored in `.mediation.json` — the tool tells you whether it is gitignored;
   if it is not, fix that. Setup never needs repeating for this directory.

`mediation_status` reports the directory it resolved. If that is not the
project you are working in (some harnesses start MCP servers elsewhere), pass
`directory: "<absolute path>"` to `mediation_status`, `mediation_init` and
`mediation_confirm` — otherwise the credential lands in the wrong place, and
the tools say so loudly when the target is not a git repository.

Projects are private. If any `mediation_*` tool returns **not a member of
project "x"**, relay the `NEXT STEP` hint to the user verbatim and **stop**:
do not retry, do not switch project ids, do not create a new project. Only a
project owner (or an instance admin) can add you, in the dashboard.

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
