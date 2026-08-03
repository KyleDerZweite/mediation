# AGENTS.md: contributor guide

Mediation: live coordination service that prevents developers and coding agents
from unknowingly duplicating work. Product spec: `docs/PRODUCT.md`.
Agent-facing protocol docs: `docs/PROTOCOL.md` (served at `/AGENT.md`, the
URL agents are told to fetch; don't confuse the two files: AGENTS.md = how to
work on this repo, docs/PROTOCOL.md = the product's wire protocol).

## Stack

- Node ≥ 22.18, TypeScript run natively (type stripping, erasable syntax only:
  no enums, no namespaces, relative imports use explicit `.ts` extensions).
  No build step. `pnpm run typecheck` must pass.
- Runtime deps (keep this list short and mainstream): `hono` + `@hono/node-server`
  (HTTP), `zod` (protocol validation). Persistence: built-in `node:sqlite`.
- Tests: `node:test` in `test/*.test.ts` (`pnpm test`). Must pass before done.

## Structure & boundaries

```
src/core/     Domain. Pure: types, wire schemas (zod), overlap rules.
              Imports NOTHING outside core. No I/O, no HTTP, no DB.
src/server/   Hono app + SQLite store + static serving. Imports core.
src/cli/      mediation-agent CLI (global fetch). Imports core only for types.
web/          Dashboard: static, vanilla JS, no build step. Talks to /api only.
              Component reference at `#/design` (unlinked; public on a manual
              instance, session-gated in github-app mode).
