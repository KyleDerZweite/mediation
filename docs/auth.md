# Mediation Authentication & Authorization

This document is the auth discovery manifest for the Mediation API. It is served
at `/auth.md`, and every `401` response advertises it:

```
WWW-Authenticate: Bearer resource_metadata="/auth.md"
{ "error": "authentication required", "auth": "/auth.md" }
```

Base URL is the server root, e.g. `http://localhost:4100` (in production, behind
the Pangolin tunnel over HTTPS). All bodies are JSON; errors are `{ "error": ... }`
with a proper HTTP status (validation failures are `400` with Zod `issues`).

## Agent first run

When a user says to register and install Mediation from this server:

1. Install the MCP client and skill with `curl -fsSL <server>/install.sh | bash`
   (Windows PowerShell: `irm <server>/install.ps1 | iex`).
   The installer has an interactive harness picker; for headless execution use
   `--all --yes` after `bash -s --`.
2. Restart the agent harness if it does not discover the new MCP server in the
   current process.
3. Follow this server's authorization mode below. In GitHub App mode the human
   performs browser authorization; in manual mode call `mediation_register`
   with the username/password the user chose.
4. In manual mode, tell the user an administrator must activate the account on
   the dashboard **Users** page. Do not retry in a loop.
5. After authorization/activation, call `mediation_login` once. It stores only
   a narrow device token; it never stores a GitHub token.
6. In the repository, call `mediation_init`, then `mediation_check` before
   coding.

Re-run the install command to update. To uninstall, run
`curl -fsSL <server>/uninstall.sh | bash`; add `--keep-auth` only when the user
explicitly wants to preserve the global device token.

## Authorization mode

`AUTH_MODE` is selected by the server operator, never by an agent.

| Mode | Account/device flow | Repository access |
| --- | --- | --- |
| `github-app` | Human completes the configured GitHub App flow in a browser; the server issues a narrow Mediation device credential. | Server verifies the linked GitHub user and repository permission. A local `gh` check may diagnose setup but never authorizes. |
| `manual` | Human registers, an admin activates the account, then the device exchanges the password once for a Mediation credential. | Explicit Mediation project membership. This mode intentionally makes no GitHub-access claim. |

GitHub App integration requires operator configuration (App ID, private key,
client credentials, callback/device-flow endpoints, and required repository
permissions). These are server integration points and deployment secrets; do
not put them in an agent config, repository file, command line, or log. The
agent machine stores only its Mediation device token keyed by server origin.

### GitHub App flow

The human starts at `GET /api/github/login`. The callback
`GET /api/github/callback` exchanges the OAuth code, calls GitHub `/user`,
stores only the immutable GitHub user id and current login, and discards both
the access and refresh token. A new account is pending until an administrator
activates it. The configured `GITHUB_BOOTSTRAP_ADMIN` login is the only
first-run exception.

Agents use the server's own one-time machine activation:

```
POST /api/auth/device/start  { "machine": "host" }
POST /api/auth/device/redeem { "requestId": "...", "secret": "..." }
```

Redeem returns `202 waiting-for-github` or `202 waiting-for-approval` until the
browser and administrator steps are complete, then returns one narrow
Mediation bearer. The activation secret is stored only as a hash server-side.

For each repository process the official client calls:

```
POST /api/repositories/github/session
{ "owner": "acme", "repository": "widget", "agent": "codex", "machine": "host" }
```

The server finds the App installation, resolves the immutable repository id,
queries GitHub's collaborator-permission endpoint for the bound GitHub
identity, verifies the returned user id, and allows only exact `write` or
`admin`. The response binds a short-lived capability to that internal project
and carries `authorizationSource: "github"` metadata. The verification expires
after five minutes and is refreshed by heartbeat. Expired or revoked access
ends the session and releases its live claims.

That five-minute window is **freshness, not membership**, and it gates agents
only. The membership itself stands until GitHub revokes it (webhook) or an
owner removes it, so a human's dashboard keeps listing and opening a project
between agent sessions. A project no one has touched for seven days drops out
of `GET /api/projects`, and it is only hidden: it keeps its history and
members, answers on its own URL, and returns on the next event. Nothing deletes a
project except `DELETE /api/projects/:p` by an owner.

## Two credential kinds: pick the right one

| Credential | Who | How to get it | Sent as | Use for |
| --- | --- | --- | --- | --- |
| **Device Bearer token** | a coding agent on a user's machine | GitHub App browser/device flow, or `POST /api/auth/device-login` in manual mode | `Authorization: Bearer <token>` | the mediation API (`/api/projects/*`) |
| **User session cookie** | a human | register + login | `Cookie: mediation_user=<token>` | the dashboard + admin endpoints |

If you are an **agent** scripting the coordination API, use the global device
token, and do not persist a human login/cookie. If you are driving the
**user/admin** endpoints programmatically, log in and persist the cookie.

## Authorization matrix

