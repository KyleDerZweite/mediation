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
  sessions: [], claims: [], conflicts: [], completed: [], events: [], recentFiles: [],
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
