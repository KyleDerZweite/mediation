import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* web/app.js is a browser module with no exports and top-level DOM/timer work,
   so it is evaluated as a script in a vm with auto-stubbed globals, then asked
   to hand back the render functions. TRAP: renderNowTab used to read `pid` from
   the caller's scope, which threw on every project with a bug and blanked the
   Now tab on every 3s poll. */

const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

const stub = (): any => new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive || k === 'then' ? undefined : stub()),
  apply: () => stub(),
  set: () => true,
});

function loadApp(storedTheme?: string) {
  const values = new Map<string, string>();
  if (storedTheme !== undefined) values.set('mediation-theme', storedTheme);
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const shell: any = {
    dataset: {},
    removeAttribute: (name: string) => { if (name === 'data-theme') delete shell.dataset.theme; },
  };
  const toggle: any = {
    hidden: true,
    attributes: new Map<string, string>(),
    setAttribute: (name: string, value: string) => toggle.attributes.set(name, value),
  };
  const document = new Proxy({
    querySelector: (selector: string) => selector === '.shell' ? shell : stub(),
    getElementById: (id: string) => id === 'themeToggle' ? toggle : stub(),
  }, { get: (target: any, key) => key in target ? target[key] : stub() });
  const ctx: any = vm.createContext({
    document: stub(), window: stub(), location: { hash: '' }, navigator: stub(),
    localStorage, console, fetch: () => new Promise(() => {}),
    EventSource: function () { return stub(); },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
  });
  ctx.document = document;
  ctx.globalThis = ctx;
  vm.runInContext(`${src}\n;globalThis.__app = { renderNowTab, renderProject, state, applyTheme, toggleTheme };`, ctx);
  return { ...ctx.__app, theme: { shell, toggle, values } };
}

const now = Date.now();
const projectState = {
  sessions: [], agents: [], claims: [], conflicts: [], completed: [], events: [], recentFiles: [],
  bugs: [{
    id: 'bug-abcdef1234',
    title: 'Now tab blanks when a bug exists',
    severity: 'high',
    status: 'open',
    reporter: 'claude-code@Kyle-FF',
    createdAt: now - 60_000,
    issueUrl: null,
  }],
};

test('dark mode is the persisted dashboard-only default', () => {
  const dark = loadApp();
  assert.equal(dark.state.darkMode, true);
  dark.state.me = { id: 'user-1' };
  dark.state.route = { view: 'overview', pid: null, tab: null };
  dark.applyTheme();
  assert.equal(dark.theme.shell.dataset.theme, 'dark');
  assert.equal(dark.theme.toggle.hidden, false);
  assert.equal(dark.theme.toggle.attributes.get('aria-pressed'), 'true');

  dark.toggleTheme();
  assert.equal(dark.theme.shell.dataset.theme, 'light');
  assert.equal(dark.theme.values.get('mediation-theme'), 'light');
  assert.equal(dark.theme.toggle.attributes.get('aria-pressed'), 'false');

  dark.state.route.view = 'design';
  dark.applyTheme();
  assert.equal(dark.theme.shell.dataset.theme, undefined);
  assert.equal(dark.theme.toggle.hidden, true);

  assert.equal(loadApp('light').state.darkMode, false);
  assert.equal(loadApp('unknown').state.darkMode, true);
});

test('renderNowTab renders bug rows with the project id it was passed', () => {
  const { renderNowTab } = loadApp();
  const html = renderNowTab(projectState, now, 'proj-42');
  assert.match(html, /Now tab blanks when a bug exists/);
  assert.match(html, /data-pid="proj-42"/);
  assert.match(html, /data-bug="bug-abcdef1234"/);
  assert.match(html, /data-bugaction="fixed"/);
});

test('a fixed bug offers Reopen and escapes the project id', () => {
  const { renderNowTab } = loadApp();
  const bugs = [{ ...projectState.bugs[0], status: 'fixed' }];
  const html = renderNowTab({ ...projectState, bugs }, now, 'p<&1');
  assert.match(html, /Reopen/);
  assert.match(html, /data-pid="p&lt;&amp;1"/);
});

/* A live session that claimed nothing is the case this whole server exists to
   catch. It used to render as one line of advice; the working tree the beat
   already carries is shown as a rough claim instead. */
