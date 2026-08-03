# Changelog

## Unreleased: live agent crews

- `GET /api/projects/:p/state` now includes durable logical agent executions.
  The dashboard groups their server-resolved parent edges into a collapsible
  Crew tree, highlights blocked, stale, and unattached agents, and falls back
  to the existing flat sessions when no lineage is available. Claims remain
  the source of truth for work ownership.
- `POST /api/projects/:p/agent-events` accepts idempotent lifecycle reports.
  The server scopes parent lookup to the project, authenticated user, and run.
  It also derives the developer identity, provenance, and stale state.
- The installer adds fail-open `SessionStart`, `SessionEnd`, `SubagentStart`,
  and `SubagentStop` hooks for Codex and Claude Code. Codex requires explicit
  review/trust in `/hooks`. Kimi stays MCP/environment-only.
- The MCP client accepts optional `MEDIATION_RUN_ID`, agent/parent ids, name,
  role, task, state, and state-reason variables, with a repository-scoped hash
  of `CODEX_THREAD_ID` as a run-id-only fallback. Static environment metadata
  is read at session start, invalid metadata is omitted, and legacy sessions
  work unchanged.
- Lifecycle hooks send only stable event identity and role metadata. They do
  not forward prompts, transcripts, assistant messages, tool I/O, secrets,
  model/permission data, or local paths, and silently degrade when reporting
  is unavailable.

## 0.5.1: surviving broken IPv6

