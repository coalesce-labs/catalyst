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
  # CTL-2204 remediation: the same runner, with fd 0 supplied. `--body -` was REWRITTEN by
  # this ticket (from `if (body === "-") readFileSync(0)` to `resolved.stdin ? …` plus a new
  # post-read emptiness check) and had no end-to-end test in either CLI — a regression that
  # dropped the resolved.stdin branch would have shipped green.
  run_mock_stdin() { # $1=db $2=stdin-source-file rest=args ; sets LAST_OUT/LAST_RC
    local db="$1"; shift
    local stdin_src="$1"; shift
    local home; home="$(mktemp -d)"; local out rc=0
    : >"$CAP_FILE"
    out="$(HOME="$home" CATALYST_DIR="$home/catalyst" CATALYST_REPLICA_DB="$db" \
      CATALYST_LINEAR_WRITE_PROXY=enforce CATALYST_CLOUD_BASE_URL="http://127.0.0.1:${PORT}" \
      CATALYST_CLOUD_TOKEN=test-token CATALYST_CLOUD_ACCOUNT=test-acct \
      "$RUNTIME" "$TOOL" "$@" <"$stdin_src" 2>&1)" || rc=$?
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

  # (CTL-2204 remediation) `--body -` reads fd 0 end-to-end, and empty stdin is a clean
  # refusal rather than a crash. The leaf only pins the {ok:true,stdin:true} SENTINEL —
  # nothing proved the CALLER actually reads fd 0.
  STDIN_BODY="${BODY_TMP}/piped.md"
  printf 'piped through stdin\n' >"$STDIN_BODY"
  run_mock_stdin "$DB_DEF" "$STDIN_BODY" CTL-1 --as COORD --body -
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] && cap_has 'piped through stdin'; then
    ok "--body - → the comment carries the text piped on stdin"
  else
    bad "--body - stdin body (rc=${LAST_RC}, cap=${CAP})"
  fi

  run_mock_stdin "$DB_DEF" /dev/null CTL-1 --as COORD --body -
  if [[ "$LAST_RC" -eq 2 ]] \
     && [[ -z "$(comment_capture)" ]] \
     && printf '%s' "$LAST_OUT" | grep -q 'stdin produced nothing'; then
    ok "--body - with EMPTY stdin → exit 2, nothing posted, names the cause"
  else
    bad "--body - empty stdin (rc=${LAST_RC}, cap=$(comment_capture), out=${LAST_OUT})"
  fi

  # (CTL-2204 remediation) The stdin path is what ask.mjs `accept` now uses to hand the body
  # to this tool, so the two argv artifacts that shape closed must be pinned HERE.
  #
  # Artifact 1 — a body whose whole value is a FLAG. `--top` is matched by whole-element
  # equality (process.argv.includes), so while the body rode argv a reply body of "--top"
  # silently flipped the post to top-level. On stdin it cannot reach argv at all.
  printf -- '--top\n' >"$STDIN_BODY"
  run_mock_stdin "$DB_DEF" "$STDIN_BODY" CTL-1 --as COORD --body -
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] && cap_has '"parentId":"c-1"'; then
    ok "a stdin body of '--top' still THREADS — a body can no longer flip routing"
  else
    bad "stdin body must not be parsed as a flag (rc=${LAST_RC}, cap=${CAP})"
  fi

  # Artifact 2 — a body that IS a path. --body-file/stdin mean "these bytes are the body",
  # so the path guard deliberately does NOT apply to them; re-refusing here is what left an
  # ask open with a message about a --body the operator never passed. The guard still fires
  # on --body (asserted above under ENFORCE) — this is the other side of that same rule.
  printf '%s\n' "${BODY_TMP}/real.md" >"$STDIN_BODY"
  run_mock_stdin "$DB_DEF" "$STDIN_BODY" CTL-1 --as COORD --body -
  CAP="$(comment_capture)"
  if [[ "$LAST_RC" -eq 0 ]] && cap_has "${BODY_TMP}/real.md"; then
    ok "a stdin body that LOOKS like a path is posted verbatim (guard is --body-only)"
  else
    bad "stdin body that looks like a path (rc=${LAST_RC}, cap=${CAP})"
  fi

  rm -f "$DB_DEF" "$DB_PAIR"
fi
# =================================================================================

rm -f "$DB_WITH" "$DB_NOISSUE"
rm -rf "$BODY_TMP"

