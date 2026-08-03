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
# Headless by default: most installs are run by agents. `[ -r /dev/tty ]` only
# checked the device node's permission bits, so a session with no controlling
# terminal passed it and then died with ENXIO on the redirect. The picker is
# opt-in now, and even then only if /dev/tty actually opens.
tty_in=0
case " $* " in *" --interactive "*) ( : < /dev/tty ) 2>/dev/null && tty_in=1;; esac
if [ "$tty_in" -eq 1 ]; then
  node "$tmp" "${args[@]}" < /dev/tty
else
  node "$tmp" "${args[@]}"
fi
