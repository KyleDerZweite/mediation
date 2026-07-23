#!/usr/bin/env node
// mediation-agent — CLI client for coding agents.
//
// Usage:
//   mediation-agent connect  --project P --agent NAME [--developer D] [--machine M]
//   mediation-agent heartbeat --session ID [--activity "text"]   (or --watch to loop)
//   mediation-agent repo     --session ID [--branch B] [--revision R] [--dirty a,b,c]
//   mediation-agent check    --project P --files a,b [--task "x"] [--intent "y"]
//   mediation-agent claim    --session ID --intent "..." [--files a,b] [--components x,y] [--task T] [--status S]
//   mediation-agent update   --claim ID [--status S] [--files a,b] [--finding "x"] [--activity "y"]
//   mediation-agent complete --claim ID [--commits c1,c2] [--prs u1,u2] [--summary "x"]
//   mediation-agent bug      --session ID --title "..." [--description d] [--files a,b] [--severity high]
//   mediation-agent state    --project P
//   mediation-agent disconnect --session ID
//
// Global: --server URL (default http://localhost:4100), or MEDIATION_SERVER env.
// Session id may also come from MEDIATION_SESSION env. Project from MEDIATION_PROJECT.

const SERVER = arg('--server') || process.env.MEDIATION_SERVER || 'http://localhost:4100';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}
function list(name) {
  const v = arg(name);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}
function need(name, value) {
  if (!value) {
    console.error(`error: ${name} is required`);
    process.exit(2);
  }
  return value;
}
const project = () => need('--project (or MEDIATION_PROJECT)', arg('--project') || process.env.MEDIATION_PROJECT);
const session = () => need('--session (or MEDIATION_SESSION)', arg('--session') || process.env.MEDIATION_SESSION);

async function call(method, path, body) {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`error ${res.status}: ${data.error || res.statusText}`);
    process.exit(1);
  }
  return data;
}

const out = (d) => console.log(JSON.stringify(d, null, 2));

const commands = {
  async connect() {
    const s = await call('POST', `/api/projects/${encodeURIComponent(project())}/sessions`, {
      agent: need('--agent', arg('--agent')),
      developer: arg('--developer'),
      machine: arg('--machine') || (await import('node:os')).hostname(),
      task: arg('--task'),
    });
    out(s);
    console.error(`\n# save this:\nexport MEDIATION_SESSION=${s.id}`);
  },

  async heartbeat() {
    if (arg('--watch')) {
      const interval = Number(arg('--watch') || 30) * 1000;
      const beat = () =>
        call('POST', `/api/projects/${encodeURIComponent(project())}/sessions/${session()}/heartbeat`, {})
          .then(() => console.error(`♥ ${new Date().toISOString()}`))
          .catch(() => process.exit(1));
      await beat();
      setInterval(beat, interval);
      return;
    }
    out(await call('POST', `/api/projects/${encodeURIComponent(project())}/sessions/${session()}/heartbeat`, {
      activity: arg('--activity'),
      status: arg('--status'),
    }));
  },

  async repo() {
    let dirty = list('--dirty');
    let branch = arg('--branch');
    let revision = arg('--revision');
    // auto-detect from git when not provided
    if (!branch || !revision || !dirty) {
      const { execSync } = await import('node:child_process');
      const git = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return null; } };
      branch ??= git('git rev-parse --abbrev-ref HEAD');
      revision ??= git('git rev-parse HEAD');
      dirty ??= git('git status --porcelain')?.split('\n').filter(Boolean).map((l) => l.slice(3)) ?? [];
    }
    out(await call('POST', `/api/projects/${encodeURIComponent(project())}/sessions/${session()}/repo`, {
      branch, revision, dirtyFiles: dirty,
    }));
  },

  async check() {
    const q = new URLSearchParams();
    if (arg('--session') || process.env.MEDIATION_SESSION) q.set('sessionId', session());
    q.set('files', (list('--files') || []).join(','));
    q.set('components', (list('--components') || []).join(','));
    if (arg('--task')) q.set('task', arg('--task'));
    if (arg('--intent')) q.set('intent', arg('--intent'));
    const r = await call('GET', `/api/projects/${encodeURIComponent(project())}/check?${q}`);
    if (r.conflicts.length) {
      console.error(`⚠ ${r.conflicts.length} overlapping claim(s) found — coordinate before proceeding`);
      out(r);
      process.exit(3); // distinct exit code: overlap detected
    }
    console.error('✓ no overlapping work detected');
    out(r);
  },

  async claim() {
    const r = await call('POST', `/api/projects/${encodeURIComponent(project())}/claims`, {
      sessionId: session(),
      intent: need('--intent', arg('--intent')),
      task: arg('--task'),
      files: list('--files') || [],
      components: list('--components') || [],
      branch: arg('--branch'),
      baseRevision: arg('--revision'),
      status: arg('--status') || 'investigating',
    });
    if (r.conflicts.length) {
      console.error(`⚠ warning: claim overlaps with ${r.conflicts.map((c) => c.agent).join(', ')}`);
    }
    out(r);
  },

  async update() {
    out(await call('PATCH', `/api/projects/${encodeURIComponent(project())}/claims/${need('--claim', arg('--claim'))}`, {
      status: arg('--status'),
      files: list('--files'),
      components: list('--components'),
      finding: arg('--finding'),
      activity: arg('--activity'),
      task: arg('--task'),
    }));
  },

  async complete() {
    out(await call('POST',
      `/api/projects/${encodeURIComponent(project())}/claims/${need('--claim', arg('--claim'))}/complete`, {
        commits: list('--commits') || [],
        prs: list('--prs') || [],
        summary: arg('--summary'),
      }));
  },

  async bug() {
    out(await call('POST', `/api/projects/${encodeURIComponent(project())}/bugs`, {
      sessionId: session(),
      title: need('--title', arg('--title')),
      description: arg('--description'),
      files: list('--files') || [],
      severity: arg('--severity'),
    }));
  },

  async state() {
    out(await call('GET', `/api/projects/${encodeURIComponent(project())}/state`));
  },

  async disconnect() {
    await call('DELETE', `/api/projects/${encodeURIComponent(project())}/sessions/${session()}`);
    console.error('session ended; claims released');
  },
};

const cmd = process.argv[2];
if (!cmd || !commands[cmd]) {
  console.error(`usage: mediation-agent <${Object.keys(commands).join('|')}> [options]`);
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
