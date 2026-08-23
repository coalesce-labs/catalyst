#!/usr/bin/env bash
# linear-reply-write-path.test.sh — CTL-1958 Phase 3. linear-reply.mjs posts through the
# cloud write proxy, credential-free: the client_credentials mint + the direct
# comment-create / reaction-delete mutations are gone, the read moves to the replica, and any
# non-`proxy` resolution REFUSES and posts nothing (AC3). The eyes-clear stays best-effort
# (never fails a posted reply). The success/threading/output-shape properties are exercised
# against a LOCAL mock cloud so they get real automated coverage, not just the manual on-host
# criteria.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/../linear-reply.mjs"

PASS=0
FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

HUMAN="c2a8cc92-cab6-4536-9500-0f24abdf702b"

# The tool reads the replica via node:sqlite (node >= 24) OR bun:sqlite, selected at runtime.
# CI runners may ship an older system `node` without node:sqlite, so run the TOOL under a
# runtime whose sqlite it can actually open: prefer `node` (the production runtime) when it can
# use node:sqlite, else fall back to `bun` (guaranteed present via setup-bun; has bun:sqlite).
# (The mock http server below stays under `node` — plain http works on any node version.)
if node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:').close()" >/dev/null 2>&1; then
  RUNTIME=node
elif command -v bun >/dev/null 2>&1; then
  RUNTIME=bun
else
  RUNTIME=node
fi
echo "# tool runtime: ${RUNTIME}"

# --- Static grep gate (+ positive control) ---
FORBIDDEN='client_credentials|LINEAR_SYNC_CLIENT_ID|OAUTH|commentCreate|reactionDelete|createAsUser|displayIconUrl'
CTRL="$(mktemp)"
printf 'client_credentials commentCreate reactionDelete createAsUser displayIconUrl OAUTH LINEAR_SYNC_CLIENT_ID\n' >"$CTRL"
if grep -Eq "$FORBIDDEN" "$CTRL"; then ok "positive control: forbidden-pattern grep matches a known fixture"
else bad "positive control FAILED — static gate untrustworthy"; fi
rm -f "$CTRL"
FCOUNT="$(grep -Ec "$FORBIDDEN" "$TOOL" || true)"
if [[ "${FCOUNT:-1}" -eq 0 ]]; then ok "linear-reply.mjs contains no mint/direct-mutation/per-agent-identity strings"
else bad "linear-reply.mjs still contains a forbidden string ($(grep -Eo "$FORBIDDEN" "$TOOL" | sort -u | tr '\n' ' '))"; fi

if node --check "$TOOL" 2>/dev/null; then ok "node --check linear-reply.mjs"; else bad "linear-reply.mjs failed node --check"; fi

# --- replica seeding ---
seed_replica() { # $1=db  $2=with_human_comment(1/0)  $3=with_parent_pair(1/0)
  local db="$1" withc="$2" withpair="${3:-0}"
  sqlite3 "$db" <<SQL
CREATE TABLE issues (id TEXT PRIMARY KEY, identifier TEXT, title TEXT, removed_at INTEGER);
CREATE TABLE comments (id TEXT PRIMARY KEY, issue_id TEXT, body TEXT, updated_at INTEGER,
  removed_at INTEGER, author_id TEXT, author_name TEXT, author_avatar_url TEXT,
  is_bot INTEGER, parent_id TEXT, created_at INTEGER);
INSERT INTO issues VALUES ('issue-1','CTL-1','t',NULL);
SQL
  [[ "$withc" == "1" ]] && sqlite3 "$db" "INSERT INTO comments (id,issue_id,is_bot,author_id,removed_at,parent_id,created_at) VALUES ('c-1','issue-1',0,'$HUMAN',NULL,NULL,100);"
  if [[ "$withpair" == "1" ]]; then
    sqlite3 "$db" "INSERT INTO comments (id,issue_id,is_bot,author_id,removed_at,parent_id,created_at) VALUES ('c-root','issue-1',0,'$HUMAN',NULL,NULL,50);"
    sqlite3 "$db" "INSERT INTO comments (id,issue_id,is_bot,author_id,removed_at,parent_id,created_at) VALUES ('c-reply','issue-1',0,'$HUMAN',NULL,'c-root',60);"
  fi
}

