import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'mediation-install-'));
const assets = {
  '/install/mediation-mcp.mjs': readFileSync('clients/mediation-mcp.mjs', 'utf8'),
  '/install/SKILL.md': readFileSync('clients/skills/mediation/SKILL.md', 'utf8'),
};
const server = createServer((req, res) => {
  const body = assets[req.url as keyof typeof assets];
  res.writeHead(body ? 200 : 404); res.end(body || 'missing');
});
let origin = '';
before(async () => { await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

function run(home: string, args: string[], extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['clients/mediation-installer.mjs', ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, MEDIATION_HOME: join(home, 'data'), MEDIATION_AUTH_HOME: join(home, 'auth'), ...extra },
    });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test('installer is idempotent and uninstaller preserves unrelated configuration', async () => {
  const home = join(root, 'one'); mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), '# mine\n');
  let result = await run(home, ['--server', origin, '--agent', 'codex', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  result = await run(home, ['--server', origin, '--agent', 'codex', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((readFileSync(join(home, '.codex', 'config.toml'), 'utf8').match(/>>> mediation >>>/g) || []).length, 1);
  const auth = join(home, 'auth'); mkdirSync(auth, { recursive: true });
  writeFileSync(join(auth, 'credentials.json'), JSON.stringify({
    [origin]: { token: 'remove-me' },
    'https://other.example': { token: 'keep-me' },
  }));
  const installedSkill = join(home, '.codex', 'skills', 'mediation', 'SKILL.md');
  writeFileSync(installedSkill, `${readFileSync(installedSkill, 'utf8')}\n# user customization\n`);
  result = await run(home, ['--uninstall']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').trim(), '# mine');
  assert.equal(JSON.parse(readFileSync(join(auth, 'credentials.json'), 'utf8'))['https://other.example'].token, 'keep-me');
  assert.equal(existsSync(installedSkill), true);
});

test('Claude receives the initialized-repository skill rule without losing its own instructions', async () => {
  const home = join(root, 'claude');
  const claudeHome = join(home, '.claude');
  const bin = join(home, 'bin');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(claudeHome, 'CLAUDE.md'), '# Mine\n');
  const fakeClaude = join(bin, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\n[ "$1 $2" = "mcp get" ] && exit 1\nexit 0\n');
  chmodSync(fakeClaude, 0o700);

  const env = { CLAUDE_HOME: claudeHome, PATH: `${bin}:${process.env.PATH}` };
  let result = await run(home, ['--server', origin, '--agent', 'claude-code', '--yes', '--no-login'], env);
  assert.equal(result.status, 0, result.stderr);
  result = await run(home, ['--server', origin, '--agent', 'claude-code', '--yes', '--no-login'], env);
  assert.equal(result.status, 0, result.stderr);
  const instructions = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8');
  assert.match(instructions, /^# Mine/m);
  assert.match(instructions, /you must use and follow the installed `mediation` skill/);
  // The trigger has to be checkable: `.mediation.json` is usually gitignored, so
  // an agent waiting for it to appear in `git status` never coordinates at all.
  assert.match(instructions, /usually gitignored/);
  assert.match(instructions, /`mediation_state`/);
  assert.match(instructions, /do not initialize Mediation unless the user explicitly asks/);
  assert.equal((instructions.match(/>>> mediation >>>/g) || []).length, 1);

  result = await run(home, ['--uninstall', '--keep-auth'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf8').trim(), '# Mine');
});

test('malformed JSON and marker files remain untouched', async () => {
  const home = join(root, 'two'); mkdirSync(join(home, '.kimi-code'), { recursive: true });
  const file = join(home, '.kimi-code', 'mcp.json'); writeFileSync(file, '{ broken');
  const result = await run(home, ['--server', origin, '--agent', 'kimi-code', '--yes']);
  assert.notEqual(result.status, 0); assert.equal(readFileSync(file, 'utf8'), '{ broken');
  const codex = join(home, '.codex'); mkdirSync(codex, { recursive: true });
  const marker = join(codex, 'config.toml'); writeFileSync(marker, '# >>> mediation >>>\n');
  const second = await run(home, ['--server', origin, '--agent', 'codex', '--yes']);
  assert.notEqual(second.status, 0); assert.equal(readFileSync(marker, 'utf8'), '# >>> mediation >>>\n');
});

test('failed staging leaves harness files unchanged', async () => {
  const home = join(root, 'three'); mkdirSync(join(home, '.codex'), { recursive: true });
  const config = join(home, '.codex', 'config.toml'); writeFileSync(config, '# keep\n');
  const blocked = join(home, 'blocked'); writeFileSync(blocked, 'not a directory');
  const result = await run(home, ['--server', origin, '--agent', 'codex', '--yes'], { MEDIATION_HOME: join(blocked, 'data') });
  assert.notEqual(result.status, 0); assert.equal(readFileSync(config, 'utf8'), '# keep\n');
});

test('served uninstaller cleans a pre-Alpha install without a local helper', () => {
  const home = join(root, 'legacy');
  const data = join(home, 'data');
  const codex = join(home, '.codex');
  const kimi = join(home, '.kimi-code');
  mkdirSync(data, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(kimi, { recursive: true });
  writeFileSync(join(data, 'mediation-mcp.mjs'), '// legacy client\n');
  writeFileSync(join(data, 'SKILL.md'), '---\nname: mediation\n---\n');
  writeFileSync(join(codex, 'config.toml'),
    '# mine\n\n# >>> mediation >>>\n[mcp_servers.mediation]\n# <<< mediation <<<\n');
  writeFileSync(join(kimi, 'mcp.json'), JSON.stringify({
    keep: true,
    mcpServers: {
      mediation: { command: 'node', args: [join(data, 'mediation-mcp.mjs')], env: { MEDIATION_URL: 'https://old.invalid' } },
    },
  }));

  const result = spawnSync('bash', ['clients/uninstall.sh'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, HOME: home, MEDIATION_HOME: data },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8').trim(), '# mine');
  assert.equal(JSON.parse(readFileSync(join(kimi, 'mcp.json'), 'utf8')).keep, true);
  assert.equal(JSON.parse(readFileSync(join(kimi, 'mcp.json'), 'utf8')).mcpServers.mediation, undefined);
  assert.equal(existsSync(join(data, 'mediation-mcp.mjs')), false);
});
