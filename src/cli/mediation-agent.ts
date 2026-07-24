#!/usr/bin/env node
// mediation-agent — CLI client for coding agents. Global fetch, no deps.
// Imports core only for types (see AGENTS.md boundaries).

import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import type {
  SessionCreate,
  Heartbeat,
  RepoReport,
  ClaimCreate,
  ClaimPatch,
  ClaimComplete,
  BugCreate,
} from '../core/schemas.ts';

const USAGE = `usage: mediation-agent <command> [options]

commands:
  connect     [--project P] --agent NAME [--developer D] [--machine M]
  heartbeat   --project P --session ID [--activity "text"] [--watch N]   (N = seconds, loop)
  repo        --project P --session ID [--branch B] [--revision R] [--dirty a,b]
              (branch/revision/dirty auto-detected from git when omitted)
  check       --project P [--session ID] [--files a,b] [--components x,y] [--task T] [--intent "..."]
              (exit code 3 when overlapping work is detected)
  claim       --project P --session ID --intent "..." [--task T] [--files a,b]
              [--components x,y] [--branch B] [--revision R] [--status S]
  update      --project P --claim ID [--status S] [--intent "..."] [--task T]
              [--files a,b] [--components x,y] [--branch B] [--revision R] [--finding "..."]
  complete    --project P --claim ID [--commits c1,c2] [--prs u1,u2] [--summary "..."]
  bug         --project P --session ID --title "..." [--description "..."] [--files a,b] [--severity S]
  state       --project P
  projects    (list all projects)
  disconnect  --project P --session ID

global flags / env:
  --server URL     MEDIATION_SERVER   (default http://localhost:4100)
  --token TOKEN    MEDIATION_TOKEN    (paired agent bearer credential; required)
  --project P      MEDIATION_PROJECT  (default: the git remote's repo name)
  --session ID     MEDIATION_SESSION

Projects are private: you must be a member (403 otherwise) — an owner adds you
in the dashboard. An unknown project id is created by the first session you
start on it, and you become its owner.

claim status values: investigating | in-progress | testing | blocked
bug severity values: low | medium | high | critical | unknown`;

// ---- arg helpers ----

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v !== undefined && !v.startsWith('--') ? v : i !== -1 ? '' : null;
}

function list(name: string): string[] | undefined {
  const v = arg(name);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

function need(name: string, value: string | null | undefined): string {
  if (!value) {
    console.error(`error: ${name} is required`);
    process.exit(2);
  }
  return value;
}

const SERVER = arg('--server') || process.env.MEDIATION_SERVER || 'http://localhost:4100';
const TOKEN = arg('--token') || process.env.MEDIATION_TOKEN || '';

// ---- git helpers ----

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

// Deliberate duplicate of parseRemoteSlug/derivedProject in
// clients/mediation-mcp.mjs — that client ships to user machines as a single
// standalone file and cannot import from here. Keep the two in sync.
function parseRemoteSlug(url: string): string | null {
  const last = String(url || '').trim().replace(/\/+$/, '').split(/[/:]/).pop() || '';
  const slug = last.replace(/\.git$/i, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug) ? slug : null;
}

function derivedProject(): { id: string; source: string } | null {
  const origin = git('config', '--get', 'remote.origin.url');
  const fromOrigin = origin ? parseRemoteSlug(origin) : null;
  if (fromOrigin) return { id: fromOrigin, source: `git remote origin: ${origin}` };
  for (const line of (git('remote', '-v') || '').split('\n')) {
    const url = line.split(/\s+/)[1];
    const id = url ? parseRemoteSlug(url) : null;
    if (id) return { id, source: `git remote: ${url}` };
  }
  return null;
}

// --project → MEDIATION_PROJECT → the git remote's repo name (never the
// directory name). The chosen id is echoed so a wrong guess is obvious.
const project = (): string => {
  const explicit = arg('--project') || process.env.MEDIATION_PROJECT;
  if (explicit) return encodeURIComponent(explicit);
  const derived = derivedProject();
  if (derived) {
    console.error(`# project: ${derived.id} (${derived.source})`);
    return encodeURIComponent(derived.id);
  }
  return encodeURIComponent(need('--project (or MEDIATION_PROJECT, or a git remote)', null));
};

const session = (): string =>
  encodeURIComponent(need('--session (or MEDIATION_SESSION)', arg('--session') || process.env.MEDIATION_SESSION));

// ---- HTTP ----

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        // Project routes require an identity; pair once and export the token.
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error(`error: cannot reach ${SERVER} — is the mediation server running?`);
    process.exit(1);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.issues ? ` ${JSON.stringify(data.issues)}` : '';
    console.error(`error ${res.status}: ${data.error || res.statusText}${detail}`);
    if (data.hint) console.error(`hint: ${data.hint}`); // membership/spelling guidance from the server
    process.exit(1);
  }
  return data as T;
}

const out = (d: unknown): void => console.log(JSON.stringify(d, null, 2));

// ---- commands ----

