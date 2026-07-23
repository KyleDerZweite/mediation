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
