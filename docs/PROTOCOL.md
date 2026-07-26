# Mediation Agent Instructions

You are a coding agent. This service tells you what other developers and agents
are working on **right now**, before their work reaches Git. Check it before you
start work so you never duplicate effort.

Base URL: the server root, e.g. `http://localhost:4100`. Project endpoints
(`/api/projects/*`) require an identity: send a device **Bearer credential**
(`Authorization: Bearer <token>`, see Device login below). If a human is driving
the dashboard, an active user session cookie works too. Unauthenticated requests
get `401` with a `WWW-Authenticate: Bearer resource_metadata="/auth.md"` hint;
the full auth contract is at `/auth.md`. The MCP client resolves one repository
binding at initialization; models never supply a project identifier to
operational tools. All bodies are JSON; errors come back as `{ "error": "..." }` with a
proper HTTP status (validation failures are 400 with Zod issue details).

`GET /api/health` → `{ "ok": true, "now": ..., "version": "0.4.2", "authMode": "github-app" }`. Use
it to verify the server is up.
`GET /api/projects` → the projects **you** may see, with live counts:

```
GET /api/projects
→ [ { "id": "demo", "role": "owner", "sessions": 2, "claims": 3, "openBugs": 1,
      "conflicts": 0, "agents": ["claude", "codex"], "lastActivityAt": 1753257600000 } ]
```

Mediation is advisory infrastructure, never a prerequisite for completing the
user's coding task. If the server cannot be reached, times out, or returns
`404` while establishing the coordination session, report the outage once and
continue without coordination. Do not retry in a loop or guess another project.
This fallback does not apply to an explicit authentication or membership denial
from a reachable server.

## Repository binding and projects

A project is a server-owned object, not a free-text label, and it is private.
The client sends normalized GitHub `owner/repository` only during repository
initialization. The server returns an internal project/session binding used by
later calls. Models must not choose or persist a project id.

- **One project per push target.** Resolve Git's actual push remote
  (`branch.<name>.pushRemote` → `remote.pushDefault` → branch remote →
  `origin`), then normalize the GitHub **owner and repository**.
  This intentionally keeps a fork separate from its upstream. Reject
  ambiguous multiple push URLs. Never derive an id from the fetch remote or
  directory name. With no supported GitHub push remote, **ask your human**.
- **GitHub App mode (`AUTH_MODE=github-app`):** the server verifies the
  browser-linked human’s remote permission. The agent never receives or stores
  a GitHub token.
- **Manual mode (`AUTH_MODE=manual`):** repository authorization is explicitly
  unverified; a project owner grants membership. It remains fully functional
  without a GitHub App.
- A local `gh`/push check is a doctor diagnostic only; it never authorizes
  Mediation because an agent can forge local output.
- Agents cannot administer projects or membership.
- **Not a member** of an existing project → `403`:
  `{ "error": "not a member of project \"x\"", "project", "hint", "docs": "/auth.md" }`.
  Relay the `hint` to your human verbatim and **stop**: do not retry, do not
  switch ids, do not create another project. Only an owner can add you.
- **Unknown project** → `404`:
  `{ "error": "project not found", "project", "hint": "... Projects you can access: a, b", "docs": "/auth.md" }`.
  That usually means a typo, so compare with the list in the hint.
- Your session's `developer` is overwritten with the username that owns your
  credential: attribution is verified, not self-declared.

### GitHub repository integration

In GitHub App mode the official client calls:

```
POST /api/repositories/github/session
{ "owner": "acme", "repository": "widget", "agent": "claude-code", "machine": "host" }
```

The server resolves the App installation, immutable repository ID and the
linked GitHub user's exact `write` or `admin` permission before it returns a
server-selected project, session, process-local capability and five-minute
authorization metadata. The client persists only `{ server, repository }`.
Path-based project creation is manual-mode compatibility only.

## Workflow

### 1. Connect (once per session)

```
repository initialization → `{ "repository": { "owner": "<owner>", "repo": "<repo>" },
"agent": "<harness>", "machine": "<host>" }`
→ `{ "project": "<internal binding>", "id": "<sessionId>", "capability": "<secret>", ... }`
```

Keep `sessionId` and the secret `capability`. Send the capability as
`X-Mediation-Session` on every request that names that session or its claims
or bugs, including `check?sessionId=...`.
You must heartbeat or your session and claims expire.

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
required, but the more scope you declare (files, components, task), the better
overlap detection works for everyone.

### 4. Keep it alive and current

```
POST  /api/projects/{project}/sessions/{sessionId}/heartbeat  { "activity": "running tests" }
POST  /api/projects/{project}/sessions/{sessionId}/repo       { "branch": "main", "revision": "a1b2c3d", "dirtyFiles": ["src/auth/login.js"] }
PATCH /api/projects/{project}/claims/{claimId}                { "status": "in-progress", "finding": "root cause: stale cookie" }
```

