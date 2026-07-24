// HTTP layer: Hono app over the Store. Bodies are validated with the zod
// schemas from src/core/schemas.ts; domain errors carry err.statusCode.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
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

const USER_COOKIE = 'mediation_user';
// Not Secure: TLS is terminated by the Pangolin tunnel; local dev is plain http.
const COOKIE_OPTS = { httpOnly: true, sameSite: 'Lax', path: '/' } as const;
const AUTH_MD = '/auth.md';

// Every 401 from the enforcement middleware advertises the discovery doc.
function unauthorized(c: Context, message = 'authentication required'): Response {
  return c.json({ error: message, auth: AUTH_MD }, 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${AUTH_MD}"`,
  });
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

  // Single enforcement point. Identity is resolved once per request from two
  // independent sources — an agent Bearer credential (pairing) and/or a human
  // user session cookie — then the route's required level is checked. See the
  // authorization matrix in docs/auth.md. A *presented* Bearer must be valid.
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('authorization');
    let cred = null;
    if (auth?.startsWith('Bearer ')) {
      cred = store.getCredentialByToken(auth.slice(7));
      if (!cred) return unauthorized(c, 'invalid or revoked credential');
      c.set('credential' as never, cred as never);
    }
    const cookie = getCookie(c, USER_COOKIE);
    const user = cookie ? store.getUserBySession(cookie) : null; // active users only
    if (user) c.set('user' as never, user as never);

    const p = c.req.path;
    const m = c.req.method === 'HEAD' ? 'GET' : c.req.method; // HEAD inherits GET's tier

    // PUBLIC — no identity required (handlers self-enforce where needed).
    if (
      (m === 'GET' && p === '/api/health') ||
      (m === 'POST' && (p === '/api/users/register' || p === '/api/users/login' || p === '/api/users/logout')) ||
      (m === 'POST' && (p === '/api/auth/request' || p === '/api/auth/redeem')) ||
      (m === 'GET' && p === '/api/auth/me')
    ) return next();

    // ADMIN — active session with role=admin.
    if ((m === 'GET' && p === '/api/users') || ((m === 'PATCH' || m === 'DELETE') && p.startsWith('/api/users/'))) {
      if (!user) return unauthorized(c);
      if (user.role !== 'admin') return c.json({ error: 'admin required' }, 403);
      return next();
    }

    // USER — any active session.
    if (
      (m === 'GET' && p === '/api/users/me') ||
      (m === 'GET' && (p === '/api/auth/pending' || p === '/api/auth/credentials')) ||
      (m === 'DELETE' && p.startsWith('/api/auth/credentials/'))
    ) {
      if (!user) return unauthorized(c);
      return next();
    }

    // AGENT-OR-USER — everything else under /api (all project routes).
    if (cred || user) return next();
    return unauthorized(c);
  });

  // ---- api ----

  app.get('/api/health', (c) => c.json({ ok: true, now: Date.now() }));

  // ---- users (see docs/auth.md) ----

  app.post('/api/users/register', async (c) =>
    c.json(await store.registerUser(await parseBody(c, schemas.userRegister))));

  app.post('/api/users/login', async (c) => {
    const { username, password } = await parseBody(c, schemas.userLogin);
    const r = await store.loginUser(username, password);
    if (!r.ok) return c.json(r.status ? { error: r.error, status: r.status } : { error: r.error }, r.code);
    setCookie(c, USER_COOKIE, r.token, COOKIE_OPTS); // pending/disabled never reach here → no cookie
    return c.json({ user: r.user });
  });

  app.post('/api/users/logout', (c) => {
    const token = getCookie(c, USER_COOKIE);
    if (token) store.logoutSession(token);
    deleteCookie(c, USER_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Middleware guarantees an active user is set for these.
  app.get('/api/users/me', (c) => c.json({ user: c.get('user' as never) }));
  app.get('/api/users', (c) => c.json(store.listUsers()));
  app.patch('/api/users/:id', async (c) =>
    c.json(store.patchUser(c.req.param('id'), await parseBody(c, schemas.userPatch))));
  app.delete('/api/users/:id', (c) => c.json(store.deleteUser(c.req.param('id'))));

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

  // Auth discovery manifest — the URL the 401 WWW-Authenticate hint points at.
  app.get('/auth.md', (c) => serveFile(c, path.join(ROOT, 'docs', 'auth.md')));

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
