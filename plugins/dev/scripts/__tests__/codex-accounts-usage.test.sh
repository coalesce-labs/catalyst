#!/usr/bin/env bash
# codex-accounts-usage.test.sh — CTL-2072, the reader half.
#
# The property under test is NOT "does it print a table". It is that the tool
# never reports a healthy-looking account it did not actually read, and never
# leaks credential material. Every case runs against a FAKE `codex` that speaks
# the real app-server protocol (captured live on mini-2, codex-cli 0.147.0,
# 2026-08-22) — no network, no real account, no token spend.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../codex-accounts-usage.mjs"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

# ── the fake app-server ─────────────────────────────────────────────────────
# Speaks the measured protocol. Behaviour per home is driven by a marker file
# inside the home, so one fake serves every fixture:
#   auth.json present            -> a full, healthy answer
#   auth.json absent             -> account:null + the -32600 limits error
#   THROTTLED marker present     -> healthy RPCs but rateLimitReachedType set
# It also emits the id-less notification the live server really interleaves.
FAKE_BIN_DIR="$SCRATCH/bin"
mkdir -p "$FAKE_BIN_DIR"
cat >"$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME || "";
// The real server realpath-resolves CODEX_HOME; reproduce that faithfully.
let real = home;
try { real = fs.realpathSync(home); } catch {}
const authed = fs.existsSync(path.join(real, "auth.json"));
const throttled = fs.existsSync(path.join(real, "THROTTLED"));
const emailFile = path.join(real, "EMAIL");
const email = fs.existsSync(emailFile) ? fs.readFileSync(emailFile, "utf8").trim() : "acct@example.com";
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const parts = buf.split("\n");
  buf = parts.pop();
  for (const line of parts) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      say({ id: m.id, result: { codexHome: real, platformOs: "macos" } });
      say({ method: "remoteControl/status/changed", params: { status: "disabled" }, emittedAtMs: 1 });
    } else if (m.method === "account/read") {
      say(authed
        ? { id: m.id, result: { account: { type: "chatgpt", email, planType: "pro" }, requiresOpenaiAuth: true } }
        : { id: m.id, result: { account: null, requiresOpenaiAuth: true } });
    } else if (m.method === "account/rateLimits/read") {
      if (!authed) {
        say({ id: m.id, error: { code: -32600, message: "codex account authentication required to read rate limits" } });
        return;
      }
      const bucket = (id, name, pri, sec) => ({
        limitId: id, limitName: name, primary: pri, secondary: sec, planType: "pro",
        rateLimitReachedType: throttled ? "rate_limit_reached" : null,
      });
      say({ id: m.id, result: {
        rateLimits: bucket("codex", null, { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787802784 }, null),
        rateLimitsByLimitId: {
          codex: bucket("codex", null, { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787802784 }, null),
          codex_bengalfox: bucket("codex_bengalfox", "GPT-5.3-Codex-Spark",
            { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787463418 },
            { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788050218 }),
        },
      } });
    }
  }
});
FAKE
chmod +x "$FAKE_BIN_DIR/codex"

run() { # run <root> [args...]
	local root="$1"
	shift
	CATALYST_CODEX_ROOT="$root" CATALYST_CODEX_BIN="$FAKE_BIN_DIR/codex" \
		node "$SUBJECT" "$@" 2>&1
}

mkroot() { # mkroot <name> — a fresh discovery root, echoes its path
	local r="$SCRATCH/$1"
	mkdir -p "$r"
	echo "$r"
}

mkacct() { # mkacct <root> <handle> [--no-auth] [--throttled] [--email X]
	local root="$1" handle="$2"
	shift 2
	local d="$root/codex-home-$handle"
	mkdir -p "$d"
	local auth=1
	while [ $# -gt 0 ]; do
		case "$1" in
		--no-auth) auth=0 ;;
		--throttled) : >"$d/THROTTLED" ;;
		--email)
			shift
			printf '%s\n' "$1" >"$d/EMAIL"
			;;
		esac
		shift
	done
	[ "$auth" -eq 1 ] && printf '{}\n' >"$d/auth.json"
	echo "$d"
}

echo ""
echo "=== two healthy accounts, one active ==="
ROOT="$(mkroot two)"
mkacct "$ROOT" acct1 --email "one@example.com" >/dev/null
mkacct "$ROOT" acct2 --email "two@example.com" >/dev/null
ln -s "$ROOT/codex-home-acct2" "$ROOT/codex-home"
OUT="$(run "$ROOT" --json)"
RC=$?
[ "$RC" -eq 0 ] && pass "exit 0 when at least one account reports limits" || fail "exit 0 when at least one account reports limits" "rc=$RC" "$OUT"

