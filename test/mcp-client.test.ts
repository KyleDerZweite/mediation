// Drives clients/mediation-mcp.mjs the way a harness does — over stdio, with a
// stub Mediation server. The other suites test the server; nothing tested the
// client's own tool calls, which is how an unawaited session-creation promise
// shipped and broke every coordination tool in both auth modes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT_ID = '0f9a2f5c-1111-2222-3333-444455556666';
const CLIENT = 'clients/mediation-mcp.mjs';

let server: Server;
let origin = '';
let repo = '';
let authHome = '';
const seen: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url?.split('?')[0]}`);
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/health') return send({ ok: true, authMode: 'github-app' });
    if (req.url === '/api/repositories/github/session') {
      return send({ project: { id: PROJECT_ID }, session: { id: 'sess-1' }, capability: 'cap-1' });
    }
    if (req.url?.startsWith(`/api/projects/${PROJECT_ID}/check`)) return send({ conflicts: [] });
    if (req.url?.startsWith(`/api/projects/${PROJECT_ID}/sessions/`)) return send({ ok: true });
    return send({ error: 'not found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  repo = mkdtempSync(join(tmpdir(), 'mediation-mcp-repo-'));
  authHome = mkdtempSync(join(tmpdir(), 'mediation-mcp-auth-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  writeFileSync(join(repo, '.mediation.json'), JSON.stringify({
    server: origin, repository: { owner: 'acme', repository: 'widgets' },
  }));
  mkdirSync(authHome, { recursive: true });
  writeFileSync(join(authHome, 'credentials.json'),
    JSON.stringify({ [origin]: { token: 'device-token', username: 'gh-acme' } }));
});

after(() => {
  server.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(authHome, { recursive: true, force: true });
});

// Minimal MCP client: initialize, then one tools/call, then read the reply.
function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLIENT], {
      env: { ...process.env, MEDIATION_URL: origin, MEDIATION_DIR: repo, MEDIATION_AUTH_HOME: authHome },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, 15_000);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })}\n`);
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result?.content?.map((c: { text: string }) => c.text).join('\n') ?? `ERROR ${JSON.stringify(msg.error)}`);
        }
      }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
  });
}

test('mediation_check binds a GitHub session and reports no overlap', async () => {
  const out = await callTool('mediation_check', { files: ['src/app.ts'], intent: 'test' });
  assert.equal(out, 'No overlapping work detected — clear to proceed.');
  assert.ok(seen.includes('POST /api/repositories/github/session'), seen.join(', '));
  assert.ok(seen.includes(`GET /api/projects/${PROJECT_ID}/check`), seen.join(', '));
});

test('mediation_status reports the resolved repository and sign-in state', async () => {
  const out = await callTool('mediation_status');
  assert.match(out, /github\.com\/acme\/widgets/);
});
