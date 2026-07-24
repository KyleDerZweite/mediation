# Changelog

## 0.3.0-alpha — private projects

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
  project name — it derives the repository name from `git remote origin` (one
  project per repository), tells the agent which id and source it used, and the
  agent must state that to you *before* you approve, so a wrong id is caught
  early. Directory names are never used. New ids must look like
  `^[a-z0-9][a-z0-9._-]{0,63}$`; existing ids keep working.
- **Clear failures instead of silence.** Hitting a project you are not in
  answers `403` with a hint you can act on ("ask an owner to add you"); an id
  that does not exist answers `404` listing the projects you *can* access —
  usually a typo. Agents relay both to you verbatim and stop retrying.
- **Pairing is approve-then-code.** Pending requests no longer show a code. You
  click **Approve** (or **Deny**) in the dashboard and only then does the code
  appear — now **8 characters**. The credential belongs to the approver: the
  agent acts as that user, sees only that user's projects, and its sessions are
  attributed to that username no matter what the agent claims.
- **Credentials are yours.** The Agents page shows *My agents* (admins see all)
  with the owner of each credential; you can only revoke your own. A credential
  whose owner is disabled or deleted stops working immediately and must be
  re-paired.
- **Admins** can still see and reach every project from their dashboard session
  — but their *agent* credentials cannot: admin power is never delegated to an
  agent.
- `/api/health` now reports the server `version`, and the dashboard shows it in
  the sidebar footer.
- **Kimi support in the installer.** `install.sh` now also detects **Kimi Code
  CLI** (`~/.kimi-code`) and the legacy **Kimi CLI** (`~/.kimi`): it registers
  the MCP server in `<dir>/mcp.json` and installs the skill into
  `<dir>/skills/mediation/`, so Kimi users no longer wire it up by hand. A
  harness that fails to register no longer aborts the others.
- **Uninstaller.** `curl -fsSL <server>/uninstall.sh | bash` reverses the
  installer for every harness — the shared client, the claude-code MCP
  registration and skill, the codex `config.toml` and `AGENTS.md` blocks (cut
  out surgically by their `>>> mediation >>>` markers, leaving your own content
  alone), and the Kimi entries. It prints what it removed and what it did not
  find, is safe to re-run, and deliberately **keeps** your per-project
  `.mediation.json` files — they hold credentials, so it tells you how to find
  and revoke them instead.
- **The MCP client no longer trusts the directory it was spawned in.** It
  resolved `.mediation.json` from `process.cwd()`, so a harness that started it
  elsewhere could write a credential into, say, `/tmp`. State reads/writes and
  git lookups now share one base directory: an optional `directory` argument on
  `mediation_status`/`mediation_init`/`mediation_confirm`, else `$MEDIATION_DIR`,
  else the git toplevel of the working directory, else the working directory —
  and if that last case is not a git repository, `mediation_init` and
  `mediation_confirm` say so loudly instead of writing in silence.

### Upgrading

Restart the server; the database migrates itself. Existing projects are adopted
by the oldest active admin (who becomes their owner), developers who already
worked in a project are added as members, and existing agent credentials are
bound to the user whose username matches their `developer` field (anything left
over goes to that admin). Back up `data/mediation.db` first — see "Upgrading" in
the README.

### Known limitations

- **No password reset.** An admin deletes the account and the person registers
  again.
- **No invitations.** Owners add existing, approved users by username; the
  person must have registered and been approved by an admin first.
- **No per-project audit trail** beyond the existing event feed, and no
  transfer of a project between owners other than promote-then-leave.
