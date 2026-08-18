#!/usr/bin/env bash
# Tests for CTL-1975 — `catalyst-backup archive|state` (the teardown-grade capture + the pre/post
# diff instrument) and the two launchd agents `uninstall-services` could not previously remove.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-archive-uninstall.test.sh
#
# ── Why the harness is shaped this way ───────────────────────────────────────────────────────────
#
# ⛔ `launchctl` is MOCKED via a PATH stub (MOCKBIN) that appends every invocation to a log, and the
# real `launchctl list` is never consulted. That is not merely hygiene: `launchctl bootout gui/<uid>`
# targets a domain that is PER-USER and not per-HOME (CTL-1968), so a test that seals HOME but keeps
# the real PATH boots out THIS machine's live agents while reporting PASS. That incident is exactly
# how the guard under test came to exist.
#
# ⭐ Every "nothing happened" assertion here is paired with a POSITIVE CONTROL that makes the same
# instrument return non-zero on a case known to be present — because an empty mock log, an empty
# grep and a broken probe are the same bytes to an assertion:
#   * the refusal case (zero bootouts) is paired with the allowed case (a recorded bootout);
#   * the "no secret VALUE in the manifest" grep is paired with the same grep finding that secret
#     in the bundle's captured config, where it legitimately IS;
#   * the label filter's two catalyst labels are paired with a third, non-catalyst label the mock
#     also emits and the probe must exclude.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="${SCRIPT_DIR}/../catalyst-backup"
STACK="${SCRIPT_DIR}/../catalyst-stack"
USAGE_PAGE="${SCRIPT_DIR}/../install-usage-page.sh"

FAILURES=0
PASSES=0
ok()   { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; echo "    $2"; }
expect_eq()       { if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
expect_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else fail "$1" "'$2' lacks '$3'"; fi; }
expect_lacks()    { if [[ "$2" != *"$3"* ]]; then ok "$1"; else fail "$1" "'$2' should not contain '$3'"; fi; }
expect_file()     { if [[ -f "$2" ]]; then ok "$1"; else fail "$1" "missing file: $2"; fi; }
expect_absent()   { if [[ ! -e "$2" ]]; then ok "$1"; else fail "$1" "should not exist: $2"; fi; }
# count_in FILE NEEDLE — occurrences, and 0 for an absent/unreadable file. NOT `grep -c || echo 0`:
# grep -c already PRINTS 0 and then exits 1, so the fallback appends a second line and the caller
# compares against "0\n0". A counter whose zero is two lines is not a counter.
count_in() { local c; c="$(grep -c "$2" "$1" 2>/dev/null)"; [[ "$c" =~ ^[0-9]+$ ]] || c=0; printf '%s' "$c"; }

command -v jq      >/dev/null 2>&1 || { echo "jq required — skipping";      exit 0; }
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 required — skipping"; exit 0; }

SB="$(mktemp -d)"
trap 'rm -rf "$SB"' EXIT
mkdir -p "$SB/home/Library/LaunchAgents" "$SB/.config/catalyst" "$SB/catalyst/execution-core" \
         "$SB/catalyst/wt" "$SB/catalyst/logs" "$SB/bin" "$SB/target/catalyst" "$SB/target/config"

SECRET="sk-CTL1975-SECRET"
printf '{"catalyst":{"node":{"class":"developer"},"apiToken":"%s"}}\n' "$SECRET" > "$SB/.config/catalyst/config.json"
printf '{"token":"%s"}\n' "$SECRET"                > "$SB/.config/catalyst/config-CTL.json"
printf '<plist>stack</plist>\n'                    > "$SB/home/Library/LaunchAgents/ai.coalesce.catalyst-stack.plist"
printf '<plist>usage</plist>\n'                    > "$SB/home/Library/LaunchAgents/ai.coalesce.catalyst-usage-page.plist"
printf '<plist>other</plist>\n'                    > "$SB/home/Library/LaunchAgents/com.example.other.plist"
printf '{"orchestrators":[]}\n'                    > "$SB/catalyst/state.json"
printf 'some log bytes\n'                          > "$SB/catalyst/logs/broker.log"
sqlite3 "$SB/catalyst/catalyst.db"         "CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES('s1');"
sqlite3 "$SB/catalyst/catalyst-replica.db" "CREATE TABLE issues(id TEXT); INSERT INTO issues VALUES('CTL-1975');"