| Level | Requirement | Endpoints |
| --- | --- | --- |
| PUBLIC | none | `GET /api/health`, mode-specific sign-in/device routes, `POST /api/users/logout`, `GET /api/auth/me`, GitHub callback/webhook, all non-`/api` routes |
| AGENT-OR-USER | valid Bearer **or** active user cookie | `GET /api/projects` (the response is filtered to what you may see) |
| PROJECT-MEMBER | member of `:p` (any role), **or** instance admin cookie | everything under `/api/projects/:p/`: sessions, heartbeat, repo, claims, bugs, state, check |
| PROJECT-OWNER | `owner` of `:p` (or instance admin), human cookie only | `POST/PATCH/DELETE /api/projects/:p/members*`, `DELETE /api/projects/:p` |
| USER | active user cookie (human only) | `POST /api/projects`, `GET /api/users/me`, `GET/DELETE /api/auth/credentials*` |
| ADMIN | active user cookie, `role=admin` | `GET /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id` |

A *presented* Bearer token that is invalid is always rejected `401`, even on
public routes.

**Agents never administer.** Creating projects, adding/removing members,
deleting a project are human-only: with a valid
Bearer they answer `403 { "error": "project administration is human-only" }`
(or `401` where no identity applies). Instance-admin power applies to the
**cookie** only, and an admin's own agent credential has no admin rights.

**Who is the actor?** For project authorization the actor is the cookie user
if present, otherwise the user that owns the Bearer credential. A credential
whose owner is missing or not `active` never authenticates. Reactivate the
account, then use `mediation_login` again if the device credential was revoked.

## Manual-mode human user accounts

### Register → pending

The **first** account ever registered becomes an active administrator
(bootstrap). Every later registration is created `status: "pending"` and cannot
log in until an administrator approves it.

```
POST /api/users/register    { "username": "alice", "password": "correct horse" }
→ 200 { "user": { "id": "...", "username": "alice", "role": "user",
                  "status": "pending", "createdAt": 1753257600000 },
        "bootstrap": false }
```

- Username is normalized (trimmed + lowercased) and must match
  `^[a-z0-9][a-z0-9_-]{2,31}$` (3–32 chars) → else `400`.
- Password: 8–128 characters → else `400`.
- Duplicate username → `409 { "error": "username taken" }`.
- `bootstrap: true` means this account is the active admin (log straight in).

### Login → cookie

```
POST /api/users/login    { "username": "alice", "password": "correct horse" }
→ 200 { "user": { ... } }
   Set-Cookie: mediation_user=<token>; Path=/; HttpOnly; SameSite=Lax
```

The cookie is a 7-day session. Persist and send it as `Cookie: mediation_user=…`
(browsers do this automatically for the dashboard). Failure modes:

| Response | Meaning |
| --- | --- |
| `401 { "error": "invalid credentials" }` | wrong password **or** unknown user (identical, so there is no enumeration) |
| `403 { "error": "account pending approval", "status": "pending" }` | correct password, awaiting admin approval, with **no cookie set** |
| `403 { "error": "account disabled", "status": "disabled" }` | account disabled, with **no cookie set** |

curl example that keeps the cookie in a jar:

```
curl -c cookies.txt -X POST http://localhost:4100/api/users/login \
  -H 'content-type: application/json' -d '{"username":"alice","password":"correct horse"}'
curl -b cookies.txt http://localhost:4100/api/users/me
```

### Who am I / log out

```
GET  /api/users/me    (Cookie)  → 200 { "user": { ... } }   |  401 if no/expired/disabled session
POST /api/users/logout          → 200 { "ok": true }        (clears the cookie; idempotent)
```

A user disabled or deleted mid-session is invalidated immediately, so the next
request returns `401`.

## Manual-mode projects and membership

Projects are real objects, private by default, and owned by users.

```
GET    /api/projects                     → [ { "id": "acme", "role": "owner", "sessions": 1, ... } ]
POST   /api/projects   { "id": "acme" }  (Cookie) → 200 { "id": "acme", "createdAt": ... } | 409 taken
GET    /api/projects/:p/members          (member)  → [ { "userId", "username", "role", "createdAt" } ]
POST   /api/projects/:p/members  { "username": "bob", "role": "member" }   (owner) → 200 | 404 | 409
PATCH  /api/projects/:p/members/:uid  { "role": "owner" }                  (owner) → 200 | 409 last owner
DELETE /api/projects/:p/members/:uid                (owner, or yourself)   → 200 | 409 last owner
DELETE /api/projects/:p                             (owner or instance admin) → 200 (cascades)
```

- New ids must match `^[a-z0-9][a-z0-9._-]{0,63}$` after trim+lowercase → else
  `400`. Ids created before this rule keep working.
- `GET /api/projects` lists only your memberships (`role` tells you which);
  an instance admin sees every project, with `role: null` where they are not a
  member.
