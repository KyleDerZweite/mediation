# Mediation — Agent Instructions

You are a coding agent. This service tells you what other developers and agents
are working on **right now**, before their work reaches Git. Check it before you
start work so you never duplicate effort.

Base URL: the server root, e.g. `http://localhost:4100`. All endpoints are open
and keyed by a shared project identifier (MVP — no auth). All bodies are JSON.

## Workflow

### 1. Connect (once per session)

```
POST /api/projects/{project}/sessions
{ "agent": "<your-name>", "developer": "<human-name>", "machine": "<host>" }
→ { "id": "<sessionId>", ... }
```

Keep `sessionId`. You must heartbeat or your session and claims expire.

### 2. Check before you start work

```
GET /api/projects/{project}/check?sessionId={id}&files=a.js,b.js&task=BUG-142&intent=fix+login+loop
→ { "conflicts": [ { "agent": ..., "intent": ..., "status": ..., "reasons": [...] } ] }
```

Conflicts are **warnings, not locks**. If you find overlap: stop, coordinate
with the owner (they are named in the response), narrow your scope, or
explicitly continue.

Also useful: `GET /api/projects/{project}/state` returns all active sessions,
claims, bugs, conflicts, recent files, and completed work.

### 3. Claim your work

```
POST /api/projects/{project}/claims
{ "sessionId": "...", "intent": "Fix login redirect loop",
  "task": "BUG-142", "files": ["src/auth/login.js"],
  "components": ["auth"], "branch": "main", "baseRevision": "a1b2c3d",
  "status": "investigating" }
→ { "claim": {...}, "conflicts": [...] }
```

Status values: `investigating`, `in-progress`, `testing`, `blocked`.

### 4. Keep it alive and current

```
POST /api/projects/{project}/sessions/{sessionId}/heartbeat   { "activity": "running tests" }
POST /api/projects/{project}/sessions/{sessionId}/repo        { "branch": "main", "revision": "...", "dirtyFiles": [...] }
PATCH /api/projects/{project}/claims/{claimId}                { "status": "in-progress", "finding": "root cause: ..." }
```

Sessions expire after ~2 minutes without a heartbeat; claims expire with
their session. Report findings as you discover them — other agents read them.

### 5. Report bugs you find (even ones you won't fix)

```
POST /api/projects/{project}/bugs
{ "sessionId": "...", "title": "flaky test in billing",
  "files": ["test/billing.test.js"], "severity": "medium" }
```

### 6. Finish

```
POST /api/projects/{project}/claims/{claimId}/complete
{ "commits": ["9f8e7d6"], "prs": ["https://.../pull/42"], "summary": "what changed" }

DELETE /api/projects/{project}/sessions/{sessionId}
```

Completing attaches your commits/PRs to the work and moves it to the
completed feed. Disconnecting releases your claims.

## CLI shortcut

`bin/mediation-agent.js` wraps all of the above:

```
mediation-agent connect --project P --agent NAME
export MEDIATION_SESSION=<id>
mediation-agent heartbeat --watch 30 &     # keep alive every 30s
mediation-agent check --project P --files src/x.js --task "BUG-1"   # exit 3 = overlap
mediation-agent claim --project P --intent "..." --files src/x.js
mediation-agent complete --project P --claim <id> --commits <sha>
```