# ── MOCKBIN launchctl ────────────────────────────────────────────────────────────────────────────
# `list` emits THREE labels: two ai.coalesce.catalyst-* and one that must be filtered out. The
# third is the positive control for the filter — without it, "the probe returned our two labels"
# is also what a probe that returns everything would produce.
cat > "$SB/bin/launchctl" <<'MOCK'
#!/usr/bin/env bash
if [[ "${1:-}" == "list" ]]; then
  printf '%s\t%s\t%s\n' 4242 0 ai.coalesce.catalyst-stack
  printf '%s\t%s\t%s\n' -    0 ai.coalesce.catalyst-usage-page
  printf '%s\t%s\t%s\n' 99   0 com.example.other
  exit 0
fi
printf '%s\n' "$*" >> "${MOCK_LAUNCHCTL_LOG:-/dev/null}"
exit 0
MOCK
chmod +x "$SB/bin/launchctl"

src_env() {
  env PATH="$SB/bin:$PATH" MOCK_LAUNCHCTL_LOG="$SB/lc.log" \
      CATALYST_DIR="$SB/catalyst" \
      CATALYST_LAYER2_CONFIG_FILE="$SB/.config/catalyst/config.json" \
      CATALYST_LAUNCHAGENTS_DIR="$SB/home/Library/LaunchAgents" \
      CATALYST_HUMANLAYER_CONFIG="$SB/.config/humanlayer/humanlayer.json" \
      CATALYST_DB_FILE="$SB/catalyst/catalyst.db" \
      CATALYST_REPLICA_DB="$SB/catalyst/catalyst-replica.db" \
      CATALYST_BACKUPS_DIR="$SB/backups" \
      CATALYST_WT_DIR="$SB/catalyst/wt" \
      CATALYST_LOGS_DIR="$SB/catalyst/logs" \
      CATALYST_ASSUME_NO_DAEMONS=1 \
      "$@"
}

echo "catalyst-backup state — the pre/post diff instrument"
STATE="$(src_env bash "$BACKUP" state 2>/dev/null)"
expect_eq "state emits valid JSON" "yes" "$(printf '%s' "$STATE" | jq -e . >/dev/null 2>&1 && echo yes || echo no)"
expect_contains "reads LOADED labels from launchctl"      "$STATE" "ai.coalesce.catalyst-usage-page"
expect_lacks    "filters non-catalyst labels (pos. ctrl)" "$STATE" "com.example.other"
expect_contains "inventories plists on disk"              "$STATE" "ai.coalesce.catalyst-stack.plist"
expect_contains "inventories the replica DB"              "$STATE" "catalyst-replica.db"
expect_contains "inventories logs by name"                "$STATE" "broker.log"
expect_contains "lists per-project secret files by BASENAME only" "$STATE" "config-CTL.json"
expect_contains "records the config KEY path"             "$STATE" "catalyst.apiToken"
expect_lacks    "⭐ carries NO secret VALUE"               "$STATE" "$SECRET"

echo "catalyst-backup archive — teardown-grade capture"
AOUT="$(src_env bash "$BACKUP" archive 2>/dev/null)"; arc=$?
TARBALL="$(printf '%s\n' "$AOUT" | tail -1)"
expect_eq "archive exits 0" "0" "$arc"
expect_eq "⭐ last stdout line is the TARBALL" "yes" "$([[ "$TARBALL" == *.tar.gz ]] && echo yes || echo no)"
expect_file "tarball exists" "$TARBALL"
BUNDLE="${TARBALL%.tar.gz}"
expect_file "manifest.json in the staging bundle"   "$BUNDLE/manifest.json"
expect_file "host-state.json in the staging bundle" "$BUNDLE/host-state.json"
expect_file "replica captured"                      "$BUNDLE/runtime/catalyst-replica.db"
MEMBERS="$(tar -tzf "$TARBALL" 2>/dev/null)"
expect_contains "tarball holds manifest.json"       "$MEMBERS" "/manifest.json"
expect_contains "tarball holds host-state.json"     "$MEMBERS" "/host-state.json"
expect_contains "tarball holds the replica DB"      "$MEMBERS" "/runtime/catalyst-replica.db"
expect_eq "manifest schemaVersion 2"  "2"    "$(jq -r '.schemaVersion' "$BUNDLE/manifest.json")"
expect_eq "manifest withReplica true" "true" "$(jq -r '.withReplica'   "$BUNDLE/manifest.json")"
expect_eq "manifest hostState true"   "true" "$(jq -r '.hostState'     "$BUNDLE/manifest.json")"
expect_eq "manifest names the tarball" "$TARBALL" "$(jq -r '.tarball'  "$BUNDLE/manifest.json")"
# ⭐ POSITIVE CONTROL for the two secret greps above and below: the SAME needle in the SAME shape
# must be findable where the secret legitimately lives, or a clean manifest proves nothing.
expect_eq "⭐ pos. ctrl — the secret IS in the captured config" "1" \
  "$(count_in "$BUNDLE/config/config.json" "$SECRET")"
