// GitHub App boundary for repository authorization.  This module deliberately
// owns no persistence: OAuth access tokens are discarded after identity lookup;
// installation and permission caches are memory-only.

import { createHash, createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

const API = 'https://api.github.com';
const OAUTH = 'https://github.com/login/oauth';
const CACHE_SKEW_MS = 5 * 60_000;
const OAUTH_TTL_MS = 10 * 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppConfig {
  publicUrl: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  webhookSecret: string;
}

export interface GitHubIdentity { id: string; login: string }
export interface GitHubRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  visibility: 'public' | 'private' | 'internal';
  installationId: string;
}
export interface OAuthStart { state: string; authorizeUrl: string; expiresAt: number }
export interface RepositoryAuthorization {
  repository: GitHubRepository;
  permission: 'write' | 'admin';
  verifiedAt: number;
  expiresAt: number;
}
export interface WebhookInvalidation {
  event: string; action: string | null; installationId: string | null; repositoryIds: string[]; githubUserId: string | null;
}

export class GitHubAppError extends Error {
  readonly statusCode: 400 | 403 | 502 | 503;
  // Instruction for the human, passed through verbatim by the API and the MCP
  // client. A denial the user cannot act on is a dead end, not an error.
  readonly hint?: string;
  constructor(message: string, statusCode: 400 | 403 | 502 | 503 = 502, hint?: string) {
    super(message);
    this.statusCode = statusCode;
    this.hint = hint;
  }
}

interface InstallationToken { token: string; expiresAt: number }
interface PermissionCache { allowed: boolean; permission: 'write' | 'admin' | null; verifiedAt: number; expiresAt: number }
interface OAuthPending { verifier: string; expiresAt: number }

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function decimal(value: unknown, label: string): string {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubAppError(`GitHub returned an invalid ${label}`);
  }
  return String(value);
}