run_tool() { # $1=mode|-  $2=db  rest=args ; sets LAST_OUT / LAST_RC ; hermetic HOME
  local mode="$1" db="$2"; shift 2
  local home; home="$(mktemp -d)"; local out rc=0
  if [[ "$mode" == "-" ]]; then
    out="$(HOME="$home" CATALYST_DIR="$home/catalyst" CATALYST_REPLICA_DB="$db" env -u CATALYST_LINEAR_WRITE_PROXY "$RUNTIME" "$TOOL" "$@" 2>&1)" || rc=$?
  else
    out="$(HOME="$home" CATALYST_DIR="$home/catalyst" CATALYST_REPLICA_DB="$db" CATALYST_LINEAR_WRITE_PROXY="$mode" "$RUNTIME" "$TOOL" "$@" 2>&1)" || rc=$?
  fi
  rm -rf "$home"; LAST_OUT="$out"; LAST_RC="$rc"
}

# --- Refuse contract: off/shadow/unset → exit nonzero + REFUSED, nothing posted ---
DB_WITH="$(mktemp -u).db"; seed_replica "$DB_WITH" 1
for m in off shadow -; do
  run_tool "$m" "$DB_WITH" CTL-1 --as FLEET --body "hi"
  label="${m/-/unset}"
  if [[ "$LAST_RC" -ne 0 ]] && printf '%s' "$LAST_OUT" | grep -q "REFUSED"; then
    ok "refuse: mode=${label} → non-zero exit + REFUSED (no comment posted)"
  else
    bad "refuse: mode=${label} (rc=${LAST_RC}, out=${LAST_OUT})"
  fi
done

# --- Loud-fail: missing replica (issueId read is mandatory) → loud about the replica ---
run_tool off "/nonexistent/replica-xyz.db" CTL-1 --as FLEET --body "hi"
if [[ "$LAST_RC" -ne 0 ]] && printf '%s' "$LAST_OUT" | grep -qi "replica"; then
  ok "missing replica fails LOUD about the replica"
else
  bad "missing replica should fail loud (rc=${LAST_RC}, out=${LAST_OUT})"
fi

# --- Issue not in the (present) replica → 'issue not found', exit 1 ---
DB_NOISSUE="$(mktemp -u).db"; seed_replica "$DB_NOISSUE" 0
run_tool off "$DB_NOISSUE" CTL-404 --as FLEET --body "hi"
if [[ "$LAST_RC" -ne 0 ]] && printf '%s' "$LAST_OUT" | grep -qi "issue not found"; then
  ok "absent issue in a present replica → 'issue not found'"
else
  bad "absent issue path (rc=${LAST_RC}, out=${LAST_OUT})"
fi

# --- CTL-2204: --body may never be a path; --body-file is the recipe (network-free cases) ---
BODY_TMP="$(mktemp -d)"
printf '# a real comment body\nwith two lines\n' >"${BODY_TMP}/real.md"

# (a) path-as-body → exit 2 naming --body-file. Exit 2 (usage family) not 1 (REFUSED family).
run_tool - "$DB_WITH" CTL-1 --as COORD --body "${BODY_TMP}/real.md"
if [[ "$LAST_RC" -eq 2 ]] && printf '%s' "$LAST_OUT" | grep -q -- "--body-file"; then
  ok "path-as-body → exit 2 naming --body-file"
else
  bad "path-as-body guard (rc=${LAST_RC}, out=${LAST_OUT})"
fi

# (b) an absolute path that does NOT exist stays a legitimate body (guard is existence-gated,
#     so it must fall through to the ordinary refuse path, exit 1 / REFUSED — not exit 2).
run_tool - "$DB_WITH" CTL-1 --as COORD --body "${BODY_TMP}/nope.md"
if [[ "$LAST_RC" -ne 2 ]]; then
  ok "non-existent path is not treated as path-as-body"
else
  bad "non-existent path wrongly refused as a path (out=${LAST_OUT})"
fi

# (c) --body-file pointing at nothing → exit 2 naming the path
run_tool - "$DB_WITH" CTL-1 --as COORD --body-file "${BODY_TMP}/gone.md"
if [[ "$LAST_RC" -eq 2 ]] && printf '%s' "$LAST_OUT" | grep -q "gone.md"; then
  ok "--body-file missing → exit 2 naming the path"
else
  bad "--body-file missing (rc=${LAST_RC}, out=${LAST_OUT})"
fi

# (d) whitespace-only body → exit 2
run_tool - "$DB_WITH" CTL-1 --as COORD --body "   "
if [[ "$LAST_RC" -eq 2 ]]; then ok "whitespace-only --body → exit 2"
else bad "whitespace-only body (rc=${LAST_RC}, out=${LAST_OUT})"; fi

