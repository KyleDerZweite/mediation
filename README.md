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
npm install
npm start                 # http://localhost:4100
# dashboard:  http://localhost:4100/?project=demo
# agent docs: http://localhost:4100/AGENT.md
```

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
| GET | `/api/health` | liveness check |
| GET | `/api/projects` | list projects with live counts |
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
[`AGENT.md`](AGENT.md) (also served at `/AGENT.md`).

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
npm test            # node:test suites
npm run typecheck   # tsc --noEmit
```

## Scope

This is the development MVP: open endpoints, shared project id, no auth.
The production identity model (human accounts, project membership, scoped
agent credentials, invitations, audit trail) is specified in
[`docs/PRODUCT.md`](docs/PRODUCT.md) and is intentionally out of scope here.
