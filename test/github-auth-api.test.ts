import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.ts';
import { GitHubApp, type FetchLike } from '../src/server/github.ts';
import { Store } from '../src/server/store.ts';

test('GitHub mode creates only verified immutable-repository sessions', async () => {
  const store = new Store({ dbPath: ':memory:' });
  const user = store.findOrCreateGithubUser({
    githubUserId: '42', login: 'octo', authorizationStatus: 'authorized',
  }, 'octo');
  const device = store.createGithubDeviceCredential(user.id, 'box');
  const replies = [
    { id: 88 },
    { token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' },
    { id: 9_001, name: 'repo', full_name: 'Org/repo', visibility: 'private', owner: { login: 'Org' } },
    { permission: 'write', user: { id: 42 } },
  ];
  const fetcher: FetchLike = async () => new Response(JSON.stringify(replies.shift()), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' }).toString();
  const github = new GitHubApp({
    publicUrl: 'https://mediation.example', appId: '1', clientId: 'client',
    clientSecret: 'secret', privateKeyPem: key, webhookSecret: 'webhook',
  }, { fetch: fetcher });
  const app = buildApp(store, {
    authMode: 'github-app', publicUrl: 'https://mediation.example', github,
  });
  const headers = { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' };
  const response = await app.request('/api/repositories/github/session', {
    method: 'POST', headers,
    body: JSON.stringify({ owner: 'org', repository: 'repo', agent: 'codex', machine: 'box' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: { id: string; externalRepositoryId: string; authorizationSource: string };
    session: { id: string };
    authorization: { repositoryPermission: string };
    capability: string;
  };
  assert.equal(body.project.externalRepositoryId, '9001');
  assert.equal(body.project.authorizationSource, 'github');
  assert.equal(body.authorization.repositoryPermission, 'write');
  assert.ok(body.capability);
  assert.equal(store.getGithubSessionAuthorization(body.project.id, body.session.id)?.githubUserId, '42');

  const bypass = await app.request(`/api/projects/${body.project.id}/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ agent: 'forged' }),
  });
  assert.equal(bypass.status, 403);
  store.close();
});

test('a repository the App is not installed on answers 403 with an actionable hint', async () => {
  const store = new Store({ dbPath: ':memory:' });
  const user = store.findOrCreateGithubUser({
    githubUserId: '42', login: 'octo', authorizationStatus: 'authorized',
  }, 'octo');
  const device = store.createGithubDeviceCredential(user.id, 'box');
  // Every repository lookup 404s; only GET /app resolves, for the install URL.
  const fetcher: FetchLike = async (url) => (url.endsWith('/app')
    ? new Response(JSON.stringify({ slug: 'mediation-example' }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' }).toString();
  const github = new GitHubApp({
    publicUrl: 'https://mediation.example', appId: '1', clientId: 'client',
    clientSecret: 'secret', privateKeyPem: key, webhookSecret: 'webhook',
  }, { fetch: fetcher });
  const app = buildApp(store, { authMode: 'github-app', publicUrl: 'https://mediation.example', github });

  const response = await app.request('/api/repositories/github/session', {
    method: 'POST',
    headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'acme', repository: 'widgets', agent: 'codex', machine: 'box' }),
  });
  assert.equal(response.status, 403);
  const body = await response.json() as { error: string; hint?: string };
  assert.equal(body.error, 'the Mediation GitHub App is not installed on acme/widgets');
  assert.match(body.hint || '', /https:\/\/github\.com\/apps\/mediation-example\/installations\/new/);
  store.close();
});
