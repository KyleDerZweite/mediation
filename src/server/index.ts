// Server entry point. Configuration via env; see AGENTS.md.

import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { DEFAULT_SESSION_TTL_MS, Store } from './store.ts';

const PORT = Number(process.env.PORT || 4100);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || './data/mediation.db';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS);

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const store = new Store({ dbPath: DB_PATH, sessionTtlMs: SESSION_TTL_MS });
setInterval(() => store.sweep(), Math.min(SESSION_TTL_MS / 2, 30_000)).unref();

serve({ fetch: buildApp(store).fetch, port: PORT, hostname: HOST }, () => {
  console.log(`mediation server listening on http://${HOST}:${PORT}`);
  console.log(`dashboard: http://localhost:${PORT}/`);
  console.log(`agent instructions: http://localhost:${PORT}/AGENT.md`);
});
