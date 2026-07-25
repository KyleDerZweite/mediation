// HTTP layer: Hono app over the Store. Bodies are validated with the zod
// schemas from src/core/schemas.ts; domain errors carry err.statusCode.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import * as schemas from '../core/schemas.ts';
import pkg from '../../package.json' with { type: 'json' };
import type { CredentialInfo, PublicUser, Store } from './store.ts';
import { GitHubApp, GitHubAppError } from './github.ts';

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
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
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
const AUTH_MD = '/auth.md';

// Every 401 from the enforcement middleware advertises the discovery doc.
function unauthorized(c: Context, message = 'authentication required'): Response {
  return c.json({ error: message, auth: AUTH_MD }, 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${AUTH_MD}"`,
  });
}

// Project ids as they may appear in a path SEGMENT. Deliberately checked on the
// raw (still-encoded) segment: anything containing %2F, %00, spaces or path
// traversal fails this test, so the middleware can never disagree with the
// decoded value the handler sees. Wider than the creation slug rule because
// pre-Alpha ids are grandfathered.
const PROJECT_SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const NOT_A_MEMBER_HINT = 'Ask a project owner (or instance admin) to add your user in the dashboard Members tab. '
  + 'Retrying will not help until they act.';

// Convenience accessors for the identity the middleware resolved.
const getUser = (c: Context): PublicUser | null => (c.get('user' as never) as PublicUser) ?? null;
const getCred = (c: Context): CredentialInfo | null => (c.get('credential' as never) as CredentialInfo) ?? null;
const actorId = (c: Context): string | null => getUser(c)?.id ?? getCred(c)?.userId ?? null;

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

export type AuthMode = 'manual' | 'github-app';
export interface AppOptions {
  authMode?: AuthMode;
  publicUrl?: string;
  github?: GitHubApp;
  githubBootstrapAdmin?: string | null;
}