test('a live session with no claim renders a rough claim from its working tree', () => {
  const { renderNowTab } = loadApp();
  const sessions = [{
    id: 'sess-1', agent: 'claude-code-8f9d3b53', developer: 'notolofen', machine: 'pc',
    lastSeenAt: now - 12_000,
    repo: { branch: 'feat/ui', revision: null, dirtyFiles: ['web/app.js', 'web/styles.css'], reportedAt: now - 12_000 },
  }];
  const html = renderNowTab({ ...projectState, sessions }, now, 'proj-42');
  assert.match(html, /claim-card rough/);
  assert.match(html, /Editing 2 files without claiming anything/);
  assert.match(html, /web\/styles\.css/);
  assert.match(html, /feat\/ui/);
  assert.ok(!html.includes('No active sessions'));
});

test('a claimed session is not also reported as a rough claim', () => {
  const { renderNowTab } = loadApp();
  const sessions = [{ id: 'sess-1', agent: 'claude-code', developer: null, machine: null, lastSeenAt: now, repo: null }];
  const claims = [{
    id: 'claim-1', sessionId: 'sess-1', agent: 'claude-code', developer: null, intent: 'real work',
    status: 'in-progress', files: [], components: [], findings: [], task: null, branch: null, updatedAt: now,
  }];
  const html = renderNowTab({ ...projectState, sessions, claims }, now, 'proj-42');
  assert.match(html, /real work/);
  assert.ok(!html.includes('claim-card rough'));
});

test('Now groups harness-reported agents into a stable expandable crew tree', () => {
  const { renderNowTab, state } = loadApp();
  const agents = [
    { id: 'node-b', parentId: 'node-root', harness: 'codex', name: 'Tests', role: 'worker', task: 'Run focused tests', state: 'active', provenance: 'harness-reported', sessionId: 'child-b', developer: 'Kyle', startedAt: now + 2, updatedAt: now, endedAt: null },
    { id: 'node-root', parentId: null, harness: 'codex', name: 'Coordinator', role: 'root', task: 'Build crew view', state: 'waiting', provenance: 'harness-reported', sessionId: 'root', developer: 'Kyle', startedAt: now, updatedAt: now, endedAt: null },
    { id: 'node-a', parentId: 'node-root', harness: 'codex', name: 'Dashboard', role: 'worker', task: 'Render lineage', state: 'active', provenance: 'harness-reported', sessionId: 'child-a', developer: 'Kyle', startedAt: now + 1, updatedAt: now, endedAt: null },
  ];
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');

  assert.match(html, /<details class="crew-branch" data-crew-node="proj-42:node-root" open>/);
  assert.match(html, /Coordinator/);
  assert.match(html, /Build crew view/);
  assert.match(html, /Harness-reported/);
  assert.ok(html.indexOf('Coordinator') < html.indexOf('Dashboard'));
  assert.ok(html.indexOf('Dashboard') < html.indexOf('Tests'), 'children have stable creation order');
  assert.ok(!html.includes('Lineage unavailable'));

  state.crewClosed.add('proj-42:node-root');
  const collapsed = renderNowTab({ ...projectState, agents }, now, 'proj-42');
  assert.match(collapsed, /data-crew-node="proj-42:node-root">/);
  assert.ok(!collapsed.includes('data-crew-node="proj-42:node-root" open'));
});

test('Crew forgets ordering and disclosure state after executions leave the preview', () => {
  const { renderNowTab, state } = loadApp();
  const oldAgents = [
    { id: 'old-root', parentId: null, harness: 'codex', state: 'active', startedAt: now, updatedAt: now },
    { id: 'old-child', parentId: 'old-root', harness: 'codex', state: 'active', startedAt: now + 1, updatedAt: now },
  ];
  renderNowTab({ ...projectState, agents: oldAgents }, now, 'proj-42');
  state.crewClosed.add('proj-42:old-root');
  assert.equal(state.crewOrder.has('proj-42:old-root'), true);

  renderNowTab({ ...projectState, agents: [
    { id: 'new-root', parentId: null, harness: 'codex', state: 'active', startedAt: now + 2, updatedAt: now + 2 },
  ] }, now + 2, 'proj-42');
  assert.equal(state.crewOrder.has('proj-42:old-root'), false);
  assert.equal(state.crewOrder.has('proj-42:old-child'), false);
  assert.equal(state.crewClosed.has('proj-42:old-root'), false);
});

