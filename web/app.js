// Mediation dashboard — vanilla ES module, no build step.
// Talks only to the HTTP API (/api/*). Renders via innerHTML string builders.

/* ---------------- utilities ---------------- */

const esc = (v) => String(v ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function initials(name) {
  const words = String(name || '?').trim().split(/[\s\-_./]+/).filter(Boolean);
  if (!words.length) return '?';
  const chars = words.length >= 2 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return chars.toUpperCase();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------------- DOM morphing ----------------
   Patch a container toward new HTML instead of replacing it wholesale.
   Unchanged nodes are left alone, so CSS animations don't restart, scroll
   positions survive, and the page doesn't flicker on the 3s poll. */

function syncNode(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    from.replaceWith(to.cloneNode(true));
    return;
  }
  if (from.nodeType === Node.TEXT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  if (from.nodeType !== Node.ELEMENT_NODE) return;
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  for (const { name, value } of [...to.attributes]) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  syncChildren(from, to);
}

function syncChildren(from, to) {
  while (from.childNodes.length > to.childNodes.length) from.removeChild(from.lastChild);
  for (let i = 0; i < to.childNodes.length; i++) {
    if (i < from.childNodes.length) syncNode(from.childNodes[i], to.childNodes[i]);
    else from.appendChild(to.childNodes[i].cloneNode(true));
  }
}

function morph(el, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  syncChildren(el, tpl.content);
}

/* ---------------- icons (ported from design reference) ---------------- */

const ICON_DEFS = {
  grid: [['rect', 3, 3, 7, 7, 1.5], ['rect', 14, 3, 7, 7, 1.5], ['rect', 3, 14, 7, 7, 1.5], ['rect', 14, 14, 7, 7, 1.5]],
  activity: [['polyline', '2 12 6 12 9 3 15 21 18 12 22 12']],
  key: [['circle', 8, 15, 5], ['path', 'M11.5 11.5 21 2'], ['path', 'M17 6l3 3']],
  sliders: [['line', 4, 21, 4, 14], ['line', 4, 10, 4, 3], ['line', 12, 21, 12, 12], ['line', 12, 8, 12, 3], ['line', 20, 21, 20, 16], ['line', 20, 12, 20, 3], ['line', 2, 14, 7, 14], ['line', 9, 8, 15, 8], ['line', 17, 16, 22, 16]],
  repo: [['line', 6, 3, 6, 15], ['circle', 18, 6, 3], ['circle', 6, 18, 3], ['path', 'M18 9a9 9 0 0 1-9 9']],
  bot: [['rect', 4, 8, 16, 12, 3], ['circle', 9, 14, 0.9], ['circle', 15, 14, 0.9], ['path', 'M12 8V5'], ['circle', 12, 4, 1]],
  file: [['path', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'], ['path', 'M14 3v5h5']],
  bug: [['rect', 8, 7, 8, 13, 4], ['path', 'M12 7V4'], ['line', 3, 11, 7, 11], ['line', 17, 11, 21, 11], ['line', 3, 17, 7, 16], ['line', 17, 16, 21, 17], ['line', 3, 14, 7, 14], ['line', 17, 14, 21, 14]],
  commit: [['circle', 12, 12, 3], ['line', 3, 12, 9, 12], ['line', 15, 12, 21, 12]],
  pr: [['circle', 6, 6, 2.4], ['circle', 6, 18, 2.4], ['line', 6, 8.4, 6, 15.6], ['circle', 18, 18, 2.4], ['path', 'M18 15.6V11a4 4 0 0 0-4-4h-3'], ['polyline', '11 4 8 7 11 10']],
  clock: [['circle', 12, 12, 9], ['polyline', '12 7 12 12 15 14']],
  chevron: [['polyline', '9 6 15 12 9 18']],
  search: [['circle', 11, 11, 7], ['line', 16.5, 16.5, 21, 21]],
  shield: [['path', 'M12 3l8 3v6c0 5-3.4 7.6-8 9-4.6-1.4-8-4-8-9V6z'], ['polyline', '9 12 11 14 15 10']],
  branch: [['line', 6, 3, 6, 15], ['circle', 18, 6, 3], ['circle', 6, 18, 3], ['path', 'M18 9a9 9 0 0 1-9 9']],
  plug: [['path', 'M9 2v6'], ['path', 'M15 2v6'], ['path', 'M7 8h10v3a5 5 0 0 1-10 0z'], ['path', 'M12 16v6']],
  check: [['polyline', '4 12 10 18 20 6']],
};

function icon(name, color = 'currentColor', size = 18, width = 1.75) {
  const parts = (ICON_DEFS[name] || []).map((p) => {
    const [t, ...a] = p;
    if (t === 'rect') return `<rect x="${a[0]}" y="${a[1]}" width="${a[2]}" height="${a[3]}" rx="${a[4] || 0}"/>`;
    if (t === 'circle') return `<circle cx="${a[0]}" cy="${a[1]}" r="${a[2]}"/>`;
    if (t === 'line') return `<line x1="${a[0]}" y1="${a[1]}" x2="${a[2]}" y2="${a[3]}"/>`;
    if (t === 'polyline') return `<polyline points="${a[0]}"/>`;
    return `<path d="${a[0]}"/>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto">${parts}</svg>`;
}

/* ---------------- domain color maps ---------------- */

const STATUS = {
  investigating: { label: 'Investigating', color: '#0891b2', tint: '#e6f6fb' },
  'in-progress': { label: 'In progress', color: '#1f6feb', tint: '#e8f0fe' },
  testing: { label: 'Testing', color: '#b45309', tint: '#fbf1e0' },
  blocked: { label: 'Blocked', color: '#e11d48', tint: '#fdeaec' },
  done: { label: 'Done', color: '#7c3aed', tint: '#f2ecfe' },
};

const AVATAR_BG = {
  '#0891b2': 'linear-gradient(135deg,#22b8cf,#0e7490)',
  '#1f6feb': 'linear-gradient(135deg,#4d9bff,#1f6feb)',
  '#b45309': 'linear-gradient(135deg,#f0a850,#b45309)',
  '#e11d48': 'linear-gradient(135deg,#f4657f,#be123c)',
  '#7c3aed': 'linear-gradient(135deg,#a78bfa,#7c3aed)',
};
const AVATAR_FALLBACK = 'linear-gradient(135deg,#8b96a8,#5b6478)';

const EVENT_KIND = {
  session: ['#10b981', 'bot', '#e7f8f0'],
  claim: ['#0891b2', 'repo', '#e6f6fb'],
  finding: ['#1f6feb', 'search', '#e8f0fe'],
  bug: ['#e11d48', 'bug', '#fdeaec'],
  completed: ['#7c3aed', 'pr', '#f2ecfe'],
  activity: ['#475467', 'commit', '#eef1f6'],
};

const SEVERITY = {
  critical: '#9f1239',
  high: '#e11d48',
  medium: '#f59e0b',
  low: '#98a2b3',
  unknown: '#98a2b3',
};

/* ---------------- state ---------------- */

const state = {
  route: { view: 'overview', pid: null, tab: 'now' },
  projects: [],            // ProjectSummary[]
  states: new Map(),       // pid -> ProjectState
  authPending: [],         // pending pairing requests (incl. code)
  authCredentials: [],     // approved credentials (no token values)
  me: null,                // logged-in user { id, username, role, status } or null
  users: [],               // admin Users view: PublicUser[]
  authMode: 'login',       // login | register (logged-out view)
  authMsg: '',             // message shown on the login/register card
  copied: null,            // key of the element that just copied, for feedback
  revokeArm: null,         // credential id armed for two-step revoke
  lastSyncAt: null,
  misses: 0,
  everSynced: false,
};

const $ = (id) => document.getElementById(id);

/* ---------------- routing ---------------- */

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) {
    const tab = parts[2] === 'agents' || parts[2] === 'activity' ? parts[2] : 'now';
    return { view: 'project', pid: decodeURIComponent(parts[1]), tab };
  }
  if (parts[0] === 'activity') return { view: 'activity', pid: null, tab: null };
  if (parts[0] === 'agents') return { view: 'agents', pid: null, tab: null };
  if (parts[0] === 'settings') return { view: 'settings', pid: null, tab: null };
  if (parts[0] === 'users') return { view: 'users', pid: null, tab: null };
  return { view: 'overview', pid: null, tab: null };
}

/* ---------------- data fetching ---------------- */

async function getJSON(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (res.status === 401) { state.me = null; throw new Error('unauthenticated'); }
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function refresh() {
  if (!state.me) return; // logged out: dashboard polling is paused
  const r = state.route;
  try {
    const [, projects] = await Promise.all([
      getJSON('/api/health'),
      getJSON('/api/projects'),
    ]);
    state.projects = Array.isArray(projects) ? projects : [];

    const need = [];
    if (r.view === 'project' && r.pid) need.push(r.pid);
    if (r.view === 'activity' || r.view === 'agents') {
      for (const p of state.projects) need.push(p.id);
    }
    const results = await Promise.all(need.map((pid) =>
      getJSON(`/api/projects/${encodeURIComponent(pid)}/state`).then(
        (s) => [pid, s],
        () => [pid, null],
      )));
    for (const [pid, s] of results) if (s) state.states.set(pid, s);

    // pairing state: pending always (feeds the Agents nav badge), credentials
    // only where shown. Tolerate older servers without these endpoints.
    state.authPending = await getJSON('/api/auth/pending').catch(() => []);
    if (r.view === 'agents' || r.view === 'settings') {
      state.authCredentials = await getJSON('/api/auth/credentials').catch(() => []);
    }
    if (r.view === 'users' && state.me.role === 'admin') {
      state.users = await getJSON('/api/users').catch(() => []);
    }

    state.misses = 0;
    state.lastSyncAt = Date.now();
    state.everSynced = true;
  } catch {
    if (!state.me) { showAuth(); return; } // session expired mid-poll
    state.misses += 1;
  }
  render();
}

/* ---------------- header + sidebar ---------------- */

function renderConnection() {
  const stale = !state.everSynced || state.misses >= 2;
  const dotClass = state.everSynced
    ? (stale ? 'dot dot-stale' : 'dot dot-ok pulse')
    : 'dot dot-idle';
  $('connDot').className = dotClass;
  $('connLabel').textContent = !state.everSynced
    ? (state.misses >= 2 ? 'API unreachable' : 'Connecting…')
    : (stale ? 'API stale' : 'API connected');
  $('connHost').textContent = location.host || 'local file';

  $('syncDot').className = stale ? 'dot dot-stale' : 'dot dot-ok pulse';
  $('syncLabel').textContent = state.lastSyncAt
    ? `Synced ${ago(state.lastSyncAt)} ago`
    : 'Syncing…';
}

const NAV = [
  ['overview', 'Overview', 'grid', '#/'],
  ['activity', 'Activity', 'activity', '#/activity'],
  ['agents', 'Agents', 'key', '#/agents'],
  ['settings', 'Settings', 'sliders', '#/settings'],
];

function renderSidebar() {
  const r = state.route;
  const nav = state.me?.role === 'admin' ? [...NAV, ['users', 'Users', 'shield', '#/users']] : NAV;
  morph($('sideNav'), nav.map(([key, label, ic, href]) => {
    const active = r.view === key;
    const badge = key === 'agents' && state.authPending.length
      ? `<span class="nav-badge">${state.authPending.length}</span>` : '';
    return `<a class="side-nav-item${active ? ' active' : ''}" href="${href}">
      ${icon(ic, active ? '#8fc0ff' : '#7b8496', 18)}<span>${label}</span>${badge}</a>`;
  }).join(''));

  const liveTotal = state.projects.reduce((n, p) => n + p.sessions, 0);
  $('liveTotal').textContent = `${liveTotal} live`;

  morph($('sideProjects'), state.projects.length
    ? state.projects.map((p) => {
      const active = r.view === 'project' && r.pid === p.id;
      return `<a class="side-proj${active ? ' active' : ''}" href="#/p/${encodeURIComponent(p.id)}">
        <span class="dot ${p.sessions > 0 ? 'dot-ok' : 'dot-idle'}"></span>
        <span class="side-proj-name">${esc(p.id)}</span>
        ${p.sessions > 0 ? `<span class="side-proj-live">${p.sessions} live</span>` : ''}
      </a>`;
    }).join('')
    : `<div class="side-empty">No projects yet. A project appears the first time an agent connects to it.</div>`);
}

const HEADER_META = {
  overview: ['Instance', null, 'Overview'],
  activity: ['Instance', null, 'Activity'],
  agents: ['Instance', null, 'Agents'],
  settings: ['Instance', null, 'Settings'],
};

function renderHeader() {
  const r = state.route;
  const meta = r.view === 'project'
    ? ['Projects', r.pid, r.pid]
    : HEADER_META[r.view] || HEADER_META.overview;
  morph($('crumbs'), `<span>${esc(meta[0])}</span>${meta[1] ? `<span>/</span><span class="crumb-sub">${esc(meta[1])}</span>` : ''}`);
  $('pageTitle').textContent = meta[2];
}

/* ---------------- shared fragments ---------------- */

function eventRow(ev, now, projTag) {
  const [color, ic, tint] = EVENT_KIND[ev.type] || EVENT_KIND.activity;
  return `<div class="act-row">
    <span class="feed-icon" style="color:${color};margin-top:1px">${icon(ic, color, 16)}</span>
    <div class="act-body">
      <div class="act-text"><span class="type-tag" style="color:${color};background:${tint}">${esc(ev.type)}</span>${esc(ev.message)}</div>
      ${projTag ? `<div class="act-meta"><span class="mono">${esc(projTag)}</span></div>` : ''}
    </div>
    <span class="act-ago">${ago(ev.at, now)} ago</span>
  </div>`;
}

function emptyCard(html) {
  return `<div class="empty-card">${html}</div>`;
}

/* ---------------- overview ---------------- */

function renderOverview() {
  const now = Date.now();
  const ps = state.projects;
  const sum = (f) => ps.reduce((n, p) => n + f(p), 0);
  const live = sum((p) => p.sessions);
  const claims = sum((p) => p.claims);
  const bugs = sum((p) => p.openBugs);
  const conflicts = sum((p) => p.conflicts);
  const activeProjects = ps.filter((p) => p.sessions > 0).length;

  const stats = [
    { label: 'Live sessions', value: live, icon: 'bot', hint: `across ${plural(activeProjects, 'project')}`, cls: '' },
    { label: 'Active claims', value: claims, icon: 'repo', hint: claims ? 'work in flight right now' : 'nothing claimed yet', cls: '' },
    { label: 'Open bugs', value: bugs, icon: 'bug', hint: bugs ? 'discovered mid-flight' : 'none reported', cls: '' },
    { label: 'Possible conflicts', value: conflicts, icon: 'shield', hint: conflicts ? 'overlapping active claims' : 'no overlap detected', cls: conflicts ? 'warn' : 'accent' },
  ];

  const statCards = stats.map((s) => `<div class="stat-card">
    <div class="stat-head">${icon(s.icon, '#667085', 15)}<span>${s.label}</span></div>
    <div class="stat-value">${s.value}</div>
    <div class="stat-hint ${s.cls}">${esc(s.hint)}</div>
  </div>`).join('');

  const cards = ps.map((p) => {
    const agentsPreview = p.agents.length
      ? esc(p.agents.slice(0, 3).join(', ')) + (p.agents.length > 3 ? ` +${p.agents.length - 3}` : '')
      : 'No agents connected yet';
    return `<a class="proj-card" href="#/p/${encodeURIComponent(p.id)}">
      <div class="proj-card-top">
        <span class="dot ${p.sessions > 0 ? 'dot-ok pulse' : 'dot-idle'}"></span>
        <span class="proj-card-name">${esc(p.id)}</span>
        <span class="proj-card-chev">${icon('chevron', '#c0c7d1', 18)}</span>
      </div>
      <div class="proj-card-desc">${agentsPreview}</div>
      <div class="proj-card-stats">
        <span><b>${p.sessions}</b> live sessions</span>
        <span><b>${p.agents.length}</b> agents</span>
        <span><b>${p.claims}</b> claims</span>
        <span><b>${p.openBugs}</b> open bugs</span>
      </div>
      <div class="proj-card-foot">
        ${icon('clock', '#98a2b3', 14)}<span class="foot-mono">last activity</span>
        <span class="foot-ago">${p.lastActivityAt ? `${ago(p.lastActivityAt, now)} ago` : 'never'}</span>
      </div>
      ${p.conflicts > 0 ? `<div class="warn-ribbon">${icon('shield', '#c9922e', 13)}<span>${plural(p.conflicts, 'possible overlap')} between active claims</span></div>` : ''}
    </a>`;
  }).join('');

  return `<div class="view-overview">
    <div class="stat-grid">${statCards}</div>
    <div class="section-head">
      <h2>Projects</h2>
      <span class="section-sub">Live state before Git makes it visible</span>
    </div>
    ${ps.length
      ? `<div class="proj-grid">${cards}</div>`
      : emptyCard(`No projects yet. Connect an agent to create one:<br><span class="mono">mediation-agent connect --project my-project --agent claude-code</span><br>See <a href="#/settings">Settings</a> for the full snippet.`)}
  </div>`;
}

/* ---------------- project view ---------------- */

function conflictsForClaim(conflicts, claimId) {
  const others = [];
  for (const c of conflicts) {
    const [a, b] = c.between;
    if (a.claimId === claimId) others.push(b.agent);
    else if (b.claimId === claimId) others.push(a.agent);
  }
  return others;
}

function reasonHtml(reason) {
  if (reason.type === 'files') {
    const pairs = reason.detail.map((d) =>
      d.mine === d.theirs
        ? `<span class="file-chip">${esc(d.mine)}</span>`
        : `<span class="file-chip">${esc(d.mine)} ↔ ${esc(d.theirs)}</span>`).join('');
    return `<div class="conflict-reason"><span class="reason-kind">files</span>${pairs}</div>`;
  }
  if (reason.type === 'components') {
    return `<div class="conflict-reason"><span class="reason-kind">components</span>${reason.detail.map((d) => `<span class="comp-chip">${esc(d)}</span>`).join('')}</div>`;
  }
  return `<div class="conflict-reason"><span class="reason-kind">shared task</span><span>${reason.detail.map(esc).join(' · ')}</span></div>`;
}

function claimCard(claim, sessionsById, conflicts, now) {
  const st = STATUS[claim.status] || STATUS.investigating;
  const sess = sessionsById.get(claim.sessionId);
  const who = claim.developer || claim.agent;
  const machine = sess?.machine;
  const branch = claim.branch || sess?.repo?.branch;
  const overlaps = conflictsForClaim(conflicts, claim.id);
  const findings = claim.findings.slice(-3);

  return `<div class="claim-card">
    <div class="claim-top">
      <span class="avatar" style="background:${AVATAR_BG[st.color] || AVATAR_FALLBACK}">${esc(initials(who))}</span>
      <div class="claim-who">
        <div class="claim-who-row">
          <span class="claim-name">${esc(who)}</span>
          <span class="agent-chip">${icon('bot', '#5b6b85', 14)}${esc(claim.agent)}</span>
          ${machine ? `<span class="claim-machine">${esc(machine)}</span>` : ''}
        </div>
      </div>
      <div class="claim-right">
        <span class="status-badge" style="background:${st.tint};color:${st.color}">${st.label}</span>
        <span class="claim-activity"><span class="dot dot-ok pulse"></span>${ago(claim.updatedAt, now)} ago</span>
      </div>
    </div>
    <div class="claim-intent">${esc(claim.intent)}</div>
    ${claim.files.length || claim.components.length ? `<div class="chip-row">
      ${claim.files.map((f) => `<span class="file-chip">${esc(f)}</span>`).join('')}
      ${claim.components.map((c) => `<span class="comp-chip">${esc(c)}</span>`).join('')}
    </div>` : ''}
    ${findings.length ? `<div class="finding-box">
      <span>${icon('search', '#0891b2', 14)}</span>
      <div class="finding-list">${findings.map((f) =>
        `<span>${esc(f.text)}<span class="finding-when">${ago(f.at, now)} ago</span></span>`).join('')}</div>
    </div>` : ''}
    <div class="claim-foot">
      ${branch ? `<span class="foot-item">${icon('branch', '#98a2b3', 14)}<span class="mono">${esc(branch)}</span></span>` : ''}
      ${claim.task ? `<span class="foot-item">${icon('file', '#98a2b3', 14)}<span>${esc(claim.task)}</span></span>` : ''}
      ${overlaps.length ? `<span class="overlap-note">${icon('shield', '#c9922e', 13)}overlaps with ${esc([...new Set(overlaps)].join(', '))}</span>` : ''}
    </div>
  </div>`;
}

function conflictCard(c) {
  const side = (s) => `<div class="conflict-side">
    <span class="conflict-agent">${esc(s.agent)}</span>
    <span class="conflict-intent">${esc(s.intent)}</span>
  </div>`;
  return `<div class="conflict-card">
    <div class="conflict-head">${icon('shield', '#c9922e', 15)}<span>Possible overlap</span></div>
    <div class="conflict-pair">${side(c.between[0])}${side(c.between[1])}</div>
    <div class="conflict-reasons">${c.reasons.map(reasonHtml).join('')}</div>
  </div>`;
}

function sessionRow(s, now) {
  const who = s.developer || s.agent;
  const dirty = s.repo?.dirtyFiles?.length || 0;
  return `<div class="sess-row">
    <span class="avatar" style="width:28px;height:28px;font-size:10px;background:${AVATAR_FALLBACK}">${esc(initials(who))}</span>
    <div class="sess-body">
      <div class="sess-name">${esc(s.agent)}${s.repo?.branch ? `<span class="sess-branch">${esc(s.repo.branch)}</span>` : ''}</div>
      <div class="sess-meta">${esc([s.developer, s.machine].filter(Boolean).join(' · ') || 'anonymous')}${dirty ? ` · ${plural(dirty, 'dirty file')}` : ''}</div>
    </div>
    <span class="sess-ago">${ago(s.lastSeenAt, now)} ago</span>
  </div>`;
}

function completedRow(c, now) {
  const refs = [
    ...c.prs.map((p) => `<span class="ref-chip">${esc(p)}</span>`),
    ...c.commits.map((h) => `<span class="ref-chip">${esc(String(h).slice(0, 7))}</span>`),
  ].join('');
  return `<div class="done-row">
    <span style="color:#7c3aed;flex:0 0 auto">${icon('check', '#0e9f6e', 16)}</span>
    <div class="done-body">
      <div class="done-title">${esc(c.intent)}</div>
      <div class="done-sub">${esc(c.developer || c.agent)}${c.summary ? ` · ${esc(c.summary)}` : ''}</div>
    </div>
    ${refs ? `<div class="done-refs">${refs}</div>` : ''}
    <span class="done-when">${ago(c.completedAt || c.updatedAt, now)} ago</span>
  </div>`;
}

function renderProject() {
  const { pid, tab } = state.route;
  const ps = state.states.get(pid);
  const summary = state.projects.find((p) => p.id === pid);
  const now = ps?.now && Math.abs(ps.now - Date.now()) < 60_000 ? Date.now() : Date.now();

  const tabs = [['now', 'Now'], ['agents', 'Agents'], ['activity', 'Activity']].map(([key, label]) => {
    const href = key === 'now' ? `#/p/${encodeURIComponent(pid)}` : `#/p/${encodeURIComponent(pid)}/${key}`;
    return `<a class="tab${tab === key ? ' active' : ''}" href="${href}">${label}</a>`;
  }).join('');

  const branch = ps?.sessions.find((s) => s.repo?.branch)?.repo?.branch;
  const live = ps ? ps.sessions.length : (summary?.sessions ?? 0);
  const nClaims = ps ? ps.claims.length : (summary?.claims ?? 0);
  const nBugs = ps ? ps.bugs.filter((b) => b.status !== 'fixed').length : (summary?.openBugs ?? 0);

  const head = `<div class="proj-head">
    <div class="proj-head-main">
      <div class="proj-title-row">
        <span class="dot ${live > 0 ? 'dot-ok pulse' : 'dot-idle'}"></span>
        <h2 class="proj-title">${esc(pid)}</h2>
        ${branch ? `<span class="repo-chip">${icon('repo', '#98a2b3', 13)}${esc(branch)}</span>` : ''}
      </div>
      <div class="proj-sub">${plural(live, 'live session')} · ${plural(nClaims, 'active claim')} · ${plural(nBugs, 'open bug')}</div>
    </div>
    <div class="proj-ministats">
      ${[[live, 'live'], [nClaims, 'claims'], [nBugs, 'bugs']].map(([v, l]) =>
        `<div class="ministat"><div class="ministat-value">${v}</div><div class="ministat-label">${l}</div></div>`).join('')}
    </div>
  </div>`;

  let body;
  if (!ps) {
    body = emptyCard(state.everSynced
      ? `Nothing recorded for <span class="mono">${esc(pid)}</span> yet. It will appear as soon as an agent connects.`
      : `Waiting for the Mediation API…`);
  } else if (tab === 'agents') {
    body = renderSessionsTable(ps.sessions, now);
  } else if (tab === 'activity') {
    body = ps.events.length
      ? `<div class="feed-panel" style="max-width:760px">${ps.events.map((e) => eventRow(e, now)).join('')}</div>`
      : emptyCard('No events yet. Sessions, claims, findings and bug reports will land here as they happen.');
  } else {
    body = renderNowTab(ps, now);
  }

  return `<div class="view-project">${head}<div class="tabs">${tabs}</div>${body}</div>`;
}

function renderNowTab(ps, now) {
  const sessionsById = new Map(ps.sessions.map((s) => [s.id, s]));

  const claimsHtml = ps.claims.length
    ? ps.claims.map((c) => claimCard(c, sessionsById, ps.conflicts, now)).join('')
    : emptyCard(ps.sessions.length
      ? 'Sessions are live but nothing is claimed. Agents should claim work before editing.'
      : `No active sessions.${ps.events.length ? ` Last activity ${ago(ps.events[0].at, now)} ago.` : ''}`);

  const conflictsHtml = ps.conflicts.length
    ? `<div class="col-head"><span class="col-head-label">Possible conflicts</span>
       <span class="col-head-sub">warnings, not locks</span></div>
       ${ps.conflicts.map(conflictCard).join('')}`
    : '';

  const completedHtml = `<div class="panel">
    <div class="panel-head">Completed work<span class="panel-count">${ps.completed.length}</span></div>
    <div class="panel-body">${ps.completed.length
      ? ps.completed.map((c) => completedRow(c, now)).join('')
      : '<div class="empty-inline">Nothing completed yet.</div>'}</div>
  </div>`;

  const sessionsPanel = `<div class="panel">
    <div class="panel-head"><span class="dot dot-ok pulse"></span>Active sessions<span class="panel-count">${ps.sessions.length}</span></div>
    <div class="panel-body">${ps.sessions.length
      ? ps.sessions.map((s) => sessionRow(s, now)).join('')
      : '<div class="empty-inline">No sessions connected right now.</div>'}</div>
  </div>`;

  const filesPanel = `<div class="panel">
    <div class="panel-head">Recently touched files</div>
    <div class="panel-body">${ps.recentFiles.length
      ? ps.recentFiles.map((f) => `<div class="rfile-row${f.agents.length > 1 ? ' multi' : ''}">
          <span class="rfile-name" title="${esc(f.file)}">${esc(f.file)}</span>
          ${f.agents.length > 1 ? `<span class="rfile-multi-chip">${f.agents.length} agents</span>` : `<span class="rfile-agents">${esc(f.agents.join(', '))}</span>`}
          <span class="rfile-ago">${ago(f.updatedAt, now)}</span>
        </div>`).join('')
      : '<div class="empty-inline">No files touched yet.</div>'}</div>
  </div>`;

  const bugsPanel = `<div class="panel">
    <div class="panel-head">Discovered bugs<span class="panel-count">${ps.bugs.length}</span></div>
    <div class="panel-body">${ps.bugs.length
      ? ps.bugs.map((b) => `<div class="bug-row">
          <span class="bug-dot" style="background:${SEVERITY[b.severity] || SEVERITY.unknown}"></span>
          <div class="bug-body">
            <div class="bug-title"><span class="bug-id">${esc(b.id.slice(0, 8))}</span> ${esc(b.title)}</div>
            <div class="bug-meta">${esc(b.reporter)} · ${esc(b.severity)} · ${esc(b.status)} · ${ago(b.createdAt, now)} ago</div>
          </div>
        </div>`).join('')
      : '<div class="empty-inline">No bugs reported.</div>'}</div>
  </div>`;

  return `<div class="now-grid">
    <div class="now-col">
      ${conflictsHtml}
      <div class="col-head">
        <span class="col-head-label">Active work claims</span>
        <span class="col-head-sub">${plural(ps.sessions.length, 'session')} reporting</span>
      </div>
      ${claimsHtml}
      ${completedHtml}
    </div>
    <div class="now-col">
      ${sessionsPanel}
      ${filesPanel}
      ${bugsPanel}
    </div>
  </div>`;
}

function renderSessionsTable(sessions, now) {
  if (!sessions.length) {
    return emptyCard('No live sessions. An agent joins with <span class="mono">mediation-agent connect</span> and stays listed while it heartbeats.');
  }
  const rows = sessions.map((s) => `<div class="table-row">
    <span class="cell-agent">${icon('bot', '#667085', 15)}<span>${esc(s.agent)}</span></span>
    <span class="cell-dev">${esc(s.developer || '—')}</span>
    <span class="cell-machine">${esc(s.machine || '—')}</span>
    <span class="cell-branch">${esc(s.repo?.branch || '—')}</span>
    <span class="cell-dirty">${s.repo ? s.repo.dirtyFiles.length : '—'}</span>
    <span class="cell-seen">${ago(s.lastSeenAt, now)} ago</span>
  </div>`).join('');
  return `<div class="table" style="max-width:960px">
    <div class="table-head">
      <span>Agent</span><span>Developer</span><span>Machine</span><span>Branch</span><span>Dirty</span><span>Last seen</span>
    </div>${rows}
  </div>`;
}

/* ---------------- instance activity / agents ---------------- */

function renderInstanceActivity() {
  const now = Date.now();
  const merged = [];
  for (const p of state.projects) {
    const ps = state.states.get(p.id);
    if (ps) for (const ev of ps.events) merged.push({ ...ev, projectId: p.id });
  }
  merged.sort((a, b) => b.at - a.at);
  const events = merged.slice(0, 100);
  return `<div class="view-activity">
    <div class="view-note">Every event across the instance, newest first — sessions, claims, findings, bugs and completions.</div>
    ${events.length
      ? `<div class="feed-panel">${events.map((e) => eventRow(e, now, e.projectId)).join('')}</div>`
      : emptyCard('Nothing has happened yet. Events appear here as agents connect, claim work and report findings.')}
  </div>`;
}

function renderPairingPanels() {
  const now = Date.now();
  const pending = state.authPending.length
    ? state.authPending.map((q) => `<div class="pair-row">
        <span class="avatar" style="background:${AVATAR_FALLBACK}">${esc(initials(q.agent))}</span>
        <div class="pair-who">
          <div class="pair-agent">${esc(q.agent)}</div>
          <div class="pair-meta">${q.machine ? esc(q.machine) + ' · ' : ''}requested ${ago(q.createdAt, now)} ago · expires in ${Math.max(0, Math.round((q.expiresAt - now) / 60000))}m</div>
        </div>
        <button class="pair-code" type="button" data-copy="${esc(q.code)}" data-copy-key="pair-${esc(q.id)}"
          title="Click to copy, then paste this code to the agent">
          ${state.copied === `pair-${q.id}` ? 'copied' : esc(q.code)}
        </button>
      </div>`).join('')
    : `<div class="empty-note">No pending requests. An agent asking to connect (via <span class="mono">mediation_init</span>) appears here with its approval code.</div>`;

  const creds = state.authCredentials.length
    ? state.authCredentials.map((cr) => `<div class="pair-row">
        <span class="avatar" style="background:${AVATAR_FALLBACK}">${esc(initials(cr.agent))}</span>
        <div class="pair-who">
          <div class="pair-agent">${esc(cr.agent)}${cr.developer ? ` <span class="pair-dev">for ${esc(cr.developer)}</span>` : ''}</div>
          <div class="pair-meta">${cr.machine ? esc(cr.machine) + ' · ' : ''}paired ${ago(cr.createdAt, now)} ago · last used ${ago(cr.lastUsedAt, now)} ago</div>
        </div>
        <button class="revoke-btn${state.revokeArm === cr.id ? ' armed' : ''}" type="button" data-revoke="${esc(cr.id)}">
          ${state.revokeArm === cr.id ? 'Confirm revoke' : 'Revoke'}
        </button>
      </div>`).join('')
    : `<div class="empty-note">No paired agent credentials yet.</div>`;

  return `<div class="settings-section" style="margin-bottom:22px">
      <h3>Pending pairing requests${state.authPending.length ? ` <span class="count-tag">${state.authPending.length}</span>` : ''}</h3>
      <div class="pair-note">Read the code to your agent (or paste it into the chat) to approve the connection.</div>
      ${pending}
    </div>
    <div class="settings-section" style="margin-bottom:22px">
      <h3>Approved agent credentials</h3>
      ${creds}
    </div>`;
}

function renderInstanceAgents() {
  const now = Date.now();
  const sections = state.projects.map((p) => {
    const ps = state.states.get(p.id);
    if (!ps || !ps.sessions.length) return '';
    return `<div class="settings-section" style="margin-bottom:22px">
      <h3><span class="mono" style="font-size:13px">${esc(p.id)}</span>
        <span style="font-size:11px;font-weight:500;color:#98a2b3"> · ${plural(ps.sessions.length, 'session')}</span></h3>
      ${renderSessionsTable(ps.sessions, now)}
    </div>`;
  }).join('');
  return `<div class="view-activity" style="max-width:960px">
    <div class="view-note">Agent pairing and every live session across the instance.</div>
    ${renderPairingPanels()}
    <div class="settings-section" style="margin-bottom:12px"><h3>Live sessions</h3></div>
    ${sections || emptyCard('No live agent sessions anywhere. See <a href="#/settings">Settings</a> for how to connect one.')}
  </div>`;
}

/* ---------------- settings ---------------- */

function renderSettings() {
  const origin = location.origin && location.origin !== 'null' ? location.origin : 'http://localhost:4100';
  const pid = state.projects[0]?.id || 'my-project';
  const snippet = [
    '# start a session for this project',
    `mediation-agent connect --project ${pid} --agent claude-code`,
    '',
    '# before touching files: check who else is there',
    `mediation-agent check --files src/server/app.ts --task "fix session expiry"`,
    '',
    '# claim the work — overlaps come back as warnings, never locks',
    `mediation-agent claim --intent "Fix session expiry" --files src/server/app.ts`,
  ].join('\n');
  const stale = !state.everSynced || state.misses >= 2;

  const installCmd = `curl -fsSL ${origin}/install.sh | bash`;

  return `<div class="view-settings">
    <div class="dark-panel">
      <div class="dark-panel-head">
        <span class="dp-icon">${icon('bot', '#8fc0ff', 18)}</span>
        <span class="dp-title">Install for your agents</span>
      </div>
      <div class="dp-note" style="margin:0 0 8px">One command on each developer machine. Detects and registers the
        Mediation MCP server for <b>claude-code</b> and <b>codex</b> (default: both) and installs a skill that
        teaches agents the workflow.</div>
      <div class="snippet-wrap">
        <pre class="snippet" id="installSnippet">${esc(installCmd)}</pre>
        <button class="copy-btn" type="button" data-copy="${esc(installCmd)}" data-copy-key="install">${state.copied === 'install' ? 'Copied' : 'Copy'}</button>
      </div>
      <div class="dp-note">Then, in a project directory, ask the agent to <i>“set up mediation for project
        &lt;name&gt;”</i> — it requests pairing, you read the 6-char code from the
        <a href="#/agents">Agents page</a> and paste it to the agent. Persistent per project directory.</div>
    </div>

    <div class="dark-panel">
      <div class="dark-panel-head">
        <span class="dp-icon">${icon('plug', '#8fc0ff', 18)}</span>
        <span class="dp-title">Connect an agent</span>
        <span class="dp-live${stale ? ' is-stale' : ''}"><span class="dot ${stale ? 'dot-stale' : 'dot-ok pulse'}"></span>${stale ? 'Stale' : 'Live'}</span>
      </div>
      <div class="dp-grid">
        <div><div class="dp-key">Server URL</div><div class="dp-val">${esc(origin)}</div></div>
        <div><div class="dp-key">Project ID</div><div class="dp-val">${esc(pid)}</div></div>
      </div>
      <div class="dp-key" style="margin-bottom:6px">CLI</div>
      <div class="snippet-wrap">
        <pre class="snippet" id="cliSnippet">${esc(snippet)}</pre>
        <button class="copy-btn" id="copyBtn" type="button">${state.copied === 'cli' ? 'Copied' : 'Copy'}</button>
      </div>
      <div class="dp-note">Agents authenticate to <span class="mono">/api</span> with a paired Bearer credential; the
        dashboard uses your user session. Protocol reference: <a href="/AGENT.md" target="_blank" rel="noopener">/AGENT.md</a> ·
        auth: <a href="/auth.md" target="_blank" rel="noopener">/auth.md</a>.</div>
    </div>

    <div class="settings-section">
      <h3>How coordination works</h3>
      <div class="kv-list">
        ${[
          ['Conflicts are warnings', 'Overlap never blocks an agent. Claims always succeed; overlapping work comes back as a warning to negotiate around.', 'warn, not lock'],
          ['Session heartbeat TTL', 'A session disappears — and its claims are released — if it stops heartbeating for this long.', '120 s'],
          ['Claim idle expiry', 'Idle work claims auto-release so overlap warnings never rely on stale locks.', '30 min'],
          ['Completed work', 'Finished claims are kept with their commits, PRs and summary so others can see what just changed.', 'kept'],
        ].map(([label, desc, value]) => `<div class="kv-row">
          <div class="kv-main"><div class="kv-label">${label}</div><div class="kv-desc">${desc}</div></div>
          <span class="kv-value">${value}</span>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}

/* ---------------- users (admin) ---------------- */

const uBtn = (act, id, label, danger) =>
  `<button class="user-act-btn${danger ? ' danger' : ''}" type="button" data-uaction="${act}" data-uid="${esc(id)}">${label}</button>`;

function renderUsers() {
  const rows = state.users.map((u) => {
    const you = state.me && u.id === state.me.id;
    const acts = [];
    if (u.status === 'pending') acts.push(uBtn('approve', u.id, 'Approve'));
    if (u.status === 'active') acts.push(uBtn('disable', u.id, 'Disable'));
    if (u.status === 'disabled') acts.push(uBtn('activate', u.id, 'Reactivate'));
    acts.push(u.role === 'admin' ? uBtn('makeuser', u.id, 'Make user') : uBtn('makeadmin', u.id, 'Make admin'));
    acts.push(uBtn('delete', u.id, 'Delete', true));
    return `<div class="table-row users-row">
      <span class="cell-agent">${esc(u.username)}${you ? ' <span class="you-tag">you</span>' : ''}</span>
      <span>${esc(u.role)}</span>
      <span><span class="ustatus ustatus-${esc(u.status)}">${esc(u.status)}</span></span>
      <span>${ago(u.createdAt)} ago</span>
      <span class="user-actions">${acts.join('')}</span>
    </div>`;
  }).join('');
  return `<div class="view-activity" style="max-width:1000px">
    <div class="view-note">Approve, disable, promote or remove accounts. The last active admin cannot be demoted, disabled or deleted.</div>
    <div class="table users-table" style="max-width:1000px">
      <div class="table-head users-row"><span>Username</span><span>Role</span><span>Status</span><span>Created</span><span>Actions</span></div>
      ${state.users.length ? rows : '<div class="empty-inline" style="padding:16px">No users yet.</div>'}
    </div>
  </div>`;
}

/* ---------------- auth (logged-out) ---------------- */

function renderAuth() {
  const reg = state.authMode === 'register';
  return `<div class="auth-wrap">
    <div class="auth-card">
      <div class="auth-brand">Mediation</div>
      <div class="auth-title">${reg ? 'Create account' : 'Sign in'}</div>
      ${state.authMsg ? `<div class="auth-msg">${esc(state.authMsg)}</div>` : ''}
      <input class="auth-input" id="authUser" placeholder="username" autocomplete="username">
      <input class="auth-input" id="authPass" type="password" placeholder="password"
        autocomplete="${reg ? 'new-password' : 'current-password'}">
      <button class="auth-btn" type="button" data-auth="${reg ? 'register' : 'login'}">${reg ? 'Register' : 'Login'}</button>
      <div class="auth-toggle">${reg
        ? 'Have an account? <a href="#" data-auth="toggle">Sign in</a>'
        : 'Need an account? <a href="#" data-auth="toggle">Register</a>'}</div>
    </div>
  </div>`;
}

function showAuth() {
  document.querySelector('.sidebar').style.display = 'none';
  document.querySelector('.topbar').style.display = 'none';
  $('main').innerHTML = renderAuth();
  const u = $('authUser');
  if (u) u.focus();
}

function enterDashboard() {
  document.querySelector('.sidebar').style.display = '';
  document.querySelector('.topbar').style.display = '';
  state.route = parseRoute();
  render();
  refresh();
}

async function doLogin(username, password) {
  try {
    const res = await fetch('/api/users/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { state.me = body.user; state.authMsg = ''; enterDashboard(); return; }
    state.authMsg = body.error || `Login failed (${res.status})`;
  } catch { state.authMsg = 'Request failed — is the server reachable?'; }
  showAuth();
}

async function doRegister(username, password) {
  try {
    const res = await fetch('/api/users/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      if (body.bootstrap) { await doLogin(username, password); return; } // first account: active admin, log straight in
      state.authMode = 'login';
      state.authMsg = 'Account created — an administrator must approve it before you can sign in.';
    } else {
      state.authMsg = (body.issues ? 'Check username (3-32 chars) and password (min 8).' : body.error) || `Registration failed (${res.status})`;
    }
  } catch { state.authMsg = 'Request failed — is the server reachable?'; }
  showAuth();
}

/* ---------------- render root ---------------- */

let lastRouteKey = null;

function render() {
  if (!state.me) return; // logged out: managed by showAuth()
  renderConnection();
  renderSidebar();
  renderHeader();
  $('userChip').innerHTML =
    `<span class="user-name">${esc(state.me.username)}</span>` +
    `<span class="user-role">${esc(state.me.role)}</span>` +
    '<button class="logout-btn" type="button" data-logout>Logout</button>';
  $('footerName').textContent = state.me.username;
  $('footerRole').textContent = state.me.role === 'admin' ? 'Administrator' : 'Member';
  const main = $('main');
  const r = state.route;
  const html =
    r.view === 'project' ? renderProject()
    : r.view === 'activity' ? renderInstanceActivity()
    : r.view === 'agents' ? renderInstanceAgents()
    : r.view === 'settings' ? renderSettings()
    : r.view === 'users' ? renderUsers()
    : renderOverview();

  // Fresh DOM on navigation (entry animation plays once); in-place patch on
  // data refresh (no flicker, no animation restarts, scroll preserved).
  const routeKey = `${r.view}:${r.pid || ''}:${r.tab || ''}`;
  if (routeKey !== lastRouteKey) {
    lastRouteKey = routeKey;
    main.innerHTML = html;
  } else {
    morph(main, html);
  }
}

/* ---------------- boot ---------------- */

$('searchIcon').innerHTML = icon('search', '#98a2b3', 15);

// Delegated listeners: elements are re-created/morphed on every poll, so all
// feedback goes through `state` + render(), never direct DOM mutation.
let copiedTimer = null;
document.addEventListener('click', async (e) => {
  const authEl = e.target.closest('[data-auth]');
  if (authEl) {
    e.preventDefault();
    const act = authEl.dataset.auth;
    if (act === 'toggle') {
      state.authMode = state.authMode === 'register' ? 'login' : 'register';
      state.authMsg = '';
      showAuth();
      return;
    }
    const username = ($('authUser')?.value || '').trim();
    const password = $('authPass')?.value || '';
    if (act === 'register') await doRegister(username, password);
    else await doLogin(username, password);
    return;
  }

  if (e.target.closest('[data-logout]')) {
    try { await fetch('/api/users/logout', { method: 'POST' }); } catch { /* ignore */ }
    state.me = null;
    state.authMode = 'login';
    state.authMsg = 'Signed out.';
    showAuth();
    return;
  }

  const ua = e.target.closest('[data-uaction]');
  if (ua) {
    const id = ua.dataset.uid;
    const act = ua.dataset.uaction;
    if (act === 'delete' && !confirm('Delete this user? This cannot be undone.')) return;
    const bodies = {
      approve: { status: 'active' }, disable: { status: 'disabled' }, activate: { status: 'active' },
      makeadmin: { role: 'admin' }, makeuser: { role: 'user' },
    };
    try {
      const res = act === 'delete'
        ? await fetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
        : await fetch(`/api/users/${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies[act]),
        });
      if (!res.ok) { const b = await res.json().catch(() => ({})); alert(b.error || `Action failed (${res.status})`); }
    } catch { alert('Request failed'); }
    refresh();
    return;
  }

  const legacyCopy = e.target.closest('#copyBtn');
  if (legacyCopy) {
    try {
      await navigator.clipboard.writeText($('cliSnippet').textContent);
      state.copied = 'cli';
    } catch { /* leave as-is */ }
    render();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { state.copied = null; render(); }, 1500);
    return;
  }

  const copyEl = e.target.closest('[data-copy]');
  if (copyEl) {
    try {
      await navigator.clipboard.writeText(copyEl.dataset.copy);
      state.copied = copyEl.dataset.copyKey || 'copied';
    } catch { /* clipboard denied — text is visible to select manually */ }
    render();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { state.copied = null; render(); }, 1500);
    return;
  }

  const revokeEl = e.target.closest('[data-revoke]');
  if (revokeEl) {
    const id = revokeEl.dataset.revoke;
    if (state.revokeArm !== id) {
      state.revokeArm = id; // first click arms, second confirms
      render();
      setTimeout(() => { if (state.revokeArm === id) { state.revokeArm = null; render(); } }, 4000);
      return;
    }
    state.revokeArm = null;
    try {
      await fetch(`/api/auth/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* refresh() below re-syncs either way */ }
    refresh();
  }
});

function onRoute() {
  if (!state.me) return; // logged out: hash changes are inert
  state.route = parseRoute();
  render();
  refresh();
}

async function checkAuth() {
  try {
    const res = await fetch('/api/users/me', { headers: { Accept: 'application/json' } });
    if (res.ok) { state.me = (await res.json()).user; return; }
  } catch { /* server unreachable — treat as logged out */ }
  state.me = null;
}

window.addEventListener('hashchange', onRoute);
setInterval(() => { if (state.me) refresh(); }, 3000);
setInterval(() => { if (state.me) renderConnection(); }, 1000); // keep "Synced Ns ago" ticking

checkAuth().then(() => { if (state.me) enterDashboard(); else showAuth(); });