expect_eq "⛔ manifest.json holds no secret VALUE"   "0" "$(count_in "$BUNDLE/manifest.json"   "$SECRET")"
expect_eq "⛔ host-state.json holds no secret VALUE" "0" "$(count_in "$BUNDLE/host-state.json" "$SECRET")"

echo "catalyst-backup backup — the lean default is UNCHANGED"
BOUT="$(src_env bash "$BACKUP" backup --label plain 2>/dev/null)"
PBUNDLE="$(printf '%s\n' "$BOUT" | tail -1)"
# install-lifecycle.mjs reads this with `tail -1`; if archive's tarball line leaked into the plain
# path the install lifecycle would take a restore point it could never restore from.
expect_eq "⭐ last stdout line is still the BUNDLE dir" "yes" "$([[ -d "$PBUNDLE" ]] && echo yes || echo no)"
expect_eq "withReplica false by default" "false" "$(jq -r '.withReplica' "$PBUNDLE/manifest.json")"
expect_eq "tarball null by default"      "null"  "$(jq -r '.tarball'     "$PBUNDLE/manifest.json")"
expect_absent "replica NOT captured by default" "$PBUNDLE/runtime/catalyst-replica.db"

echo "catalyst-backup restore — the replica is restorable, not just captured"
RESTORED="$(env PATH="$SB/bin:$PATH" MOCK_LAUNCHCTL_LOG="$SB/lc.log" \
  CATALYST_DIR="$SB/target/catalyst" \
  CATALYST_LAYER2_CONFIG_FILE="$SB/target/config/config.json" \
  CATALYST_LAUNCHAGENTS_DIR="$SB/target/LaunchAgents" \
  CATALYST_HUMANLAYER_CONFIG="$SB/target/humanlayer.json" \
  CATALYST_DB_FILE="$SB/target/catalyst/catalyst.db" \
  CATALYST_REPLICA_DB="$SB/target/catalyst/catalyst-replica.db" \
  CATALYST_ASSUME_NO_DAEMONS=1 \
  bash "$BACKUP" restore "$BUNDLE" 2>&1)"
expect_file "replica restored to the live resolver's path" "$SB/target/catalyst/catalyst-replica.db"
expect_eq "restored replica is a readable DB with its row" "CTL-1975" \
  "$(sqlite3 "$SB/target/catalyst/catalyst-replica.db" "SELECT id FROM issues;" 2>/dev/null)"
# Before CTL-1975 the replica had no rel_to_dest mapping, so restore SKIPPED it with this message
# while reporting overall success — a half-restore that looked clean.
expect_lacks "restore does not call the replica an unknown artifact" "$RESTORED" "unknown artifact, skipping: runtime/catalyst-replica.db"

echo "catalyst-backup archive — an unverifiable tarball FAILS, it does not pass quietly"
# `tar` exiting 0 does not prove the archive is readable. This stub writes a file and exits 0 for
# the create, then lists NOTHING for the verify — the exact shape where success and failure are
# byte-identical to the caller unless the verify is real.
cat > "$SB/bin/tar" <<'MOCKTAR'
#!/usr/bin/env bash
case "${1:-}" in
  -czf) : > "$2"; exit 0 ;;   # "created" — but empty
  -tzf) exit 0 ;;             # lists no members at all
