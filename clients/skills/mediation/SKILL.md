---
name: mediation
description: Coordinate work through the Mediation live-coordination server so you never duplicate another developer's or agent's in-flight work. Use at the START of every coding task whenever the mediation_* tools are available: it gives the one-step check for whether this repository coordinates, and how to claim work before editing, while working, and when finishing. Never initialize a repository unless the user explicitly asks to set up or connect Mediation.
---

# Mediation: live work coordination

Mediation shows what every developer and agent is working on *right now*,
before anything reaches Git. The `mediation_*` MCP tools talk to it. Conflicts
are **warnings, not locks**. Never refuse work because of one; surface it and
let the user decide.

## Activation boundary

In a repository that contains `.mediation.json`, this workflow is required for
every coding task, including work you delegate.

**Settle whether this repository coordinates at the start of the task, not
after your first edit.**
`.mediation.json` is usually gitignored, so it never appears in `git status`
and a fresh clone or worktree may not have it yet. Look for the file itself at
the repository root, or call `mediation_state`, which reports the directory it
resolved and whether that directory is initialized.

If `.mediation.json` is absent, do not call `mediation_init`, create a mapping,
or otherwise initialize Mediation unless the user explicitly asks to set up or
connect it. Continue the coding task without Mediation.

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
`AUTH_MODE=manual`, `mediation_setup {username, password, register: true}`
creates the account with the credentials the user provides; a new account waits
for an instance admin to activate it and a project owner adds membership
explicitly. Never pass `register: true` to recover from a failed sign-in: a
typo would silently create a junk account instead of signing anyone in. In both
modes `mediation_setup` stores only a narrow Mediation device token globally
for this server, never in a repository. It is idempotent and resumable: call
it, do what it says, call it again.

If the user asks to update Mediation, re-run the server's `install.sh`; the
manifest-owned install is idempotent. If they ask to uninstall it, run the
server's `uninstall.sh`. Uninstall removes the global device credential by
default; pass `--keep-auth` only when the user explicitly wants to preserve it.

Only when the user explicitly asks to set up or connect Mediation and
`mediation_state` says the directory is not initialized:

1. Call `mediation_init`. It has no project-name override: it independently
   resolves the GitHub owner/repository from Git's actual push remote and sends
   that coordinate only during initialization. A checkout that pushes to a fork
   coordinates on that fork. Never use the directory name or assume `origin`
   is the push target.
2. State the resolved repository and its source to the user in your reply.
   `.mediation.json` records only the server/repository mapping; it contains no
   secret and no model-selected project id. Keep it out of Git anyway: the
   mapping is per-checkout, and a shared one would bind every clone to one
   person's server and break in any fork, whose push target is different. A
   fresh clone starting uninitialized is the design, not a mistake to correct.

`mediation_state` reports the directory it resolved. If that is not the
project you are working in (some harnesses start MCP servers elsewhere), pass
`directory: "<absolute path>"` to `mediation_state`, `mediation_setup` and
`mediation_init`.

Projects are private. In GitHub App mode, a reachable authorization denial
means the linked human lacks verified access; in manual mode it means a project
owner must add them. Relay the `NEXT STEP` hint verbatim and **stop**: do not
retry, switch repositories, or create a new project. A local `gh`/push check is
diagnostic only; it never authorizes Mediation access.

## Every coding task

One tool, `mediation_claim`, covers the whole life of a piece of work. Claiming
is also how you check: the response carries the same overlap warnings a
separate look-first call would have, so there is nothing to call before it.

1. **Before you touch a file**: `mediation_claim` with `intent`. That is the
   only required field. Claim rough and claim early, then refine `files`,
   `components`, `task` and `branch` through the same `claimId` as the scope
   becomes clear; do not wait until you know your file list. Keep the returned
   `claimId`. If it warns about overlap: tell the user who is on it already and
   what they found, then stop, narrow scope, or continue only if the user (or
   the situation clearly) says so. If you stop, call
   `mediation_claim {claimId, status: "abandoned"}` so your claim stops warning
   everyone else about work you are not doing.
   Use `dryRun: true` only when you truly must look without publishing. Prefer
   publishing: an agent nobody can see is the problem this server exists to fix.
   Work you delegate is claimed too: a subagent inside your own harness shares
   this session and may reuse your `claimId`, while a separately launched agent
   has its own session and files its own claim. Only the session that created a
   claim can update it.
2. **While working**: same tool, same `claimId`. Push important discoveries with
   `finding`, and add `findingFiles` so it reaches the agents working on those
   files (`findingKind` is one of `root-cause`, `gotcha`, `decision`,
   `api-change`; `api-change` matters most to strangers, because a changed
   signature breaks them silently). Other agents read these live; a good finding
   saves someone else the same investigation. Update `status` as you move
   (investigating → in-progress → testing).
3. **When you are stuck on someone else**: `status: "blocked"` with
   `blockedOn: "<their claimId>"`. That agent is told someone is waiting, and
   you are told at your next call when it clears. Do not sit and poll.
4. **Side discoveries**: file bugs you notice but won't fix with
   `mediation_bug {title, ...}`, even small ones. Severity matters: `high` and
   `critical` also open a linked GitHub issue when the machine has an
   authenticated `gh`, so a PR saying `Closes #12` resolves the bug here too.
   Everything below that lives only in Mediation, which keeps the repository's
   issue list worth reading. No `gh`, no issue: the bug is filed either way and
   nothing about your workflow changes.
5. **When you fix one**: `mediation_bug {bugId, status: "fixed"}` once the fix
   is committed. Send `bugId` or `title`, never both: with both it cannot tell
   whether you meant to file or resolve, and it refuses rather than guess. Any
   agent may resolve any bug in the project, not only the one that reported it,
   so close what you fix even if someone else filed it. Take `bugId` from
   `mediation_state`. Mark it `claimed` first if you are about to work on it, so
   nobody duplicates the fix; `open` reopens it.
6. **When done**: `mediation_claim {claimId, status: "done", commits, summary}`
   with the real commit SHAs after committing.

**Already editing and never claimed?** Claim now with whatever you know and
continue the rest of this workflow. A late claim still prevents the next
collision; missing the start is not a reason to skip the remainder.

**Resuming with an old `claimId`?** Use it normally. The server re-attaches it
to your new session, or revives it if it had expired, and tells you what that
was; work that finished can still be completed with its commits. Only if it
answers that no claim with that id exists, claim again and finish there. A
stale id is never a reason to stop coordinating.

## News

Responses to `mediation_claim`, `mediation_bug` and `mediation_state` may carry
a short `NEWS` block: things other agents did that touch the files you claimed,
someone waiting on you, or a wait of yours that ended. It is filtered to your
own work and delivered once. Read it and act on it; nobody sends it twice, and
there is no way to ask for it again.

## Orientation

`mediation_state` shows the whole live project: sessions, claims, conflicts,
open bugs (with their ids), recent files, completed work. Use it when picking
what to work on, and prefer tasks nobody has claimed. An open bug nobody has
claimed is a task: mark it `claimed`, fix it, then resolve it as `fixed`.

Resolve bugs as you go. The list is only useful if it says what is still
broken, and an agent that reads a wall of already-fixed bugs starts ignoring
it. `mediation_state` also reconciles the other direction: a linked GitHub
issue closed by a merged PR resolves its bug the next time anyone looks.
