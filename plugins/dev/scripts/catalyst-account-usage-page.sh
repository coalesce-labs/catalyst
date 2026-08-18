#!/bin/bash
# catalyst-account-usage-page.sh — CTL-1908 (the paging half). Page BEFORE an armed Claude
# account exhausts its window, instead of discovering it from a stalled fleet.
#
# THE INCIDENT: the fleet's subscription token was armed into every login shell, a human session
# spent the budget, and the fleet stalled 02:00–08:57. The export is fixed and codified. This is
# the part that would have made it visible: nobody watches the window.
#
# ⛔ THE SOURCE, AND WHY IT IS NOT THE METRICS PIPELINE. The obvious source is
# `catalyst_account_ratelimit_five_hour_pct` in Prometheus. Measured 2026-08-18 ~01:10 CT: that
# series has NO DATA IN THE LAST 7 DAYS, and `claude_limits_account_auth_active` reads 0 for all
# three accounts (matching `claude-meter poll` returning HTTP 401/403). A pager built on it would
# never fire and would look installed. So this reads the source that IS live: the Clawdmeter usage
# daemon, which polls the Claude API's rate-limit headers every 60s and logs a structured payload.
#
# ⛔ NOT SEEING USAGE IS ITSELF A PAGE. A pager whose input goes dark and says nothing to anyone
# is worse than no pager. Every unobservable condition goes out through the SAME sinks as a
# threshold crossing — Codex #3526 P1: exiting to stderr under launchd means the message lands
# only in a log file nobody reads.
#
# Usage:
#   catalyst-account-usage-page.sh [--threshold 80] [--max-age-min 10] [--dry-run]
#                                  [--ticket <ID>] [--channel <name>]
# The Linear sink is OPT-IN (--ticket / CATALYST_USAGE_TICKET plus CATALYST_LINEAR_REPLY). With
# neither configured this is channel-only, and says so.

set -uo pipefail

USAGE_LOG="${CATALYST_USAGE_LOG:-$HOME/Library/Logs/claude-usage-daemon.out.log}"
STATE_FILE="${CATALYST_USAGE_PAGE_STATE:-$HOME/catalyst/state/account-usage-page.state}"
CHANNEL_DIR="${CATALYST_MD_CHANNELS:-$HOME/catalyst/comms/md-channels}"
CHANNEL="${CATALYST_USAGE_CHANNEL:-ctl-ctc-tenant-model-onboarding}"
# ⛔ Codex #3526 P1: no internal ticket default. A committed default made every installation post
# operational alerts at one team's issue — nonexistent or unrelated elsewhere.
TICKET="${CATALYST_USAGE_TICKET:-}"
# ⛔ Codex #3526 P1: the old default pointed at an operator-local path no installer creates, and
# even the repo's own reply tool needs LINEAR_SYNC_* credentials that launchd does not provide.
# Opt-in, and its absence is REPORTED rather than silently skipped.
REPLY_TOOL="${CATALYST_LINEAR_REPLY:-}"
TAIL_LINES="${CATALYST_USAGE_TAIL_LINES:-40}"
THRESHOLD=80
MAX_AGE_MIN=10
DRY_RUN=0

while [[ $# -gt 0 ]]; do
	case "$1" in
	--threshold) THRESHOLD="${2-}"; shift 2 ;;
	--max-age-min) MAX_AGE_MIN="${2-}"; shift 2 ;;
	--ticket) TICKET="${2-}"; shift 2 ;;
	--channel) CHANNEL="${2-}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '2,30p' "$0"; exit 0 ;;
	*) echo "usage-page: unknown argument '$1'" >&2; exit 2 ;;
	esac