# --- CTL-2204: the documented recipe must teach --body-file ---
# Every doc file Phase 4 rewrote gets its OWN positive-controlled check — not just
# threading.md. A future edit that reverts ask/SKILL.md's top-level usage sample back to
# `--body "<markdown>"` (the exact mistake this ticket exists to stop) is the file an agent
# actually reads first; without its own check that regression would pass CI silently.
#
# ⛔ ANCHORED ON THE INVOCATION LINE, NOT THE FILE (CTL-2204 remediation). The first cut
# grepped each file for `--body-file` ANYWHERE, which could not detect the very regression
# the paragraph above names. Measured occurrence counts: ask/SKILL.md 1, closing.md 1,
# threading.md 3, linearis/SKILL.md 3 — so for the latter two, reverting the PRIMARY sample
# line while leaving a `#   --body-file …` comment line intact still satisfied a file-wide
# grep. Confirmed by mutation on a /tmp copy: reverting threading.md's primary sample to
# `--body "<markdown>"` still yielded 29 passed, 0 failed. The check was strict for
# ask/SKILL.md only by ACCIDENT — that file happens to have exactly one occurrence.
#
# So each file now declares the exact invocation LINE an agent copies, and the check asserts
# that line is present. A comment line elsewhere in the file can no longer stand in for it.
DOCS_ROOT="${SCRIPT_DIR}/../../skills"
check_doc_teaches_body_file() { # $1=rel path  $2=positive-control string  $3=required invocation-line fragment
  local rel="$1" ctrl="$2" invocation="$3"
  local f="${DOCS_ROOT}/${rel}"
  if ! grep -q -- "$ctrl" "$f" 2>/dev/null; then
    bad "positive control FAILED — docs path/content wrong (${f}), grep result untrustworthy"
    return
  fi
  ok "positive control: docs grep instrument reads ${rel}"
  if grep -q -F -- "$invocation" "$f"; then
    ok "${rel} teaches --body-file ON the invocation line"
  else
    bad "${rel}: the documented invocation line no longer carries --body-file (wanted: ${invocation})"
  fi
}
check_doc_teaches_body_file "ask/references/threading.md" "linear-reply.mjs" \
  'linear-reply.mjs" CTL-NNNN --as <ROLE> --body-file'
check_doc_teaches_body_file "ask/SKILL.md" "linear-reply.mjs" \
  'linear-reply.mjs" CTL-NNNN --as <ROLE> --body-file'
check_doc_teaches_body_file "ask/references/closing.md" "ask.mjs" \
  '--body-file <path>  post a FILE'"'"'S CONTENTS'
check_doc_teaches_body_file "linearis/SKILL.md" "linear-reply.mjs" \
  '--body-file <path>  for anything longer than a one-line body'

# The other half of the same property: the FIRST agent-facing invocation in each file must
# not hand a bare `--body "` sample to an agent that copies the first recipe it sees. This
# is what actually catches a revert of the primary line — the presence check above cannot,
# because a reverted file could still carry the flag on a following comment line.
check_first_invocation_is_not_bare_body() { # $1=rel path  $2=tool basename
  local rel="$1" tool="$2"
  local f="${DOCS_ROOT}/${rel}" first
  first="$(grep -n -- "$tool" "$f" | grep -v '^\s*#' | grep -- '--body' | head -1)"
  if [[ -z "$first" ]]; then
    bad "positive control FAILED — no ${tool} --body line found in ${rel}"
    return
  fi
  if printf '%s' "$first" | grep -q -- '--body-file'; then
    ok "${rel}: the FIRST ${tool} invocation uses --body-file"
  else
    bad "${rel}: the FIRST ${tool} invocation uses a bare --body (${first})"
  fi
}
check_first_invocation_is_not_bare_body "ask/references/threading.md" "linear-reply.mjs"
check_first_invocation_is_not_bare_body "ask/SKILL.md" "linear-reply.mjs"

# ask/SKILL.md §5 is the `accept` recipe an agent copies when CLOSING an ask, and it is a
# SECOND invocation in the same file — so the ask.mjs recipe needs its own anchor. Before the
# CTL-2204 remediation this file's only --body-file mention was on the linear-reply line, so
# every file-level check passed while §5 taught a bare --body.
check_doc_teaches_body_file "ask/SKILL.md" "ask.mjs" \
  '--body-file <path>  for anything longer than a one-line body'


echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
