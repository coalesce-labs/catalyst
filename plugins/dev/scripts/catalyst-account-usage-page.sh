#!/bin/bash
# catalyst-account-usage-page.sh — CTL-1908 (the paging half). Page BEFORE an armed Claude
# account exhausts its window, instead of discovering it from a stalled fleet.
#
# THE INCIDENT: the fleet's subscription token was armed into every login shell, a human session
# spent the budget, and the fleet stalled 02:00–08:57. The export is fixed and codified. What is
# still missing is the part that would have made it visible: nobody watches the window.
#
# ⛔ THE SOURCE, AND WHY IT IS NOT THE METRICS PIPELINE. The obvious source is
# `catalyst_account_ratelimit_five_hour_pct` in Prometheus. Measured 2026-08-18 01:1x CT: that
# series has NO DATA IN THE LAST 7 DAYS, and `claude_limits_account_auth_active` reads 0 for all
# three accounts (matching `claude-meter poll` returning HTTP 401/403 for all three). A pager
# built on it would never fire, and would look installed. So this reads the source that IS live:
# the Clawdmeter usage daemon, which polls the Claude API's rate-limit headers every 60s from the
# host's own credentials and logs a structured payload.
#
# ⛔ AND THEREFORE THE STALENESS GATE IS THE LOAD-BEARING PART. A pager whose input goes dark and
# reports "under threshold" is worse than no pager: it converts an unknown into a reassurance.
# If the source is stale, this pages "usage is UNOBSERVABLE" and exits non-zero.
#
# The log lines carry a time but NO DATE, so freshness is taken from the file's mtime — the only
# honest signal available (a "[00:59:40]" line is indistinguishable from yesterday's).
#
# Usage:
#   catalyst-account-usage-page.sh [--threshold 80] [--max-age-min 10] [--dry-run]
#                                  [--ticket CTL-1908] [--channel <name>]

set -uo pipefail

USAGE_LOG="${CATALYST_USAGE_LOG:-$HOME/Library/Logs/claude-usage-daemon.out.log}"
STATE_FILE="${CATALYST_USAGE_PAGE_STATE:-$HOME/catalyst/state/account-usage-page.state}"
CHANNEL_DIR="${CATALYST_MD_CHANNELS:-$HOME/catalyst/comms/md-channels}"
CHANNEL="${CATALYST_USAGE_CHANNEL:-ctl-ctc-tenant-model-onboarding}"
TICKET="${CATALYST_USAGE_TICKET:-CTL-1908}"
REPLY_TOOL="${CATALYST_LINEAR_REPLY:-$HOME/catalyst/comms/tools/linear-reply.mjs}"
THRESHOLD=80
MAX_AGE_MIN=10
DRY_RUN=0

while [[ $# -gt 0 ]]; do
	case "$1" in
	--threshold) THRESHOLD="${2-}"; shift 2 ;;
	--max-age-min) MAX_AGE_MIN="${2-}"; shift 2 ;;
	--ticket) TICKET="${2:-}"; shift 2 ;;
	--channel) CHANNEL="${2:-}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '2,26p' "$0"; exit 0 ;;
	*) echo "usage-page: unknown argument '$1'" >&2; exit 2 ;;
	esac
done

case "$THRESHOLD" in '' | *[!0-9]*) echo "usage-page: --threshold must be an integer (got '$THRESHOLD')" >&2; exit 2 ;; esac
case "$MAX_AGE_MIN" in '' | *[!0-9]*) echo "usage-page: --max-age-min must be an integer (got '$MAX_AGE_MIN')" >&2; exit 2 ;; esac

_now() { date +%s; }

# ── the staleness gate ───────────────────────────────────────────────────────────────────
if [ ! -f "$USAGE_LOG" ]; then
	echo "usage-page: UNOBSERVABLE — no usage source at $USAGE_LOG. Account windows are UNWATCHED." >&2
	exit 3
fi
_mtime() {
	if stat -c %Y "$1" >/dev/null 2>&1; then stat -c %Y "$1"; else stat -f %m "$1"; fi
}
AGE_MIN=$(((($(_now) - $(_mtime "$USAGE_LOG"))) / 60))
if [ "$AGE_MIN" -gt "$MAX_AGE_MIN" ]; then
	echo "usage-page: UNOBSERVABLE — $USAGE_LOG last changed ${AGE_MIN}m ago (limit ${MAX_AGE_MIN}m)." >&2
	echo "usage-page: this is NOT 'under threshold'; the usage daemon is not reporting." >&2
	exit 3
fi

LINE="$(grep -o 'Sending: {.*}' "$USAGE_LOG" 2>/dev/null | grep '"acct"' | tail -1 | sed 's/^Sending: //')"
if [ -z "$LINE" ]; then
	echo "usage-page: UNOBSERVABLE — $USAGE_LOG has no parsable account payload (format drift?)." >&2
	exit 3
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
') || { echo "usage-page: UNOBSERVABLE — could not parse the payload: $LINE" >&2; exit 3; }

