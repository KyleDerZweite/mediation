import assert from 'node:assert/strict';
import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { GitHubApp, GitHubAppError, type FetchLike } from '../src/server/github.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function app(fetch: FetchLike, now = () => 1_700_000_000_000) {
  return new GitHubApp({
    publicUrl: 'https://mediation.example', appId: '123', clientId: 'client', clientSecret: 'secret', privateKeyPem, webhookSecret: 'hook-secret',
  }, { fetch, now });
}

function queue(...bodies: Array<Record<string, unknown> | string>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const body = bodies.shift();
    assert.ok(body, `unexpected request ${url}`);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

test('OAuth uses state + PKCE and discards the exchanged user token after /user', async () => {
  const mock = queue({ access_token: 'temporary-user-token' }, { id: 42, login: 'octo' });
  const github = app(mock.fetch);
  const start = github.startOAuth();
  const url = new URL(start.authorizeUrl);
  assert.equal(url.searchParams.get('state'), start.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge') || '', /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await github.completeOAuth('code', start.state), { id: '42', login: 'octo' });
  assert.equal(mock.calls.length, 2);
  assert.match(String(mock.calls[1].init?.headers && (mock.calls[1].init.headers as Record<string, string>).authorization), /temporary-user-token/);
  await assert.rejects(() => github.completeOAuth('code', start.state), GitHubAppError);
});

test('App JWT signs RS256 and permission requires the exact GitHub numeric user id', async () => {
  const mock = queue(
    { id: 88 },
    { token: 'installation-token', expires_at: '2025-01-01T00:00:00Z' },
    '{"id":9007199254740993,"name":"repo","full_name":"Org/repo","visibility":"private","owner":{"login":"Org"}}',
    { permission: 'write', user: { id: 42 } },
  );
  const github = app(mock.fetch, () => Date.parse('2024-01-01T00:00:00Z'));
  const jwt = github.appJwt();
  const [head, payload, signature] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256'); verifier.update(`${head}.${payload}`); verifier.end();
  assert.ok(verifier.verify(publicKeyPem, Buffer.from(signature, 'base64url')));
  const authorized = await github.authorizeRepository('org', 'repo', { id: '42', login: 'octo' });
  const repo = authorized.repository;
  assert.deepEqual(repo, { id: '9007199254740993', owner: 'Org', name: 'repo', fullName: 'Org/repo', visibility: 'private', installationId: '88' });
  assert.deepEqual({ permission: authorized.permission, verifiedAt: authorized.verifiedAt, expiresAt: authorized.expiresAt }, {
    permission: 'write', verifiedAt: Date.parse('2024-01-01T00:00:00Z'), expiresAt: Date.parse('2024-01-01T00:05:00Z'),
  });
  assert.equal(await github.canPush(repo, { id: '42', login: 'octo' }), true);
  assert.equal(await github.canPush(repo, { id: '42', login: 'octo' }), true, 'five-minute permission cache is shared');
  assert.equal(mock.calls.length, 4);
});

test('permission identity mismatch fails closed and verified webhooks invalidate caches', async () => {
  const mock = queue(
    { token: 'install-a', expires_at: '2025-01-01T00:00:00Z' },
    { permission: 'admin', user: { id: 99 } },
  );
  const github = app(mock.fetch, () => Date.parse('2024-01-01T00:00:00Z'));
  const repo = { id: '7', owner: 'org', name: 'repo', fullName: 'org/repo', visibility: 'private' as const, installationId: '8' };
  await assert.rejects(() => github.canPush(repo, { id: '42', login: 'octo' }), /identity mismatch/);
  const raw = Buffer.from(JSON.stringify({ installation: { id: 8 }, repository: { id: 7 } }));
  const sig = `sha256=${createHmac('sha256', 'hook-secret').update(raw).digest('hex')}`;
  assert.deepEqual(github.verifyWebhook(raw, sig, 'installation_repositories'), {
    event: 'installation_repositories', action: null, installationId: '8', repositoryIds: ['7'], githubUserId: null,
  });
  assert.throws(() => github.verifyWebhook(raw, 'sha256=bad', 'push'), /signature/);
});

test('revoked GitHub App authorization preserves the sender id as decimal text', () => {
  const github = app(async () => { throw new Error('no HTTP expected'); });
  const raw = Buffer.from('{"action":"revoked","sender":{"id":9007199254740993}}');
  const sig = `sha256=${createHmac('sha256', 'hook-secret').update(raw).digest('hex')}`;
  assert.deepEqual(github.verifyWebhook(raw, sig, 'github_app_authorization'), {
    event: 'github_app_authorization', action: 'revoked', installationId: null, repositoryIds: [], githubUserId: '9007199254740993',
  });
});
