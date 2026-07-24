# Mediation — Authentication & Authorization

This document is the auth discovery manifest for the Mediation API. It is served
at `/auth.md`, and every `401` response advertises it:

```
WWW-Authenticate: Bearer resource_metadata="/auth.md"
{ "error": "authentication required", "auth": "/auth.md" }
```

Base URL is the server root, e.g. `http://localhost:4100` (in production, behind
the Pangolin tunnel over HTTPS). All bodies are JSON; errors are `{ "error": ... }`
with a proper HTTP status (validation failures are `400` with Zod `issues`).

## Two credential kinds — pick the right one

| Credential | Who | How to get it | Sent as | Use for |
| --- | --- | --- | --- | --- |
| **Agent Bearer token** | a coding agent | pairing (below) | `Authorization: Bearer <token>` | the mediation API (`/api/projects/*`) |
| **User session cookie** | a human | register + login | `Cookie: mediation_user=<token>` | the dashboard + admin endpoints |

If you are an **agent** scripting the coordination API, pair once and use the
Bearer token — do not drive the human login/cookie flow. If you are driving the
**user/admin** endpoints programmatically, log in and persist the cookie.

## Authorization matrix

| Level | Requirement | Endpoints |
| --- | --- | --- |
| PUBLIC | none | `GET /api/health`, `POST /api/users/{register,login,logout}`, `POST /api/auth/{request,redeem}`, `GET /api/auth/me`, all non-`/api` routes |
| AGENT-OR-USER | valid Bearer **or** active user cookie | `GET /api/projects` (the response is filtered to what you may see) |
| PROJECT-MEMBER | member of `:p` (any role), **or** instance admin cookie | everything under `/api/projects/:p/` — sessions, heartbeat, repo, claims, bugs, state, check |
| PROJECT-OWNER | `owner` of `:p` (or instance admin), human cookie only | `POST/PATCH/DELETE /api/projects/:p/members*`, `DELETE /api/projects/:p` |
| USER | active user cookie (human only) | `POST /api/projects`, `GET /api/users/me`, `GET /api/auth/pending`, `POST /api/auth/pending/:id/approve`, `DELETE /api/auth/pending/:id`, `GET /api/auth/credentials`, `DELETE /api/auth/credentials/:id` |
| ADMIN | active user cookie, `role=admin` | `GET /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id` |

A *presented* Bearer token that is invalid is always rejected `401`, even on
public routes.

**Agents never administer.** Creating projects, adding/removing members,
deleting a project and approving pairing requests are human-only: with a valid
Bearer they answer `403 { "error": "project administration is human-only" }`
(or `401` where no identity applies). Instance-admin power applies to the
**cookie** only — an admin's own agent credential has no admin rights.

**Who is the actor?** For project authorization the actor is the cookie user
if present, otherwise the user that owns the Bearer credential. A credential
whose owner is missing or not `active` never authenticates:
`401 { "error": "credential must be re-paired" }`.

## Human user accounts

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
| `401 { "error": "invalid credentials" }` | wrong password **or** unknown user (identical — no enumeration) |
| `403 { "error": "account pending approval", "status": "pending" }` | correct password, awaiting admin approval — **no cookie set** |
| `403 { "error": "account disabled", "status": "disabled" }` | account disabled — **no cookie set** |

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

A user disabled or deleted mid-session is invalidated immediately — the next
request returns `401`.

## Projects and membership

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

Not a member of an existing project — **403**:

```json
{ "error": "not a member of project \"acme\"", "project": "acme",
  "hint": "Ask a project owner (or instance admin) to add your user in the dashboard Members tab. Retrying will not help until they act.",
  "docs": "/auth.md" }
```

Unknown project — **404**:

```json
{ "error": "project not found", "project": "ghost",
  "hint": "Check the spelling, or start a session to create it. Projects you can access: acme, demo",
  "docs": "/auth.md" }
```

Project existence is **not** treated as a secret on this instance: the two
statuses are distinguishable on purpose, so an agent can tell "typo" from
"ask for access". Nothing about a project's contents leaks either way.

## Agent pairing (Bearer credential) — approve, then code

```
POST /api/auth/request   { "agent": "claude-code@host", "machine": "host", "developer": "kyle" }
→ 200 { "requestId": "...", "expiresAt": 1710000000000 }
```

The request now appears in the dashboard **without** a code. A human opens the
**Agents** page (`#/agents`) and clicks **Approve** — only then does the
8-character code exist for them to relay:

```
GET  /api/auth/pending                       (Cookie)
→ [ { "id": "...", "code": null, "agent": "claude-code@host", "approvedBy": null, ... } ]

POST /api/auth/pending/<requestId>/approve   (Cookie)
→ 200 { "code": "AB2CD3EF", "approvedBy": "kyle" }

DELETE /api/auth/pending/<requestId>         (Cookie)  → 200 { "ok": true }   # deny
```

Approval is first-come: the same user may re-approve to re-read the code,
anyone else gets `409`. Redeeming an unapproved request is
`403 { "error": "pairing request not approved yet" }`.

```
POST /api/auth/redeem    { "code": "AB2CD3EF" }
→ 200 { "token": "<bearer token>", "agent": "...", "developer": "...", "ownerUsername": "kyle" }
```

The credential belongs to the approver: the agent acts **as that user** on the
projects that user belongs to, and sessions it creates are attributed to that
username no matter what the request body claims. Codes are one-time and expire
after ~15 minutes. Use the token on every mediation call:

```
curl -H "Authorization: Bearer <token>" http://localhost:4100/api/projects
```

`GET /api/auth/me` with the Bearer token validates the credential and reports
`ownerUsername` (`401` if invalid, revoked, or the owner is gone/disabled).
Credentials are scoped: `GET /api/auth/credentials` returns **your own**
credentials (an admin sees all), each with `ownerUsername`. Revoking is allowed
for the owner or an admin, else `403`:

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

- `status` may only be set to `active` or `disabled` — `pending` is never
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
| `403` | `{ error: "pairing request not approved yet" }` | redeem before a human approved |
| `404` | `{ error: "project not found", hint, docs }` | unknown or malformed project id |
| `401` | `{ error: "credential must be re-paired" }` | credential with no active owning user |
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
switch project ids, and do not create a different project to get around it —
only an owner (or instance admin) can grant access, from the project's
**Members** tab.
