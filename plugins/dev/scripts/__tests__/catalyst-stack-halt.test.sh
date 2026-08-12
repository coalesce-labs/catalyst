#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"; STACK="$ROOT/plugins/dev/scripts/catalyst-stack"
TMP="$(mktemp -d)"; trap 'launchctl bootout "gui/$(id -u)/ai.coalesce.catalyst-event-mirror" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home/catalyst"
cat > "$TMP/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/bin/launchctl"
for c in catalyst-broker catalyst-monitor catalyst-execution-core; do
  cat > "$TMP/bin/$c" <<EOF
#!/usr/bin/env bash
echo "$c \$*" >> "$TMP/calls"
[[ "\${1:-}" == status || "\${1:-}" == forward-status ]] && echo stopped
exit 0
EOF
  chmod +x "$TMP/bin/$c"
done
export HOME="$TMP/home" CATALYST_DIR="$TMP/home/catalyst" PATH="$TMP/bin:$PATH" CATALYST_NODE_CLASS=developer
fail=0
ok(){ "$@" || { echo "not ok: $*"; fail=$((fail+1)); }; }

ok "$STACK" stop
ok jq -e '.haltedAt and .host and .reason and .by' "$CATALYST_DIR/stack-halt.json"
# CAT-268: doctor treats numeric haltedAt as epoch seconds and multiplies by 1000.
ok jq -e '.haltedAt | type == "number"' "$CATALYST_DIR/stack-halt.json"
EVENT_FILE="$CATALYST_DIR/events/$(date -u +%Y-%m).jsonl"
ok jq -e 'select(.attributes["event.name"] == "node.stack.halted")' "$EVENT_FILE"
rm -f "$CATALYST_DIR/stack-halt.json"; ok "$STACK" stop --no-halt; ok test ! -e "$CATALYST_DIR/stack-halt.json"
ok "$STACK" stop; : > "$TMP/calls"; ok "$STACK" start --supervised; ok test ! -s "$TMP/calls"
ok jq -e 'select(.attributes["event.name"] == "node.stack.start-suppressed") | .body.payload.ageSecs | numbers' "$EVENT_FILE"
: > "$TMP/calls"; ok "$STACK" start; ok test ! -e "$CATALYST_DIR/stack-halt.json"; ok test -s "$TMP/calls"
ok bash -c "'$STACK' status 2>&1 | grep -q supervision"
ok "$STACK" stop; ok "$STACK" restart; ok test ! -e "$CATALYST_DIR/stack-halt.json"
# Malformed haltedAt must not abort the calling shell. A float reaching
# $((now - halted)) is a fatal bash arithmetic error that kills `status` outright.
# `status` is READ-ONLY (stack_halt_describe pins STACK_HALT_NO_HEAL=1): it
# classifies the marker but must NOT rename it aside, or merely looking at the
# stack would discard the operator's halt intent and let launchd revive it. The
# self-heal belongs to the mutating callers, asserted below.
for bad in 1.5 notanumber '"2026-01-01"'; do
  printf '{"haltedAt":%s,"host":"h","reason":"r","by":"u","ttlSecs":86400}\n' "$bad" \
    > "$CATALYST_DIR/stack-halt.json"
  ok bash -c "'$STACK' status >/dev/null 2>&1"
  ok test -e "$CATALYST_DIR/stack-halt.json"
  ok bash -c "! compgen -G '$CATALYST_DIR/stack-halt.json.invalid.*' >/dev/null"
done
rm -f "$CATALYST_DIR/stack-halt.json"
# A future-dated marker must expire (malformed), never pin age at 0 and strand the host.
printf '{"haltedAt":99999999999,"host":"h","reason":"r","by":"u","ttlSecs":86400}\n' \
  > "$CATALYST_DIR/stack-halt.json"
: > "$TMP/calls"; ok "$STACK" start --supervised; ok test -s "$TMP/calls"
ok test ! -e "$CATALYST_DIR/stack-halt.json"
rm -f "$CATALYST_DIR"/stack-halt.json.invalid.*

BAKE_ROOT="$ROOT"
GIT_DIR="$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null || true)"
if [[ "$GIT_DIR" == */worktrees/* ]]; then
  BAKE_ROOT="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"
fi
ok bash -c "CATALYST_FORCE_BAKE_DIR='$BAKE_ROOT/plugins/dev/scripts' '$STACK' install-services --print 2>/dev/null | grep -q '<string>--supervised</string>'"
exit "$fail"
