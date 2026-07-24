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

# ---- shared writers (uninstall.sh reverses each one) ----

install_skill() { # dir  — agentskills.io layout: <dir>/SKILL.md
  mkdir -p "$1"
  cp "$SKILL_SRC" "$1/SKILL.md"
}

# Add/replace our marker-delimited block in a file the harness reads.
# The markers are what makes this idempotent AND removable — keep them.
append_block() { # file begin end body...
  local file="$1" begin="$2" end="$3"; shift 3
  touch "$file"
  local tmp; tmp="$(mktemp)"
  # second awk drops trailing blank lines, so re-running never grows the file
  awk -v b="$begin" -v e="$end" '$0==b{skip=1} skip!=1{print} $0==e{skip=0}' "$file" \
    | awk 'NF{for(;n>0;n--) print ""; print; next} {n++}' > "$tmp"
  # $(...) ate the body's trailing newline — printf puts exactly one back
  {
    cat "$tmp"
    if [ -s "$tmp" ]; then printf '\n'; fi
    printf '%s\n' "$begin"; printf '%s\n' "$*"; printf '%s\n' "$end"
  } > "$file"
  rm -f "$tmp"
}

usage_block() { # -> markdown instructions for harnesses without skill support
  printf '## Mediation (live work coordination)\n\n'
  printf 'This machine has the `mediation` MCP server (tools `mediation_*`).\n'
  printf 'Before starting any coding task, call `mediation_check`; claim work with\n'
  printf '`mediation_claim`, report findings/bugs, and `mediation_complete` when done.\n'
  printf 'First use in a project: `mediation_init` (the project id defaults to the git\n'
  printf 'remote repo name — state it to the user; they approve the request at\n'
  printf '%s/#/agents and read back the 8-character code). Pass `directory` if your\n' "$MEDIATION_URL"
  printf 'MCP server was started outside the project directory.\n'
}

# Register the server in an { "mcpServers": {...} } JSON config (the Kimi
# format). Node is already a prerequisite, so no jq dependency.
register_mcp_json() { # file
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const [file, client, url] = process.argv.slice(1);
    let conf = {};
    try { conf = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (!conf || typeof conf !== "object" || Array.isArray(conf)) conf = {};
    conf.mcpServers = Object.assign({}, conf.mcpServers, {
      mediation: { command: "node", args: [client], env: { MEDIATION_URL: url } },
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(conf, null, 2) + "\n");
  ' "$1" "$MCP_FILE" "$MEDIATION_URL"
}

# ---- detect harnesses ----
HAVE_CLAUDE=0; HAVE_CODEX=0; HAVE_KIMI=0
command -v claude >/dev/null && HAVE_CLAUDE=1
{ command -v codex >/dev/null || [ -d "$HOME/.codex" ]; } && HAVE_CODEX=1

# Kimi ships two products that both install the `kimi` command: the current
# Kimi Code CLI (~/.kimi-code) and the legacy Kimi CLI (~/.kimi). Only the
# directory tells them apart; both read <dir>/mcp.json and <dir>/skills/.
KIMI_CODE_DIR="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
KIMI_LEGACY_DIR="${KIMI_SHARE_DIR:-$HOME/.kimi}"
KIMI_DIR=""; KIMI_KIND=""
if [ -d "$KIMI_CODE_DIR" ]; then
  KIMI_DIR="$KIMI_CODE_DIR"; KIMI_KIND="kimi-code"
elif [ -d "$KIMI_LEGACY_DIR" ]; then
  KIMI_DIR="$KIMI_LEGACY_DIR"; KIMI_KIND="kimi-cli"
elif command -v kimi >/dev/null; then
  KIMI_DIR="$KIMI_CODE_DIR"; KIMI_KIND="kimi-code" # installed but never run
fi
[ -n "$KIMI_DIR" ] && HAVE_KIMI=1

[ "$HAVE_CLAUDE" = 1 ] || [ "$HAVE_CODEX" = 1 ] || [ "$HAVE_KIMI" = 1 ] \
  || die "no supported agent harness found (looked for claude-code, codex, kimi)"

DETECTED=""
[ "$HAVE_CLAUDE" = 1 ] && DETECTED="claude-code"
[ "$HAVE_CODEX" = 1 ] && DETECTED="${DETECTED:+$DETECTED, }codex"
[ "$HAVE_KIMI" = 1 ] && DETECTED="${DETECTED:+$DETECTED, }$KIMI_KIND"
say "detected agent harnesses: $DETECTED"

PICK="a"
if [ -r /dev/tty ] && [ -t 2 ]; then
  say ""
  say "Install Mediation for:"
  [ "$HAVE_CLAUDE" = 1 ] && say "  [1] claude-code"
  [ "$HAVE_CODEX" = 1 ]  && say "  [2] codex"
  [ "$HAVE_KIMI" = 1 ]   && say "  [3] $KIMI_KIND"
  say "  [a] all detected (default)"
  printf 'choice [a]: ' >&2
  read -r PICK < /dev/tty || PICK="a"
  PICK="${PICK:-a}"
fi

DO_CLAUDE=0; DO_CODEX=0; DO_KIMI=0
case "$PICK" in
  1) DO_CLAUDE=$HAVE_CLAUDE ;;
  2) DO_CODEX=$HAVE_CODEX ;;
  3) DO_KIMI=$HAVE_KIMI ;;
  *) DO_CLAUDE=$HAVE_CLAUDE; DO_CODEX=$HAVE_CODEX; DO_KIMI=$HAVE_KIMI ;;
