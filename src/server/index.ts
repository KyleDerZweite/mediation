// Server entry point. Configuration via env; see AGENTS.md.

import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import type { AuthMode } from './app.ts';
import { GitHubApp, githubAppConfigFromEnv } from './github.ts';
import { DEFAULT_SESSION_TTL_MS, Store } from './store.ts';

const PORT = Number(process.env.PORT || 4100);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || './data/mediation.db';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS);
const AUTH_MODE = (process.env.AUTH_MODE || 'manual') as AuthMode;
if (AUTH_MODE !== 'manual' && AUTH_MODE !== 'github-app') throw new Error('AUTH_MODE must be manual or github-app');
const githubConfig = AUTH_MODE === 'github-app' ? githubAppConfigFromEnv() : null;
const github = githubConfig ? new GitHubApp(githubConfig) : undefined;

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const store = new Store({ dbPath: DB_PATH, sessionTtlMs: SESSION_TTL_MS });
setInterval(() => store.sweep(), Math.min(SESSION_TTL_MS / 2, 30_000)).unref();

const server = serve({ fetch: buildApp(store, {
  authMode: AUTH_MODE,
  publicUrl: githubConfig?.publicUrl ?? process.env.PUBLIC_URL,
  github,
  githubBootstrapAdmin: process.env.GITHUB_BOOTSTRAP_ADMIN ?? null,
}).fetch, port: PORT, hostname: HOST }, () => {
  console.log(`mediation server listening on http://${HOST}:${PORT}`);
  console.log(`dashboard: http://localhost:${PORT}/`);
  console.log(`agent instructions: http://localhost:${PORT}/AGENT.md`);
  console.log(`authentication mode: ${AUTH_MODE}`);
}) as ReturnType<typeof serve> & {
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
};

let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) {
    server.closeAllConnections?.();
    return;
  }
  stopping = true;
  console.log(`${signal} received; shutting down`);
  const force = setTimeout(() => {
    console.error('graceful shutdown timed out; closing remaining connections');
    server.closeAllConnections?.();
    store.close();
    process.exit(1);
  }, 7_000);
  force.unref();
  server.close((error) => {
    clearTimeout(force);
    store.close();
    process.exit(error ? 1 : 0);
  });
  server.closeIdleConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
