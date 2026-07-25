import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';

test('GitHub identities, immutable repositories, and authorization revocation persist safely', async () => {
  const store = new Store({ dbPath: ':memory:' });
  const { user } = await store.registerUser({ username: 'octo', password: 'password123' });
  store.bindGithubIdentity(user.id, { githubUserId: '12345678901234567890', login: 'octocat', authorizationStatus: 'authorized' });
  assert.equal(store.getGithubIdentity(user.id)?.githubUserId, '12345678901234567890');
  const project = store.resolveGithubProject({
    externalRepositoryId: '998877665544332211', fullName: 'octo/repo',
    installationId: '112233445566778899', visibility: 'private', authorizationSource: 'github-app', createdBy: user.id,
  });
  const renamed = store.resolveGithubProject({
    externalRepositoryId: project.externalRepositoryId, fullName: 'octo/renamed', installationId: project.installationId,
    visibility: project.visibility, authorizationSource: 'github-app', createdBy: user.id,
  });
  assert.equal(renamed.id, project.id);
  assert.equal(store.getGithubProject('998877665544332211')?.fullName, 'octo/renamed');
  const session = store.startSession(project.id, { agent: 'codex', developer: 'octo' });
  store.setGithubSessionAuthorization(project.id, session.id, {
    userId: user.id, githubUserId: '12345678901234567890', githubRepositoryId: '998877665544332211',
    permission: 'write', verifiedAt: Date.now(), expiresAt: Date.now() + 60_000, authorizationSource: 'github-app',
  });
  assert.equal(store.getGithubSessionAuthorization(project.id, session.id)?.permission, 'write');
  assert.equal(store.assertGithubSessionAuthorization(project.id, session.id).githubRepositoryId, project.externalRepositoryId);
  const grant = store.grantGithubProjectAccess(project.id, user.id, 'WRITE', Date.now() + 60_000);
  assert.equal(grant.role, 'member');
  assert.equal(store.memberRole(project.id, user.id), 'member');
  const expired = store.resolveGithubProject({
    externalRepositoryId: '998877665544332210', fullName: 'octo/expired', installationId: '112233445566778898',
    visibility: 'private', authorizationSource: 'github-app', createdBy: user.id,
  });
  store.grantGithubProjectAccess(expired.id, user.id, 'WRITE', Date.now() - 1);
  assert.equal(store.memberRole(expired.id, user.id), null);
  store.createClaim(project.id, { sessionId: session.id, intent: 'test revocation', files: [], components: [], status: 'investigating' });
  assert.deepEqual(store.revokeGithubIdentity(user.id), { sessions: 1, credentials: 0 });
  assert.equal(store.getState(project.id).sessions.length, 0);
  assert.equal(store.getState(project.id).claims.length, 0);

  store.bindGithubIdentity(user.id, { githubUserId: '12345678901234567890', login: 'octocat', authorizationStatus: 'authorized' });
  const activation = store.startGithubDeviceActivation('box');
  store.bindGithubDeviceActivation(activation.requestId, activation.userCode, '12345678901234567890');
  const device = store.redeemGithubDeviceActivation(activation.requestId, activation.secret);
  assert.ok(device.token.length > 30);
  const fresh = store.resolveGithubProject({
    externalRepositoryId: '998877665544332212', fullName: 'octo/other', installationId: project.installationId,
    visibility: 'private', authorizationSource: 'github-app', createdBy: user.id,
  });
  store.grantGithubProjectAccess(fresh.id, user.id, 'ADMIN', Date.now() + 60_000);
  assert.deepEqual(store.invalidateGithubInstallation(project.installationId), { sessions: 0, grants: 1 });
  assert.equal(store.memberRole(fresh.id, user.id), null);
  store.close();
});
