import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('humans see the GitHub login and repository name, not internal handles', async () => {
  const store = new Store({ dbPath: ':memory:' });
  const created = store.findOrCreateGithubUser({
    githubUserId: '4242', login: 'KyleDerZweite', authorizationStatus: 'authorized',
  });
  // The stored handle stays normalized; only the display name is human-facing.
  assert.equal(created.username, 'gh-kylederzweite');
  assert.equal(created.displayName, 'KyleDerZweite');
  assert.equal(created.avatarUrl, 'https://avatars.githubusercontent.com/u/4242?v=4');
  assert.equal(store.getUserByGithubId('4242')?.displayName, 'KyleDerZweite');
  assert.equal(store.getUserByGithubId('4242')?.avatarUrl, 'https://avatars.githubusercontent.com/u/4242?v=4');

  const project = store.resolveGithubProject({
    externalRepositoryId: '5150', fullName: 'KyleDerZweite/mediation', installationId: '77',
    visibility: 'private', authorizationSource: 'github-app', createdBy: created.id,
  });
  store.patchUser(created.id, { status: 'active' });
  store.grantGithubProjectAccess(project.id, created.id, 'ADMIN', Date.now() + 60_000);

  const summary = store.listProjects(created.id, false).find((p) => p.id === project.id);
  assert.equal(summary?.id, project.id); // routing still uses the opaque id
  assert.equal(summary?.name, 'KyleDerZweite/mediation');
  assert.equal(store.listMembers(project.id)[0].displayName, 'KyleDerZweite');
  assert.equal(store.listMembers(project.id)[0].avatarUrl, 'https://avatars.githubusercontent.com/u/4242?v=4');

  // An owner adds people by the name they see, in any case.
  const mate = store.findOrCreateGithubUser({ githubUserId: '99', login: 'OctoCat', authorizationStatus: 'authorized' });
  store.patchUser(mate.id, { status: 'active' });
  assert.equal(store.addMember(project.id, 'octocat', 'member').displayName, 'OctoCat');
  store.close();
});

test('a project stays listed after its GitHub grant goes stale, hides after a week idle, and is never deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mediation-idle-'));
  const dbPath = join(dir, 'idle.db');
  const store = new Store({ dbPath });
  const user = store.findOrCreateGithubUser({ githubUserId: '31337', login: 'Octo', authorizationStatus: 'authorized' });
  store.patchUser(user.id, { status: 'active' });
  const project = store.resolveGithubProject({
    externalRepositoryId: '6001', fullName: 'Octo/widgets', installationId: '42',
    visibility: 'private', authorizationSource: 'github-app', createdBy: user.id,
  });
  // The grant GitHub last confirmed has lapsed.
  store.grantGithubProjectAccess(project.id, user.id, 'ADMIN', Date.now() - 1);

  // Agents need a fresh verification; the human's own dashboard does not.
  assert.equal(store.githubMemberRole(project.id, user.id), null);
  assert.equal(store.githubMemberRole(project.id, user.id, { fresh: false }), 'owner');
  assert.deepEqual(store.listProjects(user.id, false, { fresh: true }).map((p) => p.id), []);
  assert.deepEqual(store.listProjects(user.id, false, { fresh: false }).map((p) => p.id), [project.id]);

  // Age the project and its history past the idle window (no clock injection
  // in the store, so reach into the same database file directly).
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60_000;
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE projects SET created_at = ? WHERE id = ?').run(eightDaysAgo, project.id);
  raw.prepare('UPDATE events SET at = ? WHERE projectId = ?').run(eightDaysAgo, project.id);
  raw.close();

  // Hidden from the list, but the project, its history and membership remain.
  assert.deepEqual(store.listProjects(user.id, false, { fresh: false }).map((p) => p.id), []);
  assert.equal(store.getGithubProjectById(project.id)?.fullName, 'Octo/widgets');
  assert.equal(store.githubMemberRole(project.id, user.id, { fresh: false }), 'owner');
  assert.equal(store.listMembers(project.id).length, 1);

  // Using it again brings it straight back.
  store.startSession(project.id, { agent: 'codex', developer: 'Octo' }, 'cap');
  assert.deepEqual(store.listProjects(user.id, false, { fresh: false }).map((p) => p.id), [project.id]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
