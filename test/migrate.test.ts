// Upgrade rehearsal: a pre-Alpha database (no projects/project_members, no
// credentials.user_id, no pair_requests.approved_by) must upgrade in place when
// the new Store opens it. The OLD DDL is spelled out here on purpose — it is the
// contract we are migrating from, so it must not follow src/server/store.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.ts';
import { buildApp } from '../src/server/app.ts';

const OLD_DDL = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, agent TEXT NOT NULL,
    developer TEXT, machine TEXT, repo TEXT,
    createdAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL);
  CREATE TABLE claims (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, sessionId TEXT NOT NULL,
    agent TEXT NOT NULL, developer TEXT, intent TEXT NOT NULL, task TEXT,
    files TEXT NOT NULL, components TEXT NOT NULL, branch TEXT, baseRevision TEXT,
    status TEXT NOT NULL, findings TEXT NOT NULL, commits TEXT NOT NULL,
    prs TEXT NOT NULL, summary TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, completedAt INTEGER);
  CREATE TABLE bugs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, sessionId TEXT NOT NULL,
    reporter TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
    files TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL,
    createdAt INTEGER NOT NULL);
  CREATE TABLE events (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, type TEXT NOT NULL,
    message TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE pair_requests (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, agent TEXT NOT NULL,
    machine TEXT, developer TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, agent TEXT NOT NULL,
    machine TEXT, developer TEXT,
    created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
  CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE user_sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

const T0 = 1_700_000_000_000;

// Builds the live instance's shape: admin 'kyle' + user 'gang', a credential
// each, and activity in two projects.
function makeLegacyDb(file: string, users: [id: string, name: string, role: string, status: string][]): void {
  const db = new DatabaseSync(file);
  db.exec(OLD_DDL);
  for (const [id, username, role, status] of users) {
    db.prepare(`INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, 'scrypt:x', ?, ?, ?, ?)`).run(id, username, role, status, T0, T0);
  }
  const sess = (id: string, project: string, dev: string, at: number) =>
    db.prepare(`INSERT INTO sessions (id, projectId, agent, developer, machine, repo, createdAt, lastSeenAt)
      VALUES (?, ?, 'claude-code', ?, 'box', NULL, ?, ?)`).run(id, project, dev, at, at);
  sess('s1', 'mediation', 'kyle', T0 + 1000);
  sess('s2', 'sidequest', 'gang', T0 + 5000);
  db.prepare(`INSERT INTO claims (id, projectId, sessionId, agent, developer, intent, task, files,
      components, branch, baseRevision, status, findings, commits, prs, summary, createdAt, updatedAt, completedAt)
    VALUES ('c1', 'mediation', 's1', 'claude-code', 'kyle', 'fix thing', NULL, '[]', '[]', NULL, NULL,
      'in-progress', '[]', '[]', '[]', NULL, ?, ?, NULL)`).run(T0 + 2000, T0 + 2000);
  db.prepare(`INSERT INTO events (id, projectId, type, message, at)
    VALUES ('e1', 'mediation', 'session', 'claude-code connected', ?)`).run(T0 + 900);
  for (const [id, dev] of [['cr-kyle', 'kyle'], ['cr-gang', 'gang'], ['cr-ghost', 'nobody']]) {
    db.prepare(`INSERT INTO credentials (id, token, agent, machine, developer, created_at, last_used_at)
      VALUES (?, ?, 'claude-code', 'box', ?, ?, ?)`).run(id, `token-${id}`, dev, T0, T0);
  }
  db.close();
}

function tmpFile(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'mediation-migrate-')), name);
}

test('pre-Alpha database upgrades in place: projects, ownership, credential binding', () => {
  const file = tmpFile('legacy.db');
  makeLegacyDb(file, [['u-kyle', 'kyle', 'admin', 'active'], ['u-gang', 'gang', 'user', 'active']]);

  const store = new Store({ dbPath: file });
  const row = <T>(sql: string, ...args: unknown[]): T =>
    store.db.prepare(sql).get(...args as never[]) as T;

  // 1. new schema exists, old rows survive
  const projects = store.db.prepare('SELECT id, created_by, created_at FROM projects ORDER BY id').all() as
    { id: string; created_by: string; created_at: number }[];
  assert.deepEqual(projects.map((p) => p.id), ['mediation', 'sidequest']);
  assert.ok(projects.every((p) => p.created_by === 'u-kyle'));
  assert.equal(projects[0].created_at, T0 + 900); // earliest known activity, not "now"

  // 2. the admin owns every adopted project
  assert.equal(store.memberRole('mediation', 'u-kyle'), 'owner');
  assert.equal(store.memberRole('sidequest', 'u-kyle'), 'owner');

  // 3. credentials bound by developer/username match; the rest to the admin
  assert.equal(row<{ user_id: string }>('SELECT user_id FROM credentials WHERE id = ?', 'cr-kyle').user_id, 'u-kyle');
  assert.equal(row<{ user_id: string }>('SELECT user_id FROM credentials WHERE id = ?', 'cr-gang').user_id, 'u-gang');
  assert.equal(row<{ user_id: string }>('SELECT user_id FROM credentials WHERE id = ?', 'cr-ghost').user_id, 'u-kyle');

  // 4. grandfathered membership keeps already-paired directories working
  assert.equal(store.memberRole('sidequest', 'u-gang'), 'member');
  assert.equal(store.memberRole('mediation', 'u-gang'), null);

  // added columns are usable
  assert.equal(row<{ n: number }>("SELECT COUNT(*) AS n FROM pragma_table_info('pair_requests') WHERE name = 'approved_by'").n, 1);
  store.close();

  // 5. reopening is a no-op — no duplicate members, no re-dating
  const again = new Store({ dbPath: file });
  const members = again.db.prepare('SELECT COUNT(*) AS n FROM project_members').get() as { n: number };
  assert.equal(Number(members.n), 3); // kyle x2 owner + gang member
  assert.equal((again.db.prepare('SELECT created_at FROM projects WHERE id = ?').get('mediation') as { created_at: number }).created_at, T0 + 900);
  again.close();
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('no active admin: backfill is skipped and the orphaned credentials 401', async () => {
  const file = tmpFile('noadmin.db');
  makeLegacyDb(file, [['u-gang', 'gang', 'user', 'active']]); // no admin at all

  const store = new Store({ dbPath: file });
  assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n), 0);
  assert.equal((store.db.prepare('SELECT user_id FROM credentials WHERE id = ?')
    .get('cr-gang') as { user_id: string | null }).user_id, null); // stayed orphaned

  const app = buildApp(store);
  const res = await app.request('/api/projects', { headers: { authorization: 'Bearer token-cr-gang' } });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, 'credential must be re-paired');
  store.close();
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('the first admin to register adopts a legacy database that had no users', async () => {
  const file = tmpFile('adopt.db');
  makeLegacyDb(file, []); // nobody registered yet

  const store = new Store({ dbPath: file });
  assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n), 0);

  const { user, bootstrap } = await store.registerUser({ username: 'kyle', password: 'password123' });
  assert.equal(bootstrap, true);
  assert.equal(store.memberRole('mediation', user.id), 'owner');
  assert.equal(store.memberRole('sidequest', user.id), 'owner');
  assert.equal((store.db.prepare('SELECT user_id FROM credentials WHERE id = ?').get('cr-kyle') as { user_id: string }).user_id, user.id);
  store.close();
  rmSync(path.dirname(file), { recursive: true, force: true });
});