export function buildApp(store: Store, options: AppOptions = {}): Hono {
  const app = new Hono();
  const authMode = options.authMode ?? 'manual';
  if (authMode === 'github-app' && !options.github) {
    throw new Error('GitHub App service is required in github-app mode');
  }
  const publicUrl = options.publicUrl?.replace(/\/+$/, '') ?? null;
  const cookieOpts = {
    httpOnly: true, sameSite: 'Lax', path: '/', secure: !!publicUrl?.startsWith('https://'),
  } as const;
  const oauthContexts = new Map<string, { requestId: string | null; userCode: string | null; expiresAt: number }>();

  app.onError((err, c) => {
    const e = err as Error & { statusCode?: number; issues?: unknown };
    const status = (e.statusCode ?? (e instanceof GitHubAppError ? 502 : 500)) as ContentfulStatusCode;
    const body: Record<string, unknown> = { error: e.message };
    if (e.issues) body.issues = e.issues;
    return c.json(body, status);
  });

  // Single enforcement point. Identity is resolved once per request from two
  // independent sources — a global device Bearer and/or a human
  // user session cookie — then the route's required level is checked. See the
  // authorization matrix in docs/auth.md. A *presented* Bearer must be valid.
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('authorization');
    let cred = null;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      cred = store.getCredentialByToken(token); // only resolves with an ACTIVE owning user
      if (!cred) {
        return unauthorized(c, store.credentialTokenExists(token)
          ? 'credential owner is unavailable; sign in again after reactivation'
          : 'invalid or revoked credential');
      }
      if (authMode === 'github-app' && cred.authorizationSource !== 'github-app') {
        return unauthorized(c, 'this device credential predates GitHub authorization; sign in again');
      }
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
      (m === 'POST' && (p === '/api/users/register' || p === '/api/users/login' || p === '/api/users/logout'
        || p === '/api/auth/device-login' || p === '/api/auth/device/start' || p === '/api/auth/device/redeem'
        || p === '/api/github/webhook')) ||
      (m === 'GET' && (p === '/api/github/login' || p === '/api/github/callback')) ||
      (m === 'GET' && p === '/api/auth/me')
    ) return next();

    // ADMIN — active session with role=admin.
    if ((m === 'GET' && p === '/api/users') || ((m === 'PATCH' || m === 'DELETE') && p.startsWith('/api/users/'))) {
      if (!user) return unauthorized(c);
      if (user.role !== 'admin') return c.json({ error: 'admin required' }, 403);
      return next();
    }

    // USER — any active session, human only.
    if (
      (m === 'GET' && p === '/api/users/me') ||
      (m === 'GET' && p === '/api/auth/credentials') ||
      (m === 'DELETE' && p.startsWith('/api/auth/credentials/'))
    ) {
      if (!user) return unauthorized(c);
      return next();
    }

    // Creating a project is a human act; a valid agent gets a 403 that says so.
    if (m === 'POST' && p === '/api/projects') {
      if (user) return next();
      return cred
        ? c.json({ error: 'project administration is human-only', docs: AUTH_MD }, 403)
        : unauthorized(c);
    }

    // PROJECT-MEMBER — everything under /api/projects/:p/. Deny by default:
    // any future route below this prefix is member-gated by construction.
    if (p.startsWith('/api/projects/')) {
      const seg = p.split('/'); // ['', 'api', 'projects', '<pid>', ...]
      const pid = seg[3] ?? '';
      if (!PROJECT_SEG_RE.test(pid)) return c.json({ error: 'project not found', project: pid }, 404);
      if (!cred && !user) return unauthorized(c);

      // Project administration (members, deletion) is never available to agents.
      const isAdminSurface = seg[4] === 'members' || (m === 'DELETE' && seg.length === 4);
      if (isAdminSurface && !user) {
        return c.json({ error: 'project administration is human-only', docs: AUTH_MD }, 403);
      }
      const actor = user?.id ?? cred!.userId;
      const githubProject = authMode === 'github-app' ? store.getGithubProjectById(pid) : null;
      const instanceAdmin = user?.role === 'admin' && !githubProject;

      if (!store.projectExists(pid)) {
        // The one creation path agents have: first session on an unknown id.
        if (authMode === 'manual' && m === 'POST' && seg.length === 5 && seg[4] === 'sessions') {
          store.ensureProject(pid, actor);
          return next();
        }
        const mine = store.memberProjectIds(actor).join(', ') || 'none yet';
        return c.json({
          error: 'project not found',
          project: pid,
          hint: `Check the spelling, or start a session to create it. Projects you can access: ${mine}`,
          docs: AUTH_MD,
        }, 404);
      }
      if (authMode === 'github-app' && !githubProject) {
        return c.json({ error: 'legacy/manual projects are unavailable in GitHub App mode' }, 404);
      }

      // A GitHub session whose five-minute grant just expired may reach only
      // its heartbeat so the server can re-check GitHub. The capability and
      // owning Mediation user are checked again in the handler.
      if (authMode === 'github-app' && m === 'POST' && seg.length === 7
        && seg[4] === 'sessions' && seg[6] === 'heartbeat') {
        store.assertSessionCapability(pid, seg[5]!, c.req.header('x-mediation-session'), true);
        return next();
      }
      if (authMode === 'github-app' && m === 'DELETE' && seg.length === 6 && seg[4] === 'sessions') {
        store.assertSessionCapability(pid, seg[5]!, c.req.header('x-mediation-session'), true);
        return next();
      }

      const role = githubProject ? store.githubMemberRole(pid, actor) : store.memberRole(pid, actor);
      if (!role && !instanceAdmin) {
        return c.json({
          error: `not a member of project "${pid}"`, project: pid, hint: NOT_A_MEMBER_HINT, docs: AUTH_MD,
        }, 403);
      }
      // Members may read the member list; changing it is owner-only, except
      // that anyone may remove themselves (leave).
      if (seg[4] === 'members' && m !== 'GET') {
        const selfLeave = m === 'DELETE' && seg[5] === actor;
        if (!selfLeave && role !== 'owner' && !instanceAdmin) {
          return c.json({ error: 'project owner required', project: pid, docs: AUTH_MD }, 403);
        }
      }
      if (m === 'DELETE' && seg.length === 4 && role !== 'owner' && !instanceAdmin) {
        return c.json({ error: 'project owner required', project: pid, docs: AUTH_MD }, 403);
      }
      return next();
    }

    // AGENT-OR-USER — the rest under /api (GET /api/projects; handler filters).
    if (cred || user) return next();
    return unauthorized(c);
  });

  // ---- api ----

  app.get('/api/health', (c) => c.json({ ok: true, now: Date.now(), version: pkg.version, authMode }));

  // ---- GitHub App identity + machine activation ----

  app.post('/api/auth/device/start', async (c) => {
    if (authMode !== 'github-app') return c.json({ error: 'GitHub device activation is disabled in manual mode' }, 404);
    const { machine } = await parseBody(c, schemas.deviceStart);
    const activation = store.startGithubDeviceActivation(machine ?? null);
    const base = publicUrl ?? new URL(c.req.url).origin;
    const verificationUri = new URL('/api/github/login', base);
    verificationUri.searchParams.set('device', activation.requestId);
    verificationUri.searchParams.set('code', activation.userCode);
    return c.json({ ...activation, verificationUri: verificationUri.toString() });
  });

  app.post('/api/auth/device/redeem', async (c) => {
    if (authMode !== 'github-app') return c.json({ error: 'GitHub device activation is disabled in manual mode' }, 404);
    const { requestId, secret } = await parseBody(c, schemas.deviceRedeem);
    const status = store.githubDeviceActivationStatus(requestId, secret);
    if (status === 'invalid') return c.json({ error: 'device activation not found or expired' }, 404);
    if (status !== 'ready') return c.json({ status }, 202);
    const redeemed = store.redeemGithubDeviceActivation(requestId, secret);
    const user = store.getUserByGithubId(
      store.getGithubIdentity(redeemed.userId)!.githubUserId,
    )!;
    return c.json({ token: redeemed.token, user });
  });

  app.get('/api/github/login', (c) => {
    if (authMode !== 'github-app') return c.json({ error: 'GitHub sign-in is disabled in manual mode' }, 404);
    for (const [state, context] of oauthContexts) {
      if (context.expiresAt <= Date.now()) oauthContexts.delete(state);
    }
    const device = c.req.query('device') ?? null;
    const userCode = c.req.query('code') ?? null;
    if (device && userCode && c.req.query('confirm') !== '1') {
      const confirm = new URL('/api/github/login', publicUrl ?? new URL(c.req.url).origin);
      confirm.searchParams.set('device', device);
      confirm.searchParams.set('code', userCode);
      confirm.searchParams.set('confirm', '1');
      const shown = /^[A-Z0-9]{10}$/.test(userCode) ? userCode : 'INVALID';
      return c.html(`<!doctype html><meta charset="utf-8"><title>Authorize Mediation</title>
        <main style="font:16px system-ui;max-width:36rem;margin:10vh auto;padding:2rem">
        <h1>Authorize this Mediation device?</h1>
        <p>Confirm that your coding agent showed this code:</p>
        <p style="font:700 2rem monospace;letter-spacing:.15em">${shown}</p>
        <p>Mediation asks GitHub only for repository metadata so it can verify write access. It cannot read repository contents.</p>
        <a href="${confirm.pathname}${confirm.search}" style="display:inline-block;padding:.8rem 1rem;background:#111;color:white;border-radius:.5rem;text-decoration:none">Continue with GitHub</a>
        </main>`);
    }
    const started = options.github!.startOAuth();
    oauthContexts.set(started.state, {
      requestId: device,
      userCode,
      expiresAt: started.expiresAt,
    });
    return c.redirect(started.authorizeUrl);
  });

  app.get('/api/github/callback', async (c) => {
    if (authMode !== 'github-app') return c.json({ error: 'GitHub sign-in is disabled in manual mode' }, 404);
    const state = c.req.query('state') ?? '';
    const context = oauthContexts.get(state);
    oauthContexts.delete(state);
    if (!context || context.expiresAt <= Date.now()) {
      return c.redirect('/?auth=error&message=GitHub%20sign-in%20expired');
    }
    try {
      const githubIdentity = await options.github!.completeOAuth(c.req.query('code') ?? '', state);
      const user = store.findOrCreateGithubUser({
        githubUserId: githubIdentity.id, login: githubIdentity.login, authorizationStatus: 'authorized',
      }, options.githubBootstrapAdmin);
      if (context.requestId && context.userCode) {
        store.bindGithubDeviceActivation(context.requestId, context.userCode, githubIdentity.id);
      }
      if (user.status === 'active') {
        const loggedIn = store.createGithubUserSession(user.id);
        setCookie(c, USER_COOKIE, loggedIn.token, cookieOpts);
        return c.redirect('/?auth=ok');
      }
      return c.redirect('/?auth=pending');
    } catch {
      return c.redirect('/?auth=error&message=GitHub%20sign-in%20failed');
    }
  });

  app.post('/api/github/webhook', async (c) => {
    if (authMode !== 'github-app') return c.json({ error: 'GitHub webhooks are disabled in manual mode' }, 404);
    const raw = Buffer.from(await c.req.arrayBuffer());
    const event = options.github!.verifyWebhook(raw, c.req.header('x-hub-signature-256'), c.req.header('x-github-event'));
    if (event.event === 'github_app_authorization' && event.action === 'revoked' && event.githubUserId) {
      const user = store.getUserByGithubId(event.githubUserId);
      if (user) store.revokeGithubIdentity(user.id);
    }
    if (event.installationId && event.event === 'installation'
      && (event.action === 'deleted' || event.action === 'suspend')) {
      store.invalidateGithubInstallation(event.installationId);
    }
    for (const repositoryId of event.repositoryIds) {
      if (event.event === 'installation_repositories'
        || (event.event === 'repository' && ['deleted', 'transferred'].includes(event.action ?? ''))) {
        store.invalidateGithubRepository(repositoryId);
      }
    }
    return c.json({ ok: true });
  });

  // ---- users (see docs/auth.md) ----

  app.post('/api/users/register', async (c) => authMode === 'manual'
    ? c.json(await store.registerUser(await parseBody(c, schemas.userRegister)))
    : c.json({ error: 'password registration is disabled; sign in with GitHub' }, 404));

  app.post('/api/users/login', async (c) => {
    if (authMode !== 'manual') return c.json({ error: 'password login is disabled; sign in with GitHub' }, 404);
    const { username, password } = await parseBody(c, schemas.userLogin);
    const r = await store.loginUser(username, password);
    if (!r.ok) return c.json(r.status ? { error: r.error, status: r.status } : { error: r.error }, r.code);
    setCookie(c, USER_COOKIE, r.token, cookieOpts); // pending/disabled never reach here → no cookie
    return c.json({ user: r.user });
  });

  app.post('/api/users/logout', (c) => {
    const token = getCookie(c, USER_COOKIE);
    if (token) store.logoutSession(token);
    deleteCookie(c, USER_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/api/auth/device-login', async (c) => {
    if (authMode !== 'manual') return c.json({ error: 'password device login is disabled; sign in with GitHub' }, 404);
    const { username, password, machine } = await parseBody(c, schemas.deviceLogin);
    const r = await store.loginDevice(username, password, machine ?? null);
    return r.ok ? c.json({ token: r.token, user: r.user })
      : c.json(r.status ? { error: r.error, status: r.status } : { error: r.error }, r.code);
  });

  // Middleware guarantees an active user is set for these.
  app.get('/api/users/me', (c) => c.json({ user: c.get('user' as never) }));
  app.get('/api/users', (c) => c.json(store.listUsers()));
  app.patch('/api/users/:id', async (c) =>
    c.json(store.patchUser(c.req.param('id'), await parseBody(c, schemas.userPatch))));
  app.delete('/api/users/:id', (c) => c.json(store.deleteUser(c.req.param('id'))));

  app.get('/api/auth/me', (c) => {
    const auth = c.req.header('authorization');
    const cred = auth?.startsWith('Bearer ') ? store.getCredentialByToken(auth.slice(7)) : null;
    return cred ? c.json(cred) : c.json({ error: 'missing or invalid credential' }, 401);
  });

  app.get('/api/auth/credentials', (c) => {
    const user = getUser(c)!;
    return c.json(store.listCredentials(user.role === 'admin' ? null : user.id));
  });

  app.delete('/api/auth/credentials/:id', (c) => {
    const user = getUser(c)!;
    return c.json(store.revokeCredential(c.req.param('id'), user.id, user.role === 'admin'));
  });

  // ---- projects + membership ----

  app.post('/api/repositories/github/session', async (c) => {
    if (authMode !== 'github-app') return c.json({ error: 'GitHub repository sessions are disabled in manual mode' }, 404);
    const userId = actorId(c);
    if (!userId) return unauthorized(c);
    const identity = store.getGithubIdentity(userId);
    if (!identity || identity.authorizationStatus !== 'authorized') {
      return c.json({ error: 'active GitHub identity authorization required' }, 403);
    }
    const body = await parseBody(c, schemas.githubRepositorySession);
    const authorization = await options.github!.authorizeRepository(body.owner, body.repository, {
      id: identity.githubUserId, login: identity.login,
    });
    const project = store.resolveGithubProject({
      externalRepositoryId: authorization.repository.id,
      fullName: authorization.repository.fullName,
      installationId: authorization.repository.installationId,
      visibility: authorization.repository.visibility,
      authorizationSource: 'github-app',
      createdBy: userId,
    });
    store.grantGithubProjectAccess(project.id, userId, authorization.permission, authorization.expiresAt);
    const capability = randomBytes(32).toString('base64url');
    const session = store.startSession(project.id, {
      agent: body.agent, machine: body.machine ?? null, developer: getUser(c)?.username ?? getCred(c)?.ownerUsername ?? null,
    }, capability);
    store.setGithubSessionAuthorization(project.id, session.id, {
      userId,
      githubUserId: identity.githubUserId,
      githubRepositoryId: project.externalRepositoryId,
      permission: authorization.permission,
      verifiedAt: authorization.verifiedAt,
      expiresAt: authorization.expiresAt,
      authorizationSource: 'github-app',
    });
    return c.json({
      project: {
        id: project.id,
        provider: 'github',
        externalRepositoryId: project.externalRepositoryId,
        fullName: project.fullName,
        installationId: project.installationId,
        visibility: project.visibility,
        authorizationSource: 'github',
      },
      session,
      capability,
      authorization: {
        authorizationSource: 'github',
        repositoryPermission: authorization.permission,
        githubUserId: identity.githubUserId,
        externalRepositoryId: project.externalRepositoryId,
        verifiedAt: new Date(authorization.verifiedAt).toISOString(),
        authorizationExpiresAt: new Date(authorization.expiresAt).toISOString(),
      },
    });
  });

  app.get('/api/projects', (c) => {
    const actor = actorId(c);
    const projects = store.listProjects(actor, authMode === 'manual' && getUser(c)?.role === 'admin');
    return c.json(authMode === 'github-app'
      ? projects.filter((project) => !!store.getGithubProjectById(project.id)
        && !!store.githubMemberRole(project.id, actor))
      : projects);
  });

  app.post('/api/projects', async (c) => authMode === 'manual'
    ? c.json(store.createProject((await parseBody(c, schemas.projectCreate)).id, getUser(c)!.id))
    : c.json({ error: 'projects are created from verified GitHub repositories' }, 403));

  app.delete('/api/projects/:p', (c) => c.json(store.deleteProject(c.req.param('p'))));

  app.get('/api/projects/:p/members', (c) => c.json(store.listMembers(c.req.param('p'))));

  app.post('/api/projects/:p/members', async (c) => {
    const { username, role } = await parseBody(c, schemas.memberAdd);
    return c.json(store.addMember(c.req.param('p'), username, role));
  });

  app.patch('/api/projects/:p/members/:uid', async (c) =>
    c.json(store.setMemberRole(c.req.param('p'), c.req.param('uid'),
      (await parseBody(c, schemas.memberPatch)).role)));

  app.delete('/api/projects/:p/members/:uid', (c) =>
    c.json(store.removeMember(c.req.param('p'), c.req.param('uid'))));

  // Attribution always comes from the authenticated identity, never the body.
  app.post('/api/projects/:p/sessions', async (c) => {
    if (authMode === 'github-app') {
      return c.json({ error: 'sessions must be created through the verified GitHub repository binding' }, 403);
    }
    const body = await parseBody(c, schemas.sessionCreate);
    const cred = getCred(c);
    const user = getUser(c);
    const capability = randomBytes(32).toString('base64url');
    const session = store.startSession(c.req.param('p'),
      { ...body, developer: user?.username ?? cred?.ownerUsername ?? null }, capability);
    return c.json({ ...session, capability });
  });

  app.post('/api/projects/:p/sessions/:id/heartbeat', async (c) => {
    const projectId = c.req.param('p');
    const sessionId = c.req.param('id');
    store.assertSessionCapability(projectId, sessionId, c.req.header('x-mediation-session'), true);
    const existing = store.getGithubSessionAuthorization(projectId, sessionId);
    if (existing) {
      if (existing.userId !== actorId(c)) return c.json({ error: 'session belongs to another user' }, 403);
      if (existing.expiresAt - Date.now() <= 30_000) {
        try {
          const project = store.getGithubProjectById(projectId);
          const identity = store.getGithubIdentity(existing.userId);
          if (!project || !identity || identity.authorizationStatus !== 'authorized') {
            throw new GitHubAppError('GitHub session identity is no longer authorized', 403);
          }
          const [owner, repository] = project.fullName.split('/');
          if (!owner || !repository) throw new GitHubAppError('stored GitHub repository identity is invalid', 403);
          const authorization = await options.github!.authorizeRepository(owner, repository, {
            id: identity.githubUserId, login: identity.login,
          });
          if (authorization.repository.id !== project.externalRepositoryId) {
            throw new GitHubAppError('GitHub repository identity changed', 403);
          }
          store.resolveGithubProject({
            externalRepositoryId: authorization.repository.id,
            fullName: authorization.repository.fullName,
            installationId: authorization.repository.installationId,
            visibility: authorization.repository.visibility,
            authorizationSource: 'github-app',
            createdBy: existing.userId,
          });
          store.grantGithubProjectAccess(projectId, existing.userId, authorization.permission, authorization.expiresAt);
          store.setGithubSessionAuthorization(projectId, sessionId, {
            ...existing,
            permission: authorization.permission,
            verifiedAt: authorization.verifiedAt,
            expiresAt: authorization.expiresAt,
          });
        } catch (error) {
          store.endSession(projectId, sessionId, 'GitHub repository authorization expired');
          throw error;
        }
      }
    }
    return c.json(store.heartbeat(projectId, sessionId, await parseBody(c, schemas.heartbeat)));
  });

  app.delete('/api/projects/:p/sessions/:id', (c) => {
    store.assertSessionCapability(c.req.param('p'), c.req.param('id'), c.req.header('x-mediation-session'), true);
    return c.json(store.endSession(c.req.param('p'), c.req.param('id')));
  });

  app.post('/api/projects/:p/sessions/:id/repo', async (c) => {
    store.assertSessionCapability(c.req.param('p'), c.req.param('id'), c.req.header('x-mediation-session'));
    return c.json(store.reportRepoState(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.repoReport)));
  });

  app.post('/api/projects/:p/claims', async (c) => {
    const body = await parseBody(c, schemas.claimCreate);
    store.assertSessionCapability(c.req.param('p'), body.sessionId, c.req.header('x-mediation-session'));
    return c.json(store.createClaim(c.req.param('p'), body));
  });

  app.patch('/api/projects/:p/claims/:id', async (c) => {
    store.assertClaimCapability(c.req.param('p'), c.req.param('id'), c.req.header('x-mediation-session'));
    return c.json(store.updateClaim(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.claimPatch)));
  });

  app.post('/api/projects/:p/claims/:id/complete', async (c) => {
    store.assertClaimCapability(c.req.param('p'), c.req.param('id'), c.req.header('x-mediation-session'));
    return c.json(store.completeClaim(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.claimComplete)));
  });

  app.post('/api/projects/:p/bugs', async (c) => {
    const body = await parseBody(c, schemas.bugCreate);
    store.assertSessionCapability(c.req.param('p'), body.sessionId, c.req.header('x-mediation-session'));
    return c.json(store.reportBug(c.req.param('p'), body));
  });

  app.patch('/api/projects/:p/bugs/:id', async (c) => {
    store.assertBugCapability(c.req.param('p'), c.req.param('id'), c.req.header('x-mediation-session'));
    return c.json(store.updateBug(c.req.param('p'), c.req.param('id'), await parseBody(c, schemas.bugPatch)));
  });

  app.get('/api/projects/:p/state', (c) => c.json(store.getState(c.req.param('p'))));

  app.get('/api/projects/:p/check', (c) => {
    const q = c.req.query();
    if (q.sessionId) {
      store.assertSessionCapability(c.req.param('p'), q.sessionId, c.req.header('x-mediation-session'));
    }
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
    return c.text(script.replaceAll('__MEDIATION_URL__', publicUrl ?? `${proto}://${host}`), 200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
    });
  });

  app.get('/install.ps1', (c) => {
    let script: string;
    try {
      script = fs.readFileSync(path.join(ROOT, 'clients', 'install.ps1'), 'utf8');
    } catch {
      return c.text('installer not available on this server build', 503);
    }
    const proto = c.req.header('x-forwarded-proto') ?? 'http';
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'localhost:4100';
    return c.text(script.replaceAll('__MEDIATION_URL__', publicUrl ?? `${proto}://${host}`));
  });

  // No templating: the uninstaller only touches local paths, so it needs no URL.
  app.get('/uninstall.sh', (c) =>
    serveFile(c, path.join(ROOT, 'clients', 'uninstall.sh')));

  app.get('/uninstall.ps1', (c) =>
    serveFile(c, path.join(ROOT, 'clients', 'uninstall.ps1')));

  app.get('/install/mediation-mcp.mjs', (c) =>
    serveFile(c, path.join(ROOT, 'clients', 'mediation-mcp.mjs')));

  app.get('/install/mediation-installer.mjs', (c) =>
    serveFile(c, path.join(ROOT, 'clients', 'mediation-installer.mjs')));

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