# (e) both flags → exit 2
run_tool - "$DB_WITH" CTL-1 --as COORD --body "hi" --body-file "${BODY_TMP}/real.md"
if [[ "$LAST_RC" -eq 2 ]]; then ok "--body + --body-file → exit 2 (ambiguous)"
else bad "ambiguous flags (rc=${LAST_RC}, out=${LAST_OUT})"; fi

# ============================ MOCK CLOUD (success path) ============================
MOCK_DIR="$(mktemp -d)"
MOCK_JS="${MOCK_DIR}/mock.mjs"
PORT_FILE="${MOCK_DIR}/port"
CAP_FILE="${MOCK_DIR}/capture.jsonl"
CTRL_FILE="${MOCK_DIR}/reaction-status"
echo "200" >"$CTRL_FILE"
cat >"$MOCK_JS" <<'MOCK'
import { createServer } from "node:http";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
const CAP = process.env.MOCK_CAP;
const CTRL = process.env.MOCK_CTRL;
const PORTF = process.env.MOCK_PORTF;
const srv = createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    appendFileSync(CAP, JSON.stringify({ path: req.url.split("?")[0], body: b }) + "\n");
    if (req.url.split("?")[0] === "/agent/reaction") {
      let st = "200";
      try { st = readFileSync(CTRL, "utf8").trim(); } catch {}
      if (st !== "200") { res.writeHead(Number(st)); res.end(JSON.stringify({ outcome: "rejected", reason: "mock-fail" })); return; }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ outcome: "succeeded" }));
  });
});
// Self-limiting: never outlive the test even if cleanup is broken (AGENTS.md).
setTimeout(() => process.exit(0), 20000);
srv.listen(0, "127.0.0.1", () => { writeFileSync(PORTF, String(srv.address().port)); });
MOCK

MOCK_CAP="$CAP_FILE" MOCK_CTRL="$CTRL_FILE" MOCK_PORTF="$PORT_FILE" node "$MOCK_JS" &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true  # keep the shell from printing "Terminated" when we kill it
cleanup_mock() { kill "$MOCK_PID" 2>/dev/null || true; rm -rf "$MOCK_DIR"; }
trap cleanup_mock EXIT
# Wait (bounded) for the port file.
for _ in $(seq 1 50); do [[ -s "$PORT_FILE" ]] && break; sleep 0.1; done

if [[ ! -s "$PORT_FILE" ]] || ! ps -p "$MOCK_PID" >/dev/null 2>&1; then
  bad "mock cloud failed to start — success-path coverage SKIPPED (not a code failure)"