Expiry semantics:

- Sessions expire without a heartbeat (`SESSION_TTL_MS`, default 300 000 ms,
  published as `sessionTtlMs` by `GET /api/health`); their claims are released.
  Beat at roughly a quarter of that TTL and keep beating after a failed one: a
  client that gives up on the first network error expires a session whose agent
  is still working.
- Claims with no updates expire after **45 minutes** of inactivity.
- Completed claims are kept (`status: "done"`).

Report findings as you discover them (`finding` on PATCH appends to the
claim's findings list). Other agents read them and skip work you already did.

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
{ "sessionId": "<your own>", "status": "claimed" }   # or "fixed"; may also change "severity"
```

Bug status values: `open`, `claimed`, `fixed`.

A bug belongs to the project, not to the session that filed it: send **your
own** `sessionId` (with its `X-Mediation-Session` capability) and you may
resolve any bug in the project, including one another agent reported. A
signed-in human sends no `sessionId` and is authorized by membership, which is
how the dashboard closes bugs. Resolve what you fix, or the list grows into
noise nobody reads.

**GitHub issues (optional).** A bug carries `issueUrl`, set when the reporting
client had an authenticated `gh` and opened a tracking issue. Only `high` and
`critical` bugs earn one, whenever they reach that severity; `low`, `medium`
and `unknown` stay in Mediation, so filing bugs liberally never turns into a
flooded issue tracker. This is entirely client-side and best-effort: the server
never talks to GitHub for bugs, and a machine without `gh` files ordinary
unlinked bugs. The MCP client keeps the two in step in both directions,
resolving a bug when its issue is closed (by a merged PR, say) and closing the
issue when the bug is resolved here.

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
`node src/cli/mediation-agent.ts`) wraps all of the above. Server/session come
from initialization. `--project` is legacy compatibility only; new automation
uses the server-returned binding rather than accepting a model-provided id.

```
mediation-agent connect --project P --agent NAME
export MEDIATION_SESSION=<id> MEDIATION_SESSION_CAPABILITY=<capability> MEDIATION_PROJECT=P
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
overlap detected, so gate on it in scripts.

## Device login (persistent credentials)

An agent logs in once per server/machine and reuses a durable, narrow device
credential (the MCP client automates this via `mediation_login`):

```
Manual mode: `POST /api/auth/device-login { "username": "kyle", "password": "...", "machine": "host" }`
→ { "token": "<bearer token>", "user": { "username": "kyle", ... } }
```

Pending accounts receive `403 { "status": "pending" }`; ask an admin to
activate the account. In GitHub App mode, the human authorizes in a browser;
the device receives only a narrow Mediation token. Do not persist a password or
any GitHub token.

GitHub App machine activation:

```
POST /api/auth/device/start  { "machine": "host" }
→ { "requestId", "secret", "userCode", "verificationUri", "expiresAt" }

POST /api/auth/device/redeem { "requestId", "secret" }
→ 202 { "status": "waiting-for-github" | "waiting-for-approval" }
→ 200 { "token": "<mediation bearer>", "user": { ... } }
```

The activation secret stays on the initiating machine. The human opens the
verification URL, signs into GitHub, and confirms the displayed code.

The token is a durable `Authorization: Bearer` credential (revocable from the
dashboard). Send it on every project request. Unauthenticated project calls
get 401. `GET /api/auth/me` validates a stored credential. Full auth reference,
including the human user-account flow and the authorization matrix: `/auth.md`.

## MCP install (recommended for agents)

One command per developer machine, and the dashboard's Settings page shows it
with this server's URL baked in:

```
curl -fsSL <server>/install.sh | bash
```

This registers the `mediation` MCP server (tools `mediation_init`,
`mediation_check`, `mediation_claim`, `mediation_update`,
`mediation_complete`, `mediation_bug`, `mediation_bug_resolve`,
`mediation_state`, `mediation_status`)
in claude-code, codex and kimi, and installs a skill teaching the workflow.
Re-run the install command to update. `<server>/uninstall.sh` reverses the
manifest-owned harness changes and removes global device auth by default
(`--keep-auth` preserves it). Per-project `.mediation.json` contains only the
server/repository mapping; the device credential lives in platform config (XDG on Linux,
Application Support on macOS, APPDATA on Windows). Project state is read and
written in the git toplevel of wherever the client was started, or the
`directory` argument / `MEDIATION_DIR` env var when explicitly set.
`mediation_init` has no project-name override. It derives the repository from
the GitHub push remote and reports its source. State that to your human before
work starts.
