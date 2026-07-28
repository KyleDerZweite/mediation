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

function loadApp() {
  const ctx: any = vm.createContext({
    document: stub(), window: stub(), location: { hash: '' }, navigator: stub(),
    localStorage: stub(), console, fetch: () => new Promise(() => {}),
    EventSource: function () { return stub(); },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
  });
  ctx.globalThis = ctx;
  vm.runInContext(`${src}\n;globalThis.__app = { renderNowTab, renderProject, state };`, ctx);
  return ctx.__app;
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
