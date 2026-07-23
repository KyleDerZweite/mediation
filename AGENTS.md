# AGENTS.md — contributor guide

Mediation: live coordination service that prevents developers and coding agents
from unknowingly duplicating work. Product spec: `docs/PRODUCT.md`.
Agent-facing protocol docs: `docs/PROTOCOL.md` (served at `/AGENT.md` — the
URL agents are told to fetch; don't confuse the two files: AGENTS.md = how to
work on this repo, docs/PROTOCOL.md = the product's wire protocol).

## Stack

- Node ≥ 22.18, TypeScript run natively (type stripping — erasable syntax only:
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
test/         node:test suites.
clients/      Things installed on USER machines: MCP client, installer, skill.
docs/         PRODUCT.md (product goal) + PROTOCOL.md (wire protocol, served at /AGENT.md).
design/       Imported claude.ai design reference (read-only).
```

Dependency direction is one-way: `server`/`cli` → `core`. `core` never imports
up. The web dashboard knows only the HTTP API, never server internals. Anything
violating this direction is wrong regardless of convenience.

## API (v1, MVP — open endpoints, no auth)

| Method | Path | Body schema (`src/core/schemas.ts`) |
| --- | --- | --- |
| GET | `/api/health` | — |
| GET | `/api/projects` | — (ProjectSummary[]) |
| POST | `/api/projects/:p/sessions` | `sessionCreate` |
| POST | `/api/projects/:p/sessions/:id/heartbeat` | `heartbeat` |
| DELETE | `/api/projects/:p/sessions/:id` | — |
| POST | `/api/projects/:p/sessions/:id/repo` | `repoReport` |
| POST | `/api/projects/:p/claims` | `claimCreate` → `{ claim, conflicts }` |
| PATCH | `/api/projects/:p/claims/:id` | `claimPatch` |
| POST | `/api/projects/:p/claims/:id/complete` | `claimComplete` |
| POST | `/api/projects/:p/bugs` | `bugCreate` |
| PATCH | `/api/projects/:p/bugs/:id` | `bugPatch` |
| GET | `/api/projects/:p/state` | — (ProjectState) |
| GET | `/api/projects/:p/check` | query: `sessionId,files,components,task,intent` |
| POST | `/api/auth/request` | `authRequest` → `{ requestId, expiresAt }` (code visible only in dashboard) |
| POST | `/api/auth/redeem` | `authRedeem` → `{ token, agent, developer }` (one-time; 404 wrong/expired code) |
| GET | `/api/auth/me` | Bearer token → identity, 401 if invalid |
| GET | `/api/auth/pending` | — dashboard: pending pairing requests incl. `code` |
| GET | `/api/auth/credentials` | — dashboard: approved credentials (no token value) |
| DELETE | `/api/auth/credentials/:id` | revoke |
| GET | `/install.sh` | installer script, `__MEDIATION_URL__` templated from request proto+host |
| GET | `/install/mediation-mcp.mjs` | dependency-free MCP client (stdio), served from `clients/` |
| GET | `/install/SKILL.md` | agent skill file, served from `clients/skills/mediation/` |

## Pairing (MVP auth)

Device-flow-lite so a credential identifies agent+developer persistently:
agent POSTs `/api/auth/request` → dashboard (#/agents) shows the pending
request with a 6-char one-time code (15 min TTL) → the human relays the code
to the agent → agent POSTs `/api/auth/redeem` → durable bearer token.
MVP keeps other endpoints open; if an `Authorization: Bearer` header IS sent,
it must be valid (401 otherwise). Enforcement becomes strict in the production
identity phase — don't scatter permission checks beyond this.

## Clients (`clients/`)

- `clients/mediation-mcp.mjs` — single-file, dependency-free MCP stdio server
  (plain JS, Node ≥ 20, no TS, no imports beyond node builtins). Downloaded to
  user machines by the installer; must stay self-contained.
- `clients/install.sh` — installer template; server serves it with
  `__MEDIATION_URL__` replaced. Detects claude-code + codex, registers the MCP
  server, installs the skill. Idempotent.
- `clients/skills/mediation/SKILL.md` — teaches agents the workflow
  (init → check → claim → update findings → complete).

## Conventions

- Conflicts are **warnings, not locks**. Never reject an operation because of
  overlap; return warnings alongside the result.
- Overlap rules live only in `src/core/overlap.ts`: path equality or
  directory-prefix match, case-insensitive component match, ≥2 shared
  significant task/intent tokens.
- Sessions expire after `SESSION_TTL_MS` (default 120 000) without heartbeat;
  their claims are released. Idle claims expire after 30 min. Completed claims
  are kept (`status: 'done'`).
- Errors: JSON `{ error }` with proper status; validation failures are 400 with
  Zod issue details.
- No auth/accounts in the MVP — the production identity model (`docs/PRODUCT.md`)
  is a later, separate module; don't scatter permission stubs around.

## Commands

- `pnpm start` — run server (env: `PORT`=4100, `HOST`, `DB_PATH`=./data/mediation.db, `SESSION_TTL_MS`)
- `pnpm test` — tests. `pnpm run typecheck` — TS check. Both gate "done".
