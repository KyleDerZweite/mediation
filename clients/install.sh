#!/usr/bin/env bash
# Mediation agent-harness installer.
# Served by the mediation server with __MEDIATION_URL__ replaced, so:
#   curl -fsSL http://<your-server>/install.sh | bash
# needs no other configuration. Idempotent — safe to re-run.
set -euo pipefail

MEDIATION_URL="${MEDIATION_URL:-__MEDIATION_URL__}"
SHARE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mediation"
MCP_FILE="$SHARE_DIR/mediation-mcp.mjs"
SKILL_SRC="$SHARE_DIR/SKILL.md"

say()  { printf '%s\n' "$*" >&2; }
die()  { say "error: $*"; exit 1; }

# ---- prerequisites ----
command -v curl >/dev/null || die "curl is required"
command -v node >/dev/null || die "node >= 20 is required (https://nodejs.org)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || die "node >= 20 required, found $(node --version)"
# sentinel split in two so the server's templating can't rewrite this guard
SENTINEL="__MEDIATION""_URL__"
case "$MEDIATION_URL" in *"$SENTINEL"*) die "no server URL baked in — fetch this script from your mediation server (/install.sh) or set MEDIATION_URL";; esac

say "Mediation installer — server: $MEDIATION_URL"

# ---- download client + skill ----
mkdir -p "$SHARE_DIR"
curl -fsSL "$MEDIATION_URL/install/mediation-mcp.mjs" -o "$MCP_FILE" || die "download failed: $MEDIATION_URL/install/mediation-mcp.mjs"
curl -fsSL "$MEDIATION_URL/install/SKILL.md" -o "$SKILL_SRC" || die "download failed: $MEDIATION_URL/install/SKILL.md"
say "downloaded MCP client -> $MCP_FILE"

# ---- detect harnesses ----
HAVE_CLAUDE=0; HAVE_CODEX=0
command -v claude >/dev/null && HAVE_CLAUDE=1
{ command -v codex >/dev/null || [ -d "$HOME/.codex" ]; } && HAVE_CODEX=1
[ "$HAVE_CLAUDE" = 1 ] || [ "$HAVE_CODEX" = 1 ] || die "neither claude-code nor codex found on this machine"

DETECTED=""
[ "$HAVE_CLAUDE" = 1 ] && DETECTED="claude-code"
[ "$HAVE_CODEX" = 1 ] && DETECTED="${DETECTED:+$DETECTED, }codex"
say "detected agent harnesses: $DETECTED"

PICK="a"
if [ -r /dev/tty ] && [ -t 2 ]; then
  say ""
  say "Install Mediation for:"
  [ "$HAVE_CLAUDE" = 1 ] && say "  [1] claude-code"
  [ "$HAVE_CODEX" = 1 ]  && say "  [2] codex"
  say "  [a] all detected (default)"
  printf 'choice [a]: ' >&2
  read -r PICK < /dev/tty || PICK="a"
  PICK="${PICK:-a}"
fi

DO_CLAUDE=0; DO_CODEX=0
case "$PICK" in
  1) DO_CLAUDE=$HAVE_CLAUDE ;;
  2) DO_CODEX=$HAVE_CODEX ;;
  *) DO_CLAUDE=$HAVE_CLAUDE; DO_CODEX=$HAVE_CODEX ;;
esac

# ---- claude-code ----
if [ "$DO_CLAUDE" = 1 ]; then
  # replace-then-add keeps the registration idempotent
  claude mcp get mediation >/dev/null 2>&1 && claude mcp remove --scope user mediation >/dev/null 2>&1 || true
  claude mcp add --scope user mediation \
    --env "MEDIATION_URL=$MEDIATION_URL" \
    -- node "$MCP_FILE" \
    && say "claude-code: MCP server 'mediation' registered (user scope)" \
    || die "claude mcp add failed"
  SKILL_DIR="$HOME/.claude/skills/mediation"
  mkdir -p "$SKILL_DIR"
  cp "$SKILL_SRC" "$SKILL_DIR/SKILL.md"
  say "claude-code: skill installed -> $SKILL_DIR/SKILL.md"
fi

# ---- codex ----
if [ "$DO_CODEX" = 1 ]; then
  CODEX_DIR="$HOME/.codex"
  mkdir -p "$CODEX_DIR"
  CONF="$CODEX_DIR/config.toml"
  touch "$CONF"
  # marker-delimited block; replace if present, append otherwise
  TMP="$(mktemp)"
  awk '/^# >>> mediation >>>$/{skip=1} skip!=1{print} /^# <<< mediation <<<$/{skip=0}' "$CONF" > "$TMP"
  {
    cat "$TMP"
    printf '\n# >>> mediation >>>\n'
    printf '[mcp_servers.mediation]\n'
    printf 'command = "node"\n'
    printf 'args = ["%s"]\n' "$MCP_FILE"
    printf 'env = { MEDIATION_URL = "%s" }\n' "$MEDIATION_URL"
    printf '# <<< mediation <<<\n'
  } > "$CONF"
  rm -f "$TMP"
  say "codex: MCP server 'mediation' configured in $CONF"

  AGMD="$CODEX_DIR/AGENTS.md"
  touch "$AGMD"
  TMP="$(mktemp)"
  awk '/^<!-- >>> mediation >>> -->$/{skip=1} skip!=1{print} /^<!-- <<< mediation <<< -->$/{skip=0}' "$AGMD" > "$TMP"
  {
    cat "$TMP"
    printf '\n<!-- >>> mediation >>> -->\n'
    printf '## Mediation (live work coordination)\n\n'
    printf 'This machine has the `mediation` MCP server (tools `mediation_*`).\n'
    printf 'Before starting any coding task, call `mediation_check`; claim work with\n'
    printf '`mediation_claim`, report findings/bugs, and `mediation_complete` when done.\n'
    printf 'First use in a project: `mediation_init` (the user reads a pairing code\n'
    printf 'from the dashboard at %s/#/agents).\n' "$MEDIATION_URL"
    printf '<!-- <<< mediation <<< -->\n'
  } > "$AGMD"
  rm -f "$TMP"
  say "codex: usage instructions added to $AGMD"
fi

say ""
say "Done. Next step: open your agent in a project directory and say, e.g.:"
say "  \"set up mediation for project <name>\""
say "The agent will request pairing; read the 6-char code from $MEDIATION_URL/#/agents and paste it to the agent. That is persistent per project."
