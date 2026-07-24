#!/usr/bin/env bash
# Mediation uninstaller — reverses clients/install.sh for every harness it
# supports (claude-code, codex, kimi-code, kimi-cli):
#   curl -fsSL http://<your-server>/uninstall.sh | bash
# Needs no server URL: it only touches local paths. Idempotent, safe on partial
# installs, and it never deletes per-project .mediation.json files.
set -euo pipefail

SHARE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mediation"
BEGIN_TOML='# >>> mediation >>>'
END_TOML='# <<< mediation <<<'
BEGIN_MD='<!-- >>> mediation >>> -->'
END_MD='<!-- <<< mediation <<< -->'

say()  { printf '%s\n' "$*" >&2; }
gone() { say "removed:   $*"; }
kept() { say "not found: $*"; }

say "Mediation uninstaller"

drop_path() { # path
  if [ -e "$1" ]; then rm -rf "$1"; gone "$1"; else kept "$1"; fi
}

# Strip exactly the block install.sh appended, leaving the rest of the file
# alone. Files the user also uses for other things stay in place.
drop_block() { # file begin end
  if [ ! -f "$1" ]; then kept "$1"; return; fi
  if ! grep -qxF "$2" "$1"; then kept "mediation block in $1"; return; fi
  local tmp; tmp="$(mktemp)"
  awk -v b="$2" -v e="$3" '$0==b{skip=1} skip!=1{print} $0==e{skip=0}' "$1" > "$tmp"
  cat "$tmp" > "$1" # truncate in place: keeps the file's mode and inode
  rm -f "$tmp"
  gone "mediation block in $1"
}

# Delete the "mediation" entry from an { "mcpServers": {...} } JSON config
# without disturbing the user's other servers. Prints its own result.
drop_mcp_json() { # file label
  if [ ! -f "$1" ]; then kept "$1"; return; fi
  if ! command -v node >/dev/null; then
    say "MANUAL:    remove the \"mediation\" entry from $1 (node not available to edit it)"
    return
  fi
  if node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    let conf;
    try { conf = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(1); }
    if (!conf?.mcpServers?.mediation) process.exit(1);
    delete conf.mcpServers.mediation;
    fs.writeFileSync(file, JSON.stringify(conf, null, 2) + "\n");
  ' "$1"; then gone "MCP server 'mediation' in $1"; else kept "MCP server 'mediation' in $1"; fi
}

# ---- shared client + skill source ----
drop_path "$SHARE_DIR"

# ---- claude-code ----
if command -v claude >/dev/null; then
  if claude mcp get mediation >/dev/null 2>&1; then
    claude mcp remove --scope user mediation >/dev/null 2>&1 \
      && gone "claude-code MCP server 'mediation' (user scope)" \
      || say "MANUAL:    'claude mcp remove --scope user mediation' failed — remove it yourself"
  else
    kept "claude-code MCP server 'mediation'"
  fi
elif grep -q '"mediation"' "$HOME/.claude.json" 2>/dev/null; then
  say "MANUAL:    the claude CLI is gone but $HOME/.claude.json still mentions mediation — remove that entry by hand"
fi
drop_path "$HOME/.claude/skills/mediation"
rmdir "$HOME/.claude/skills" 2>/dev/null || true # only if we left it empty

# ---- codex ----
drop_block "$HOME/.codex/config.toml" "$BEGIN_TOML" "$END_TOML"
drop_block "$HOME/.codex/AGENTS.md" "$BEGIN_MD" "$END_MD"

# ---- kimi (current Kimi Code CLI and legacy Kimi CLI) ----
for KIMI_DIR in "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${KIMI_SHARE_DIR:-$HOME/.kimi}"; do
  if [ ! -d "$KIMI_DIR" ]; then kept "$KIMI_DIR"; continue; fi
  drop_mcp_json "$KIMI_DIR/mcp.json"
  drop_path "$KIMI_DIR/skills/mediation"
  rmdir "$KIMI_DIR/skills" 2>/dev/null || true
  drop_block "$KIMI_DIR/AGENTS.md" "$BEGIN_MD" "$END_MD"
done

say ""
say "Done. Per-project state files were NOT touched: each .mediation.json holds a"
say "bearer credential for one project. Find them with:"
say "  find ~ -name .mediation.json"
say "Delete them at your leisure, and revoke the credentials on the dashboard's Agents page."
