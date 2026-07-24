# Mediation — Agent Instructions

You are a coding agent. This service tells you what other developers and agents
are working on **right now**, before their work reaches Git. Check it before you
start work so you never duplicate effort.

Base URL: the server root, e.g. `http://localhost:4100`. Project endpoints
(`/api/projects/*`) require an identity: send a paired **Bearer credential**
(`Authorization: Bearer <token>`, see Pairing below) — or, if a human is driving
the dashboard, an active user session cookie works too. Unauthenticated requests
get `401` with a `WWW-Authenticate: Bearer resource_metadata="/auth.md"` hint;
the full auth contract is at `/auth.md`. Requests are keyed by a shared project
identifier. All bodies are JSON; errors come back as `{ "error": "..." }` with a
proper HTTP status (validation failures are 400 with Zod issue details).

`GET /api/health` → `{ "ok": true, "now": ..., "version": "0.3.0-alpha" }` — use
it to verify the server is up.
`GET /api/projects` → the projects **you** may see, with live counts:

```
GET /api/projects
→ [ { "id": "demo", "role": "owner", "sessions": 2, "claims": 3, "openBugs": 1,
      "conflicts": 0, "agents": ["claude", "codex"], "lastActivityAt": 1753257600000 } ]
```

## Projects

A project id is a real object, not a free-text label, and it is **private**:
only its members (and instance admins) can read or write anything under
`/api/projects/{project}/`.

- **One project per repository.** The id is the repository name from the git
  remote — `git config --get remote.origin.url`, take the last path component,
  strip `.git`, lowercase, replace anything outside `[a-z0-9._-]` with `-`.
  Never derive it from the directory name (stale, renamed, generic). With no
  git remote, **ask your human** which project this is.
- **Ids created from now on** must match `^[a-z0-9][a-z0-9._-]{0,63}$`
  (trimmed + lowercased); older ids are grandfathered.
- **Auto-create:** `POST /api/projects/{project}/sessions` on an id that does
  not exist creates it, with the user owning your credential as its owner.
  That is the only creation path an agent has — everything else answers `404`.
- **Membership is human-managed.** Agents cannot add members, remove members,
  create projects through `POST /api/projects`, or delete a project: those
  answer `403 { "error": "project administration is human-only" }`.
- **Not a member** of an existing project → `403`:
  `{ "error": "not a member of project \"x\"", "project", "hint", "docs": "/auth.md" }`.
  Relay the `hint` to your human verbatim and **stop**: do not retry, do not
  switch ids, do not create another project. Only an owner can add you.
- **Unknown project** → `404`:
  `{ "error": "project not found", "project", "hint": "... Projects you can access: a, b", "docs": "/auth.md" }`.
  That usually means a typo — compare with the list in the hint.
- Your session's `developer` is overwritten with the username that owns your
  credential: attribution is verified, not self-declared.

## Workflow

### 1. Connect (once per session)

```
POST /api/projects/{project}/sessions
{ "agent": "<your-name>", "developer": "<human-name>", "machine": "<host>" }
→ { "id": "<sessionId>", "agent": ..., "createdAt": ..., ... }
```

Keep `sessionId`. You must heartbeat or your session and claims expire.

### 2. Check before you start work

```
GET /api/projects/{project}/check?sessionId={id}&files=src/a.js,src/b.js&task=BUG-142&intent=fix+login+loop
→ { "conflicts": [ { "claimId": ..., "agent": ..., "developer": ...,
                     "intent": ..., "status": ..., "reasons": [...] } ] }
```

`files` and `components` are comma-separated; `sessionId` excludes your own
claims from the results. Overlap is detected on: same file or directory-prefix
match, case-insensitive component match, or ≥2 shared significant task/intent
tokens.

Conflicts are **warnings, not locks**. No operation is ever rejected because of
overlap. If you find overlap: stop, coordinate with the owner (they are named
in the response), narrow your scope, or explicitly continue.

Also useful: `GET /api/projects/{project}/state` returns all active sessions,
claims, bugs, pairwise conflicts, recent files, events, and completed work.

### 3. Claim your work

```
POST /api/projects/{project}/claims
{ "sessionId": "...", "intent": "Fix login redirect loop",
  "task": "BUG-142", "files": ["src/auth/login.js"],
  "components": ["auth"], "branch": "main", "baseRevision": "a1b2c3d",
  "status": "investigating" }
→ { "claim": { "id": ..., ... }, "conflicts": [...] }
```

Status values: `investigating`, `in-progress`, `testing`, `blocked`
(`done` is set by completion, not by you). Only `sessionId` and `intent` are
required — but the more scope you declare (files, components, task), the better
overlap detection works for everyone.

### 4. Keep it alive and current

```
POST  /api/projects/{project}/sessions/{sessionId}/heartbeat  { "activity": "running tests" }
POST  /api/projects/{project}/sessions/{sessionId}/repo       { "branch": "main", "revision": "a1b2c3d", "dirtyFiles": ["src/auth/login.js"] }
PATCH /api/projects/{project}/claims/{claimId}                { "status": "in-progress", "finding": "root cause: stale cookie" }
```

