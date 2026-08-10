#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$(cd "${SCRIPT_DIR}/../lib" && pwd)/cloud-sync-token-probe.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
FAILURES=0
PASSES=0

check() { local name="$1"; shift; if "$@"; then PASSES=$((PASSES+1)); echo "  PASS: $name"; else FAILURES=$((FAILURES+1)); echo "  FAIL: $name"; fi; }
has_line() { grep -qxF "$1" <<<"$OUT"; }
run_probe() {
  local fixture="$1"; shift
  mkdir -p "$fixture/.config/catalyst"
  OUT="$(HOME="$fixture" CATALYST_CLOUD_TOKEN=interactive CLOUD_SYNC_CONFIG_DIR="$(cd "${SCRIPT_DIR}/../execution-core" && pwd)" cloud_sync_probe_token --host test-host "$@" 2>"$fixture/stderr")"
}

source "$LIB"

H="$TMP_ROOT/empty"; run_probe "$H"
check "default token name" has_line "name=CATALYST_CLOUD_TOKEN"
check "absent token" has_line "present=no"
check "default source" has_line "source=default"
check "interactive token ignored" has_line "present=no"

H="$TMP_ROOT/interactive-override"; mkdir -p "$H/.config/catalyst"; printf 'export CATALYST_CLOUD_TOKEN_ENV=MY_TOKEN\n' > "$H/.config/catalyst/cluster.env"; chmod 600 "$H/.config/catalyst/cluster.env"
OUT="$(HOME="$H" MY_TOKEN=interactive CLOUD_SYNC_CONFIG_DIR="$(cd "${SCRIPT_DIR}/../execution-core" && pwd)" cloud_sync_probe_token --host test-host 2>"$H/stderr")"
check "interactive overridden token ignored" has_line "present=no"

H="$TMP_ROOT/cloud"; mkdir -p "$H/.config/catalyst"; printf 'export CATALYST_CLOUD_TOKEN=abc\n' > "$H/.config/catalyst/cloud-sync.env"; chmod 600 "$H/.config/catalyst/cloud-sync.env"; run_probe "$H"
check "cloud-sync token present" has_line "present=yes"
check "cloud-sync source" has_line "source=cloud-sync.env"
check "secret absent from output" bash -c '! grep -q abc <<<"$1"' _ "$OUT"

H="$TMP_ROOT/cluster"; mkdir -p "$H/.config/catalyst"; printf 'export CATALYST_CLOUD_TOKEN=abc\n' > "$H/.config/catalyst/cluster.env"; chmod 600 "$H/.config/catalyst/cluster.env"; run_probe "$H"
check "cluster token present" has_line "present=yes"
check "cluster source" has_line "source=cluster.env"

H="$TMP_ROOT/override"; mkdir -p "$H/.config/catalyst"; printf 'export CATALYST_CLOUD_TOKEN_ENV=MY_TOKEN\nexport MY_TOKEN=abc\n' > "$H/.config/catalyst/cloud-sync.env"; chmod 600 "$H/.config/catalyst/cloud-sync.env"; run_probe "$H"
check "override name" has_line "name=MY_TOKEN"
check "override present" has_line "present=yes"

H="$TMP_ROOT/perms"; mkdir -p "$H/.config/catalyst"; printf 'export CATALYST_CLOUD_TOKEN=abc\n' > "$H/.config/catalyst/cloud-sync.env"; chmod 644 "$H/.config/catalyst/cloud-sync.env"; run_probe "$H"
check "permissive file still resolves" has_line "present=yes"
check "perms warning" has_line "perms_warning=yes"
check "secret absent from stderr" bash -c '! grep -q abc "$1"' _ "$H/stderr"

# CAT-21 Codex P1: the probe must present LAUNCHD's environment, not the caller's.
# render_cloud_sync_plist sets only PATH/HOME/CATALYST_DIR/CATALYST_HOST_NAME, so an
# override exported by the invoking shell is invisible to the daemon. These two
# redirect Layer-2 config resolution and therefore change which token variable the
# probe reports — the earlier enumerate-a-few-unsets approach missed both.
H="$TMP_ROOT/machine-config-override"; mkdir -p "$H/.config/catalyst" "$H/elsewhere"
printf 'export CATALYST_CLOUD_TOKEN=abc\n' > "$H/.config/catalyst/cloud-sync.env"; chmod 600 "$H/.config/catalyst/cloud-sync.env"
printf '{"catalyst":{"cloud":{"tokenEnv":"MY_TOKEN"}}}\n' > "$H/elsewhere/config.json"
OUT="$(HOME="$H" CATALYST_MACHINE_CONFIG="$H/elsewhere/config.json" \
       CLOUD_SYNC_CONFIG_DIR="$(cd "${SCRIPT_DIR}/../execution-core" && pwd)" \
       cloud_sync_probe_token --host test-host 2>"$H/stderr")"
check "CATALYST_MACHINE_CONFIG from the caller is ignored" has_line "name=CATALYST_CLOUD_TOKEN"

H="$TMP_ROOT/xdg-override"; mkdir -p "$H/.config/catalyst" "$H/xdg/catalyst"
printf 'export CATALYST_CLOUD_TOKEN=abc\n' > "$H/.config/catalyst/cloud-sync.env"; chmod 600 "$H/.config/catalyst/cloud-sync.env"
printf '{"catalyst":{"cloud":{"tokenEnv":"XDG_TOKEN"}}}\n' > "$H/xdg/catalyst/config.json"
OUT="$(HOME="$H" XDG_CONFIG_HOME="$H/xdg" \
       CLOUD_SYNC_CONFIG_DIR="$(cd "${SCRIPT_DIR}/../execution-core" && pwd)" \
       cloud_sync_probe_token --host test-host 2>"$H/stderr")"
check "XDG_CONFIG_HOME from the caller is ignored" has_line "source=cloud-sync.env"
check "XDG override does not rename the token" has_line "name=CATALYST_CLOUD_TOKEN"

echo
if (( FAILURES > 0 )); then echo "FAIL: $FAILURES failed, $PASSES passed"; exit 1; fi
echo "OK: $PASSES passed"