# ⛔ A missing or unparsable percentage must not read as 0. -1 is the sentinel the parser emits, and
# it is treated as "cannot see", never as "healthy".
if [ "$FIVE" -lt 0 ] || [ "$SEVEN" -lt 0 ]; then
	echo "usage-page: UNOBSERVABLE — the payload carries no usable percentages: $LINE" >&2
	exit 3
fi

echo "usage-page: ${ACCT} 5h=${FIVE}% (resets ${FIVE_RESET}m) 7d=${SEVEN}% (resets ${SEVEN_RESET}m) threshold=${THRESHOLD}%"

# ── page only on a CROSSING, so a cron does not repeat itself every minute ───────────────
mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE" 2>/dev/null || true
_state_get() { grep -E "^$1=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2; }
_state_set() {
	local k="$1" v="$2" tmp
	tmp="$STATE_FILE.tmp.$$"
	grep -vE "^$k=" "$STATE_FILE" 2>/dev/null >"$tmp"
	echo "$k=$v" >>"$tmp"
	mv "$tmp" "$STATE_FILE"
}

PAGED=0
SUPPRESSED=0
# ⛔ The state records the reading AND the threshold it was judged against. Recording the reading
# alone was wrong and the test caught it: a run at threshold 80 wrote "28", and a later run at
# threshold 20 then saw 28 >= 20 and announced "already paged at 28%" — when nothing had ever
# been paged. Suppression must mean "we already paged THIS window at THIS threshold", not
# "the previous number happened to exceed the current threshold".
_page() { # _page <window> <pct> <resets-min>
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
	local body
	body="⚠️ **Armed account \`${ACCT}\` is at ${pct}% of its ${window} window** (threshold ${THRESHOLD}%). It resets in ${resets} minutes.

This is the page CTL-1908 asked for: the export that stalled the fleet 02:00–08:57 is fixed and codified, but nobody was watching the window itself. Source: the Clawdmeter usage daemon's live rate-limit poll (5h=${FIVE}%, 7d=${SEVEN}%).

⚠️ Not from the metrics pipeline: \`catalyst_account_ratelimit_five_hour_pct\` has carried no data for 7+ days and \`claude_limits_account_auth_active\` reads 0 for all three accounts, so a pager built on it would never fire."

	if [ "$DRY_RUN" -eq 1 ]; then
		echo "usage-page: [dry-run] would page ${window} at ${pct}%"
		PAGED=$((PAGED + 1))
		return 0
	fi

	local chan="$CHANNEL_DIR/$CHANNEL.md"
	if [ -f "$chan" ]; then
		{
			printf '\n## Turn FLEET-AUTO — usage page: %s at %s%% of its %s window\n\n' "$ACCT" "$pct" "$window"
			printf '%s\n\n— catalyst-account-usage-page.sh, %s CT\n' "$body" "$(TZ=America/Chicago date '+%Y-%m-%d %H:%M')"
		} >>"$chan"
		echo "usage-page: appended a channel line to $chan"
	else
		echo "usage-page: no channel file at $chan — the ticket comment below is the only page" >&2
	fi

	if [ -x "$REPLY_TOOL" ] || [ -f "$REPLY_TOOL" ]; then
		if node "$REPLY_TOOL" "$TICKET" --as FLEET --body "$body" >/dev/null 2>&1; then
			echo "usage-page: commented on $TICKET"
		else
			echo "usage-page: FAILED to comment on $TICKET — the channel line above is the only page" >&2
		fi
	else
		echo "usage-page: no reply tool at $REPLY_TOOL — the channel line above is the only page" >&2
	fi
	PAGED=$((PAGED + 1))
}

[ "$FIVE" -ge "$THRESHOLD" ] && _page "5-hour" "$FIVE" "$FIVE_RESET"
[ "$SEVEN" -ge "$THRESHOLD" ] && _page "7-day" "$SEVEN" "$SEVEN_RESET"

# Record the current reading so a crossing is a crossing, and so a window that falls back below
# the threshold re-arms instead of staying silent forever after one page.
_state_set "${ACCT}:5-hour" "${FIVE}:${THRESHOLD}"
_state_set "${ACCT}:7-day" "${SEVEN}:${THRESHOLD}"

# ⛔ Distinguish "nothing crossed" from "crossed, but already paged". Collapsing them printed
# "no window at or above 20%" while a window sat at 29% — a summary that contradicted the line
# directly above it.
if [ "$PAGED" -gt 0 ]; then
	echo "usage-page: paged ${PAGED} window(s)"
elif [ "$SUPPRESSED" -gt 0 ]; then
	echo "usage-page: ${SUPPRESSED} window(s) at or above ${THRESHOLD}%, already paged — nothing new"
else
	echo "usage-page: no window at or above ${THRESHOLD}% — nothing paged"
fi
exit 0