esac
exit 0
MOCKTAR
chmod +x "$SB/bin/tar"
BADOUT="$(src_env bash "$BACKUP" archive --label badtar 2>&1)"; badrc=$?
expect_eq "⭐ archive exits NON-zero when the tarball cannot be verified" "yes" "$([[ $badrc -ne 0 ]] && echo yes || echo no)"
expect_contains "and says so by name" "$BADOUT" "FAILED to create or verify tarball"
expect_absent "the unverifiable tarball is REMOVED, not left for 'list' to offer" \
  "$(ls -1 "$SB"/backups/*badtar*.tar.gz 2>/dev/null | head -1)"
rm -f "$SB/bin/tar"

# ── the two agents uninstall-services could not remove ───────────────────────────────────────────
echo "install-usage-page.sh --uninstall — CTL-1968 guard + MOCKBIN bootout"
: > "$SB/lc.log"
UOUT="$(env PATH="$SB/bin:$PATH" MOCK_LAUNCHCTL_LOG="$SB/lc.log" HOME="$SB/home" \
        bash "$USAGE_PAGE" --uninstall 2>&1)"; urc=$?
expect_eq "⛔ REFUSES under a scratch HOME with no declaration" "yes" "$([[ $urc -ne 0 ]] && echo yes || echo no)"
expect_contains "names the refusal"      "$UOUT" "REFUSED"
expect_eq "⛔ zero launchctl calls made"  "0" "$(wc -l < "$SB/lc.log" | tr -d ' ')"
expect_file "the plist is left alone"    "$SB/home/Library/LaunchAgents/ai.coalesce.catalyst-usage-page.plist"

# ⭐ POSITIVE CONTROL: the same command, same mock, same scratch HOME — only the declaration
# differs. Without this case, "zero launchctl calls" above is equally consistent with a mock that
# never records anything.
: > "$SB/lc.log"
UOUT2="$(env PATH="$SB/bin:$PATH" MOCK_LAUNCHCTL_LOG="$SB/lc.log" HOME="$SB/home" \
         CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1 bash "$USAGE_PAGE" --uninstall 2>&1)"; urc2=$?
expect_eq "⭐ pos. ctrl — proceeds when the caller declares launchctl is sealed" "0" "$urc2"
expect_contains "⭐ pos. ctrl — the mock DID record a bootout" "$(cat "$SB/lc.log")" "bootout gui/$(id -u)/ai.coalesce.catalyst-usage-page"
expect_absent "the usage-page plist is removed" "$SB/home/Library/LaunchAgents/ai.coalesce.catalyst-usage-page.plist"

: > "$SB/lc.log"
UOUT3="$(env PATH="$SB/bin:$PATH" MOCK_LAUNCHCTL_LOG="$SB/lc.log" HOME="$SB/home" \
         CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1 bash "$USAGE_PAGE" --uninstall 2>&1)"; urc3=$?
expect_eq "idempotent — a second uninstall still exits 0" "0" "$urc3"

echo "cmd_uninstall_services reaches both previously-unremovable agents"
# A SOURCE-EXTRACTION check, and named as one: it is the instrument that FOUND this gap (the
# function's body reached 9 agents and neither of these two). It fails closed — if the awk range
# ever stops matching, the positive control below goes to 0 and the whole block fails rather than
# silently reporting two absences.
# ⛔ FULL-LINE COMMENTS ARE STRIPPED, and that is load-bearing rather than tidy. The first cut of
# this check matched the raw body — and the comment introducing the call literally contains the
# word `stop_event_mirror`, so DELETING THE CALL still passed. Caught by mutation, not by reading:
# the mutant was verified applied and the suite stayed green. Only full-line comments are removed
# (never `sed 's/#.*//'`), so a `#` inside real code can't be mangled into a false absence.
BODY="$(awk '/^cmd_uninstall_services\(\)/,/^}/' "$STACK" | grep -v '^[[:space:]]*#')"
expect_eq "⭐ pos. ctrl — the extractor really reads the body" "yes" \
  "$([[ "$BODY" == *'CLOUD_SYNC_AGENT_PLIST'* ]] && echo yes || echo no)"
expect_contains "delegates the usage-page teardown" "$BODY" 'install-usage-page.sh" --uninstall' 
expect_contains "calls the event-mirror teardown"   "$BODY" "stop_event_mirror"

echo
echo "  ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
