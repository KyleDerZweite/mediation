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

Detects **claude-code**, **codex** and **kimi** (default: all found), registers
the Mediation MCP server with the server URL baked in, and installs a skill
that teaches agents the workflow. Then, in any project directory, tell the
agent *"set up mediation"* — it derives the project id from the git remote (one
project per repository) and tells you which id it picked, then requests
pairing. Click **Approve** on the dashboard's Agents page, read the revealed
8-character code to the agent, and the credential is stored in
`.mediation.json` (gitignored) — that directory never needs setup again.

To remove it all again: `curl -fsSL http://<your-server>/uninstall.sh | bash`
(your per-project `.mediation.json` files are left in place — they hold
credentials; `find ~ -name .mediation.json` lists them).

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
export MEDIATION_SESSION=<id> MEDIATION_PROJECT=demo
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

Idle claims expire after 30 minutes; completed claims are kept.

## Tests

```bash
pnpm test            # node:test suites
pnpm run typecheck   # tsc --noEmit
```

## Deploy (podman)

```bash
cp .env.example .env          # then fill the NEWT_* / PANGOLIN_ENDPOINT values
podman-compose up -d --build  # starts mediation on :4100 (+ the Newt tunnel)
```

### Upgrading

The database migrates itself on start (additive schema + one-shot backfill), so
an upgrade is: back up, pull, rebuild.

```bash
podman-compose stop mediation && cp data/mediation.db data/mediation.db.bak && podman-compose up -d --build mediation
git pull                       # (before the rebuild, if you deploy from source)
```

Keep a rolling backup — SQLite is a single file:

```
# crontab -e   → nightly copy, keeps the last 7 by date
0 3 * * * cp /path/to/mediation/data/mediation.db /path/to/backups/mediation-$(date +\%F).db
```

Newt values come from your Pangolin dashboard (Sites → Add Site → Newt); point
the Pangolin site at `mediation:4100`. SQLite data persists in `./data`.
Mediation runs standalone: without Newt credentials the tunnel container just
crash-loops while mediation keeps serving on `:4100` — or run only it with
`podman-compose up -d mediation`.

## Users & auth

The API requires an identity. Two credential kinds (details:
[`docs/auth.md`](docs/auth.md), served at `/auth.md`):

- **Agents** pair once and send `Authorization: Bearer <token>` on every
  `/api/projects/*` call (see [Connect your coding agents](#connect-your-coding-agents-one-command)).
  A pairing request must be **approved** by a human in the dashboard before its
  8-character code appears; the resulting credential belongs to that user and
  can only reach the projects that user is a member of.
- **Humans** register an account and use the dashboard with a session cookie.

**Projects are private.** A project has members (`owner` / `member`). Owners add
people by username on the project's **Members** tab; nobody else can see the
project at all. An agent that starts a session on an unknown project id creates
that project and its owner becomes the credential's owner. Agents never manage
membership — that is human-only.

**Bootstrap (first run):** deploy, open the dashboard, and register the first
account. Because the user table is empty, that account becomes an **active
administrator** and is logged straight in. Every later registration is created
**pending** and cannot sign in until an admin approves it on the **Users** page
(`#/users`), where admins also disable/reactivate, change roles, and delete
accounts. No credentials are committed or defaulted anywhere.

Roles: `admin` (user administration) and `user`. What needs what:

| Access | Requirement |
| --- | --- |
| `/api/projects/:p/*` (the mediation API) | membership of that project (agent token or user session) |
| Create a project, manage its members | human session; owner for changes |
| Dashboard + pairing approval | active user session |
| Approve / disable / role / delete users | `admin` session |

The last active admin cannot be demoted, disabled, or deleted, and neither can
a project's last owner. Invitations and an audit trail remain specified in
[`docs/PRODUCT.md`](docs/PRODUCT.md). Release notes and known limitations:
[`CHANGELOG.md`](CHANGELOG.md).