test/         node:test suites.
clients/      Things installed on USER machines: MCP client, installer, skill.
docs/         PRODUCT.md (product goal) + PROTOCOL.md (wire protocol, served at /AGENT.md).
design/       Imported claude.ai design reference (read-only).
```

Dependency direction is one-way: `server`/`cli` → `core`. `core` never imports
up. The web dashboard knows only the HTTP API, never server internals. Anything
violating this direction is wrong regardless of convenience.

## API (v1)

Enforcement is strict (single point in `src/server/app.ts`; matrix in
`docs/auth.md`, served at `/auth.md`). Identity is a global **device Bearer**
(issued after the user account is active) and/or a **human user session
cookie**. Levels below: PUBLIC (none), A|U (device bearer OR active user),
MEMBER (member of the project, or instance-admin cookie), OWNER (project owner
or instance-admin cookie, human only), USER (active user, human only), ADMIN
(active admin user).

| Level | Method | Path | Body schema (`src/core/schemas.ts`) |
| --- | --- | --- | --- |
| PUBLIC | GET | `/api/health` | none |
| PUBLIC | POST | `/api/auth/device/start` | `deviceStart` (GitHub App mode) |
| PUBLIC | POST | `/api/auth/device/redeem` | `deviceRedeem` (GitHub App mode) |
| PUBLIC | GET | `/api/github/login`, `/api/github/callback` | browser OAuth |
| PUBLIC | POST | `/api/github/webhook` | signed GitHub webhook |
| A\|U | GET | `/api/projects` | none (ProjectSummary[], filtered to the actor; `role` per row) |
| A\|U | POST | `/api/repositories/github/session` | `githubRepositorySession` → verified repository-bound session |
| USER | POST | `/api/projects` | `projectCreate` → creates + owner membership (409 taken, 400 bad slug). Manual mode only, and not offered in the dashboard: agents bootstrap projects via `mediation_init` |
| MEMBER | POST | `/api/projects/:p/sessions` | `sessionCreate` (manual mode only; auto-creates an unknown project) |
| MEMBER | POST | `/api/projects/:p/sessions/:id/heartbeat` | `heartbeat` |
| MEMBER | DELETE | `/api/projects/:p/sessions/:id` | none |
| MEMBER | POST | `/api/projects/:p/sessions/:id/repo` | `repoReport` |
| MEMBER | POST | `/api/projects/:p/agent-events` | `agentEvent` → `AgentExecution` (idempotent harness lifecycle report) |
| MEMBER | POST | `/api/projects/:p/claims` | `claimCreate` → `{ claim, conflicts }` |
| MEMBER | PATCH | `/api/projects/:p/claims/:id` | `claimPatch` |
| MEMBER | POST | `/api/projects/:p/claims/:id/complete` | `claimComplete` |
| MEMBER | POST | `/api/projects/:p/bugs` | `bugCreate` |
| MEMBER | PATCH | `/api/projects/:p/bugs/:id` | `bugPatch` |
| MEMBER | GET | `/api/projects/:p/state` | none (ProjectState) |
| MEMBER | GET | `/api/projects/:p/check` | query: `sessionId,files,components,task,intent` |
| MEMBER | GET | `/api/projects/:p/members` | none (ProjectMember[]) |
| OWNER | POST | `/api/projects/:p/members` | `memberAdd` (404 unknown user, 409 dup) |
| OWNER | PATCH | `/api/projects/:p/members/:uid` | `memberPatch` (409 last owner) |
| OWNER | DELETE | `/api/projects/:p/members/:uid` | none (a member may remove themselves; 409 last owner) |
| OWNER | DELETE | `/api/projects/:p` | none; cascades sessions/claims/bugs/events/members |
| PUBLIC | POST | `/api/users/register` | `userRegister` (manual mode only) |
| PUBLIC | POST | `/api/users/login` | `userLogin` (manual mode only) |
| PUBLIC | POST | `/api/users/logout` | none; clears cookie |
| PUBLIC | POST | `/api/auth/device-login` | `deviceLogin` → narrow global device token (manual mode only) |
| USER | GET | `/api/users/me` | none; returns the active user identity |
| ADMIN | GET | `/api/users` | none (PublicUser[]) |
| ADMIN | PATCH | `/api/users/:id` | `userPatch` (role?/status?; final-admin protected 409) |
| ADMIN | DELETE | `/api/users/:id` | none (final-admin protected 409) |
| PUBLIC | GET | `/api/auth/me` | Bearer token → identity, 401 if invalid |
| USER | GET | `/api/auth/credentials` | none; own credentials only (admins included), incl. `ownerUsername`/`ownerDisplayName` |
| USER | DELETE | `/api/auth/credentials/:id` | revoke (owner or admin, else 403) |
| PUBLIC | GET | `/install.sh` | installer script, `__MEDIATION_URL__` templated from request proto+host |
| PUBLIC | GET | `/install.ps1` | Windows installer bootstrap, URL templated likewise |
| PUBLIC | GET | `/install/mediation-mcp.mjs` | dependency-free MCP client (stdio), served from `clients/` |
| PUBLIC | GET | `/install/mediation-hook.mjs` | dependency-free Codex/Claude Code lifecycle bridge |
| PUBLIC | GET | `/install/SKILL.md` | agent skill file, served from `clients/skills/mediation/` |

User accounts + sessions live in the same SQLite store (`users`,
`user_sessions`), as do projects and membership (`projects`,
`project_members`); scrypt password hashing and session cookies are handled in
`src/server/store.ts`. Full auth contract: `docs/auth.md`.

Schema changes are **additive and self-migrating**: new tables use
`CREATE TABLE IF NOT EXISTS`, new columns go in the `ADD_COLUMNS` list in
`store.ts` (guarded by a `PRAGMA table_info` check, because node:sqlite throws
on a duplicate `ADD COLUMN`). A live database must upgrade by restarting the
container, never by hand.

## Device identity + enforcement

`AUTH_MODE=manual` registers the human account, waits for an administrator to
activate it, then exchanges the password once at `/api/auth/device-login`.
`AUTH_MODE=github-app` is browser/user-driven: the server verifies GitHub
access and issues only a narrow Mediation device token. No GitHub token, App
private key, browser cookie, or password belongs in a client/repository map.
All harnesses on that machine share the device token.
Every process creates a distinct short-lived server session and receives a
session capability; mutations for that session, its claims, and its bugs must
present `X-Mediation-Session`.

Enforcement summary (all of it in the one `/api/*` middleware in
`src/server/app.ts`; don't scatter permission checks beyond it):

- Actor for project authorization = cookie user ?? the credential's owner.
  Instance-admin power comes from the **cookie** only, never a credential.
- The project id is validated on the raw path **segment**
  (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) before anything else. `%2F`, `%00`,
  spaces and traversal all 404 there, so the middleware and the handler's
  decoded param can never disagree.
- Deny by default: **any** future route under `/api/projects/:p/` is
  member-gated by construction. Adding a route needs no new check; making one
  *less* restricted is the change that needs thought.
- Human-only surfaces (members and project create/delete) reject
  agents explicitly instead of falling through to a tier that might allow them.
- 403 = exists but you are not a member (with a `hint` for the human); 404 =
  unknown project (with the list of projects the actor can access).
- GitHub App binding is `POST /api/repositories/github/session` with
  `{ owner, repository, agent, machine }`; the server returns its internal
  project/session/capability binding. A local `gh`/push check is doctor-only,
  never authorization.

## Clients (`clients/`)

- `clients/mediation-mcp.mjs` is a single-file, dependency-free MCP stdio server
  (plain JS, Node ≥ 20, no TS, no imports beyond node builtins). Downloaded to
  user machines by the installer; must stay self-contained. All state I/O and
  git calls resolve against one base directory (`directory` argument >
  `MEDIATION_DIR` > git toplevel of cwd > cwd), never bare `process.cwd()`.
  Optional `MEDIATION_*` crew metadata is untrusted and visible to all project
  members. Read it once when the transport session starts. Do not resend static
  environment state on heartbeat. The native `CODEX_THREAD_ID` fallback is
  server-and-repository scoped and hashed before upload.
- `clients/mediation-hook.mjs` is the fail-open lifecycle bridge for Codex and
  Claude Code. It accepts only `SessionStart`, `SessionEnd`, `SubagentStart`,
  and `SubagentStop`. It sends scoped, hashed session/agent ids and maps
  `agent_type` to the reported role.
  It never sends prompts, transcripts, messages, tool data, secrets, model or
  permission data, or `cwd`. It uses `cwd` only to find `.mediation.json`.
  Codex users must review/trust the command in `/hooks`. Kimi stays MCP-only.
- `clients/install.sh` is the installer template; the server serves it with
  `__MEDIATION_URL__` replaced. Its dependency-free Node helper performs
  transactional, manifest-owned changes and supports wizard or headless use.
  Detects claude-code + codex + kimi (Kimi Code
  CLI `~/.kimi-code`, legacy Kimi CLI `~/.kimi`; both take an `mcpServers`
  JSON at `<dir>/mcp.json` and a skill at `<dir>/skills/`), registers the MCP
  server, installs the skill. Idempotent.
- `clients/uninstall.sh` reverses install.sh for every harness; it is served
  verbatim at `/uninstall.sh` (no URL templating needed). Blocks appended to
  harness config files carry `>>> mediation >>>` / `<<< mediation <<<` markers
  so they can be removed surgically. Keep them in sync with install.sh.
  Never deletes per-project `.mediation.json` (they contain only repository
  mappings). Global device auth is removed unless `--keep-auth` is passed.
- `clients/skills/mediation/SKILL.md` teaches agents the workflow
  (init → check → claim → update findings → complete).

## Conventions

- Conflicts are **warnings, not locks**. Never reject an operation because of
  overlap; return warnings alongside the result.
- Overlap rules live only in `src/core/overlap.ts`: path equality or
  directory-prefix match, case-insensitive component match, ≥2 shared
  significant task/intent tokens.
- Sessions expire after `SESSION_TTL_MS` (default 300 000) without heartbeat;
  their claims are released. Idle claims expire after 45 min. Projects are
  never expired or deleted automatically: after `PROJECT_IDLE_HIDE_MS`
  (7 days) with no activity one is merely hidden from `GET /api/projects`,
  and reappears on the next event. Completed claims
  are kept (`status: 'done'`).
- A `Session` is a short-lived authenticated transport. An `AgentExecution` is
  a durable logical harness execution that can survive transport recycling.
  The server derives its developer, provenance, resolved `parentId`,
  `parentUnavailable`, and `stale` values. `ProjectState.agents` returns at most
  200 active and 50 recent terminal executions. `agentCount` reports the full
  retained count. Terminal executions and event deduplication records are
  pruned after seven days on a later lifecycle report. Event deduplication is
  also capped at 5,000 records per project user.
- Errors: JSON `{ error }` with proper status; validation failures are 400 with
  Zod issue details. A denial the human can act on also carries `hint`, which
  agents relay verbatim; GitHub setup failures (App not installed, repository
  not granted, not a collaborator, read-only) each get their own message and
  hint, while a GitHub outage stays a hintless 503.
- Auth is a single module: global device Bearers + human user
  accounts/sessions + project membership (`docs/auth.md`), enforced once in the
  `/api/*` middleware. Invitations and an audit trail from `docs/PRODUCT.md`
  are still later work. Don't scatter permission checks around.
- Project ids identify the actual GitHub **push target**. Clients follow Git's
  push-remote precedence and include owner+repository, so forks do not collide
  with upstream. The slug rule applies only to new ids; pre-Alpha ids remain
  grandfathered.

## Commands

- `pnpm start` runs the server (env: `PORT`=4100, `HOST`, `DB_PATH`=./data/mediation.db, `SESSION_TTL_MS`)
- `pnpm test` runs the tests. `pnpm run typecheck` runs the TS check. Both gate "done".

## Development vs production

- This checkout is the development workspace. Use `podman-compose.dev.yml`
  with `.dev.env`; it runs `AUTH_MODE=manual` and stores data under `data/dev`.
- Production is a separate remote deployment. Its host, address, SSH details,
  `.env`, database, GitHub secrets, and private keys are operational state and
  must never be committed or copied into repository documentation.
- `podman-compose.yml` is the production template. It expects an untracked
  `.env` plus one untracked GitHub App private-key file under `secrets/`.
  Client and webhook secrets are strings in `.env`. Do not start, stop, rebuild, or
  otherwise operate the production stack from the development machine.
