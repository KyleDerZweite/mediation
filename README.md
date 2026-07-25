# Mediation

Live coordination for developers and coding agents — see overlapping work
**before Git makes it visible**.

Git shows committed work. Mediation shows local work that is still being
investigated, edited, tested, or prepared for commit, so two agents never
unknowingly solve the same problem twice.

> Before another developer or agent starts overlapping work, they can see that
> it is already being handled.

## Quick start

```bash
pnpm install
pnpm start                 # http://localhost:4100
# dashboard:  http://localhost:4100/?project=demo
# agent docs: http://localhost:4100/AGENT.md
```

## Connect your coding agents (one command)

On each developer machine (command also shown in the dashboard's Settings):

```bash
curl -fsSL http://<your-server>/install.sh | bash
```

On Windows PowerShell:

```powershell
irm http://<your-server>/install.ps1 | iex
```

Detects **Claude Code**, **Codex**, **Kimi Code**, and legacy **Kimi CLI**
(default: all found), registers the MCP server, and installs the workflow
skill. Then tell an agent *"register and set up mediation at
http://<your-server>"*. It registers the user, waits for an administrator to
activate the account on the dashboard's **Users** page, and signs the machine
in once. All harnesses share that global device credential; every running
agent still receives a distinct short-lived session id and capability. In
`AUTH_MODE=github-app`, the human completes GitHub App authorization in a
browser and the server verifies remote access; no GitHub token reaches the
agent machine. In `AUTH_MODE=manual`, admin-approved accounts use explicit
Mediation membership instead.

Re-run the install command to update. Remove it with
`curl -fsSL http://<your-server>/uninstall.sh | bash`. Uninstall removes the
global device credential by default (`--keep-auth` preserves it) and leaves
secret-free per-repository `.mediation.json` mappings in place.
On Windows, use `irm http://<your-server>/uninstall.ps1 | iex`.

## Stack

Node.js ≥ 22.18, TypeScript run natively (type stripping — no build step),
[Hono](https://hono.dev) for HTTP, [Zod](https://zod.dev) for protocol
validation, built-in `node:sqlite` for persistence. Nothing else.

## Structure

```
src/core/     Domain: types, wire schemas (zod), overlap rules. Pure, no I/O.
src/server/   Hono app + SQLite store + static serving.
src/cli/      mediation-agent CLI (global fetch, no deps).
web/          Dashboard: static, vanilla JS, no build step.
test/         node:test suites.
```

Boundaries and contributor conventions: [`AGENTS.md`](AGENTS.md).
Product spec: [`docs/PRODUCT.md`](docs/PRODUCT.md).

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness check + server version |
| GET | `/api/projects` | your projects with live counts (admins see all) |
| POST | `/api/projects` | create a project you own (dashboard/human only) |
| GET/POST/PATCH/DELETE | `/api/projects/:p/members[/:uid]` | membership (owners; humans only) |
| DELETE | `/api/projects/:p` | delete a project and everything in it (owner) |
| POST | `/api/projects/:p/sessions` | start a session |
| POST | `/api/projects/:p/sessions/:id/heartbeat` | keep alive / report activity |
| DELETE | `/api/projects/:p/sessions/:id` | end session, release claims |
| POST | `/api/projects/:p/sessions/:id/repo` | report branch/revision/dirty files |
| POST | `/api/projects/:p/claims` | create work claim (returns overlap warnings) |
| PATCH | `/api/projects/:p/claims/:id` | update status/files/findings |
| POST | `/api/projects/:p/claims/:id/complete` | finish with commits/PRs |
| POST | `/api/projects/:p/bugs` | report a discovered bug |
| PATCH | `/api/projects/:p/bugs/:id` | update bug status/severity |
| GET | `/api/projects/:p/state` | full live project state (dashboard uses this) |
| GET | `/api/projects/:p/check` | pre-flight overlap check |

Conflicts are **warnings, not locks** — no request is ever rejected because of
overlap. Full agent-facing instructions with request/response examples:
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) (served to agents at `/AGENT.md`).

## CLI

```bash
node src/cli/mediation-agent.ts connect --project demo --agent my-agent
export MEDIATION_SESSION=<id> MEDIATION_SESSION_CAPABILITY=<capability> MEDIATION_PROJECT=demo
node src/cli/mediation-agent.ts heartbeat --watch 30 &
node src/cli/mediation-agent.ts check --files src/x.js --intent "fix login loop"
node src/cli/mediation-agent.ts claim --intent "fix login loop" --files src/x.js
node src/cli/mediation-agent.ts complete --claim <id> --commits <sha>
```

`check` exits with code `3` when overlap is detected, so agents can gate on it
in scripts:

```bash
node src/cli/mediation-agent.ts check --files src/x.js || exit 1   # stop on overlap (exit 3)
```

## Configuration

Environment variables for the server:

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4100` | listen port |
| `HOST` | — | listen host |
| `DB_PATH` | `./data/mediation.db` | SQLite database file |
| `SESSION_TTL_MS` | `120000` | session expiry without heartbeat |
| `AUTH_MODE` | `manual` | `github-app` in production, `manual` for local/self-hosted auth |
| `PUBLIC_URL` | — | externally reachable origin used for OAuth callbacks and secure cookies |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` | — | GitHub App identifiers |
| `GITHUB_APP_PRIVATE_KEY_FILE` | — | protected App private-key path |
| `GITHUB_APP_CLIENT_SECRET` | — | OAuth client-secret string |
| `GITHUB_WEBHOOK_SECRET` | — | webhook-secret string |
| `GITHUB_BOOTSTRAP_ADMIN` | — | GitHub login allowed to become the first GitHub-backed admin |

Idle claims expire after 30 minutes; completed claims are kept.

## Tests

```bash
pnpm test            # node:test suites
pnpm run typecheck   # tsc --noEmit
```

## Containers

```bash
cp .env.example .env
mkdir -p secrets
# Add only the downloaded private key as secrets/github-app.pem.
podman-compose up -d --build
```

Production uses `podman-compose.yml`, `.env`, GitHub App authentication and the
optional Newt tunnel. For local manual-auth development:

```bash
cp .dev.env.example .dev.env
podman-compose --env-file .dev.env -f podman-compose.dev.yml up --build
```

### Upgrading

The database migrates itself on start (additive schema + one-shot backfill), so
an upgrade is: back up, pull, rebuild.

```bash
podman-compose down && cp data/mediation.db data/mediation.db.bak && podman-compose up -d --build
git pull                       # (before the rebuild, if you deploy from source)
```

Keep a rolling backup — SQLite is a single file:

```
# crontab -e   → nightly copy, keeps the last 7 by date
0 3 * * * cp /path/to/mediation/data/mediation.db /path/to/backups/mediation-$(date +\%F).db
```

Newt values come from your Pangolin dashboard (Sites → Add Site → Newt). For
the public resource target select method `HTTP`, hostname `mediation`, and port
`4100`. Do not add the `http://` prefix to the hostname and do not use
`localhost`—inside Newt, `localhost` is the Newt container itself. Production
does not publish port 4100 on the host; only Newt can reach it through the
Compose network. SQLite data persists in `./data`.

## Users & auth

The API requires an identity. Two credential kinds (details:
[`docs/auth.md`](docs/auth.md), served at `/auth.md`):

- **Agents** receive a narrow, revocable global Mediation device token after
  browser GitHub authorization, or exchange a local password once in manual
  mode. No GitHub token reaches the agent. Each process gets a separate session capability, so
  two Claude/Codex/Kimi instances sharing one device token cannot mutate one
  another's sessions, claims, or bugs.
- **Humans** register an account and use the dashboard with a session cookie.

**Projects are private.** The client resolves the actual GitHub push remote
once and initializes a server-owned repository binding; agents never select
project ids for coordination operations. GitHub App mode authorizes that
binding server-side from the human's linked GitHub identity. Manual mode keeps
explicit `owner` / `member` membership. A local `gh` or push probe is a doctor
diagnostic only, never authorization.

### GitHub App operator setup

`AUTH_MODE=github-app` requires a GitHub App configured by the server operator.
Give it only repository **Metadata: read-only**. Configure its callback as
`<PUBLIC_URL>/api/github/callback` and its webhook as
`<PUBLIC_URL>/api/github/webhook`. The deployment variables are:

```sh
AUTH_MODE=github-app
PUBLIC_URL=https://mediation.example.com
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv23...
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/mediation-github-app.pem
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_WEBHOOK_SECRET=<webhook-secret>
GITHUB_BOOTSTRAP_ADMIN=github-login
```

The private key stays in a protected file; the two short secrets live in the
untracked `.env`. All three stay outside the application database. OAuth user tokens are used only
to resolve immutable identity and are immediately discarded. Until the App is
configured, use `AUTH_MODE=manual`.

**Bootstrap (first run):** in GitHub App mode, the GitHub login named by
`GITHUB_BOOTSTRAP_ADMIN` becomes the initial active administrator. In manual
mode, the first locally registered account becomes the initial administrator.
Every later account is created **pending** and cannot sign in until an admin
approves it on the **Users** page
(`#/users`), where admins also disable/reactivate, change roles, and delete
accounts. No credentials are committed or defaulted anywhere. Device
credentials follow the host platform: XDG config on Linux, Application Support
on macOS, and APPDATA on Windows.

Roles: `admin` (user administration) and `user`. What needs what:

| Access | Requirement |
| --- | --- |
| `/api/projects/:p/*` (the mediation API) | membership of that project (agent token or user session) |
| Create a project, manage its members | human session; owner for changes |
| Dashboard + device credential revocation | active user session |
| Approve / disable / role / delete users | `admin` session |

The last active admin cannot be demoted, disabled, or deleted, and neither can
a project's last owner. Invitations and an audit trail remain specified in
[`docs/PRODUCT.md`](docs/PRODUCT.md). Release notes and known limitations:
[`CHANGELOG.md`](CHANGELOG.md).
