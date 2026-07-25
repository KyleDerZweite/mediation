import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('CLI derives the project from Git pushRemote and keeps a fork distinct', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mediation-push-remote-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/upstream/manga.git');
  git('remote', 'add', 'fork', 'git@github.com:gang/manga.git');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.pushRemote', 'fork');

  let requested = '';
  const server = createServer((req, res) => {
    requested = req.url || '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'session-id', capability: 'session-capability', agent: 'test',
      developer: 'gang', machine: 'box', repo: null, createdAt: Date.now(), lastSeenAt: Date.now(),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [
        join(process.cwd(), 'src/cli/mediation-agent.ts'), 'connect',
        '--server', `http://127.0.0.1:${address.port}`, '--token', 'device-token', '--agent', 'codex',
      ], { cwd: repo });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requested, '/api/projects/gh-gang--manga/sessions');
    assert.match(result.stderr, /Git push remote fork: github\.com\/gang\/manga/);
  } finally {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