Expiry semantics:

- Sessions expire after **~2 minutes** without a heartbeat (`SESSION_TTL_MS`,
  default 120 000 ms); their claims are released.
- Claims with no updates expire after **30 minutes** of inactivity.
- Completed claims are kept (`status: "done"`).

Report findings as you discover them (`finding` on PATCH appends to the
claim's findings list) — other agents read them and skip work you already did.

### 5. Report bugs you find (even ones you won't fix)

```
POST /api/projects/{project}/bugs
{ "sessionId": "...", "title": "flaky test in billing",
  "description": "fails ~1 in 5 runs", "files": ["test/billing.test.js"],
  "severity": "medium" }
→ { "id": ..., "status": "open", ... }
```

Severity: `low`, `medium`, `high`, `critical`, `unknown`.
Update a bug when you pick it up or fix it:

```
PATCH /api/projects/{project}/bugs/{bugId}
{ "status": "claimed" }        # or "fixed"; may also change "severity"
```

Bug status values: `open`, `claimed`, `fixed`.

### 6. Finish

```
POST /api/projects/{project}/claims/{claimId}/complete
{ "commits": ["9f8e7d6"], "prs": ["https://.../pull/42"], "summary": "what changed" }

DELETE /api/projects/{project}/sessions/{sessionId}
```

Completing attaches your commits/PRs to the work and moves it to the
completed feed. Disconnecting releases your remaining claims.

## CLI shortcut

`src/cli/mediation-agent.ts` (installed as `mediation-agent`, or run with
`node src/cli/mediation-agent.ts`) wraps all of the above. Server/project/
session come from `--server`/`--project`/`--session` flags or the
`MEDIATION_SERVER`/`MEDIATION_PROJECT`/`MEDIATION_SESSION` env vars.

```
mediation-agent connect --project P --agent NAME
export MEDIATION_SESSION=<id> MEDIATION_PROJECT=P
mediation-agent heartbeat --watch 30 &        # keep alive every 30s
mediation-agent repo                          # auto-detects branch/revision/dirty from git
mediation-agent check --files src/x.js --task "BUG-1"   # exit code 3 = overlap
mediation-agent claim --intent "..." --files src/x.js
mediation-agent update --claim <id> --status in-progress --finding "root cause: ..."
mediation-agent bug --title "flaky test" --severity medium
mediation-agent complete --claim <id> --commits <sha> --summary "..."
mediation-agent projects                      # list all projects
mediation-agent state                         # full project state
mediation-agent disconnect
```

Run `mediation-agent` with no arguments for full usage. Exit codes: `0` ok,
`1` request/server error, `2` missing/unknown arguments, `3` (check only)
overlap detected — gate on it in scripts.

## Pairing (persistent credentials)

Instead of raw sessions, an agent can pair once per machine/user and reuse a
durable credential (the MCP client automates this via `mediation_init`):

```
POST /api/auth/request   { "agent": "claude-code@host", "machine": "host", "developer": "kyle" }
→ { "requestId": "...", "expiresAt": 1710000000000 }
```

The human opens the dashboard's **Agents** page and clicks **Approve** on the
pending request. Only then does an 8-character code appear, which they relay:

```
POST /api/auth/redeem    { "code": "AB2CD3EF" }
→ { "token": "<bearer token>", "agent": "...", "developer": "...", "ownerUsername": "kyle" }
```

Redeeming before approval is `403 { "error": "pairing request not approved yet" }`
— ask the human to click Approve; do not spin. The credential belongs to the
approving user and acts as them.

The token is a durable `Authorization: Bearer` credential (revocable from the
dashboard). Codes are one-time and expire after ~15 minutes. Send this token on
every project request — it is now required (unauthenticated project calls get
401). `GET /api/auth/me` validates a stored credential. Full auth reference,
including the human user-account flow and the authorization matrix: `/auth.md`.

## MCP install (recommended for agents)

One command per developer machine — the dashboard's Settings page shows it
with this server's URL baked in:

```
curl -fsSL <server>/install.sh | bash
```

This registers the `mediation` MCP server (tools `mediation_init`,
`mediation_check`, `mediation_claim`, `mediation_update`,
`mediation_complete`, `mediation_bug`, `mediation_state`, `mediation_status`)
in claude-code, codex and kimi, and installs a skill teaching the workflow.
`<server>/uninstall.sh` reverses all of it (per-project `.mediation.json`
files are left alone — they hold credentials).
Per-project pairing state lives in `.mediation.json` (gitignore it —
`mediation_confirm` checks with `git check-ignore` and tells you). It is read
and written in the project directory: the git toplevel of wherever the client
was started, or the `directory` argument / `MEDIATION_DIR` env var if the
harness starts the MCP server somewhere else.
`mediation_init` takes the project id as an *optional* argument: by default it
derives it from the git remote and reports which id and which source it used —
state that to your human before they approve, so a wrong id is corrected
before it becomes a project nobody else can see.
