#!/usr/bin/env bash
# Thin bootstrap: the installed Node helper performs all mutation atomically.
set -euo pipefail
MEDIATION_URL="${MEDIATION_URL:-__MEDIATION_URL__}"
SENTINEL="__MEDIATION""_URL__"
case "$MEDIATION_URL" in *"$SENTINEL"*) echo 'error: fetch install.sh from your Mediation server or set MEDIATION_URL' >&2; exit 1;; esac
command -v node >/dev/null || { echo 'error: node >= 20 is required' >&2; exit 1; }
command -v curl >/dev/null || { echo 'error: curl is required' >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo 'error: node >= 20 is required' >&2; exit 1; }
tmp="$(mktemp "${TMPDIR:-/tmp}/mediation-installer.XXXXXX.mjs")"; trap 'rm -f "$tmp"' EXIT
curl -fsSL "$MEDIATION_URL/install/mediation-installer.mjs" -o "$tmp"
args=(install --server "$MEDIATION_URL")
[ "$#" -gt 0 ] && args+=("$@")
if [ "$#" -eq 0 ] && [ -r /dev/tty ]; then
  node "$tmp" "${args[@]}" < /dev/tty
else
  node "$tmp" "${args[@]}"
fi
