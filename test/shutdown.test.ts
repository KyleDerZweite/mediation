import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server exits cleanly on SIGTERM', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mediation-shutdown-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: 'manual',
      HOST: '127.0.0.1',
      PORT: '0',
      DB_PATH: path.join(dir, 'mediation.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server did not start')), 5_000);
      child.stdout!.on('data', (chunk) => {
        if (String(chunk).includes('mediation server listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('error', reject);
    });
    const started = Date.now();
    child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('server did not stop after SIGTERM')), 9_000);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.ok(Date.now() - started < 9_000);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