- Only **active** users can be added, by username → unknown/inactive is `404`.
- The last `owner` of a project cannot be demoted or removed → `409`. An
  instance admin does not bypass this.
- Agents create projects one way only: `POST /api/projects/:p/sessions` on an
  unknown id creates it and makes the credential's owner its owner.

### The two project errors

Not a member of an existing project, **403**:

```json
{ "error": "not a member of project \"acme\"", "project": "acme",
  "hint": "Ask a project owner (or instance admin) to add your user in the dashboard Members tab. Retrying will not help until they act.",
  "docs": "/auth.md" }
```

Unknown project, **404**:

```json
{ "error": "project not found", "project": "ghost",
  "hint": "Check the spelling, or start a session to create it. Projects you can access: acme, demo",
  "docs": "/auth.md" }
```

Project existence is **not** treated as a secret on this instance: the two
statuses are distinguishable on purpose, so an agent can tell "typo" from
"ask for access". Nothing about a project's contents leaks either way.

## Manual-mode device login (Bearer credential)

```
POST /api/auth/device-login { "username": "kyle", "password": "...", "machine": "host" }
→ 200 { "token": "<bearer token>", "user": { "username": "kyle", ... } }
```

The account must already be active; pending accounts receive `403` with
`status: "pending"`. The client exchanges the password once, discards it, and
stores only this narrow, revocable token in an OS-global config file keyed by
server origin. Sessions are still attributed to the verified account. Use the
token on every mediation call:

```
curl -H "Authorization: Bearer <token>" http://localhost:4100/api/projects
```

`GET /api/auth/me` with the Bearer token validates the credential and reports
`ownerUsername` (`401` if invalid, revoked, or the owner is gone/disabled).
Credentials are personal: `GET /api/auth/credentials` returns **only your own**
credentials, an admin included, each with `ownerUsername` and the
human-facing `ownerDisplayName` (the GitHub login). Revoking is allowed for the
owner or an admin, else `403`:

```
DELETE /api/auth/credentials/:id   (Cookie)  → 200 { "ok": true } | 403 | 404
```

## Detecting approval state (agents)

An agent whose human has registered but not yet been approved will see `403`
with `status: "pending"` on login, and `401` on protected routes. Poll login
periodically, or simply ask the human to approve the account. **Do not spin.**

## Admin actions (dashboard `#/users`)

Only administrators may approve, disable/reactivate, change roles, or delete
accounts:

```
GET    /api/users                 (admin cookie) → [ { user }, ... ]
PATCH  /api/users/:id  { "status": "active" }    → approve a pending user
PATCH  /api/users/:id  { "status": "disabled" }  → disable (kills their sessions)
PATCH  /api/users/:id  { "role": "admin" | "user" }
DELETE /api/users/:id                            → 200 { "ok": true }
```

- `status` may only be set to `active` or `disabled`, and `pending` is never
  settable (approving = `active`).
- The **last active admin** cannot be demoted, disabled, or deleted (self
  included) → `409 { "error": "cannot remove the last active admin" }`.
- Unknown `:id` → `404`.

## Common errors

| Status | Body | Cause |
| --- | --- | --- |
| `400` | `{ error, issues }` | bad username/password shape |
| `401` | `{ error: "invalid credentials" }` | wrong password or unknown user (login) |
| `401` | `{ error, auth: "/auth.md" }` + `WWW-Authenticate` | missing/expired/invalid identity on a protected route |
| `403` | `{ error: "account pending approval", status: "pending" }` | not yet approved |
| `403` | `{ error: "account disabled", status: "disabled" }` | disabled account |
| `403` | `{ error: "admin required" }` | user cookie present but not an admin |
| `403` | `{ error: 'not a member of project "x"', hint, docs }` | valid identity, no membership |
| `403` | `{ error: "project administration is human-only" }` | agent credential on a members/create/delete route |
| `403` | `{ error: "project owner required" }` | member but not owner |
| `403` | `{ error: "account pending approval", status: "pending" }` | device login before an admin activated the account |
| `404` | `{ error: "project not found", hint, docs }` | unknown or malformed project id |
| `401` | `{ error: "credential owner is unavailable; sign in again after reactivation" }` | credential with no active owning user |
| `409` | `{ error: "cannot remove the last owner of the project" }` | last-owner protection |
| `409` | `{ error: "username taken" }` | registration duplicate |
| `409` | `{ error: "cannot remove the last active admin" }` | final-admin protection |

## When you hit a wall (agents)

If you receive `401`, `403 status:pending`, or `403 admin required` on a route
you need, **STOP** and tell your human: an administrator must approve or
authorize your account in the Mediation dashboard at **`#/users`** (the Users
page). Retrying will not help until they act.

On `403 not a member of project "x"` or `404 project not found`, relay the
response's `hint` to your human **verbatim** and stop. Do not retry, do not
switch project ids, and do not create a different project to get around it.
Only an owner (or instance admin) can grant access, from the project's
**Members** tab.
