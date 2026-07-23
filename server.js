// Mediation coordination server — zero-dependency HTTP API + dashboard.
//
// MVP: open endpoints keyed by a shared project identifier. No auth.
// See README.md for the API surface and AGENT.md for agent instructions.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, DEFAULT_SESSION_TTL_MS } from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT || 4100);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS);

const store = new Store({ dataDir: DATA_DIR, sessionTtlMs: SESSION_TTL_MS });
setInterval(() => store.sweep(), Math.min(SESSION_TTL_MS / 2, 30_000)).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body, null, 2) : body;
  res.writeHead(status, {
    'content-type': isObj ? 'application/json; charset=utf-8' : headers['content-type'] || 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  });
}

// Route table: [method, regex, handler(params, body, query)]
const routes = [
  // sessions
  ['POST', /^\/api\/projects\/([^/]+)\/sessions$/, (p, b) => store.startSession(p.project, b)],
  ['POST', /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/heartbeat$/, (p, b) =>
    store.heartbeat(p.project, p.sessionId, b)],
  ['DELETE', /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)$/, (p) => store.endSession(p.project, p.sessionId)],
  ['POST', /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/repo$/, (p, b) =>
    store.reportRepoState(p.project, p.sessionId, b)],

  // claims
  ['POST', /^\/api\/projects\/([^/]+)\/claims$/, (p, b) => {
    const { sessionId, ...rest } = b;
    return store.createClaim(p.project, sessionId, rest);
  }],
  ['PATCH', /^\/api\/projects\/([^/]+)\/claims\/([^/]+)$/, (p, b) => store.updateClaim(p.project, p.claimId, b)],
  ['POST', /^\/api\/projects\/([^/]+)\/claims\/([^/]+)\/complete$/, (p, b) =>
    store.completeClaim(p.project, p.claimId, b)],

  // bugs
  ['POST', /^\/api\/projects\/([^/]+)\/bugs$/, (p, b) => {
    const { sessionId, ...rest } = b;
    return store.reportBug(p.project, sessionId, rest);
  }],
  ['PATCH', /^\/api\/projects\/([^/]+)\/bugs\/([^/]+)$/, (p, b) => store.updateBug(p.project, p.bugId, b)],

  // queries
  ['GET', /^\/api\/projects\/([^/]+)\/state$/, (p) => store.getState(p.project)],
  ['GET', /^\/api\/projects\/([^/]+)\/check$/, (p, _b, q) =>
    ({
      conflicts: store.checkOverlap(p.project, {
        sessionId: q.get('sessionId'),
        files: (q.get('files') || '').split(',').filter(Boolean),
        components: (q.get('components') || '').split(',').filter(Boolean),
        task: q.get('task'),
        intent: q.get('intent'),
      }),
    })],
  ['GET', /^\/api\/health$/, () => ({ ok: true, now: Date.now() })],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // static
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (req.method === 'GET' && pathname === '/AGENT.md') {
    return serveStatic(res, path.join(__dirname, 'AGENT.md'));
  }
  if (req.method === 'GET' && pathname.startsWith('/public/')) {
    const safe = path.normalize(pathname.slice('/public/'.length)).replace(/^(\.\.[/\\])+/, '');
    return serveStatic(res, path.join(PUBLIC_DIR, safe));
  }

  // API
  for (const [method, regex, handler] of routes) {
    if (method !== req.method) continue;
    const m = pathname.match(regex);
    if (!m) continue;
    const names = [];
    if (regex.source.includes('projects')) names.push('project');
    if (regex.source.includes('sessions\\/')) names.push('sessionId');
    if (regex.source.includes('claims\\/')) names.push('claimId');
    if (regex.source.includes('bugs\\/')) names.push('bugId');
    const params = {};
    m.slice(1).forEach((v, i) => (params[names[i]] = decodeURIComponent(v)));
    try {
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, handler(params, body, url.searchParams));
    } catch (err) {
      return send(res, err.statusCode || 500, { error: err.message });
    }
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`mediation server listening on http://${HOST}:${PORT}`);
  console.log(`dashboard: http://localhost:${PORT}/  (default project via ?project=<id>)`);
  console.log(`agent instructions: http://localhost:${PORT}/AGENT.md`);
});
