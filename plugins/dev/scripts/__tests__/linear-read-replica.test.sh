#!/usr/bin/env bash
# linear-read-replica.test.sh — CTL-1397: unit tests for the direct-SQLite Linear
# read helper (lib/linear-read-replica.sh). Covers the two-gate freshness check
# (writer.lock heartbeat + sync_meta cursor), the normalized SQL HIT shape (which
# must match `catalyst-linear read` / `linearis issues read`), and the LOUD
# linearis fallback on stale / seed-incomplete / absent-lock / MISS.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../lib/linear-read-replica.sh"

PASS=0
FAIL=0
ok() {
	PASS=$((PASS + 1))
	printf '  PASS: %s\n' "$1"
}
fail() {
	FAIL=$((FAIL + 1))
	printf '  FAIL: %s\n    %s\n' "$1" "$2"
}
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }

command -v sqlite3 >/dev/null 2>&1 || {
	echo "SKIP: sqlite3 not available"
	exit 0
}
command -v jq >/dev/null 2>&1 || {
	echo "SKIP: jq not available"
	exit 0
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Fixture replica DB (a realistic subset of the live schema) ────────────────
DB="$TMP/replica.db"
sqlite3 "$DB" <<'SQL'
CREATE TABLE issues (id TEXT PRIMARY KEY, identifier TEXT, title TEXT, state TEXT,
  estimate REAL, description TEXT, url TEXT, branch_name TEXT, assignee TEXT,
  assignee_id TEXT, priority INTEGER, removed_at INTEGER);
CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT);
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO issues (id,identifier,title,state,estimate,description,url,assignee_id,assignee,priority,removed_at)
  VALUES ('i1','TST-1','Fix the thing','Implement',3,'A description','https://linear.app/x/TST-1','u1','Ryan',2,NULL);
INSERT INTO issues (id,identifier,title,state,removed_at) VALUES ('i2','TST-2','Tombstoned','Done',12345);
INSERT INTO labels (id,name) VALUES ('l1','bug'),('l2','backend');
INSERT INTO issue_labels (issue_id,label_id) VALUES ('i1','l1'),('i1','l2');
INSERT INTO sync_meta (key,value) VALUES ('cursor','9999');
SQL

fresh_lock() { : >"$DB.writer.lock"; } # heartbeat = now
fresh_lock

export CATALYST_REPLICA_DB="$DB"
# shellcheck source=/dev/null
source "$HELPER"

# ── linearis stub on PATH for the fallback cases ──────────────────────────────
STUBBIN="$TMP/bin"
mkdir -p "$STUBBIN"
cat >"$STUBBIN/linearis" <<'EOF'
#!/usr/bin/env bash
echo "LINEARIS_CALLED $*" >&2
echo '{"identifier":"FALLBACK","state":{"name":"FromLinearis"}}'
EOF
chmod +x "$STUBBIN/linearis"
export PATH="$STUBBIN:$PATH"

echo "linear-read-replica: freshness gates + HIT shape + loud fallback"

# ── 1. Freshness gate ─────────────────────────────────────────────────────────
if replica_fresh; then ok "replica_fresh: fresh lock + cursor → true"; else fail "replica_fresh true" "returned false"; fi

# ── 2. HIT: normalized fields match the canonical shape ───────────────────────
HIT="$(linear_read_ticket TST-1 2>/dev/null)"
assert_eq "HIT: state.name" "Implement" "$(echo "$HIT" | jq -r '.state.name')"
assert_eq "HIT: estimate is 3" "3" "$(echo "$HIT" | jq -r '.estimate | floor')"
assert_eq "HIT: title" "Fix the thing" "$(echo "$HIT" | jq -r '.title')"
assert_eq "HIT: url" "https://linear.app/x/TST-1" "$(echo "$HIT" | jq -r '.url')"
assert_eq "HIT: description" "A description" "$(echo "$HIT" | jq -r '.description')"
assert_eq "HIT: labels canonical {nodes:[…]}" "backend,bug" "$(echo "$HIT" | jq -r '[.labels.nodes[].name] | sort | join(",")')"
assert_eq "HIT: assignee.name" "Ryan" "$(echo "$HIT" | jq -r '.assignee.name')"

# ── 3. HIT does NOT touch linearis (the whole point: quota relief) ─────────────
HIT_ERR="$(linear_read_ticket TST-1 2>&1 >/dev/null)"
if echo "$HIT_ERR" | grep -q "LINEARIS_CALLED"; then
	fail "HIT avoids linearis" "linearis was called on a fresh HIT"
else
	ok "HIT does not call linearis"
fi

# ── 4. Tombstoned row (removed_at set) → MISS → loud fallback ──────────────────
OUT="$(linear_read_ticket TST-2 2>"$TMP/e4.err")"
assert_eq "tombstone: fell back to linearis" "FromLinearis" "$(echo "$OUT" | jq -r '.state.name')"
if grep -q "MISS" "$TMP/e4.err"; then ok "tombstone: emitted loud MISS warning"; else fail "tombstone warning" "no MISS on stderr"; fi

# ── 5. Absent id → MISS → fallback ────────────────────────────────────────────
OUT="$(linear_read_ticket TST-999 2>/dev/null)"
assert_eq "absent id: fell back to linearis" "FromLinearis" "$(echo "$OUT" | jq -r '.state.name')"

# ── 6. Stale writer.lock (heartbeat old) → not fresh → loud fallback ──────────
touch -t 202001010000 "$DB.writer.lock"
if replica_fresh; then fail "stale lock" "replica_fresh returned true on a stale lock"; else ok "stale lock: replica_fresh → false"; fi
OUT="$(linear_read_ticket TST-1 2>"$TMP/e6.err")"
assert_eq "stale lock: fell back to linearis" "FromLinearis" "$(echo "$OUT" | jq -r '.state.name')"
if grep -q "STALE/ABSENT" "$TMP/e6.err"; then ok "stale lock: emitted loud STALE warning"; else fail "stale warning" "no STALE on stderr"; fi
fresh_lock

# ── 7. Absent writer.lock → not fresh → fallback ──────────────────────────────
rm -f "$DB.writer.lock"
if replica_fresh; then fail "absent lock" "replica_fresh returned true with no lock"; else ok "absent lock: replica_fresh → false"; fi
fresh_lock

# ── 8. Seed incomplete (no cursor row) → not fresh → fallback ─────────────────
sqlite3 "$DB" "DELETE FROM sync_meta WHERE key='cursor';"
if replica_fresh; then fail "no cursor" "replica_fresh returned true mid-reseed (no cursor)"; else ok "no cursor: replica_fresh → false"; fi
sqlite3 "$DB" "INSERT INTO sync_meta (key,value) VALUES ('cursor','9999');"
if replica_fresh; then ok "cursor restored: replica_fresh → true"; else fail "cursor restore" "still false"; fi

# ── 9. Bad ticket id → rc 2, no read attempted ────────────────────────────────
linear_read_ticket "not-a-ticket" >/dev/null 2>&1
assert_eq "bad id: rc 2" "2" "$?"

echo "─────────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
