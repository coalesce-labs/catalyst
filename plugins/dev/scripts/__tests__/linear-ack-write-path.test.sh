#!/usr/bin/env bash
# linear-ack-write-path.test.sh — CTL-1958 Phase 2. linear-ack.mjs is proxy-or-refuse:
# the client_credentials mint + the direct reactionCreate/reactionDelete fallbacks are
# gone, the "latest human comment" target is read credential-free from the replica, and
# any non-`proxy` write resolution REFUSES and writes nothing. These are the enforceable
# contract for a tool whose write success path needs a live cloud proxy (manual, on a
# fleet host).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/../linear-ack.mjs"

PASS=0
FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# The tool reads the replica via node:sqlite (node >= 24) OR bun:sqlite, selected at runtime.
# CI runners may ship an older system `node` without node:sqlite, so run the tool under a
# runtime whose sqlite it can actually open: prefer `node` (the production runtime) when it can
# use node:sqlite, else fall back to `bun` (guaranteed present via setup-bun; has bun:sqlite).
if node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:').close()" >/dev/null 2>&1; then
  RUNTIME=node
elif command -v bun >/dev/null 2>&1; then
  RUNTIME=bun
else
  RUNTIME=node  # last resort — surfaces the real error rather than hiding it
fi
echo "# tool runtime: ${RUNTIME}"

# --- Static grep gate (with a positive control so a zero is evidence, not a mistyped path) ---
FORBIDDEN='client_credentials|LINEAR_SYNC_CLIENT_ID|OAUTH|reactionCreate|reactionDelete'
# Positive control: the same pattern MUST hit a fixture that carries those strings, proving
# the grep works before we trust its zero over the tool (AGENTS.md: report a negative only
# after a positive control).
CTRL_FIXTURE="$(mktemp)"
printf 'grant_type=client_credentials\nLINEAR_SYNC_CLIENT_ID=x\nconst OAUTH=1\nreactionCreate reactionDelete\n' >"$CTRL_FIXTURE"
if grep -Eq "$FORBIDDEN" "$CTRL_FIXTURE"; then
  ok "positive control: forbidden-pattern grep matches a known-present fixture"
else
  bad "positive control FAILED — the grep would report a false zero; static gate is not trustworthy"
fi
rm -f "$CTRL_FIXTURE"

# grep -c exits 1 on a zero count, so capture with `|| true` (pipefail would otherwise
# propagate that as a spurious failure).
FORBIDDEN_COUNT="$(grep -Ec "$FORBIDDEN" "$TOOL" || true)"
if [[ "${FORBIDDEN_COUNT:-1}" -eq 0 ]]; then
  ok "linear-ack.mjs contains no mint/OAuth/direct-reaction strings"
else
  bad "linear-ack.mjs still contains a forbidden string ($(grep -Eo "$FORBIDDEN" "$TOOL" | sort -u | tr '\n' ' '))"
fi

# --- node --check (syntax) ---
if node --check "$TOOL" 2>/dev/null; then
  ok "node --check linear-ack.mjs"
else
  bad "linear-ack.mjs failed node --check"
fi

# --- Hermetic replica seeding helper ---
seed_replica() { # $1=db path  $2=with_human_comment(1/0)
  local db="$1" withc="$2"
  sqlite3 "$db" <<SQL
CREATE TABLE issues (id TEXT PRIMARY KEY, identifier TEXT, title TEXT, removed_at INTEGER);
CREATE TABLE comments (id TEXT PRIMARY KEY, issue_id TEXT, body TEXT, updated_at INTEGER,
  removed_at INTEGER, author_id TEXT, author_name TEXT, author_avatar_url TEXT,
  is_bot INTEGER, parent_id TEXT, created_at INTEGER);
INSERT INTO issues VALUES ('issue-1','CTL-1','t',NULL);
SQL
  if [[ "$withc" == "1" ]]; then
    sqlite3 "$db" "INSERT INTO comments (id,issue_id,is_bot,author_id,removed_at,created_at) VALUES ('c-1','issue-1',0,'c2a8cc92-cab6-4536-9500-0f24abdf702b',NULL,100);"
  fi
}

# Run the tool hermetically: temp HOME (no Layer-2 leak), explicit proxy mode + replica.
# Captures stderr+stdout and the exit code. Usage: run_tool <mode|-> <replica_db> <args...>
run_tool() {
  local mode="$1" db="$2"; shift 2
  local home; home="$(mktemp -d)"
  local out rc=0
  if [[ "$mode" == "-" ]]; then
    out="$(HOME="$home" CATALYST_REPLICA_DB="$db" env -u CATALYST_LINEAR_WRITE_PROXY \
      "$RUNTIME" "$TOOL" "$@" 2>&1)" || rc=$?
  else
    out="$(HOME="$home" CATALYST_REPLICA_DB="$db" CATALYST_LINEAR_WRITE_PROXY="$mode" \
      "$RUNTIME" "$TOOL" "$@" 2>&1)" || rc=$?
  fi
  rm -rf "$home"
  LAST_OUT="$out"; LAST_RC="$rc"
}

