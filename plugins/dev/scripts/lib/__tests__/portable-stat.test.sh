#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../portable-stat.sh"
source "$HERE/helpers/gnu-stat-stub.sh"
SCRATCH="$(mktemp -d)"; trap 'rm -rf "$SCRATCH"' EXIT
MOCKBIN="$SCRATCH/bin"; mkdir -p "$MOCKBIN"; ORIGINAL_PATH="$PATH"
FILE="$SCRATCH/file"; : > "$FILE"; chmod 600 "$FILE"

assert_digits() { [[ "$1" =~ ^[0-9]+$ ]]; }
assert_digits "$(portable_stat_mtime "$FILE")"
for dialect in gnu bsd; do
  "stub_${dialect}_stat" "$MOCKBIN"; PATH="$MOCKBIN:$ORIGINAL_PATH"
  out="$(portable_stat_mtime "$FILE")"; assert_digits "$out"; [[ "$out" != *File:* ]]
  out="$(portable_stat_size "$FILE")"; : "$(( out / 1024 ))"
  [[ "$(portable_stat_mode "$FILE")" == 0600 ]]
  [[ "$(portable_stat_mode_oct "$FILE")" == 384 ]]
  [[ "$(portable_stat_owner "$FILE")" == "$(id -u)" ]]
  out="$(portable_stat_mtime "$SCRATCH/missing" 2>/dev/null || true)"; [[ -z "$out" ]]
  [[ "$(portable_stat_mtime "$SCRATCH/missing" 2>/dev/null || echo 0)" == 0 ]]
  PATH="$ORIGINAL_PATH"; unstub_stat "$MOCKBIN"
done
mkdir "$SCRATCH/sticky"; chmod 1777 "$SCRATCH/sticky"
stub_bsd_stat "$MOCKBIN"; PATH="$MOCKBIN:$ORIGINAL_PATH"
[[ "$(portable_stat_mode "$SCRATCH/sticky")" == 1777 ]]
PATH="$ORIGINAL_PATH"; unstub_stat "$MOCKBIN"
source "$HERE/../portable-stat.sh"
( set -u; source "$HERE/../portable-stat.sh"; portable_stat_mtime "$FILE" >/dev/null )
echo "portable-stat: PASS"
