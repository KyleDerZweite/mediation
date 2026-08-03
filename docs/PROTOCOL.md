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

Also useful: `GET /api/projects/{project}/state` returns logical agent
executions, active sessions, claims, bugs, pairwise conflicts, recent files,
events, and completed work. The server always returns `agents`, which is empty
when the harness reports no lineage. `agentCount` gives the total before the
bounded state preview.

### Optional harness crew reporting

Mediation can show a harness's root agent and subagents as a crew without
making that tree part of coordination or authorization. Claims remain the
source of truth for work ownership. The crew tree supplies execution context.

The official MCP client adds optional lineage metadata to session creation:
`runId`, `agentId`, `parentAgentId`, `agentName`, `agentRole`, `agentTask`,
`agentState`, and `agentStateReason`. These describe the MCP process when its
session starts. A heartbeat does not treat static environment values as live
lifecycle updates. The client reads them from this exact environment allowlist:

| Environment variable | Session field |
| --- | --- |
| `MEDIATION_HARNESS` | session `agent` / execution `harness` |
| `MEDIATION_RUN_ID` | `runId` |
| `MEDIATION_AGENT_ID` | `agentId` |
| `MEDIATION_PARENT_AGENT_ID` | `parentAgentId` |
| `MEDIATION_AGENT_NAME` | `agentName` |
| `MEDIATION_AGENT_ROLE` | `agentRole` |
| `MEDIATION_AGENT_TASK` | `agentTask` |
| `MEDIATION_AGENT_STATE` | `agentState` |
| `MEDIATION_AGENT_STATE_REASON` | `agentStateReason` |

`CODEX_THREAD_ID` is a fallback for `runId` only. The client scopes and hashes
it to the server and repository before upload. The client does not infer an
agent or parent id. The client omits blank, unsafe, invalid, or overlong values.
Thus, older harnesses and sessions continue to work unchanged. If several
subagents share one MCP process, its environment describes that process. It
does not identify the caller.

The heartbeat schema also accepts `agentTask`, `agentState`, and
`agentStateReason` for clients that have a real live signal. The official MCP
client does not copy the static environment values into heartbeats.

Names, roles, tasks, states, and reasons from explicit environment metadata are
project-member data. Shared `ProjectState` strips raw run, agent, and parent
agent ids. Its sessions expose only `agentLineage: true|false`. Mutation
responses to the reporting device can return its submitted correlation ids.
Do not put a secret or a reusable cross-project identifier in these variables.
Only the native harness id fallback is automatically scoped and hashed.

Harness lifecycle adapters instead report explicit events. This route requires
a device Bearer. A cookie alone gets 403, and no session capability is needed.
If both credentials are present, the credential owner supplies identity and
membership.

```
POST /api/projects/{project}/agent-events
{ "eventId": "opaque-retry-stable-id", "runId": "run-42", "agentId": "worker-3",
  "parentAgentId": "root", "harness": "codex", "name": "Test worker",
  "role": "worker", "task": "Run focused tests", "state": "active",
  "stateReason": null, "occurredAt": 1753257600000 }
```

`eventId`, `runId`, `agentId`, and `occurredAt` are required. States are
`starting`, `active`, `waiting`, `blocked`, `needs-input`, `completed`,
`failed`, or `cancelled`. An `eventId` retry is idempotent only when its
canonical content is identical. Reusing the id with changed content gets 409.
The endpoint derives
the developer and provenance from the device credential. Clients cannot submit
either. The server resolves parent references only within the same project,
credential owner, and run. It returns the parent's server id in `parentId`.

The server accepts client event times within five minutes of receipt for
ordering. A past time outside that window gets 409 when no execution exists.
It is a no-op when the execution still exists. This rule prevents an old retry
from recreating history after retention removes the execution and retry row.
The server bounds a future time outside the window to receipt time.

Each `ProjectState.agents` entry has this shape:

```
{ "id": "server-execution-id", "projectId": "...",
  "parentId": "server-parent-id", "parentUnavailable": false,
  "parentOutsidePreview": false, "harness": "codex",
  "name": "Test worker", "role": "worker", "task": "Run focused tests",
  "state": "active", "stateReason": null, "provenance": "harness-reported",
  "sessionId": null, "developer": "Alice", "startedAt": 1753257600000,
  "updatedAt": 1753257600000, "endedAt": null, "stale": false }
```

The server derives `provenance`. Native lifecycle events are
`harness-reported`. Session/environment metadata is `environment-reported`.
Shared state never includes `runId`, `agentId`, or `parentAgentId`. This value
identifies the reporting channel, not verified identity or delegation. The
server also derives `stale` from lifecycle freshness and a
live transport session for the same actor and run. Terminal executions are not
stale. The dashboard uses only the resolved `parentId` for the tree.
`parentUnavailable` distinguishes a reported parent that is absent from a true
root. Missing parents and cycles render under **Unattached agents**.

`parentOutsidePreview` means the server still has the parent, but the bounded
preview omitted it. In that case the server clears `parentId` to avoid a
dangling edge. The dashboard groups the child under **Lineage continues outside
preview**, not under **Unattached agents**.

A transport `Session` still expires after its normal heartbeat TTL. Its linked
logical execution remains and loses only the `sessionId` association.
Transport shutdown does not mean logical completion. The server returns at
most 200 active executions and 50 recent terminal executions in `agents`.
`agentCount` reports all retained executions. Lifecycle reports and state reads
prune terminal and stale, unlinked nonterminal executions after seven days.
Each project user keeps the newest 1,000 unlinked executions plus all linked
executions. The server also limits event retry records to 5,000 per project
user.