done
case "$THRESHOLD" in '' | *[!0-9]*) echo "usage-page: --threshold must be an integer (got '$THRESHOLD')" >&2; exit 2 ;; esac
case "$MAX_AGE_MIN" in '' | *[!0-9]*) echo "usage-page: --max-age-min must be an integer (got '$MAX_AGE_MIN')" >&2; exit 2 ;; esac

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
touch "$STATE_FILE" 2>/dev/null || true
_state_get() { grep -E "^$1=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }
_state_set() {
	local k="$1" v="$2" tmp="$STATE_FILE.tmp.$$"
	grep -vE "^$k=" "$STATE_FILE" 2>/dev/null >"$tmp"
	echo "$k=$v" >>"$tmp"
	mv "$tmp" "$STATE_FILE"
}

# ── delivery ─────────────────────────────────────────────────────────────────────────────
# Returns 0 only if AT LEAST ONE sink actually accepted the message. Codex #3526 P1: recording a
# crossing that was never delivered suppresses every later run until the window falls back below
# the threshold — hiding the whole exhaustion.
_deliver() { # _deliver <heading> <body>
	local heading="$1" body="$2" delivered=0
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "usage-page: [dry-run] would page — ${heading}"
		return 0
	fi
	local chan="$CHANNEL_DIR/$CHANNEL.md"
	if [ -n "$CHANNEL" ] && [ -f "$chan" ]; then
		if {
			printf '\n## Turn FLEET-AUTO — %s\n\n' "$heading"
			printf '%s\n\n— catalyst-account-usage-page.sh, %s CT\n' "$body" "$(TZ=America/Chicago date '+%Y-%m-%d %H:%M')"
		} >>"$chan" 2>/dev/null; then
			echo "usage-page: appended to $chan"
			delivered=1
		else
			echo "usage-page: FAILED to append to $chan" >&2
		fi
	else
		echo "usage-page: no channel file at $chan — channel sink unavailable" >&2
	fi
	if [ -n "$TICKET" ] && [ -n "$REPLY_TOOL" ] && [ -f "$REPLY_TOOL" ]; then
		if node "$REPLY_TOOL" "$TICKET" --as FLEET --body "$body" >/dev/null 2>&1; then
			echo "usage-page: commented on $TICKET"
			delivered=1
		else
			echo "usage-page: FAILED to comment on $TICKET (credentials? launchd has no direnv profile)" >&2
		fi
	elif [ -n "$TICKET" ] || [ -n "$REPLY_TOOL" ]; then
		echo "usage-page: Linear sink only PARTLY configured (ticket='${TICKET}' tool='${REPLY_TOOL}') — not used" >&2
	fi
	[ "$delivered" -eq 1 ]
}

# ⛔ Unobservable is a PAGE, not a log line. De-duplicated so a dark source does not append every
# 10 minutes forever, but re-pages once the condition clears and returns.
_unobservable() {
	local why="$1"
	echo "usage-page: UNOBSERVABLE — $why" >&2
	echo "usage-page: this is NOT 'under threshold'; account windows are UNWATCHED." >&2
	if [ "$(_state_get unobservable)" != "1" ]; then
		if _deliver "usage source is DARK — account windows are UNWATCHED" \
			"⛔ **The account-usage pager cannot see usage.** ${why}

This is not \"under threshold\" — it is *no reading at all*, which is the condition CTL-1908 exists to make visible. While this holds, nothing is watching whether an armed account is about to exhaust its window."; then
			[ "$DRY_RUN" -eq 0 ] && _state_set unobservable 1
		fi
	else
		echo "usage-page: (already paged that the source is dark — not repeating)"
	fi
	exit 3
}

# ── the staleness gate ───────────────────────────────────────────────────────────────────
[ -f "$USAGE_LOG" ] || _unobservable "no usage source at $USAGE_LOG"
_mtime() { if stat -c %Y "$1" >/dev/null 2>&1; then stat -c %Y "$1"; else stat -f %m "$1"; fi; }
AGE_MIN=$(((($(date +%s) - $(_mtime "$USAGE_LOG"))) / 60))
[ "$AGE_MIN" -le "$MAX_AGE_MIN" ] || _unobservable "$USAGE_LOG last changed ${AGE_MIN}m ago (limit ${MAX_AGE_MIN}m)"

# ⛔ Codex #3526 P1: a FRESH mtime does not mean a fresh PAYLOAD. If the daemon keeps writing
# connection/error lines after its last `Sending:` line, the file keeps changing while the newest
# payload is hours old — and an unbounded search happily returns it. Two independent bounds: the
# payload must be among the last TAIL_LINES lines, AND its own [HH:MM:SS] must be within the age
# limit.
RAW="$(tail -n "$TAIL_LINES" "$USAGE_LOG" 2>/dev/null | grep -E '^\[[0-9:]+\] Sending: \{.*"acct"' | tail -1)"
[ -n "$RAW" ] || _unobservable "no account payload in the last ${TAIL_LINES} lines of $USAGE_LOG — the daemon is writing, but not usage"
LINE="$(printf '%s' "$RAW" | sed 's/^.*Sending: //')"
STAMP="$(printf '%s' "$RAW" | sed -n 's/^\[\([0-9][0-9]:[0-9][0-9]:[0-9][0-9]\)\].*/\1/p')"
if [ -n "$STAMP" ]; then
	PAYLOAD_AGE_MIN="$(STAMP="$STAMP" python3 -c '
import os, time
h, m, s = (int(x) for x in os.environ["STAMP"].split(":"))
n = time.localtime()
d = (n.tm_hour * 3600 + n.tm_min * 60 + n.tm_sec) - (h * 3600 + m * 60 + s)
if d < 0:
    d += 86400  # the payload is from before midnight
print(d // 60)
' 2>/dev/null)"
	case "$PAYLOAD_AGE_MIN" in '' | *[!0-9]*) PAYLOAD_AGE_MIN="" ;; esac
	if [ -n "$PAYLOAD_AGE_MIN" ] && [ "$PAYLOAD_AGE_MIN" -gt "$MAX_AGE_MIN" ]; then
		_unobservable "the newest usage payload is stamped ${STAMP} — ${PAYLOAD_AGE_MIN}m old (limit ${MAX_AGE_MIN}m) — though $USAGE_LOG is still being written"
	fi
fi

read -r ACCT FIVE SEVEN FIVE_RESET SEVEN_RESET < <(printf '%s' "$LINE" | python3 -c '
import json,sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
def num(x):
    try: return int(float(x))
    except Exception: return -1
print(d.get("acct","unknown"), num(d.get("s")), num(d.get("w")), num(d.get("sr")), num(d.get("wr")))
') || _unobservable "could not parse the payload: $LINE"

# A missing percentage must not read as 0 (i.e. as healthy). -1 is the parser's sentinel.
{ [ "$FIVE" -ge 0 ] && [ "$SEVEN" -ge 0 ]; } || _unobservable "the payload carries no usable percentages: $LINE"

# The source is readable again — clear the dark flag so a future outage pages afresh.
[ "$(_state_get unobservable)" = "1" ] && [ "$DRY_RUN" -eq 0 ] && _state_set unobservable 0

echo "usage-page: ${ACCT} 5h=${FIVE}% (resets ${FIVE_RESET}m) 7d=${SEVEN}% (resets ${SEVEN_RESET}m) threshold=${THRESHOLD}%"

PAGED=0
SUPPRESSED=0
UNDELIVERED=0
# ⛔ The state records the reading AND the threshold it was judged against, and is written ONLY
# after a page is actually delivered. Recording the reading alone made a run at threshold 80 write
# "28", after which a run at threshold 20 announced "already paged at 28%" when nothing had ever
# been paged; recording it after a FAILED or dry-run delivery would suppress every later attempt.
_page() { # _page <window> <pct> <resets-min>
	# NOT one `local` statement: an initializer in the same `local` cannot reference an earlier
	# variable from that same statement, so `key="${ACCT}:${window}"` died on `unbound variable`
	# under `set -u` — on the paging path, i.e. the one that matters.
	local window="$1" pct="$2" resets="$3"
	local key="${ACCT}:${window}"
	local prev was_pct was_thr
	prev="$(_state_get "$key")"
	was_pct="${prev%%:*}"
	was_thr="${prev##*:}"
	case "$was_pct" in '' | *[!0-9]*) was_pct=-1 ;; esac
	case "$was_thr" in '' | *[!0-9]*) was_thr=-1 ;; esac
	if [ "$was_pct" -ge "$THRESHOLD" ] && [ "$was_thr" -eq "$THRESHOLD" ]; then
		echo "usage-page: ${window} was already paged at ${was_pct}% (threshold ${THRESHOLD}%) — not repeating"
		SUPPRESSED=$((SUPPRESSED + 1))
		return 0
	fi
	if _deliver "usage page: ${ACCT} at ${pct}% of its ${window} window" \
		"⚠️ **Armed account \`${ACCT}\` is at ${pct}% of its ${window} window** (threshold ${THRESHOLD}%). It resets in ${resets} minutes.

Current reading: 5h=${FIVE}%, 7d=${SEVEN}%. Source: the Clawdmeter usage daemon's live rate-limit poll — *not* the metrics pipeline, which has carried no data for 7+ days (CTL-1947)."; then
		PAGED=$((PAGED + 1))
		[ "$DRY_RUN" -eq 0 ] && _state_set "$key" "${pct}:${THRESHOLD}"
	else
		echo "usage-page: ${window} crossed ${THRESHOLD}% but NO SINK ACCEPTED the page — NOT recording it, so the next run retries" >&2
		UNDELIVERED=$((UNDELIVERED + 1))
	fi
}

