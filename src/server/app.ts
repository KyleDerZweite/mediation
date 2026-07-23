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
  '.mjs': 'text/javascript; charset=utf-8',
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

  // If a Bearer token is sent it must be valid; absent stays allowed (MVP open
  // API). This is the single enforcement point — production tightens it here.
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
      const cred = store.getCredentialByToken(auth.slice(7));
      if (!cred) return c.json({ error: 'invalid or revoked credential' }, 401);
      c.set('credential' as never, cred as never);
    }
    await next();
  });

  // ---- api ----

  app.get('/api/health', (c) => c.json({ ok: true, now: Date.now() }));

  // ---- pairing (device-flow-lite; see AGENTS.md "Pairing") ----

  app.post('/api/auth/request', async (c) =>
    c.json(store.createPairRequest(await parseBody(c, schemas.authRequest))));

  app.post('/api/auth/redeem', async (c) =>
    c.json(store.redeemPairCode((await parseBody(c, schemas.authRedeem)).code)));

  app.get('/api/auth/me', (c) => {
    const auth = c.req.header('authorization');
    const cred = auth?.startsWith('Bearer ') ? store.getCredentialByToken(auth.slice(7)) : null;
    return cred ? c.json(cred) : c.json({ error: 'missing or invalid credential' }, 401);
  });

  app.get('/api/auth/pending', (c) => c.json(store.listPendingPairRequests()));

  app.get('/api/auth/credentials', (c) => c.json(store.listCredentials()));

  app.delete('/api/auth/credentials/:id', (c) =>
    c.json(store.revokeCredential(c.req.param('id'))));

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

  // ---- installer + agent-machine clients (see AGENTS.md "Clients") ----

  // Origin baked into the script so `curl <server>/install.sh | bash` needs no
  // other configuration. Proxy headers win over the raw Host.
  app.get('/install.sh', (c) => {
    let script: string;
    try {
      script = fs.readFileSync(path.join(ROOT, 'clients', 'install.sh'), 'utf8');
    } catch {
      return c.text('installer not available on this server build', 503);
    }
    const proto = c.req.header('x-forwarded-proto') ?? 'http';
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'localhost:4100';
    return c.text(script.replaceAll('__MEDIATION_URL__', `${proto}://${host}`), 200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
    });
  });

  app.get('/install/mediation-mcp.mjs', (c) =>
    serveFile(c, path.join(ROOT, 'clients', 'mediation-mcp.mjs')));

  app.get('/install/SKILL.md', (c) =>
    serveFile(c, path.join(ROOT, 'clients', 'skills', 'mediation', 'SKILL.md')));

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