// GitHub's REST IDs are decimal integers, including values beyond JavaScript's
// exact Number range. Convert only an `"id": <integer>` token before JSON.parse.
// API JSON is trusted syntax, and this narrowly preserves every ID we consume.
function githubObject(raw: string): Record<string, unknown> {
  const exactIds = raw.replace(/("id"\s*:\s*)(-?(?:0|[1-9]\d*))(?![\d.])/g, '$1"$2"');
  try { return object(JSON.parse(exactIds) as unknown); }
  catch { throw new GitHubAppError('GitHub returned an invalid response'); }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new GitHubAppError(`GitHub returned an invalid ${label}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new GitHubAppError('GitHub returned an invalid response');
  return value as Record<string, unknown>;
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function githubAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new GitHubAppError(`${name} is required for github-app mode`);
    return value;
  };
  const secret = (inlineName: string, fileName: string): string => {
    const inline = env[inlineName];
    const file = env[fileName];
    if (inline && file) throw new GitHubAppError(`set only one of ${inlineName} or ${fileName}`);
    const value = inline ?? (file ? fs.readFileSync(file, 'utf8').trim() : '');
    if (!value) throw new GitHubAppError(`${inlineName} or ${fileName} is required for github-app mode`);
    return value;
  };
  const privateKeyPem = secret('GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE');
  return {
    publicUrl: need('PUBLIC_URL'), appId: need('GITHUB_APP_ID'), clientId: need('GITHUB_APP_CLIENT_ID'),
    clientSecret: secret('GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_CLIENT_SECRET_FILE'),
    privateKeyPem,
    webhookSecret: secret('GITHUB_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET_FILE'),
  };
}

export class GitHubApp {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly config: GitHubAppConfig;
  private readonly installationTokens = new Map<string, InstallationToken>();
  private readonly permissions = new Map<string, PermissionCache>();
  private slug: string | null | undefined; // undefined = not looked up yet
  private readonly oauth = new Map<string, OAuthPending>();

  constructor(config: GitHubAppConfig, options: { fetch?: FetchLike; now?: () => number } = {}) {
    this.config = config;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    // Validate configuration once and avoid accidentally accepting a path/URL.
    const publicUrl = new URL(config.publicUrl);
    if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) {
      throw new GitHubAppError('PUBLIC_URL must be an http(s) URL without credentials', 400);
    }
    if (!/^\d+$/.test(config.appId)) throw new GitHubAppError('GITHUB_APP_ID must be decimal');
    if (!config.clientId || !config.clientSecret || !config.privateKeyPem || !config.webhookSecret) {
      throw new GitHubAppError('incomplete GitHub App configuration');
    }
  }

  startOAuth(): OAuthStart {
    this.pruneOAuth();
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const challenge = b64url(awaitDigest(codeVerifier));
    const expiresAt = this.now() + OAUTH_TTL_MS;
    this.oauth.set(state, { verifier: codeVerifier, expiresAt });
    const url = new URL(`${OAUTH}/authorize`);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', new URL('/api/github/callback', this.config.publicUrl).toString());
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { state, authorizeUrl: url.toString(), expiresAt };
  }

  async completeOAuth(code: string, state: string): Promise<GitHubIdentity> {
    if (!code) throw new GitHubAppError('missing OAuth code');
    const pending = this.oauth.get(state);
    this.oauth.delete(state);
    if (!pending || pending.expiresAt <= this.now()) throw new GitHubAppError('invalid or expired OAuth state');
    const response = await this.fetcher(`${OAUTH}/access_token`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, code_verifier: pending.verifier }),
    });
    const tokenBody = githubObject(await response.text());
    if (!response.ok || typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) {
      throw new GitHubAppError('GitHub OAuth exchange failed');
    }
    // Intentionally scoped to this method. Never return, cache, log, or persist it.
    const user = await this.githubJson('/user', { authorization: `Bearer ${tokenBody.access_token}` });
    return { id: decimal(user.id, 'user id'), login: text(user.login, 'user login') };
  }

  appJwt(): string {
    const issuedAt = Math.floor(this.now() / 1000) - 60;
    const encoded = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: this.config.appId }))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(encoded); signer.end();
    return `${encoded}.${signer.sign(this.config.privateKeyPem).toString('base64url')}`;
  }

  async resolveRepository(owner: string, name: string): Promise<GitHubRepository> {
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new GitHubAppError('invalid GitHub repository name');
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    // App JWTs discover installations; they are not used to read repository data.
    // A 404 here is the single most common first-run failure: the App exists
    // but nobody installed it on this repository yet.
    let installation;
    try {
      installation = await this.githubJson(`${repositoryPath}/installation`, { authorization: `Bearer ${this.appJwt()}` });
    } catch (error) {
      throw await this.explain(error, `the Mediation GitHub App is not installed on ${owner}/${name}`,
        `Install the Mediation GitHub App on ${owner}/${name}`,
        'On an organisation repository an owner may have to approve the installation. Then run the same command again.');
    }
    const installationId = decimal(installation.id, 'installation id');
    const token = await this.installationToken(installationId);
    let repo;
    try {
      repo = await this.githubJson(repositoryPath, { authorization: `Bearer ${token}` });
    } catch (error) {
      throw await this.explain(error, `the Mediation GitHub App installation cannot see ${owner}/${name}`,
        `Grant the Mediation GitHub App access to ${owner}/${name}`,
        'The App is installed but this repository is not in its selected repositories.');
    }
    const repoOwner = object(repo.owner);
    const resolvedOwner = text(repoOwner.login, 'repository owner');
    const resolvedName = text(repo.name, 'repository name');
    const fullName = text(repo.full_name, 'repository full name');
    const visibility = text(repo.visibility, 'repository visibility');
    if (visibility !== 'public' && visibility !== 'private' && visibility !== 'internal') throw new GitHubAppError('GitHub returned an invalid repository visibility');
    return { id: decimal(repo.id, 'repository id'), owner: resolvedOwner, name: resolvedName, fullName, visibility, installationId };
  }

  async authorizeRepository(owner: string, name: string, identity: GitHubIdentity): Promise<RepositoryAuthorization> {
    const repository = await this.resolveRepository(owner, name);
    return { repository, ...await this.permission(repository, identity) };
  }

  async canPush(repository: GitHubRepository, identity: GitHubIdentity): Promise<boolean> {
    try { await this.permission(repository, identity); return true; }
    catch (error) {
      if (error instanceof GitHubAppError && error.message === 'GitHub user lacks write permission') return false;
      throw error;
    }
  }

  private async permission(repository: GitHubRepository, identity: GitHubIdentity): Promise<Omit<RepositoryAuthorization, 'repository'>> {
    if (!/^\d+$/.test(repository.id) || !/^\d+$/.test(repository.installationId) || !/^\d+$/.test(identity.id) || !identity.login) {
      throw new GitHubAppError('invalid GitHub authorization input');
    }
    const key = `${repository.id}:${identity.id}`;
    const cached = this.permissions.get(key);
    if (cached && cached.expiresAt > this.now()) {
      if (!cached.allowed) throw new GitHubAppError('GitHub user lacks write permission', 403);
      return { permission: cached.permission!, verifiedAt: cached.verifiedAt, expiresAt: cached.expiresAt };
    }
    const token = await this.installationToken(repository.installationId);
    let reply;
    try {
      reply = await this.githubJson(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/collaborators/${encodeURIComponent(identity.login)}/permission`, { authorization: `Bearer ${token}` });
    } catch (error) {
      throw await this.explain(error,
        `GitHub does not list ${identity.login} as a collaborator on ${repository.fullName}`,
        null, `Ask a ${repository.fullName} admin for write access, then try again.`);
    }
    const user = object(reply.user);
    if (decimal(user.id, 'permission user id') !== identity.id) throw new GitHubAppError('GitHub permission identity mismatch', 403);
    const permission = text(reply.permission, 'repository permission');
    const allowed = permission === 'write' || permission === 'admin';
    const verifiedAt = this.now();
    const expiresAt = verifiedAt + CACHE_SKEW_MS;
    this.permissions.set(key, { allowed, permission: allowed ? permission : null, verifiedAt, expiresAt });
    if (!allowed) {
      throw new GitHubAppError('GitHub user lacks write permission', 403,
        `Mediation coordinates work you can push: ${identity.login} needs write or admin on `
        + `${repository.fullName}, but GitHub reports "${permission}".`);
    }
    return { permission, verifiedAt, expiresAt };
  }

  verifyWebhook(raw: Buffer | string, signature: string | null | undefined, event: string | null | undefined): WebhookInvalidation {
    if (!signature?.startsWith('sha256=') || !event) throw new GitHubAppError('invalid GitHub webhook');
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const expected = Buffer.from(`sha256=${createHmac('sha256', this.config.webhookSecret).update(body).digest('hex')}`);
    if (!safeEqual(expected, Buffer.from(signature))) throw new GitHubAppError('invalid GitHub webhook signature');
    const payload = githubObject(body.toString('utf8'));
    const action = payload.action === undefined ? null : text(payload.action, 'webhook action');
    const installationId = payload.installation === undefined ? null : decimal(object(payload.installation).id, 'installation id');
    const repositoryIds = payload.repository === undefined
      ? []
      : [decimal(object(payload.repository).id, 'repository id')];
    if (Array.isArray(payload.repositories_removed)) {
      for (const repository of payload.repositories_removed) {
        repositoryIds.push(decimal(object(repository).id, 'repository id'));
      }
    }
    const githubUserId = event === 'github_app_authorization' && action === 'revoked'
      ? decimal(object(payload.sender).id, 'webhook sender id') : null;
    // Conservative invalidation is cheap and prevents stale permission grants.
    this.permissions.clear();
    if (installationId) this.installationTokens.delete(installationId);
    return { event, action, installationId, repositoryIds: [...new Set(repositoryIds)], githubUserId };
  }

  /* Turn GitHub's flat "cannot access this repository" into the sentence the
     human needs, with the App's own install URL. The slug comes from GET /app
     and is cached; if that lookup fails the hint simply omits the link, and a
     GitHub outage (5xx) still surfaces as an outage, not as a setup problem. */
  private async explain(error: unknown, message: string, action: string | null, detail: string): Promise<unknown> {
    if (!(error instanceof GitHubAppError) || error.statusCode !== 403) return error;
    const url = action ? await this.installUrl() : null;
    const act = action ? `${action}${url ? ` at ${url}` : ' from your GitHub App settings'}. ` : '';
    return new GitHubAppError(message, 403, `${act}${detail}`);
  }

  private async installUrl(): Promise<string | null> {
    if (this.slug === undefined) {
      try {
        const info = await this.githubJson('/app', { authorization: `Bearer ${this.appJwt()}` });
        this.slug = typeof info.slug === 'string' && /^[A-Za-z0-9-]{1,60}$/.test(info.slug) ? info.slug : null;
      } catch { this.slug = null; } // a hint lookup must never fail the request
    }
    return this.slug ? `https://github.com/apps/${this.slug}/installations/new` : null;
  }

  private async installationToken(installationId: string): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt - CACHE_SKEW_MS > this.now()) return cached.token;
    const reply = await this.githubJson(`/app/installations/${installationId}/access_tokens`, { method: 'POST', authorization: `Bearer ${this.appJwt()}` });
    const token = text(reply.token, 'installation token');
    const expiresAt = Date.parse(text(reply.expires_at, 'installation token expiry'));
    if (!Number.isFinite(expiresAt) || expiresAt - CACHE_SKEW_MS <= this.now()) throw new GitHubAppError('GitHub returned an unusable installation token');
    this.installationTokens.set(installationId, { token, expiresAt });
    return token;
  }

  private async githubJson(apiPath: string, init: { method?: string; authorization: string }): Promise<Record<string, unknown>> {
    const response = await this.fetcher(`${API}${apiPath}`, {
      method: init.method ?? 'GET', headers: { accept: 'application/vnd.github+json', authorization: init.authorization, 'x-github-api-version': '2022-11-28' },
    });
    const body = githubObject(await response.text());
    if (!response.ok) {
      throw new GitHubAppError(
        response.status >= 500 ? 'GitHub is temporarily unavailable' : 'GitHub App cannot access this repository',
        response.status >= 500 ? 503 : 403,
      );
    }
    return body;
  }

  private pruneOAuth(): void {
    for (const [state, pending] of this.oauth) if (pending.expiresAt <= this.now()) this.oauth.delete(state);
  }
}

function awaitDigest(value: string): Buffer {
  // Node's synchronous hash primitive is sufficient for PKCE and keeps this
  // helper usable before any asynchronous request state exists.
  return createHash('sha256').update(value).digest();
}