# --- Refuse contract: off / shadow / unset all refuse loudly and write nothing ---
DB_WITH="$(mktemp -u).db"; seed_replica "$DB_WITH" 1
for m in off shadow -; do
  run_tool "$m" "$DB_WITH" CTL-1
  label="${m/-/unset}"
  if [[ "$LAST_RC" -ne 0 ]] && printf '%s' "$LAST_OUT" | grep -q "REFUSED"; then
    ok "refuse: mode=${label} → non-zero exit + REFUSED reason"
  else
    bad "refuse: mode=${label} → expected non-zero+REFUSED (rc=${LAST_RC}, out=${LAST_OUT})"
  fi
done

# --- No human comment: seeded-but-empty replica → 'no human comment', exit 0 ---
DB_EMPTY="$(mktemp -u).db"; seed_replica "$DB_EMPTY" 0
run_tool off "$DB_EMPTY" CTL-1
if [[ "$LAST_RC" -eq 0 ]] && printf '%s' "$LAST_OUT" | grep -q "no human comment"; then
  ok "no human comment → exit 0, 'no human comment'"
else
  bad "no human comment path (rc=${LAST_RC}, out=${LAST_OUT})"
fi

# --- --comment-id fast path skips the replica read entirely ---
# Point at a NONEXISTENT replica: a read would throw ReplicaUnavailableError. With
# --comment-id the read is skipped, so we reach the refuse decision (not a replica error).
run_tool off "/nonexistent/replica-xyz.db" CTL-1 --comment-id c-supplied
if [[ "$LAST_RC" -ne 0 ]] && printf '%s' "$LAST_OUT" | grep -q "REFUSED" \
   && ! printf '%s' "$LAST_OUT" | grep -qi "replica unreadable"; then
  ok "--comment-id fast path skips the read (refuse, not a replica error)"
else
  bad "--comment-id fast path (rc=${LAST_RC}, out=${LAST_OUT})"
fi

# --- Loud-fail: missing replica + no --comment-id → throws about the replica, not silent ---
run_tool off "/nonexistent/replica-xyz.db" CTL-1
if [[ "$LAST_RC" -ne 0 ]] && printf '%s' "$LAST_OUT" | grep -qi "replica"; then
  ok "missing replica (no --comment-id) fails LOUD about the replica"
else
  bad "missing replica should fail loud (rc=${LAST_RC}, out=${LAST_OUT})"
fi

# --- Handled-but-NOT-applied: enforce + valid replica + NO cloud key. The proxy returns
# {handled:true, applied:false, reason:"no-cloud-token"} (linear-write-proxy.mjs fail()), which
# is its shape for EVERY genuine write failure (401/403, 429, 5xx, no-token, host-budget refuse).
# The reaction IS the whole operation, so the tool MUST fail LOUDLY (non-zero exit) — never print
# applied:false with exit 0. Regression guard for the CTL-1958 verify HIGH: the old
# `!res?.handled`-only guard passed this and silently reported the failed reaction as success.
# HOME is a throwaway (no Layer-2) and the cloud-token env vars are stripped so the no-token
# refusal is reached hermetically (this session's ambient CATALYST_CLOUD_TOKEN must not leak in).
home_hba="$(mktemp -d)"
out_hba=""; rc_hba=0
out_hba="$(HOME="$home_hba" CATALYST_REPLICA_DB="$DB_WITH" CATALYST_LINEAR_WRITE_PROXY=enforce \
  env -u CATALYST_CLOUD_TOKEN -u CATALYST_CLOUD_TOKEN_ENV \
  "$RUNTIME" "$TOOL" CTL-1 2>&1)" || rc_hba=$?
rm -rf "$home_hba"
if [[ "$rc_hba" -ne 0 ]] \
   && printf '%s' "$out_hba" | grep -q "REFUSED" \
   && ! printf '%s' "$out_hba" | grep -q '"applied":false'; then
  ok "enforce + no cloud key → proxy handled:true/applied:false → non-zero exit + REFUSED (not a silent applied:false, exit 0)"
else
  bad "handled-but-not-applied should fail loud (rc=${rc_hba}, out=${out_hba})"
fi

rm -f "$DB_WITH" "$DB_EMPTY"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
