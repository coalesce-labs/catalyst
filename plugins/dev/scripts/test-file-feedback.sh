#!/usr/bin/env bash
# Test suite for feedback-consent.sh + file-feedback.sh
#
# Uses PATH-stubbed `linearis` and `gh` to exercise routing logic without
# touching real APIs. CTL-183.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONSENT_SCRIPT="$SCRIPT_DIR/feedback-consent.sh"
FILE_SCRIPT="$SCRIPT_DIR/file-feedback.sh"

PASS=true
TESTS=0
FAILURES=0

fail() { echo "  FAIL: $1"; PASS=false; FAILURES=$((FAILURES + 1)); }
pass() { echo "  PASS: $1"; }
run_test() { TESTS=$((TESTS + 1)); echo ""; echo "--- Test $TESTS: $1 ---"; }

# Make a scratch dir with a minimal .catalyst/config.json.
setup_config() {
  local dir="$1"
  local contents="$2"
  [ -z "$contents" ] && contents='{}'
  mkdir -p "$dir/.catalyst"
  printf '%s' "$contents" > "$dir/.catalyst/config.json"
}

# Write a PATH stub with given contents. $1=name, $2=script body.
make_stub() {
  local dir="$1" name="$2" body="$3"
  cat > "$dir/$name" <<EOF
#!/usr/bin/env bash
$body
EOF
  chmod +x "$dir/$name"
}

# ───────────────────────────────────────────────────────────────────────────
# Consent helper tests
# ───────────────────────────────────────────────────────────────────────────

run_test "consent check on fresh config returns unset"
TMPD=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{}}'
OUT=$("$CONSENT_SCRIPT" check --config "$TMPD/.catalyst/config.json")
[ "$OUT" = "unset" ] && pass "got unset" || fail "expected unset, got: $OUT"
rm -rf "$TMPD"

run_test "consent grant writes autoFile=true + defaults"
TMPD=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{}}'
"$CONSENT_SCRIPT" grant --config "$TMPD/.catalyst/config.json" >/dev/null
AUTO=$(jq -r '.catalyst.feedback.autoFile' "$TMPD/.catalyst/config.json")
REPO=$(jq -r '.catalyst.feedback.githubRepo' "$TMPD/.catalyst/config.json")
LABELS=$(jq -r '.catalyst.feedback.labels | join(",")' "$TMPD/.catalyst/config.json")
[ "$AUTO" = "true" ] && pass "autoFile=true" || fail "autoFile=$AUTO"
[ "$REPO" = "coalesce-labs/catalyst" ] && pass "githubRepo default" || fail "repo=$REPO"
[ "$LABELS" = "auto-submitted" ] && pass "labels default" || fail "labels=$LABELS"
rm -rf "$TMPD"

run_test "consent grant is idempotent (does not overwrite existing values)"
TMPD=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":false,"githubRepo":"foo/bar","labels":["custom"]}}}'
"$CONSENT_SCRIPT" grant --config "$TMPD/.catalyst/config.json" >/dev/null
AUTO=$(jq -r '.catalyst.feedback.autoFile' "$TMPD/.catalyst/config.json")
REPO=$(jq -r '.catalyst.feedback.githubRepo' "$TMPD/.catalyst/config.json")
LABELS=$(jq -r '.catalyst.feedback.labels | join(",")' "$TMPD/.catalyst/config.json")
[ "$AUTO" = "true" ] && pass "autoFile flipped to true" || fail "autoFile=$AUTO"
[ "$REPO" = "foo/bar" ] && pass "existing repo preserved" || fail "repo=$REPO"
[ "$LABELS" = "custom" ] && pass "existing labels preserved" || fail "labels=$LABELS"
rm -rf "$TMPD"

run_test "consent check returns granted after grant"
TMPD=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":true}}}'
OUT=$("$CONSENT_SCRIPT" check --config "$TMPD/.catalyst/config.json")
[ "$OUT" = "granted" ] && pass "got granted" || fail "expected granted, got: $OUT"
rm -rf "$TMPD"

# ───────────────────────────────────────────────────────────────────────────
# File-feedback routing tests
# ───────────────────────────────────────────────────────────────────────────