if command -v jq >/dev/null 2>&1; then
	LABELS="$(jq -r '[.accounts[].label] | join(",")' <<<"$OUT" 2>/dev/null)"
	[ "$LABELS" = "acct1,acct2" ] && pass "json has accounts[] with labels" || fail "json has accounts[] with labels" "got=$LABELS"

	STATUSES="$(jq -r '[.accounts[].status] | unique | join(",")' <<<"$OUT" 2>/dev/null)"
	[ "$STATUSES" = "ok" ] && pass "both accounts classify ok" || fail "both accounts classify ok" "got=$STATUSES"

	EMAILS="$(jq -r '[.accounts[].email] | join(",")' <<<"$OUT" 2>/dev/null)"
	[ "$EMAILS" = "one@example.com,two@example.com" ] && pass "each account reports its OWN email (not a shared read)" || fail "each account reports its own email" "got=$EMAILS"

	ACTIVE="$(jq -r '.selector.activeHandle' <<<"$OUT" 2>/dev/null)"
	[ "$ACTIVE" = "acct2" ] && pass "selector symlink resolves to the active handle" || fail "selector resolves to active handle" "got=$ACTIVE"

	KIND="$(jq -r '.selector.kind' <<<"$OUT" 2>/dev/null)"
	[ "$KIND" = "symlink" ] && pass "selector kind is reported" || fail "selector kind is reported" "got=$KIND"

	ISACTIVE="$(jq -r '[.accounts[] | select(.isActive) | .label] | join(",")' <<<"$OUT" 2>/dev/null)"
	[ "$ISACTIVE" = "acct2" ] && pass "exactly the active account is flagged isActive" || fail "active account flagged" "got=$ISACTIVE"

	# ⛔ THE MEASURED CORRECTION: windows are named from windowDurationMins.
	# The `codex` bucket is WEEKLY-ONLY on the live fleet; a positional
	# primary->fiveHour mapping would call it 5h and hide the real 5h window.
	CODEXW="$(jq -r '.accounts[0].buckets[] | select(.limitId=="codex") | [.windows[].label] | join(",")' <<<"$OUT" 2>/dev/null)"
	[ "$CODEXW" = "weekly" ] && pass "the codex bucket reports weekly and no 5h window" || fail "codex bucket window labels" "got=$CODEXW"

	SPARKW="$(jq -r '.accounts[0].buckets[] | select(.limitId=="codex_bengalfox") | [.windows[].label] | sort | join(",")' <<<"$OUT" 2>/dev/null)"
	[ "$SPARKW" = "5h,weekly" ] && pass "the spark bucket reports both windows" || fail "spark bucket window labels" "got=$SPARKW"

	BIND="$(jq -r '.accounts[0].binding.label' <<<"$OUT" 2>/dev/null)"
	[ "$BIND" = "weekly" ] && pass "binding window is the most-consumed one" || fail "binding window" "got=$BIND"
else
	fail "jq required for the JSON shape checks" "jq not found"
fi

# ── ⛔ SECRETS HYGIENE ───────────────────────────────────────────────────────
# Credential material must never reach any output surface. Plant a token-shaped
# string in each home's auth.json so a tool that echoed the file would trip this.
echo ""
echo "=== secrets hygiene ==="
ROOT="$(mkroot secrets)"
D1="$(mkacct "$ROOT" acct1)"
printf '{"tokens":{"access_token":"eyJhbGciOiJIUzI1NiJ9.SECRETPAYLOAD.sig","refresh":"sk-proj-DEADBEEFCAFE"}}\n' >"$D1/auth.json"
ln -s "$D1" "$ROOT/codex-home"
JSON_OUT="$(run "$ROOT" --json)"
HUMAN_OUT="$(run "$ROOT")"
if grep -qE 'eyJ[A-Za-z0-9_-]{5,}|sk-proj-|SECRETPAYLOAD|DEADBEEFCAFE' <<<"$JSON_OUT"; then
	fail "no token-shaped string in --json output" "$(grep -oE 'eyJ[A-Za-z0-9_-]{5,}|sk-proj-[A-Za-z0-9]*|SECRETPAYLOAD|DEADBEEFCAFE' <<<"$JSON_OUT" | head -3)"
else
	pass "no token-shaped string in --json output"
fi
if grep -qE 'eyJ[A-Za-z0-9_-]{5,}|sk-proj-|SECRETPAYLOAD|DEADBEEFCAFE' <<<"$HUMAN_OUT"; then
	fail "no token-shaped string in the human table" "$(grep -oE 'eyJ[A-Za-z0-9_-]{5,}|sk-proj-[A-Za-z0-9]*|SECRETPAYLOAD|DEADBEEFCAFE' <<<"$HUMAN_OUT" | head -3)"
