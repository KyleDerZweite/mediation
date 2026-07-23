# Mediation

Live coordination for developers and coding agents — see overlapping work
**before Git makes it visible**.

Git shows committed work. Mediation shows local work that is still being
investigated, edited, tested, or prepared for commit, so two agents never
unknowingly solve the same problem twice.

> Before another developer or agent starts overlapping work, they can see that
> it is already being handled.

## Quick start

Requires Node.js ≥ 20. Zero dependencies.

```bash
npm start                 # http://localhost:4100
# dashboard:  http://localhost:4100/?project=demo
# agent docs: http://localhost:4100/AGENT.md
```

Config via env: `PORT`, `HOST`, `DATA_DIR` (default `./data`),
`SESSION_TTL_MS` (default `120000`).

## How it works

1. Each agent session **connects** to a shared project id and heartbeats to
   stay alive.
2. Before starting work, an agent **checks** for overlapping claims
   (files, components, or similar task descriptions). Conflicts are warnings,
   not locks — the agent can stop, coordinate, narrow scope, or continue.
3. Each session publishes a **work claim**: intent, task reference, affected
   files/components, branch, base revision, status, and findings as they are
   discovered.
4. Sessions **report repo state** (branch, revision, dirty files) so the
   dashboard shows what is actually being touched.
5. Agents **file bugs** they discover, even ones they don't fix.
6. Finished work is **completed with commits/PRs** attached.
7. Sessions and claims **expire** automatically when heartbeats stop.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/projects/:p/sessions` | start a session |
| POST | `/api/projects/:p/sessions/:id/heartbeat` | keep alive / report activity |
| DELETE | `/api/projects/:p/sessions/:id` | end session, release claims |
| POST | `/api/projects/:p/sessions/:id/repo` | report branch/revision/dirty files |
| POST | `/api/projects/:p/claims` | create work claim (returns overlap warnings) |
| PATCH | `/api/projects/:p/claims/:id` | update status/files/findings |
| POST | `/api/projects/:p/claims/:id/complete` | finish with commits/PRs |
| POST | `/api/projects/:p/bugs` | report a discovered bug |
| PATCH | `/api/projects/:p/bugs/:id` | update bug status |
| GET | `/api/projects/:p/state` | full live project state (dashboard uses this) |
| GET | `/api/projects/:p/check` | pre-flight overlap check |

Full agent-facing instructions: [`AGENT.md`](AGENT.md).

## CLI

```bash
node bin/mediation-agent.js connect --project demo --agent my-agent
node bin/mediation-agent.js check --project demo --files src/x.js --intent "fix login loop"
node bin/mediation-agent.js claim --project demo --session <id> --intent "..." --files src/x.js
```

`mediation-agent check` exits with code `3` when overlap is detected, so
agents can gate on it in scripts.

## Tests

```bash
npm test
```

## Scope

This is the development MVP: open endpoints, shared project id, no auth.
The production identity model (human accounts, project membership, scoped
agent credentials, invitations, audit trail) is specified in the product
document and is intentionally out of scope here.