esac

# ---- claude-code ----
if [ "$DO_CLAUDE" = 1 ]; then
  # replace-then-add keeps the registration idempotent
  claude mcp get mediation >/dev/null 2>&1 && claude mcp remove --scope user mediation >/dev/null 2>&1 || true
  # a broken claude must not abort the other harnesses
  if claude mcp add --scope user mediation \
    --env "MEDIATION_URL=$MEDIATION_URL" \
    -- node "$MCP_FILE"; then
    say "claude-code: MCP server 'mediation' registered (user scope)"
  else
    say "claude-code: WARNING — 'claude mcp add' failed; register it yourself:"
    say "  claude mcp add --scope user mediation --env MEDIATION_URL=$MEDIATION_URL -- node $MCP_FILE"
  fi
  install_skill "$HOME/.claude/skills/mediation"
  say "claude-code: skill installed -> $HOME/.claude/skills/mediation/SKILL.md"
fi

# ---- codex ----
if [ "$DO_CODEX" = 1 ]; then
  CODEX_DIR="$HOME/.codex"
  mkdir -p "$CODEX_DIR"
  append_block "$CODEX_DIR/config.toml" '# >>> mediation >>>' '# <<< mediation <<<' "$(
    printf '[mcp_servers.mediation]\n'
    printf 'command = "node"\n'
    printf 'args = ["%s"]\n' "$MCP_FILE"
    printf 'env = { MEDIATION_URL = "%s" }\n' "$MEDIATION_URL"
  )"
  say "codex: MCP server 'mediation' configured in $CODEX_DIR/config.toml"
  append_block "$CODEX_DIR/AGENTS.md" '<!-- >>> mediation >>> -->' '<!-- <<< mediation <<< -->' "$(usage_block)"
  say "codex: usage instructions added to $CODEX_DIR/AGENTS.md"
fi

# ---- kimi ----
if [ "$DO_KIMI" = 1 ]; then
  mkdir -p "$KIMI_DIR"
  register_mcp_json "$KIMI_DIR/mcp.json"
  say "$KIMI_KIND: MCP server 'mediation' configured in $KIMI_DIR/mcp.json"
  install_skill "$KIMI_DIR/skills/mediation"
  say "$KIMI_KIND: skill installed -> $KIMI_DIR/skills/mediation/SKILL.md"
  # Only Kimi Code CLI reads a user-level AGENTS.md; legacy kimi-cli reads
  # project-level ones only, where the skill covers it instead.
  if [ "$KIMI_KIND" = "kimi-code" ]; then
    append_block "$KIMI_DIR/AGENTS.md" '<!-- >>> mediation >>> -->' '<!-- <<< mediation <<< -->' "$(usage_block)"
    say "$KIMI_KIND: usage instructions added to $KIMI_DIR/AGENTS.md"
  fi
fi

say ""
say "Done. Next step: open your agent in a project directory and say, e.g.:"
say "  \"set up mediation\""
say "The agent derives the project id from the git remote and tells you which one it picked — correct it if it is wrong."
say "Then approve the pairing request at $MEDIATION_URL/#/agents and read the revealed 8-character code to the agent. That is persistent per project directory."
say ""
say "To remove all of this again: curl -fsSL $MEDIATION_URL/uninstall.sh | bash"
