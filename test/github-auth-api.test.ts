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
    body: JSON.stringify({
      owner: 'org', repository: 'repo', agent: 'codex', machine: 'box',
      runId: 'github-run', agentId: 'github-agent', agentTask: 'Verify repository', agentState: 'active',
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    project: { id: string; externalRepositoryId: string; authorizationSource: string };
    session: { id: string; runId: string; agentId: string; agentProvenance: string };
    authorization: { repositoryPermission: string };
    capability: string;
  };
  assert.equal(body.project.externalRepositoryId, '9001');
  assert.equal(body.project.authorizationSource, 'github');
  assert.equal(body.authorization.repositoryPermission, 'write');
  assert.ok(body.capability);
  assert.equal(body.session.runId, 'github-run');
  assert.equal(body.session.agentId, 'github-agent');
  assert.equal(body.session.agentProvenance, 'environment-reported');
  assert.equal(store.getState(body.project.id).agents[0]?.task, 'Verify repository');
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

// The permission cache hands back the expiry it was created with, so renewing a
// grant from cache moved nothing: the grant lapsed on schedule and every call
// except the heartbeat answered "not a member of project" until a later beat
// re-verified. The renewal must reach GitHub and actually push the expiry out.
test('a heartbeat renews the GitHub grant before it lapses', async () => {
  const store = new Store({ dbPath: ':memory:' });
  const user = store.findOrCreateGithubUser({
    githubUserId: '42', login: 'octo', authorizationStatus: 'authorized',
  }, 'octo');
  const device = store.createGithubDeviceCredential(user.id, 'box');
  let permissionChecks = 0;
  let offset = 0;
  const fetcher: FetchLike = async (url) => {
    const body = url.endsWith('/installation') ? { id: 88 }
      : url.endsWith('/access_tokens') ? { token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }
        : url.endsWith('/permission') ? (permissionChecks += 1, { permission: 'write', user: { id: 42 } })
          : { id: 9_001, name: 'repo', full_name: 'Org/repo', visibility: 'private', owner: { login: 'Org' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' }).toString();
  const github = new GitHubApp({
    publicUrl: 'https://mediation.example', appId: '1', clientId: 'client',
    clientSecret: 'secret', privateKeyPem: key, webhookSecret: 'webhook',
  }, { fetch: fetcher, now: () => Date.now() + offset });
  const app = buildApp(store, { authMode: 'github-app', publicUrl: 'https://mediation.example', github });
  const headers = { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' };

  // Create the session four minutes in the past, so its five-minute grant is
  // inside the renewal window the moment the clock catches up.
  offset = -4 * 60_000;
  const created = await (await app.request('/api/repositories/github/session', {
    method: 'POST', headers,
    body: JSON.stringify({ owner: 'org', repository: 'repo', agent: 'codex', machine: 'box' }),
  })).json() as { project: { id: string }; session: { id: string }; capability: string };
  offset = 0;
  const before = store.getGithubSessionAuthorization(created.project.id, created.session.id)!.expiresAt;
  assert.equal(permissionChecks, 1);

  const beat = await app.request(`/api/projects/${created.project.id}/sessions/${created.session.id}/heartbeat`, {
    method: 'POST', headers: { ...headers, 'x-mediation-session': created.capability }, body: '{}',
  });
  assert.equal(beat.status, 200);
  assert.equal(permissionChecks, 2, 'the renewal answered from cache instead of asking GitHub');
  const after = store.getGithubSessionAuthorization(created.project.id, created.session.id)!.expiresAt;
  assert.ok(after > before, `grant did not extend: ${after} <= ${before}`);
  // The member row backs every non-heartbeat call, so it must move too.
  assert.equal(store.githubMemberRole(created.project.id, user.id), 'member');
  store.close();
});