run_test "skipped-no-consent when autoFile unset, exit 2"
TMPD=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{}}'
OUT=$("$FILE_SCRIPT" --title T --body B --skill oneshot \
  --config "$TMPD/.catalyst/config.json" --json)
RC=$?
STATUS=$(echo "$OUT" | jq -r .status)
[ $RC -eq 2 ] && pass "exit 2" || fail "exit=$RC"
[ "$STATUS" = "skipped-no-consent" ] && pass "status=skipped-no-consent" || fail "status=$STATUS"
rm -rf "$TMPD"

run_test "consent-required with --ensure-consent, exit 3"
TMPD=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{}}'
OUT=$("$FILE_SCRIPT" --title T --body B --skill oneshot \
  --config "$TMPD/.catalyst/config.json" --ensure-consent --json)
RC=$?
STATUS=$(echo "$OUT" | jq -r .status)
[ $RC -eq 3 ] && pass "exit 3" || fail "exit=$RC"
[ "$STATUS" = "consent-required" ] && pass "status=consent-required" || fail "status=$STATUS"
rm -rf "$TMPD"

run_test "linearis stub returns identifier → filed to linear"
TMPD=$(mktemp -d); STUB=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":true},"linear":{"teamKey":"TEST"}}}'
make_stub "$STUB" "linearis" '
if [ "$1" = "issues" ] && [ "$2" = "create" ]; then
  echo "{\"identifier\":\"TEST-42\",\"url\":\"https://linear.app/test/issue/TEST-42\"}"
elif [ "$1" = "issues" ] && [ "$2" = "update" ]; then
  echo "{\"ok\":true}"
else
  echo "{}"
fi
'
PATH="$STUB:$PATH" OUT=$("$FILE_SCRIPT" --title T --body B --skill oneshot \
  --config "$TMPD/.catalyst/config.json" --json)
RC=$?
STATUS=$(echo "$OUT" | jq -r .status)
DEST=$(echo "$OUT" | jq -r .destination)
IDENT=$(echo "$OUT" | jq -r .identifier)
URL=$(echo "$OUT" | jq -r .url)
LABELS=$(echo "$OUT" | jq -r '.labels | join(",")')
[ $RC -eq 0 ] && pass "exit 0" || fail "exit=$RC"
[ "$STATUS" = "filed" ] && pass "status=filed" || fail "status=$STATUS"
[ "$DEST" = "linear" ] && pass "destination=linear" || fail "dest=$DEST"
[ "$IDENT" = "TEST-42" ] && pass "identifier=TEST-42" || fail "ident=$IDENT"
[ "$URL" = "https://linear.app/test/issue/TEST-42" ] && pass "url set" || fail "url=$URL"
[ "$LABELS" = "auto-submitted,oneshot" ] && pass "labels=auto-submitted,oneshot" || fail "labels=$LABELS"
rm -rf "$TMPD" "$STUB"

run_test "linearis returns empty → falls through to github"
TMPD=$(mktemp -d); STUB=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":true,"githubRepo":"my/repo"},"linear":{"teamKey":"TEST"}}}'
make_stub "$STUB" "linearis" 'echo ""'
make_stub "$STUB" "gh" '
# Capture args for verification.
echo "https://github.com/my/repo/issues/7"
'
PATH="$STUB:$PATH" OUT=$("$FILE_SCRIPT" --title T --body B --skill oneshot \
  --config "$TMPD/.catalyst/config.json" --json)
RC=$?
STATUS=$(echo "$OUT" | jq -r .status)
DEST=$(echo "$OUT" | jq -r .destination)
NUM=$(echo "$OUT" | jq -r .number)
URL=$(echo "$OUT" | jq -r .url)
[ $RC -eq 0 ] && pass "exit 0" || fail "exit=$RC"
[ "$STATUS" = "filed" ] && pass "status=filed" || fail "status=$STATUS"
[ "$DEST" = "github" ] && pass "destination=github" || fail "dest=$DEST"
[ "$NUM" = "7" ] && pass "number=7" || fail "num=$NUM"
[ "$URL" = "https://github.com/my/repo/issues/7" ] && pass "url set" || fail "url=$URL"
rm -rf "$TMPD" "$STUB"

