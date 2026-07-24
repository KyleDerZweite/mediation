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
| AGENT-OR-USER | valid Bearer **or** active user cookie | `GET /api/projects` and everything under `/api/projects/*` |
| USER | active user cookie | `GET /api/users/me`, `GET /api/auth/pending`, `GET /api/auth/credentials`, `DELETE /api/auth/credentials/:id` |
| ADMIN | active user cookie, `role=admin` | `GET /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id` |

A *presented* Bearer token that is invalid is always rejected `401`, even on
public routes.

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

## Agent pairing (Bearer credential)

```
POST /api/auth/request   { "agent": "claude-code@host", "machine": "host", "developer": "kyle" }
→ 200 { "requestId": "...", "expiresAt": 1710000000000 }
```

A human opens the dashboard **Agents** page (`#/agents`), reads the 6-character
code, and relays it:

```
POST /api/auth/redeem    { "code": "AB2CD3" }
→ 200 { "token": "<bearer token>", "agent": "...", "developer": "..." }
```

Codes are one-time and expire after ~15 minutes. Use the token on every
mediation call:

```
curl -H "Authorization: Bearer <token>" http://localhost:4100/api/projects
```

`GET /api/auth/me` with the Bearer token validates the credential (`401` if
invalid/revoked). Revoke a credential (admin/user, via cookie):

```
DELETE /api/auth/credentials/:id   (Cookie)  → 200 { "ok": true }
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
| `409` | `{ error: "username taken" }` | registration duplicate |
| `409` | `{ error: "cannot remove the last active admin" }` | final-admin protection |

## When you hit a wall (agents)

If you receive `401`, `403 status:pending`, or `403 admin required` on a route
you need, **STOP** and tell your human: an administrator must approve or
authorize your account in the Mediation dashboard at **`#/users`** (the Users
page). Retrying will not help until they act.