test('Crew summarizes blocked, stale, and unattached sessions', () => {
  const { renderNowTab } = loadApp();
  const agents = [
    { id: 'root', parentId: null, harness: 'codex', name: 'Root', state: 'running', sessionId: 'root-session', startedAt: now, updatedAt: now, endedAt: null },
    { id: 'blocked', parentId: 'root', harness: 'codex', name: 'Blocked child', state: 'blocked', stateReason: 'Waiting for API', sessionId: 'blocked-session', startedAt: now + 1, updatedAt: now, endedAt: null },
    { id: 'orphan', parentId: null, parentUnavailable: true, harness: 'codex', name: 'Orphan', state: 'running', sessionId: 'orphan-session', startedAt: now + 2, updatedAt: now - 121_000, endedAt: null, stale: true },
  ];
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');

  assert.match(html, /<b>1<\/b> blocked/);
  assert.match(html, /<b>1<\/b> stale/);
  assert.match(html, /Working · stale/);
  assert.match(html, /last reported 2m ago/);
  assert.match(html, /<b>1<\/b> unattached/);
  assert.match(html, /Unattached agents/);
  assert.match(html, /Waiting for API/);
});

test('Crew keeps descendants visible below a privacy-safe unavailable parent', () => {
  const { renderNowTab } = loadApp();
  const agents = [
    { id: 'orphan-root', parentId: null, parentUnavailable: true, harness: 'codex', name: 'Unattached root',
      state: 'active', startedAt: now, updatedAt: now, endedAt: null },
    { id: 'known-child', parentId: 'orphan-root', parentUnavailable: false, harness: 'codex', name: 'Known child',
      state: 'active', startedAt: now + 1, updatedAt: now, endedAt: null },
  ];
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');

  assert.match(html, /<b>2<\/b> unattached/);
  assert.match(html, /Unattached root/);
  assert.match(html, /Known child/);
  assert.match(html, /data-crew-node="proj-42:orphan-root"/);
});

test('Crew maps lifecycle states to truthful human labels', () => {
  const { renderNowTab } = loadApp();
  const agents = ['starting', 'active', 'waiting', 'needs-input', 'completed', 'failed', 'cancelled', 'mystery']
    .map((state, i) => ({ id: `state-${i}`, parentId: null, harness: 'codex', name: state,
      state, startedAt: now + i, updatedAt: now, endedAt: ['completed', 'failed', 'cancelled'].includes(state) ? now : null }));
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');

  for (const label of ['Working', 'Waiting', 'Needs input', 'Done', 'Failed', 'Stopped', 'Unknown']) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.ok(!html.includes('>Active<'));
});

test('Crew preserves actionable lifecycle state when freshness is stale', () => {
  const { renderNowTab } = loadApp();
  const agents = [{ id: 'stale-blocked', parentId: null, harness: 'codex', name: 'Blocked worker',
    state: 'blocked', stateReason: 'Waiting for review', stale: true,
    startedAt: now - 300_000, updatedAt: now - 180_000, endedAt: null }];
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');

  assert.match(html, /<b>1<\/b> blocked/);
  assert.match(html, /<b>1<\/b> stale/);
  assert.match(html, /Blocked · stale/);
  assert.match(html, /crew-reason attention[^>]*>Waiting for review/);
});