const commands: Record<string, () => Promise<void>> = {
  async connect() {
    const body: SessionCreate = {
      agent: need('--agent', arg('--agent')),
      developer: arg('--developer'),
      machine: arg('--machine') || hostname(),
    };
    const s = await call<{ id: string }>('POST', `/api/projects/${project()}/sessions`, body);
    out(s);
    console.error(`\n# save this:\nexport MEDIATION_SESSION=${s.id}`);
  },

  async heartbeat() {
    const path = `/api/projects/${project()}/sessions/${session()}/heartbeat`;
    const body: Heartbeat = { activity: arg('--activity') };
    const watch = arg('--watch');
    if (watch !== null) {
      const interval = Math.max(1, Number(watch) || 30) * 1000;
      const beat = (): Promise<void> =>
        call('POST', path, body).then(() => {
          console.error(`heartbeat ${new Date().toISOString()}`);
        });
      await beat();
      setInterval(beat, interval);
      return;
    }
    out(await call('POST', path, body));
  },

  async repo() {
    const branch = arg('--branch') ?? git('rev-parse', '--abbrev-ref', 'HEAD');
    const revision = arg('--revision') ?? git('rev-parse', 'HEAD');
    const dirtyFiles =
      list('--dirty') ??
      git('status', '--porcelain')?.split('\n').filter(Boolean).map((l) => l.slice(3)) ??
      [];
    const body: RepoReport = { branch, revision, dirtyFiles };
    out(await call('POST', `/api/projects/${project()}/sessions/${session()}/repo`, body));
  },

  async check() {
    const q = new URLSearchParams();
    const sid = arg('--session') || process.env.MEDIATION_SESSION;
    if (sid) q.set('sessionId', sid);
    q.set('files', (list('--files') ?? []).join(','));
    q.set('components', (list('--components') ?? []).join(','));
    const task = arg('--task');
    if (task) q.set('task', task);
    const intent = arg('--intent');
    if (intent) q.set('intent', intent);
    const r = await call<{ conflicts: { agent: string }[] }>('GET', `/api/projects/${project()}/check?${q}`);
    if (r.conflicts.length) {
      console.error(
        `warning: ${r.conflicts.length} overlapping claim(s) found — coordinate before proceeding ` +
          `(agents: ${[...new Set(r.conflicts.map((c) => c.agent))].join(', ')})`,
      );
      out(r);
      process.exit(3); // distinct exit code: overlap detected
    }
    console.error('ok: no overlapping work detected');
    out(r);
  },

  async claim() {
    const body: ClaimCreate = {
      sessionId: need('--session (or MEDIATION_SESSION)', arg('--session') || process.env.MEDIATION_SESSION),
      intent: need('--intent', arg('--intent')),
      task: arg('--task'),
      files: list('--files') ?? [],
      components: list('--components') ?? [],
      branch: arg('--branch'),
      baseRevision: arg('--revision'),
      status: (arg('--status') as ClaimCreate['status']) || 'investigating',
    };
    const r = await call<{ conflicts: { agent: string }[] }>('POST', `/api/projects/${project()}/claims`, body);
    if (r.conflicts.length) {
      console.error(
        `warning: claim overlaps with ${[...new Set(r.conflicts.map((c) => c.agent))].join(', ')}`,
      );
    }
    out(r);
  },

  async update() {
    const id = encodeURIComponent(need('--claim', arg('--claim')));
    const body: ClaimPatch = {
      intent: arg('--intent'),
      task: arg('--task'),
      files: list('--files'),
      components: list('--components'),
      branch: arg('--branch'),
      baseRevision: arg('--revision'),
      status: (arg('--status') as ClaimPatch['status']) ?? undefined,
      finding: arg('--finding'),
    };
    out(await call('PATCH', `/api/projects/${project()}/claims/${id}`, body));
  },

  async complete() {
    const id = encodeURIComponent(need('--claim', arg('--claim')));
    const body: ClaimComplete = {
      commits: list('--commits') ?? [],
      prs: list('--prs') ?? [],
      summary: arg('--summary'),
    };
    out(await call('POST', `/api/projects/${project()}/claims/${id}/complete`, body));
  },

  async bug() {
    const body: BugCreate = {
      sessionId: need('--session (or MEDIATION_SESSION)', arg('--session') || process.env.MEDIATION_SESSION),
      title: need('--title', arg('--title')),
      description: arg('--description'),
      files: list('--files') ?? [],
      severity: (arg('--severity') as BugCreate['severity']) || 'unknown',
    };
    out(await call('POST', `/api/projects/${project()}/bugs`, body));
  },

  async state() {
    out(await call('GET', `/api/projects/${project()}/state`));
  },

  async projects() {
    out(await call('GET', '/api/projects'));
  },

  async disconnect() {
    await call('DELETE', `/api/projects/${project()}/sessions/${session()}`);
    console.error('session ended; claims released');
  },
};

// ---- entry ----

const cmd = process.argv[2];
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.error(USAGE);
  process.exit(2);
}
if (!Object.hasOwn(commands, cmd)) {
  console.error(`error: unknown command '${cmd}'\n\n${USAGE}`);
  process.exit(2);
}
commands[cmd]().catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
