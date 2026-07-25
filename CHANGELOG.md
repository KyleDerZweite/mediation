# Changelog

## 0.4.0-alpha: names humans recognise

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

Not yet Alpha-complete: the server still needs independent GitHub permission
verification before agent-driven project creation is a security boundary.
Until that lands, a valid device bearer can present a guessed project slug.

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
