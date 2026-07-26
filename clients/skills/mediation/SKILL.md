---
name: mediation
description: Coordinate work through the Mediation live-coordination server so you never duplicate another developer's or agent's in-flight work. Use BEFORE starting any coding task (check for overlapping claims), when starting work (claim it), when discovering findings or bugs (report them), and when finishing (complete with commits). Also use when the user says "set up mediation", "connect to mediation", or asks what others are working on.
---

# Mediation: live work coordination

Mediation shows what every developer and agent is working on *right now*,
before anything reaches Git. The `mediation_*` MCP tools talk to it. Conflicts
are **warnings, not locks**. Never refuse work because of one; surface it and
let the user decide.

## Service unavailable

Coordination must never block the user's coding work because the Mediation
service is offline. If a `mediation_*` call cannot connect, times out, or
returns `404` for the coordination endpoint/project session:

1. State once that live coordination is unavailable.
2. Continue the requested work without Mediation.
3. Do not retry repeatedly, guess another project, or treat the outage as a
   coding-task failure.

Authentication or membership denials from a reachable server are not outages;
follow the access instructions below for those responses.

## One-time account and project setup

Mediation has two server-selected authorization modes. In `AUTH_MODE=github-app`
the human completes browser-based GitHub App authorization; the server verifies
repository access and the agent never receives or stores a GitHub token. In
`AUTH_MODE=manual`, register with the username/password the user provides; a
new account waits for an instance admin to activate it and a project owner adds
membership explicitly. In both modes, `mediation_login` stores only a narrow
Mediation device token globally for this server, never in a repository.

If the user asks to update Mediation, re-run the server's `install.sh`; the
manifest-owned install is idempotent. If they ask to uninstall it, run the
server's `uninstall.sh`. Uninstall removes the global device credential by
default; pass `--keep-auth` only when the user explicitly wants to preserve it.

If `mediation_status` says the directory is not initialized (no `.mediation.json`):

1. Call `mediation_init`. It has no project-name override: it independently
   resolves the GitHub owner/repository from Git's actual push remote and sends
   that coordinate only during initialization. A checkout that pushes to a fork
   coordinates on that fork. Never use the directory name or assume `origin`
   is the push target.
2. State the resolved repository and its source to the user in your reply.
   `.mediation.json` records only the server/repository mapping; it contains no
   secret and no model-selected project id.

`mediation_status` reports the directory it resolved. If that is not the
project you are working in (some harnesses start MCP servers elsewhere), pass
`directory: "<absolute path>"` to `mediation_status` and `mediation_init`.

Projects are private. In GitHub App mode, a reachable authorization denial
means the linked human lacks verified access; in manual mode it means a project
owner must add them. Relay the `NEXT STEP` hint verbatim and **stop**: do not
retry, switch repositories, or create a new project. A local `gh`/push check is
diagnostic only; it never authorizes Mediation access.

## Every coding task

1. **Before starting**: `mediation_check` with the files/components you intend
   to touch plus a short intent. If it warns about overlap: tell the user who
   is already on it and what they found, then stop, narrow scope, or continue
   only if the user (or the situation clearly) says so.
2. **When you start**: `mediation_claim` with intent, files, components, task
   reference, and branch. Keep the returned `claimId`.
3. **While working**: push important discoveries with
   `mediation_update {claimId, finding}` for root causes, gotchas, decisions.
   Other agents read these live; a good finding saves someone else the same
   investigation. Update `status` as you move (investigating → in-progress →
   testing; blocked when stuck).
4. **Side discoveries**: file bugs you notice but won't fix with
   `mediation_bug`, even small ones. If the machine has an authenticated `gh`,
   this also opens a GitHub issue and links it, so a PR saying `Closes #12`
   resolves the bug here too. No `gh`, no issue: the bug is filed either way and
   nothing about your workflow changes.
5. **When you fix one**: `mediation_bug_resolve {bugId, status: "fixed"}` once
   the fix is committed. Any agent may resolve any bug in the project, not only
   the one that reported it, so close what you fix even if someone else filed
   it. Take `bugId` from `mediation_state`. Mark it `claimed` first if you are
   about to work on it, so nobody duplicates the fix; `open` reopens it.
6. **When done**: `mediation_complete {claimId, commits, summary}` with the
   real commit SHAs after committing.

## Orientation

`mediation_state` shows the whole live project: sessions, claims, conflicts,
open bugs (with their ids), recent files, completed work. Use it when picking
what to work on, and prefer tasks nobody has claimed. An open bug nobody has
claimed is a task: mark it `claimed`, fix it, then resolve it as `fixed`.

Resolve bugs as you go. The list is only useful if it says what is still
broken, and an agent that reads a wall of already-fixed bugs starts ignoring
it. `mediation_state` also reconciles the other direction: a linked GitHub
issue closed by a merged PR resolves its bug the next time anyone looks.