else
	pass "no token-shaped string in the human table"
fi
# Positive control: the planted secret really IS present in the fixture, so the
# two refutations above are evidence of scrubbing, not of an empty haystack.
if grep -q 'SECRETPAYLOAD' "$D1/auth.json"; then
	pass "positive control: the planted secret is present in the fixture"
else
	fail "positive control: the planted secret is present in the fixture" "fixture did not contain it"
fi
# ...and the human table is genuinely non-empty (a blank output trivially has no secret).
if grep -q 'acct1' <<<"$HUMAN_OUT"; then
	pass "positive control: the human table is non-empty"
else
	fail "positive control: the human table is non-empty" "$HUMAN_OUT"
fi

echo ""
echo "=== an unauthenticated home is unauthenticated, never ok ==="
ROOT="$(mkroot unauth)"
mkacct "$ROOT" acct1 --no-auth >/dev/null
OUT="$(run "$ROOT" --json)"
RC=$?
[ "$RC" -eq 1 ] && pass "exit 1 when no account can report limits" || fail "exit 1 when no account can report limits" "rc=$RC"
if command -v jq >/dev/null 2>&1; then
	S="$(jq -r '.accounts[0].status' <<<"$OUT" 2>/dev/null)"
	[ "$S" = "unauthenticated" ] && pass "status is unauthenticated" || fail "status is unauthenticated" "got=$S"
	R="$(jq -r '.accounts[0].reason' <<<"$OUT" 2>/dev/null)"
	grep -qi 'authentication required' <<<"$R" && pass "reason names the auth failure" || fail "reason names the auth failure" "got=$R"
fi

echo ""
echo "=== a throttled account is rejected even though every RPC succeeded ==="
ROOT="$(mkroot throttled)"
mkacct "$ROOT" acct1 --throttled >/dev/null
OUT="$(run "$ROOT" --json)"
if command -v jq >/dev/null 2>&1; then
	S="$(jq -r '.accounts[0].status' <<<"$OUT" 2>/dev/null)"
	[ "$S" = "rejected" ] && pass "throttled account classifies rejected" || fail "throttled account classifies rejected" "got=$S"
fi

echo ""
echo "=== zero accounts is an error, never a clean empty table ==="
ROOT="$(mkroot empty)"
OUT="$(run "$ROOT" --json)"
RC=$?
[ "$RC" -eq 1 ] && pass "exit 1 when the root holds no accounts" || fail "exit 1 when the root holds no accounts" "rc=$RC"

echo ""
echo "=== a missing codex binary is an error, not a silent empty read ==="
ROOT="$(mkroot nobin)"
mkacct "$ROOT" acct1 >/dev/null
OUT="$(CATALYST_CODEX_ROOT="$ROOT" CATALYST_CODEX_BIN="$SCRATCH/no-such-codex" node "$SUBJECT" --json 2>&1)"
RC=$?
[ "$RC" -eq 1 ] && pass "exit 1 when the codex binary is absent" || fail "exit 1 when the codex binary is absent" "rc=$RC"
if command -v jq >/dev/null 2>&1; then
	S="$(jq -r '.accounts[0].status' <<<"$OUT" 2>/dev/null)"
	[ "$S" = "error" ] && pass "an unreadable account is error, not ok" || fail "an unreadable account is error" "got=$S"
fi

echo ""
echo "=== the selector being a real directory is reported, not silently ignored ==="
ROOT="$(mkroot pinned)"
mkacct "$ROOT" acct1 >/dev/null
mkdir -p "$ROOT/codex-home"
OUT="$(run "$ROOT" --json)"
if command -v jq >/dev/null 2>&1; then
	K="$(jq -r '.selector.kind' <<<"$OUT" 2>/dev/null)"
	[ "$K" = "directory" ] && pass "a real-directory selector is reported as such" || fail "real-directory selector reported" "got=$K"
fi

echo ""
echo "=== --json is valid JSON ==="
ROOT="$(mkroot valid)"
mkacct "$ROOT" acct1 >/dev/null
OUT="$(run "$ROOT" --json)"
if node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s);process.exit(0)})' <<<"$OUT" 2>/dev/null; then
	pass "--json emits parseable JSON"
else
	fail "--json emits parseable JSON" "$OUT"
fi

echo ""
echo "codex-accounts-usage: $((PASSES))/$((PASSES + FAILURES)) passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
