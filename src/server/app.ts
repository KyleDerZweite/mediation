// HTTP layer: Hono app over the Store. Bodies are validated with the zod
// schemas from src/core/schemas.ts; domain errors carry err.statusCode.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import * as schemas from '../core/schemas.ts';
import type { Store } from './store.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_DIR = path.join(ROOT, 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveFile(c: Context, filePath: string): Response {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  return c.body(new Uint8Array(buf), 200, { 'content-type': type });
}

async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.json().catch(() => ({}));
  const result = schema.safeParse(raw);
  if (!result.success) {
    const err = new Error('validation failed') as Error & { statusCode: number; issues: unknown };
    err.statusCode = 400;
    err.issues = result.error.issues;
    throw err;
  }
  return result.data;
}

export function buildApp(store: Store): Hono {
  const app = new Hono();

  app.use('*', cors()); // MVP: open to all origins

  app.onError((err, c) => {
    const e = err as Error & { statusCode?: number; issues?: unknown };
    const status = (e.statusCode ?? 500) as ContentfulStatusCode;
    const body: Record<string, unknown> = { error: e.message };
    if (e.issues) body.issues = e.issues;
    return c.json(body, status);
  });

  // ---- api ----

  app.get('/api/health', (c) => c.json({ ok: true, now: Date.now() }));

  app.get('/api/projects', (c) => c.json(store.listProjects()));

  app.post('/api/projects/:p/sessions', async (c) =>
    c.json(store.startSession(c.req.param('p'), await parseBody(c, schemas.sessionCreate))));

  app.post('/api/projects/:p/sessions/:id/heartbeat', async (c) =>
    c.json(store.heartbeat(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.heartbeat))));

  app.delete('/api/projects/:p/sessions/:id', (c) =>
    c.json(store.endSession(c.req.param('p'), c.req.param('id'))));

  app.post('/api/projects/:p/sessions/:id/repo', async (c) =>
    c.json(store.reportRepoState(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.repoReport))));

  app.post('/api/projects/:p/claims', async (c) =>
    c.json(store.createClaim(c.req.param('p'), await parseBody(c, schemas.claimCreate))));

  app.patch('/api/projects/:p/claims/:id', async (c) =>
    c.json(store.updateClaim(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.claimPatch))));

  app.post('/api/projects/:p/claims/:id/complete', async (c) =>
    c.json(store.completeClaim(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.claimComplete))));

  app.post('/api/projects/:p/bugs', async (c) =>
    c.json(store.reportBug(c.req.param('p'), await parseBody(c, schemas.bugCreate))));

  app.patch('/api/projects/:p/bugs/:id', async (c) =>
    c.json(store.updateBug(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.bugPatch))));

  app.get('/api/projects/:p/state', (c) => c.json(store.getState(c.req.param('p'))));

  app.get('/api/projects/:p/check', (c) => {
    const q = c.req.query();
    return c.json({
      conflicts: store.check(c.req.param('p'), {
        sessionId: q.sessionId ?? null,
        files: (q.files ?? '').split(',').filter(Boolean),
        components: (q.components ?? '').split(',').filter(Boolean),
        task: q.task ?? null,
        intent: q.intent ?? null,
      }),
    });
  });

  // ---- static ----

  app.get('/', (c) => serveFile(c, path.join(WEB_DIR, 'index.html')));

  // The protocol doc lives at docs/PROTOCOL.md but stays served at /AGENT.md —
  // that URL is the discovery convention agents are told to fetch.
  app.get('/AGENT.md', (c) => serveFile(c, path.join(ROOT, 'docs', 'PROTOCOL.md')));

  app.get('/web/*', (c) => {
    const rel = decodeURIComponent(c.req.path.slice('/web/'.length));
    const abs = path.resolve(WEB_DIR, rel);
    // never escape web/ regardless of what the URL contains
    if (abs !== WEB_DIR && !abs.startsWith(WEB_DIR + path.sep)) {
      return c.json({ error: 'not found' }, 404);
    }
    return serveFile(c, abs);
  });

  return app;
}