test('Crew pairs observed activity with its own freshness and flags needs input', () => {
  const { renderNowTab } = loadApp();
  const agents = [
    { id: 'awaiting', parentId: null, harness: 'claude-code', name: 'Root agent', state: 'needs-input',
      stateReason: 'waiting for approval', startedAt: now - 60_000, updatedAt: now - 8_000, endedAt: null },
    { id: 'busy', parentId: null, harness: 'claude-code', name: 'Busy agent', state: 'active',
      stateReason: 'running a command', startedAt: now - 60_000, updatedAt: now - 2_000, endedAt: null },
  ];
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');

  assert.match(html, /crew-reason attention needs-input">waiting for approval · 8s ago</);
  assert.match(html, /crew-state attention needs-input">Needs input</);
  assert.match(html, /crew-reason">running a command · 2s ago</);
});

test('Crew renders a very deep valid lineage without recursion overflow', () => {
  const { renderNowTab } = loadApp();
  const agents = Array.from({ length: 1200 }, (_, i) => ({
    id: `deep-${i}`, parentId: i ? `deep-${i - 1}` : null, harness: 'codex', name: `Agent ${i}`,
    state: 'active', startedAt: now + i, updatedAt: now, endedAt: null,
  }));
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');
  assert.match(html, /Agent 0/);
  assert.match(html, /Agent 1199/);
  assert.equal((html.match(/data-crew-node=/g) || []).length, 1199);
});

test('Crew truthfully falls back when the harness reports no lineage', () => {
  const { renderNowTab } = loadApp();
  const sessions = [{ id: 'legacy', agent: 'claude-code', developer: 'Kyle', machine: 'pc', createdAt: now, lastSeenAt: now, repo: null }];
  const html = renderNowTab({ ...projectState, sessions }, now, 'proj-42');

  assert.match(html, /Lineage unavailable/);
  assert.match(html, /did not report logical agent metadata/);
  assert.ok(!html.includes('crew-panel'));
  assert.match(html, /Active sessions/);
  assert.match(html, /claude-code/);
});

test('Crew falls back to privacy-safe session lineage markers', () => {
  const { renderNowTab } = loadApp();
  const sessions = [
    { id: 'root-session', agentLineage: true, agent: 'codex', agentName: 'Root', developer: null, machine: null, createdAt: now, lastSeenAt: now, repo: null },
    { id: 'child-session', agentLineage: true, agent: 'codex', agentName: 'Child', developer: null, machine: null, createdAt: now + 1, lastSeenAt: now, repo: null },
  ];
  const html = renderNowTab({ ...projectState, sessions }, now, 'proj-42');

  assert.match(html, /crew-panel/);
  assert.ok(!html.includes('crew-branch'), 'a boolean fallback never invents a parent relationship');
});

test('Crew contains malformed parent cycles without losing agents', () => {
  const { renderNowTab } = loadApp();
  const agents = [
    { id: 'cycle-a', parentId: 'cycle-b', harness: 'codex', name: 'Cycle A', state: 'running', startedAt: now, updatedAt: now },
    { id: 'cycle-b', parentId: 'cycle-a', harness: 'codex', name: 'Cycle B', state: 'running', startedAt: now + 1, updatedAt: now },
  ];
  const html = renderNowTab({ ...projectState, agents }, now, 'proj-42');

  assert.match(html, /<b>2<\/b> unattached/);
  assert.equal((html.match(/Cycle A/g) || []).length, 1);
  assert.equal((html.match(/Cycle B/g) || []).length, 1);
});

test('Crew discloses a bounded server preview and unknown freshness', () => {
  const { renderNowTab } = loadApp();
  const agents = [{ id: 'only', parentId: null, harness: 'codex', name: 'Only returned',
    state: 'active', startedAt: now, updatedAt: null }];
  const html = renderNowTab({ ...projectState, agents, agentCount: 7 }, now, 'proj-42');
  assert.match(html, /6 additional executions outside this preview/);
  assert.match(html, /Freshness unknown/);
  assert.match(html, /<ul class="crew-tree"/);
  assert.match(html, /class="crew-scroll"[^>]*tabindex="0"/);
});

test('Crew distinguishes a parent outside the preview from unavailable lineage', () => {
  const { renderNowTab } = loadApp();
  const agents = [{ id: 'continued-child', parentId: null, parentOutsidePreview: true,
    parentUnavailable: false, harness: 'codex', name: 'Visible descendant',
    state: 'active', startedAt: now, updatedAt: now, endedAt: null }];
  const html = renderNowTab({ ...projectState, agents, agentCount: 2 }, now, 'proj-42');

  assert.match(html, /Lineage continues outside preview/);
  assert.match(html, /Visible descendant/);
  assert.match(html, /<b>0<\/b> unattached/);
  assert.ok(!html.includes('Unattached agents'));
});

/* Twenty finished claims with paragraph-long summaries pushed the live half of
   the page off the screen. */
test('completed work shows a preview and expands on demand', () => {
  const { renderNowTab, state } = loadApp();
  const completed = Array.from({ length: 20 }, (_, i) => ({
    id: `done-${i}`, intent: `finished job ${i}`, summary: 'x'.repeat(400),
    agent: 'claude-code', developer: null, commits: [], prs: [], completedAt: now - i * 1000, updatedAt: now,
  }));

  const collapsed = renderNowTab({ ...projectState, completed }, now, 'proj-42');
  assert.match(collapsed, /Show 16 older/);
  assert.match(collapsed, /finished job 3/);
  assert.ok(!collapsed.includes('finished job 4'), 'rows past the preview stay collapsed');

  state.allCompleted = true;
  const expanded = renderNowTab({ ...projectState, completed }, now, 'proj-42');
  assert.match(expanded, /finished job 19/);
  assert.match(expanded, /Show less/);
});

test('a throwing tab body degrades to an error card instead of blanking the view', () => {
  const { renderProject, state } = loadApp();
  state.route = { pid: 'proj-42', tab: 'now' };
  // completed is only read inside renderNowTab, i.e. inside the guarded build
  state.states = new Map([['proj-42', {
    ...projectState,
    get completed(): never { throw new Error('boom'); },
  }]]);
  state.stateErrors = new Map();
  state.projects = [];

  const html = renderProject();
  assert.match(html, /Could not render this tab/);
  assert.match(html, /boom/);
  assert.match(html, /class="tabs"/);
});
