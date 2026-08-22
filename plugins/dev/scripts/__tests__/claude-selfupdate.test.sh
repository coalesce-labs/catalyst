#!/usr/bin/env bash
# claude-selfupdate.test.sh — CTL-2085. Hermetic: fake `claude`, temp HOME + event log.
# Tests the claude-selfupdate.sh script's core behaviors:
#   1. Runs `claude update` and emits node.claude.update.updated on a new version
#   2. Fail-open: a failing `claude update` exits 0 and emits node.claude.update.failed
#   3. Throttle: a second run inside the min-interval is a no-op (no second run)
#   4. Missing `claude` on PATH — exits 0, no crash (fail-open)
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/claude-selfupdate.sh"
fail=0
note(){ echo "  FAIL: $1" >&2; }

# Fail fast if the script doesn't exist.
if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: claude-selfupdate.sh not found at $SCRIPT" >&2
  exit 1
fi

# --- case 1: runs `claude update` and emits node.claude.update.* on a new version ---
tmp="$(mktemp -d)"; bin="$tmp/bin"; mkdir -p "$bin" "$tmp/catalyst/events"
cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  --version) echo "2.1.100 (Claude Code)";;
  update|upgrade) echo "Updated to 2.1.237";;
esac
EOF
chmod +x "$bin/claude"
PATH="$bin:$PATH" HOME="$tmp" CATALYST_EVENTS_DIR="$tmp/catalyst/events" \
  CATALYST_CLAUDE_UPDATE_MIN_INTERVAL_MS=0 bash "$SCRIPT"
rc=$?
if [[ $rc -ne 0 ]]; then
  note "c1: exit $rc (expected 0)"; fail=1
fi
event_found=0
for f in "$tmp/catalyst/events/"*.jsonl; do
  [[ -f "$f" ]] && grep -q '"node\.claude\.update\.' "$f" 2>/dev/null && event_found=1 || true
done
[[ $event_found -eq 1 ]] || { note "c1: no node.claude.update.* event emitted"; fail=1; }
# Marker must be written
[[ -f "$tmp/catalyst/.claude-selfupdate.last" ]] || { note "c1: throttle marker not written"; fail=1; }

# --- case 2: fail-open — a failing `claude update` exits 0 and emits ...failed ---
mkdir -p "$tmp/catalyst/events2"
cat > "$bin/claude" <<'EOF'
#!/usr/bin/env bash
case "$1" in --version) echo "2.1.100";; update|upgrade) echo "boom" >&2; exit 3;; esac
EOF
chmod +x "$bin/claude"
PATH="$bin:$PATH" HOME="$tmp" CATALYST_EVENTS_DIR="$tmp/catalyst/events2" \
  CATALYST_CLAUDE_UPDATE_MIN_INTERVAL_MS=0 bash "$SCRIPT"
rc=$?
if [[ $rc -ne 0 ]]; then
  note "c2: exit $rc (expected 0 — must fail-open)"; fail=1
fi
failed_found=0
for f in "$tmp/catalyst/events2/"*.jsonl; do
  [[ -f "$f" ]] && grep -q '"node\.claude\.update\.failed' "$f" 2>/dev/null && failed_found=1 || true
done
[[ $failed_found -eq 1 ]] || { note "c2: no node.claude.update.failed event"; fail=1; }

# --- case 3: throttle — a second run inside the min-interval is a no-op (no second run) ---
runs="$tmp/runs"; : > "$runs"
mkdir -p "$tmp/catalyst/events3"
cat > "$bin/claude" <<EOF
#!/usr/bin/env bash
case "\$1" in --version) echo "2.1.100";; update|upgrade) echo x >> "$runs";; esac
EOF
chmod +x "$bin/claude"
for i in 1 2; do
  PATH="$bin:$PATH" HOME="$tmp" CATALYST_EVENTS_DIR="$tmp/catalyst/events3" \
    CATALYST_CLAUDE_UPDATE_MIN_INTERVAL_MS=999999999 bash "$SCRIPT"
done
run_count="$(wc -l < "$runs" | tr -d ' ')"
if [[ "$run_count" -gt 1 ]]; then
  note "c3: throttle did not suppress 2nd run (expected <=1 update run, got $run_count)"; fail=1
fi

# --- case 4: missing `claude` on PATH — exits 0, no crash (fail-open) ---
PATH="/usr/bin:/bin" HOME="$tmp" CATALYST_EVENTS_DIR="$tmp/catalyst/events4" bash "$SCRIPT"
rc=$?
if [[ $rc -ne 0 ]]; then
  note "c4: exit $rc when claude absent (expected 0 — must fail-open)"; fail=1
fi

rm -rf "$tmp"
[[ $fail -eq 0 ]] && echo "PASS claude-selfupdate.test.sh" || { echo "FAIL claude-selfupdate.test.sh"; exit 1; }
