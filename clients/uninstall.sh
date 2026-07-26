#!/usr/bin/env bash
# Offline-safe when copied by the installer: the helper is stored locally.
# Harness paths owned through the manifest: .claude/skills/mediation,
# .codex/config.toml, .kimi-code, and .kimi.
set -euo pipefail
if [ -n "${MEDIATION_HOME:-}" ]; then
  root="$MEDIATION_HOME"
elif [ "$(uname -s)" = "Darwin" ]; then
  root="$HOME/Library/Application Support/Mediation"
else
  root="${XDG_DATA_HOME:-$HOME/.local/share}/mediation"
fi
helper="$root/mediation-installer.mjs"
if [ -f "$helper" ]; then
  exec node "$helper" --uninstall "$@"
fi
legacy_root="${XDG_DATA_HOME:-$HOME/.local/share}/mediation"
if [ -f "$legacy_root/mediation-mcp.mjs" ]; then
  root="$legacy_root"
fi

# Pre-Alpha fallback: those installs predate the local manifest/helper. Only
# remove exact marker blocks and MCP entries that point at Mediation's legacy
# shared client; leave anything ambiguous for the user.
client="$root/mediation-mcp.mjs"
begin_toml='# >>> mediation >>>'; end_toml='# <<< mediation <<<'
begin_md='<!-- >>> mediation >>> -->'; end_md='<!-- <<< mediation <<< -->'

drop_block() {
  file="$1"; begin="$2"; end="$3"
  [ -f "$file" ] || return 0
  [ "$(grep -xcF "$begin" "$file" || true)" = 1 ] || return 0
  [ "$(grep -xcF "$end" "$file" || true)" = 1 ] || return 0
  tmp="$(mktemp "${TMPDIR:-/tmp}/mediation-uninstall.XXXXXX")"
  awk -v b="$begin" -v e="$end" '$0==b{skip=1} skip!=1{print} $0==e{skip=0}' "$file" > "$tmp"
  chmod --reference="$file" "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
}
drop_skill() {
  dir="$1"; skill="$dir/SKILL.md"
  if [ -f "$skill" ] && grep -q '^name:[[:space:]]*mediation[[:space:]]*$' "$skill"; then
    rm -f "$skill"; rmdir "$dir" 2>/dev/null || true
  fi
}
drop_json() {
  file="$1"; [ -f "$file" ] || return 0
  node -e '
    const fs = require("node:fs"), [file, client] = process.argv.slice(1);
    let value;
    try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
    const entry = value?.mcpServers?.mediation;
    if (!entry || entry.command !== "node" || entry.args?.[0] !== client) process.exit(0);
    delete value.mcpServers.mediation;
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  ' "$file" "$client"
}

if command -v claude >/dev/null 2>&1; then
  claude_entry="$(claude mcp get mediation 2>&1 || true)"
  case "$claude_entry" in *"$client"*) claude mcp remove --scope user mediation >/dev/null 2>&1 || true;; esac
fi
drop_skill "$HOME/.claude/skills/mediation"
drop_block "${CLAUDE_HOME:-$HOME/.claude}/CLAUDE.md" "$begin_md" "$end_md"
drop_block "${CODEX_HOME:-$HOME/.codex}/config.toml" "$begin_toml" "$end_toml"
drop_block "${CODEX_HOME:-$HOME/.codex}/AGENTS.md" "$begin_md" "$end_md"
for dir in "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${KIMI_SHARE_DIR:-$HOME/.kimi}"; do
  drop_json "$dir/mcp.json"
  drop_skill "$dir/skills/mediation"
  drop_block "$dir/AGENTS.md" "$begin_md" "$end_md"
done
rm -f "$root/mediation-mcp.mjs" "$root/SKILL.md"
rmdir "$root" 2>/dev/null || true
echo "legacy Mediation install removed; per-project .mediation.json files were preserved" >&2