[ "$FIVE" -ge "$THRESHOLD" ] && _page "5-hour" "$FIVE" "$FIVE_RESET"
[ "$SEVEN" -ge "$THRESHOLD" ] && _page "7-day" "$SEVEN" "$SEVEN_RESET"

# A window that falls back below the threshold re-arms, so the next crossing pages again.
[ "$FIVE" -lt "$THRESHOLD" ] && [ "$DRY_RUN" -eq 0 ] && _state_set "${ACCT}:5-hour" "${FIVE}:${THRESHOLD}"
[ "$SEVEN" -lt "$THRESHOLD" ] && [ "$DRY_RUN" -eq 0 ] && _state_set "${ACCT}:7-day" "${SEVEN}:${THRESHOLD}"

if [ "$UNDELIVERED" -gt 0 ]; then
	echo "usage-page: ${UNDELIVERED} window(s) crossed but could not be delivered"
	exit 4
elif [ "$PAGED" -gt 0 ]; then
	echo "usage-page: paged ${PAGED} window(s)"
elif [ "$SUPPRESSED" -gt 0 ]; then
	echo "usage-page: ${SUPPRESSED} window(s) at or above ${THRESHOLD}%, already paged — nothing new"
else
	echo "usage-page: no window at or above ${THRESHOLD}% — nothing paged"
fi
exit 0