The installer wires the dependency-free lifecycle bridge into Codex and
Claude Code for `SessionStart`, `SessionEnd`, `SubagentStart`, and
`SubagentStop`. For Claude Code it also wires the observed-activity events
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, and
`PreCompact`. Codex stays lifecycle-only: no tool-level Codex hook event name
is verifiable here, and a guessed one would install dead configuration.
Codex requires the user to open `/hooks` and review/trust the
installed command before it runs. The hook is silent and fail-open when the
server, repository mapping, credential, or input is unavailable. Kimi has no
native lifecycle hook and therefore remains MCP/environment-only. Its sessions
stay visible, but a crew tree appears only when valid lineage is available.
Native session and agent ids are scoped and hashed before upload.

Each native hook invocation creates one occurrence timestamp and a unique
event id. Thus, a `Start` after `End` resumes the same logical execution.
`SubagentStart` refreshes the root and starts the child. `SubagentStop` reports
only the child's completion and does not reopen the root.

Observed activity reuses the existing states. It adds no new ones:

| Event | `state` | `stateReason` |
| --- | --- | --- |
| `UserPromptSubmit` | `active` | `processing prompt` |
| `PreToolUse` | `active` | one coarse category per tool name |
| `PostToolUse` | `active` | `working` |
| `Notification` | `needs-input` | `waiting for approval`, else `needs attention` |
| `Stop` | `waiting` | `idle` |
| `PreCompact` | `active` | `compacting context` |

The `PreToolUse` categories are `running a command`, `editing files`,
`reading code`, `delegating to a subagent`, `using an MCP tool`, `browsing`,
and `using a tool` for anything unrecognised. No state in the table above is
terminal, so an observed event never sets `endedAt`; only `SessionEnd` and
`SubagentStop` end an execution.

The hook debounces observed activity against a per-run cache file in a scratch
directory, keyed by the hashed run id. An unchanged state makes no request at
all, not even the project lookup, because the harness waits for the hook on
every tool call. A changed state always posts. A changed reason within the same
state posts once when there was no reason before, and is otherwise rate limited
to one report per fifteen seconds, so read/edit/read alternation does not spam.
The cache is advisory: any read or write failure behaves as an empty cache and
costs at most one redundant report. Lifecycle events are never debounced,
because a repeat still has to deliver parent links, resumption, or a terminal
state. Each occurrence keeps its own event id, so a repeat is never a
changed-payload reuse of an existing one.

The dashboard bounds the Crew tree in a keyboard-focusable scroll region.
`stale` is a secondary freshness qualifier. It does not replace a lifecycle
state such as **Blocked**, **Needs input**, or **Failed**.

Crew task and reason text is visible to every project member. Report only a
short telemetry-safe summary: never copy a prompt, transcript, assistant
message, tool input/output, secret, permission data, model setting, or absolute
path. The native hook reads only the event name, stable session and
agent ids, agent type, and `cwd`. It uses `cwd` locally to find
`.mediation.json`. It does not send `cwd` or the excluded content. A tool name
and a notification message are read locally only to select one of the fixed
phrases above; neither the tool name itself nor any tool input, path, command,
URL, or message text is sent, and an unrecognised tool falls back to a generic
phrase so a custom or MCP tool name cannot leak through the mapping. The
dashboard and raw HTTP state show free-text crew metadata. MCP
`mediation_state` news does not include it.

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
  published as `sessionTtlMs` by `GET /api/health`). Beat at roughly a quarter
  of that TTL and keep beating after a failed one: a client that gives up on
  the first network error expires a session whose agent is still working.
- A claim outlives the session that made it. When the session ends, anyone
  blocked on the claim is released, but the claim itself stands: the work is
  still in the working tree, and the client is a child process a harness may
  recycle at any time. Touching the claim from a later session of the same
  developer and worktree re-attaches it, and the response carries a `note`
  saying so.
- Claims with no updates expire after **45 minutes** of inactivity. Expiry sets
  `status: "expired"` (or `"released"` when access was revoked) and keeps the
  row: touching such a claim revives it, or completes it with its commits, and
  says so in `note`. Only an unknown id is a 404.
- Completed claims are kept (`status: "done"`). Completing one twice merges the
  commits instead of entering the history again.

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

Remove one that should never have been filed (mistaken, duplicate, obsolete):

```
DELETE /api/projects/{project}/bugs/{bugId}?sessionId=<your own>
→ { "ok": true }
```

This is a hard delete, not a fourth status: it is for noise, not for work that
was done — resolve what you fixed with `status: "fixed"` so the history reads
true. The report stays in the event feed either way, and a linked GitHub issue
is left open; only Mediation's row goes.

A bug belongs to the project, not to the session that filed it: send **your
own** `sessionId` (with its `X-Mediation-Session` capability) and you may
resolve or remove any bug in the project, including one another agent reported.
A signed-in human sends no `sessionId` and is authorized by membership, which is
how the dashboard closes and removes bugs. Resolve what you fix, or the list grows into
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
credential (the MCP client automates this via `mediation_setup`):

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

This registers the `mediation` MCP server in claude-code, codex and kimi, and
installs a skill teaching the workflow. Five tools, split by the object they
act on rather than by transition, because every tool description is context an
agent pays for on every call and one more decision it can get wrong:

| Tool | Covers |
| --- | --- |
| `mediation_setup` | sign this machine in; register an account in manual mode; report setup state |
| `mediation_init` | bind this repository's GitHub push target (separate, so a harness can deny it on its own) |
| `mediation_claim` | the whole life of a claim: publish (which also checks), record findings, block on another claim, finish as `done` or `abandoned` |
| `mediation_bug` | file a bug, or resolve one by `bugId` |
| `mediation_state` | the live project picture, or what is missing when setup is incomplete |

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
