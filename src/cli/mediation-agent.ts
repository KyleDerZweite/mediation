#!/usr/bin/env node
// mediation-agent: CLI client for coding agents. Global fetch, no deps.
// Imports core only for types (see AGENTS.md boundaries).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  --token TOKEN    MEDIATION_TOKEN    (global device Bearer; required)
  --project P      MEDIATION_PROJECT  (legacy manual-mode compatibility only)
  --session ID     MEDIATION_SESSION
  --capability C   MEDIATION_SESSION_CAPABILITY (required for session mutations)

Projects are private. In AUTH_MODE=github-app, use repository initialization
and the server-returned binding; never accept a model-provided project id.
AUTH_MODE=manual retains explicit membership and this legacy path argument.

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
const CAPABILITY = arg('--capability') || process.env.MEDIATION_SESSION_CAPABILITY || '';

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

// Deliberate duplicate of push-remote resolution in
// clients/mediation-mcp.mjs, because that client ships to user machines as a single
// standalone file and cannot import from here. Keep the two in sync.
function parseGitHubRemote(raw: string): { owner: string; repo: string } | null {
  const value = raw.trim();
  let owner: string;
  let repo: string;
  const scp = /^(?:[^@]+@)?github\.com:([^/]+)\/(.+)$/i.exec(value);
  if (scp) {
    [, owner, repo] = scp;
  } else {
    try {
      const u = new URL(value);
      if (u.hostname.toLowerCase() !== 'github.com') return null;
      const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length !== 2) return null;
      [owner, repo] = parts;
    } catch {
      return null;
    }
  }
  repo = repo.replace(/\.git$/i, '');
  return /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repo) ? { owner, repo } : null;
}

function projectSlug(owner: string, repo: string): string {
  const raw = `gh-${owner.toLowerCase()}--${repo.toLowerCase()}`;
  if (raw.length <= 64) return raw;
  const hash = createHash('sha256').update(`${owner}/${repo}`.toLowerCase()).digest('hex').slice(0, 10);
  return `${raw.slice(0, 53).replace(/[._-]+$/g, '')}-${hash}`;
}

function derivedProject(): { id?: string; source?: string; error?: string } {
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const remote = (branch && git('config', '--get', `branch.${branch}.pushRemote`))
    || git('config', '--get', 'remote.pushDefault')
    || (branch && git('config', '--get', `branch.${branch}.remote`))
    || 'origin';
  if (remote === '.') return { error: 'the Git push remote is local, not GitHub' };
  const values = git('config', '--get-all', `remote.${remote}.pushurl`)
    || git('config', '--get-all', `remote.${remote}.url`) || '';
  const urls = [...new Set(values.split('\n').map((x) => x.trim()).filter(Boolean))];
  if (!urls.length) return { error: `Git remote "${remote}" has no push URL` };
  if (urls.length > 1) return { error: `Git remote "${remote}" has multiple distinct push URLs` };
  const repository = parseGitHubRemote(urls[0]);
  if (!repository) return { error: `Git push remote "${remote}" is not a supported github.com repository` };
  return {
    id: projectSlug(repository.owner, repository.repo),
    source: `Git push remote ${remote}: github.com/${repository.owner}/${repository.repo}`,
  };
}

// Legacy manual-mode compatibility: --project → MEDIATION_PROJECT → a derived
// path id. GitHub App mode must use repository initialization/server binding,
// not expose this helper to a model-facing workflow.
const project = (): string => {
  const explicit = arg('--project') || process.env.MEDIATION_PROJECT;
  if (explicit) return encodeURIComponent(explicit);
  const derived = derivedProject();
  if (derived.id) {
    console.error(`# legacy manual project: ${derived.id} (${derived.source})`);
    return encodeURIComponent(derived.id);
  }
  console.error(`error: ${derived.error}`);
  return encodeURIComponent(need('--project (or MEDIATION_PROJECT, or a GitHub push remote)', null));
};

const session = (): string =>
  encodeURIComponent(need('--session (or MEDIATION_SESSION)', arg('--session') || process.env.MEDIATION_SESSION));

// ---- HTTP ----

// One-shot commands exit on failure. `fatal: false` throws instead, for the
// heartbeat watch, where a single failed request must not end the loop.
async function call<T = any>(method: string, path: string, body?: unknown, { fatal = true } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        // Project routes require the global device identity. Session-scoped
        // mutations additionally require the capability returned by connect.
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(CAPABILITY ? { 'x-mediation-session': CAPABILITY } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const message = `cannot reach ${SERVER}. Is the mediation server running?`;
    if (!fatal) throw new Error(message);
    console.error(`error: ${message}`);
    process.exit(1);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.issues ? ` ${JSON.stringify(data.issues)}` : '';
    if (!fatal) throw new Error(`${res.status}: ${data.error || res.statusText}${detail}`);
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
    const s = await call<{ id: string; capability: string }>('POST', `/api/projects/${project()}/sessions`, body);
    out(s);
    console.error(`\n# save these for this process only:\nexport MEDIATION_SESSION=${s.id}\nexport MEDIATION_SESSION_CAPABILITY=${s.capability}`);
  },

  async heartbeat() {
    const path = `/api/projects/${project()}/sessions/${session()}/heartbeat`;
    const body: Heartbeat = { activity: arg('--activity') };
    const watch = arg('--watch');
    if (watch !== null) {
      const interval = Math.max(1, Number(watch) || 30) * 1000;
      const stamp = (): void => console.error(`heartbeat ${new Date().toISOString()}`);
      // The first beat is fatal: it proves the session and capability work.
      await call('POST', path, body);
      stamp();
      // Later ones are not. Ending the watch on a dropped request expires the
      // session and releases its claims while the agent is still working.
      setInterval(() => {
        call('POST', path, body, { fatal: false }).then(stamp)
          .catch((error: Error) => console.error(`heartbeat failed: ${error.message}`));
      }, interval);
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
        `warning: ${r.conflicts.length} overlapping claim(s) found. Coordinate before proceeding ` +
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
