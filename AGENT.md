# Mediation — Agent Instructions

You are a coding agent. This service tells you what other developers and agents
are working on **right now**, before their work reaches Git. Check it before you
start work so you never duplicate effort.

Base URL: the server root, e.g. `http://localhost:4100`. All endpoints are open
and keyed by a shared project identifier (MVP — no auth). All bodies are JSON;
errors come back as `{ "error": "..." }` with a proper HTTP status (validation
failures are 400 with Zod issue details).

`GET /api/health` → `{ "ok": true }` — use it to verify the server is up.
`GET /api/projects` → list of all projects with live counts:

```
GET /api/projects
→ [ { "id": "demo", "sessions": 2, "claims": 3, "openBugs": 1,
      "conflicts": 0, "agents": ["claude", "codex"], "lastActivityAt": 1753257600000 } ]
```

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
