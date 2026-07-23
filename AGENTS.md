# AGENTS.md

## What this is

Mediation: a live coordination service that prevents developers and coding
agents from unknowingly duplicating work. It exposes pre-Git state: active
sessions, work claims, affected files, findings, bugs, and overlap warnings.

## Stack & layout

- Node.js ≥ 20, ESM (`"type": "module"`), **zero runtime dependencies** — keep
  it that way. Use `node:http`, `node:fs`, etc.
- `server.js` — HTTP API + static file serving. Entry point (`npm start`).
- `lib/store.js` — all state and business logic: sessions, claims, bugs,
  expiry sweeps, conflict detection, JSON persistence. No HTTP here.
- `bin/mediation-agent.js` — CLI client used by coding agents (global `fetch`).
- `public/index.html` — single-file dashboard (vanilla JS, polls
  `/api/projects/:p/state` every 3s). Dark "watchtower" theme matching
  `public/logo.png` (deep navy, teal/cyan, Fraunces + IBM Plex Mono).
- `AGENT.md` — agent-readable protocol docs, also served at `/AGENT.md`.
- `test/store.test.js` — `node:test` unit tests (`npm test`).

## Conventions

- Conflicts are **warnings, not locks**. Never block an operation because of
  overlap; return warnings alongside the result.
- Sessions expire after `SESSION_TTL_MS` without heartbeat; claims die with
  their session. Completed claims move to a capped `completed` feed.
- API errors: throw `Error` with a `statusCode` property; the server maps it.
- Overlap rules live in `checkOverlap`: file path equality or directory-prefix
  match, case-insensitive component equality, and shared significant task
  tokens (≥2).
- Persistence is best-effort JSON snapshots in `DATA_DIR`; stale sessions are
  not resurrected on restart.
- No auth in the MVP — do not add account/permission code here; the production
  identity model is a separate phase described in the product spec.

## Commands

- `npm start` — run the server (PORT/HOST/DATA_DIR/SESSION_TTL_MS env vars).
- `npm test` — run tests. Must pass before changes are considered done.