A network that advertises IPv6 it cannot reach made ~25% of MCP client
requests fail with an unretried `ETIMEDOUT` (#1): Node's Happy Eyeballs
abandons each connect attempt after 250ms, which real Cloudflare TCP connects
exceed under load, so both IPv4 fallback attempts were aborted while a plain
socket to the same address connected in 40ms.

- The client raises the attempt timeout to 2s at load — RFC 8305's ceiling for
  this delay, and measured 20/20 against 15/20 at the default.
- Connect-phase failures (`ETIMEDOUT`, `ENETUNREACH`, `EHOSTUNREACH`,
  `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`) are now retried once, like the
  socket-death codes already were. They fail before a byte is written, so the
  retry cannot duplicate a write. `ECONNREFUSED` and `ENOTFOUND` stay
  unretried: those are answers, not accidents.
- A request that exhausts its 5s budget is no longer reported as "mediation
  server unreachable". The server may be fine and the write may even have been
  recorded — the server has no idempotency key, so the client does not repeat
  it and the message now says to check `mediation_state` first. Only a refused
  connection or an unresolvable name still reads as unreachable.

## 0.5.0: five tools, and news that finds you

**Eleven MCP tools became five.** Every tool description is context an agent
pays for on every call, and every tool is one more decision it can get wrong.
The surface is now split by the object it acts on: `mediation_setup` (sign in,
register, report setup), `mediation_init`, `mediation_claim`, `mediation_bug`,
`mediation_state`. `mediation_init` deliberately stays separate: it is the one
action with a policy boundary and the only one that writes into the repository,
so a harness must be able to deny it on its own.

- `mediation_claim` covers a claim's whole life. Claiming is also checking:
  creating a claim already ran the same overlap computation and returned the
  same warnings, so the old separate check was a round trip that published
  nothing. `dryRun: true` remains for the rare look-without-publishing case.
- New terminal status `abandoned`, for work claimed and then dropped. It closes
  the claim without entering the completed feed, so backing off a conflict no
  longer leaves a phantom warning standing for 45 minutes.
- `mediation_bug` files or resolves. Sending `title` and `bugId` together is a
  hard error rather than a silently filed duplicate.
- `mediation_state` answers with what setup is missing instead of erring and
  naming a different tool, and caps its lists: a busy project is counted, not
  dumped. Completed work now shows its summaries.

**Coordination signal.**

- Heartbeats carry `git status --porcelain`. The beat is the only thing that
  fires while an agent codes without calling tools, so overlap data stays fresh
  through exactly the window where a collision forms unnoticed. Agents predict
  their own file lists badly; the working tree does not guess.
- Sessions report a worktree id. Two harnesses in one checkout share a working
  tree, so their identical dirty files no longer read as a conflict.
- Task-wording similarity only speaks when there is no file or component
  evidence. With several agents on one subsystem it fired constantly and
  drowned the hard signals.
- Conflict warnings carry the claim's age.

**News.** Events now carry scope (claim, files, author), so anything relevant to
an agent rides back on a call it was already making: no poll, no extra round
trip, relevance-filtered to its own files and delivered once. `blocked` becomes
a real edge via `blockedOn`: the blocker is told someone is waiting, and the
waiter is told when it clears. Findings can name the files they are about and a
kind (`root-cause`, `gotcha`, `decision`, `api-change`), and now survive their
claim: a claim row is deleted when its session dies, and what an agent learned
must not die with it.

**A claim outlives its session.** The MCP client is a child process a harness
recycles freely, and its `shutdown()` deleted every claim it held. An agent
whose process restarted mid-task kept editing with its coordination record
gone, and since dirty-file widening only ever widens a *claim*, a session
holding none contributed nothing to any overlap check: the live work was
uncovered, not merely mislabelled. This is the same symptom as the two
instruction bugs below, reached without any instruction being disobeyed.

- Ending a session leaves its claims standing. Whoever was blocked on one is
  still released, because an agent that vanishes mid-block may never return.
- Idle expiry and forced release now tombstone (`status: "expired"` /
  `"released"`) instead of deleting. The row is what lets the server answer a
  returning agent at all.
- Touching a claim is authorized against the caller, so a later session can
  adopt one whose session ended, and revive one that expired. Adoption is keyed
  on the `developer` the server set from the authenticated credential and
  narrowed by worktree; the worktree alone would be a hijack, since it is
  client-declared and every member can read it.
- Work that finished still lands in the history: completing an expired claim
  succeeds with its commits, and completing an already completed one merges
  rather than entering the feed twice. Every recovery says what it did in the
  response `note`; only an unknown id is still a 404, and that 404 now names
  the way forward instead of ending the conversation.

**Agents actually coordinate.** Two instruction bugs, both of which produced the
same thing: a live session holding no claims.

- The activation condition was not checkable. Everything gated on "a repository
  that contains `.mediation.json`", and that mapping is per-checkout and
  gitignored by design, so it never appears in `git status` and a fresh clone
  has none. The skill's own description gated on it too, which decided whether
  the skill was ever loaded: it now triggers on the `mediation_*` tools being
  available, and the skill answers the repository question in one step instead
  of assuming it. Both harness instructions name the two cheap ways to check
  and say to check before the first edit.
- `.mediation.json` stays out of Git, and now says so where the decision is
  made. Sharing it binds every clone to one person's server, and a fork pushes
  somewhere else, so the client refuses the stale binding until someone
  re-initializes: on a tracked file that is a dirty tree and a merge conflict
  for everyone after. `mediation_init`, the skill and the README agree on it.
- Claiming read as expensive, so it got deferred until after editing began. The
  skill asked for intent, files, components, task and branch; only `intent` is
  required. It now says to claim rough and early and refine through the same
  `claimId`, and adds the rule for the case that actually happens: already
  editing, never claimed, claim now anyway.
- Delegated work is spelled out. A subagent inside your own harness shares its
  session and may reuse your `claimId`; a separately launched agent files its
  own. Only the session that created a claim can update it.

**Dashboard.** The Now tab shows what is happening now.

- A live session that has claimed nothing renders as a *rough claim* built from
  the working tree the heartbeat already carries: agent, branch, dirty files,
  marked as derived and never confused with a published claim. An agent nobody
  can see is the problem this server exists to fix, and "nothing is claimed"
  was advice, not information.
- The client sends its first working-tree report when the session is created
  instead of one heartbeat interval later, so that rough claim is there from
  the first second.
- Completed work is history, not news: it previews the newest four and keeps
  the rest one click away, and long agent-written summaries are clamped to two
  lines. Twenty finished claims used to push the live half of the page off the
  screen.

## 0.4.2: explicit coordination boundary

- In repositories already initialized with `.mediation.json`, harness
  instructions now require agents to use the installed `mediation` skill
  before coding or delegating and to follow it for the full task.
- Uninitialized repositories stay opt-in: agents must not call
  `mediation_init` or create a mapping unless the user explicitly asks to set
  up or connect Mediation.

## 0.4.1: agents keep coordination alive

- The installer now gives Claude Code the same small, marker-owned instruction
  Codex and Kimi Code receive: for coding tasks, use the installed `mediation`
  skill for the full task. The workflow remains in one place, `SKILL.md`, and
  uninstall removes the instruction without touching surrounding user content.
- MCP heartbeats follow the server-advertised session TTL and keep running
  after transient failures instead of silently abandoning a live claim.
- Any agent can claim or resolve any project bug with
  `mediation_bug_resolve`. High and critical bugs may open a linked GitHub
  issue when `gh` is available; a closed linked issue resolves the Mediation
  bug on the next `mediation_state`.

## 0.4.0-alpha: names humans recognise

- **Fixed: your own project showed a "not a member" badge.** The card's role
  came from a freshness-gated lookup while the row beside it was listed
  through the stale-tolerant one, so five minutes after the last agent
  session an owner was labelled a stranger to their own project. `memberRole`
  now takes the same `fresh` flag as the listing that renders it.
- The **Activity** feed filters by event type, agent and project, plus free
  text, with counts on the type pills and an "N of M" line when a filter is
  on. Events now record the agent that caused them (new `events.agent`
  column, `EventEntry.agent`); the agent picker collapses the per-session
  identity `codex-4fd2545b@Kyle` to `codex@Kyle` so it lists people, not
  sessions.
- **Removed "Create project" from the dashboard.** Projects are bootstrapped
  by agents working in a repository, never typed in by a human: the empty
  state now points at `mediation_init` and the Agents page. The manual-mode
  `POST /api/projects` endpoint stays for the development configuration,
  where it is still how the test fixtures build a project; production
  (GitHub App mode) already refuses it.
- **GitHub denials now say what to do.** `GitHub App cannot access this
  repository` was a dead end: the fix (install the App on that repository) was
  discoverable only by reading the server source. The four distinct causes are
  now four messages, each with a `hint` the agent relays verbatim, and the two
  install-related ones carry the App's own install URL, discovered from
  `GET /app` and cached. `GET /api/*` error bodies pass `hint` through.
- Settings no longer offers the `mediation-agent` CLI on a GitHub App
  instance, where sessions exist only through a verified repository binding
  and those commands answer 403. That panel now lists the MCP tools in the
  order an agent calls them; the CLI stays on manual-mode instances, labelled
  as such.

- **Fixed: no coordination tool worked in a fresh install.** The MCP client
  never awaited session creation, so `mediation_check`, `claim`, `update`,
  `complete`, `bug` and `state` all failed with "session binding is not
  established" in both auth modes. A new suite (`test/mcp-client.test.ts`)
  drives the client over stdio against a stub server so this cannot recur.
- Projects are shown by their GitHub repository (`owner/name`) instead of the
  opaque uuid; `ProjectSummary` gained `name`. Routing still uses the id.
- People are shown by their GitHub login in original case
  (`KyleDerZweite`, not `gh-kylederzweite`). `PublicUser`/`ProjectMember`
  gained `displayName`, credentials gained `ownerDisplayName`, and session
  attribution records the display name. Owners can add a member by GitHub
  login (case-insensitive) as well as by handle.
- Device credentials are personal: `GET /api/auth/credentials` returns only
  the caller's own, admins included. Admins can still revoke any by id.
- The dashboard's install instructions moved from Settings to **Agents**, and
  now include a paste-ready prompt that sets a local agent up end to end.
  The instance Agents page lists only your own live sessions; a project's
  Agents tab still shows every session in that project.
- **Projects no longer vanish from the dashboard.** A GitHub grant went stale
  five minutes after the last verification and the project disappeared from
  the list. Membership and freshness are now separate: the membership row
  stands until GitHub revokes it (webhook) or an owner removes it, while the
  five-minute freshness window keeps gating agents, whose session creation
  re-verifies against GitHub anyway. A project drops out of the list only
  after **7 idle days**, and only from the list. The project, its history and
  its members are kept, it is reachable by URL, and it returns the moment an
  agent connects. Nothing ever deletes a project except an owner's explicit
  delete.
- New **design-system reference** at `#/design`, rendered from the app's own
  CSS so it cannot drift: colour, type, every button/menu/chip/avatar/icon,
  cards, tables, the event feed and feedback states. It is linked from
  nowhere. A dev instance (`AUTH_MODE=manual`) serves it signed out;
  production requires the user session. `DESIGN_SYSTEM_PUBLIC=0|1` overrides,
  and `GET /api/health` reports the resolved `designSystemPublic`.
- Overview tiles get a hue each (live green, claims blue, bugs amber,
  conflicts violet) with a coloured icon, accent rail and a hint that only
  takes colour when the number means something.
- **Fixed: the Users list showed neither GitHub names nor avatars.**
  `listUsers()` selected five columns and dropped `github_login` /
  `github_user_id`, so every row fell back to the `gh-…` handle.
- Row menus are no longer clipped by their table: the card stops hiding
  overflow, rows clip themselves to keep the rounded corners, and the row with
  an open menu is raised above its neighbours.
- The sidebar footer no longer repeats the version; it is on the Settings page.
- **Users page rebuilt.** Rows now carry the GitHub profile picture (initials
  if it fails to load), the display name over the `gh-…` handle, and a role
  chip with an icon (shield = admin, person = user). Rare and destructive
  actions moved out of the row into a ⋯ menu (disable / reactivate / delete,
  with delete arming before it fires); only *Approve* stays inline, because a
  pending account is the one row that needs acting on. Role changes go through
  a pencil button next to the chip that opens a role picker with the current
  role checked. A filter bar adds name search plus role and status filters
  with live counts, and accounts waiting for approval sort to the top.
  Avatars also appear in the sidebar footer, project members and device
  credentials; `PublicUser`/`ProjectMember` gained `avatarUrl`.
- Dashboard chrome is quieter: the sidebar "API connected" chip, the topbar
  "Synced Ns ago" pill and the top-right user chip are gone. Logout moved to
  the sidebar footer next to your name, and connection state (server, version,
  last sync, auth mode) now lives in one **Health** panel on Settings.
- Static assets are served `cache-control: no-cache`, so a proxy or browser no
  longer hands users last deploy's dashboard or install script.
- Sessions survive quiet agents: heartbeat TTL 120 s → **5 min** (client
  heartbeat every 2 min) and idle claim expiry 30 min → **45 min**, because
  real agent turns regularly run longer than half an hour.

## Unreleased Alpha: global device identity

- Per-agent pairing and relay codes are removed. After an administrator
  activates a registered user, the agent exchanges that user's password once
  for a narrow, revocable device token shared by the installed harnesses on
  the machine. Legacy bearer credentials and pending pairing requests are
  revoked during migration.
- Every running agent receives a distinct short-lived session id and secret
  capability. A process cannot heartbeat, end, update, or complete another
  process's session-scoped work merely because both share the device token.
- Global auth follows platform conventions (XDG config on Linux, Application
  Support on macOS, APPDATA on Windows). `.mediation.json` is secret-free.
- The dependency-free installer is manifest-owned, transactional, idempotent,
  supports wizard and headless flags, and configures Claude Code, Codex, Kimi
  Code, and legacy Kimi CLI. Re-running updates; uninstall removes only owned
  changes and removes global auth unless `--keep-auth` is supplied.
- Project derivation now follows Git's push-remote precedence and includes the
  GitHub owner as well as the repository, so a fork no longer silently shares
  its upstream's basename-only namespace.

Historical note: this section shipped before independent GitHub permission
verification existed. It landed in 0.4.0-alpha's GitHub App mode, where the
server resolves the repository and checks the caller's collaborator permission
before binding a session, so a device bearer can no longer reach a project by
guessing a slug. The caveat still applies to `AUTH_MODE=manual`, which is the
development configuration.

## 0.3.0-alpha: private projects

**Projects are now real, private objects.** A project has an owner and members;
only they can see or touch anything in it.

- **Membership.** Every project has an `owner` (whoever created it) and
  `member`s. Owners add people **by username** on the new project → **Members**
  tab, change roles, and remove them; anyone can leave. The last owner cannot be
  removed or demoted.
- **Creating a project.** Humans create one from the Overview page. Agents get
  one path only: starting a session on an id that does not exist creates it,
  and the user who owns the agent's credential becomes its owner.
- **Project ids come from the git remote.** `mediation_init` no longer needs a
  project name. It derives the repository name from `git remote origin` (one
  project per repository), tells the agent which id and source it used, and the
  agent must state that to you *before* you approve, so a wrong id is caught
  early. Directory names are never used. New ids must look like
  `^[a-z0-9][a-z0-9._-]{0,63}$`; existing ids keep working.
- **Clear failures instead of silence.** Hitting a project you are not in
  answers `403` with a hint you can act on ("ask an owner to add you"); an id
  that does not exist answers `404` listing the projects you *can* access,
  which usually means a typo. Agents relay both to you verbatim and stop retrying.
- **Pairing is approve-then-code.** Pending requests no longer show a code. You
  click **Approve** (or **Deny**) in the dashboard and only then does the code
  appear, and it is now **8 characters**. The credential belongs to the approver: the
  agent acts as that user, sees only that user's projects, and its sessions are
  attributed to that username no matter what the agent claims.
- **Credentials are yours.** The Agents page shows *My agents* (admins see all)
  with the owner of each credential; you can only revoke your own. A credential
  whose owner is disabled or deleted stops working immediately and must be
  re-paired.
- **Admins** can still see and reach every project from their dashboard
  session, but their *agent* credentials cannot: admin power is never delegated
  to an agent.
- `/api/health` now reports the server `version`, and the dashboard shows it in
  the sidebar footer.
- **Kimi support in the installer.** `install.sh` now also detects **Kimi Code
  CLI** (`~/.kimi-code`) and the legacy **Kimi CLI** (`~/.kimi`): it registers
  the MCP server in `<dir>/mcp.json` and installs the skill into
  `<dir>/skills/mediation/`, so Kimi users no longer wire it up by hand. A
  harness that fails to register no longer aborts the others.
- **Uninstaller.** `curl -fsSL <server>/uninstall.sh | bash` reverses the
  installer for every harness: the shared client, the claude-code MCP
  registration and skill, the codex `config.toml` and `AGENTS.md` blocks (cut
  out surgically by their `>>> mediation >>>` markers, leaving your own content
  alone), and the Kimi entries. It prints what it removed and what it did not
  find, is safe to re-run, and deliberately **keeps** your per-project
  `.mediation.json` files. They hold credentials, so it tells you how to find
  and revoke them instead.
- **The MCP client no longer trusts the directory it was spawned in.** It
  resolved `.mediation.json` from `process.cwd()`, so a harness that started it
  elsewhere could write a credential into, say, `/tmp`. State reads/writes and
  git lookups now share one base directory: an optional `directory` argument on
  `mediation_status`/`mediation_init`/`mediation_confirm`, else `$MEDIATION_DIR`,
  else the git toplevel of the working directory, else the working directory.
  If that last case is not a git repository, `mediation_init` and
  `mediation_confirm` say so loudly instead of writing in silence.

### Upgrading

Restart the server; the database migrates itself. Existing projects are adopted
by the oldest active admin (who becomes their owner), developers who already
worked in a project are added as members, and existing agent credentials are
bound to the user whose username matches their `developer` field (anything left
over goes to that admin). Back up `data/mediation.db` first. See "Upgrading" in
the README.

### Known limitations

- **No password reset.** An admin deletes the account and the person registers
  again.
- **No invitations.** Owners add existing, approved users by username; the
  person must have registered and been approved by an admin first.
- **No per-project audit trail** beyond the existing event feed, and no
  transfer of a project between owners other than promote-then-leave.