else
  PORT="$(cat "$PORT_FILE")"
  run_mock() { # $1=db rest=args ; sets LAST_OUT/LAST_RC
    local db="$1"; shift
    local home; home="$(mktemp -d)"; local out rc=0
    : >"$CAP_FILE"
    out="$(HOME="$home" CATALYST_DIR="$home/catalyst" CATALYST_REPLICA_DB="$db" \
      CATALYST_LINEAR_WRITE_PROXY=enforce CATALYST_CLOUD_BASE_URL="http://127.0.0.1:${PORT}" \
      CATALYST_CLOUD_TOKEN=test-token CATALYST_CLOUD_ACCOUNT=test-acct \
      "$RUNTIME" "$TOOL" "$@" 2>&1)" || rc=$?
    rm -rf "$home"; LAST_OUT="$out"; LAST_RC="$rc"
  }
  comment_capture() { grep '"/agent/issue-comment"' "$CAP_FILE" | tail -1; }
  # The captured request body is a JSON-ENCODED string, so its inner quotes are
  # backslash-escaped on disk. Unescape before matching so assertions read the real payload.
  cap_has() { printf '%s' "$CAP" | sed 's/\\"/"/g' | grep -q "$1"; }
  cap_lacks() { ! printf '%s' "$CAP" | sed 's/\\"/"/g' | grep -q "$1"; }

  # (#5) default reply → posts, output shape {ok,via:proxy,parentId,eyesCleared:1}, exit 0
  echo "200" >"$CTRL_FILE"
  DB_DEF="$(mktemp -u).db"; seed_replica "$DB_DEF" 1
  run_mock "$DB_DEF" CTL-1 --as FLEET --body "hello world"
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] \
     && printf '%s' "$LAST_OUT" | grep -q '"via":"proxy"' \
     && printf '%s' "$LAST_OUT" | grep -q '"ok":true' \
     && printf '%s' "$LAST_OUT" | grep -q '"eyesCleared":1' \
     && printf '%s' "$LAST_OUT" | grep -q '"parentId":"c-1"'; then
    ok "default reply → exit 0 + output shape {ok,via:proxy,parentId:c-1,eyesCleared:1}"
  else
    bad "default reply output shape (rc=${LAST_RC}, out=${LAST_OUT})"
  fi
  if cap_has '"issueId":"issue-1"' && cap_has '"parentId":"c-1"' && cap_has '— _FLEET_'; then
    ok "default reply → comment payload carries issueId, thread-root parentId, and the --as tag in-body"
  else
    bad "default reply payload (cap=${CAP})"
  fi

  # (#4) --top → top-level (NO parentId in the payload)
  run_mock "$DB_DEF" CTL-1 --as FLEET --body "top note" --top
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] && cap_lacks '"parentId"'; then
    ok "--top → posts top-level (no parentId), exit 0"
  else
    bad "--top threading (rc=${LAST_RC}, cap=${CAP})"
  fi

  # (#4) --parent c-reply → threads under the ROOT (c-root)
  DB_PAIR="$(mktemp -u).db"; seed_replica "$DB_PAIR" 0 1
  run_mock "$DB_PAIR" CTL-1 --as FLEET --body "reply" --parent c-reply
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] && cap_has '"parentId":"c-root"'; then
    ok "--parent resolves to the thread ROOT (c-reply → c-root)"
  else
    bad "--parent root resolution (rc=${LAST_RC}, cap=${CAP})"
  fi

  # (#3) eyes-clear best-effort: reaction route 500 → reply still succeeds, exit 0, eyesCleared:0
  echo "500" >"$CTRL_FILE"
  run_mock "$DB_DEF" CTL-1 --as FLEET --body "hello again"
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] \
     && printf '%s' "$LAST_OUT" | grep -q '"eyesCleared":0' \
     && printf '%s' "$LAST_OUT" | grep -qi "NOT cleared" \
     && cap_has '"issueId":"issue-1"'; then
    ok "eyes-clear failure is best-effort: reply still posted, exit 0, eyesCleared:0"
  else
    bad "eyes-clear best-effort (rc=${LAST_RC}, out=${LAST_OUT})"
  fi
  # (CTL-2204) THE NEGATIVE CONTROL. Under enforce + a REACHABLE mock, an unguarded tool
  # would really post. Two assertions, in this order:
  #   1. POSITIVE CONTROL — a good body DOES produce an /agent/issue-comment capture, so an
  #      empty capture below means "refused", not "the mock is broken". (run_mock truncates
  #      $CAP_FILE on every call, so the two runs cannot contaminate each other.)
  #   2. the path-as-body run leaves ZERO captures.
  echo "200" >"$CTRL_FILE"
  run_mock "$DB_DEF" CTL-1 --as COORD --body "control body"
  if [[ "$LAST_RC" -eq 0 ]] && [[ -n "$(comment_capture)" ]]; then
    ok "positive control: a good body DOES reach /agent/issue-comment under the mock"
    run_mock "$DB_DEF" CTL-1 --as COORD --body "${BODY_TMP}/real.md"
    if [[ "$LAST_RC" -eq 2 ]] \
       && [[ -z "$(comment_capture)" ]] \
       && printf '%s' "$LAST_OUT" | grep -q -- "--body-file"; then
      ok "path-as-body under ENFORCE: exit 2, NOTHING posted (no /agent/issue-comment capture)"
    else
      bad "path-as-body must post nothing under enforce (rc=${LAST_RC}, cap=$(comment_capture), out=${LAST_OUT})"
    fi
  else
    bad "positive control FAILED — the no-capture assertion below would be untrustworthy"
  fi

  # (CTL-2204) --body-file posts the file's CONTENTS, and never the path.
  run_mock "$DB_DEF" CTL-1 --as COORD --body-file "${BODY_TMP}/real.md"
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] && cap_has 'a real comment body' && cap_lacks "${BODY_TMP}"; then
    ok "--body-file → the comment carries the file CONTENTS, not the path"
  else
    bad "--body-file contents (rc=${LAST_RC}, cap=${CAP})"
  fi

  rm -f "$DB_DEF" "$DB_PAIR"
fi
# =================================================================================

rm -f "$DB_WITH" "$DB_NOISSUE"
rm -rf "$BODY_TMP"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