run_test "no linearis, gh present → files to github"
TMPD=$(mktemp -d); STUB=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":true,"githubRepo":"coalesce-labs/catalyst"}}}'
# Only gh stub — no linearis. Build a minimal PATH that still has jq + core utilities.
make_stub "$STUB" "gh" 'echo "https://github.com/coalesce-labs/catalyst/issues/99"'
REAL_PATH=$(dirname "$(command -v jq)"):$(dirname "$(command -v bash)"):$(dirname "$(command -v awk)"):$(dirname "$(command -v sed)")
OUT=$(PATH="$STUB:$REAL_PATH:/usr/bin:/bin" "$FILE_SCRIPT" --title T --body B --skill oneshot \
  --config "$TMPD/.catalyst/config.json" --json)
RC=$?
STATUS=$(echo "$OUT" | jq -r .status)
DEST=$(echo "$OUT" | jq -r .destination)
[ $RC -eq 0 ] && pass "exit 0" || fail "exit=$RC"
[ "$STATUS" = "filed" ] && pass "status=filed" || fail "status=$STATUS"
[ "$DEST" = "github" ] && pass "destination=github" || fail "dest=$DEST"
rm -rf "$TMPD" "$STUB"

run_test "neither CLI → failed-no-destinations, exit 1"
TMPD=$(mktemp -d); STUB=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":true}}}'
# Put deliberately-broken stubs that make `command -v` succeed but invocation
# fails — except we want command -v to FAIL, so we don't create them at all.
# Instead, shadow real tools with blockers by placing non-exec files named
# linearis/gh ahead of PATH so `command -v` doesn't find them.
# Easiest: build PATH with only the real dirs needed for jq/coreutils, and
# skip the stubdir.
JQ_DIR=$(dirname "$(command -v jq)")
OUT=$(PATH="$JQ_DIR:/usr/bin:/bin" "$FILE_SCRIPT" --title T --body B --skill oneshot \
  --config "$TMPD/.catalyst/config.json" --json)
RC=$?
STATUS=$(echo "$OUT" | jq -r .status)
[ $RC -eq 1 ] && pass "exit 1" || fail "exit=$RC"
[ "$STATUS" = "failed-no-destinations" ] && pass "status=failed-no-destinations" || fail "status=$STATUS"
rm -rf "$TMPD" "$STUB"

run_test "custom --labels merged + deduplicated with config labels + skill name"
TMPD=$(mktemp -d); STUB=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":true,"labels":["auto-submitted","critical"]},"linear":{"teamKey":"TEST"}}}'
make_stub "$STUB" "linearis" 'echo "{\"identifier\":\"TEST-1\",\"url\":\"https://linear.app/x/issue/TEST-1\"}"'
PATH="$STUB:$PATH" OUT=$("$FILE_SCRIPT" --title T --body B --skill oneshot \
  --labels "auto-submitted,extra-label" \
  --config "$TMPD/.catalyst/config.json" --json)
LABELS=$(echo "$OUT" | jq -r '.labels | join(",")')
# Expected order: config labels → --labels → skill name, deduped in-place
[ "$LABELS" = "auto-submitted,critical,extra-label,oneshot" ] && pass "labels deduped: $LABELS" || fail "labels=$LABELS"
rm -rf "$TMPD" "$STUB"

run_test "dry-run reports linear destination when linearis present"
TMPD=$(mktemp -d); STUB=$(mktemp -d)
setup_config "$TMPD" '{"catalyst":{"feedback":{"autoFile":true},"linear":{"teamKey":"TEST"}}}'
make_stub "$STUB" "linearis" 'echo "{}"'
PATH="$STUB:$PATH" OUT=$("$FILE_SCRIPT" --title T --body B --skill oneshot \
  --config "$TMPD/.catalyst/config.json" --dry-run --json)
STATUS=$(echo "$OUT" | jq -r .status)
DEST=$(echo "$OUT" | jq -r .destination)
[ "$STATUS" = "dry-run" ] && pass "status=dry-run" || fail "status=$STATUS"
[ "$DEST" = "linear" ] && pass "dest=linear" || fail "dest=$DEST"
rm -rf "$TMPD" "$STUB"

# ───────────────────────────────────────────────────────────────────────────
# Summary
# ───────────────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "Tests: $TESTS, Failures: $FAILURES"
if [ "$PASS" = "true" ]; then
  echo "All tests passed."
  exit 0
else
  echo "Some tests failed."
  exit 1
fi
