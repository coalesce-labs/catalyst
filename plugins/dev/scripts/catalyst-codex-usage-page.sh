#!/bin/bash
# catalyst-codex-usage-page.sh — CTL-2072 (the paging half). Page BEFORE a Codex
# account exhausts its window, instead of discovering it from a stalled fleet.
#
# THE INCIDENT THIS CLOSES: CTL-2046. Our own codex-exec account ran dead and the
# only signal was `classifyCodexOutcome`'s reactive `rate-park` string match,
# which produced 276 silent events and paged nobody. That is post-hoc by
# construction — it fires once work has ALREADY failed.
#
# ⛔ THE SOURCE, AND WHY IT DIFFERS FROM THE CLAUDE PAGER'S. Its sibling
# catalyst-account-usage-page.sh had to route AROUND the metrics pipeline, because
# `catalyst_account_ratelimit_five_hour_pct` had carried no data for 7+ days — a
# pager built on it would never fire and would look installed. Here the source is
# codex-accounts-usage.mjs, which reads the `codex app-server` account plane and
# was measured LIVE on mini-2 (codex-cli 0.147.0, 2026-08-22) returning real
# quota for both provisioned accounts. It also costs ZERO TOKENS, so a 10-minute
# cadence is free — strictly cheaper than the Claude pager's inference-based read.
#
# ⛔ NOT SEEING QUOTA IS ITSELF A PAGE. A pager whose input goes dark and says
# nothing to anyone is worse than no pager. Every unobservable condition goes out
# through the SAME sinks as a threshold crossing — under launchd, exiting to
# stderr means the message lands only in a log file nobody reads.
#
# ⛔ ZERO ACCOUNTS IS NOT "UNDER THRESHOLD". An empty accounts[] trivially
# satisfies "no window over threshold" (`[].every(p)` is true), so it is routed to
# the DARK path explicitly rather than falling out of the loop as all-clear.
#
# ⛔ A THROTTLED ACCOUNT CAN READ 0%. `account/rateLimits/read` SUCCEEDS on a
# rejected account, carrying a non-null rateLimitReachedType — so status alone,
# not the percentage, decides that case. This imports lib/codex-account-plane.mjs's
# `rejected` verdict rather than re-deriving the ladder here.
#
# SCOPE: this covers OUR Codex accounts. The GitHub `chatgpt-codex-connector[bot]`
# reviewer runs on OpenAI's own infrastructure with a separate quota pool that is
# not observable from our account plane at all — that gap is CTL-1972's, and
# building it off our quota would be a detector that cannot detect its condition.
#
# NOTE (intended extraction): _deliver/_state_* below are kept byte-parallel with
# catalyst-account-usage-page.sh so a later lift into a shared
# lib/usage-page-sink.sh is mechanical. They are deliberately NOT shared today:
# that script is CI-pinned and actively paging, and refactoring a live paging path
# for a cosmetic win is the wrong trade.
#
# Usage:
#   catalyst-codex-usage-page.sh [--threshold 80] [--dry-run]
#                                [--ticket <ID>] [--channel <name>]
# The Linear sink is OPT-IN (--ticket / CATALYST_CODEX_USAGE_TICKET plus
# CATALYST_LINEAR_REPLY). With neither configured this is channel-only, and says so.
#
# Exit: 0 normal · 2 bad arguments · 3 UNOBSERVABLE · 4 crossed but undelivered

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE_SOURCE="${CATALYST_CODEX_USAGE_SOURCE:-$SELF_DIR/codex-accounts-usage.mjs}"
STATE_FILE="${CATALYST_CODEX_USAGE_PAGE_STATE:-$HOME/catalyst/state/codex-usage-page.state}"
CHANNEL_DIR="${CATALYST_MD_CHANNELS:-$HOME/catalyst/comms/md-channels}"
CHANNEL="${CATALYST_CODEX_USAGE_CHANNEL:-}"
# No committed ticket default: a committed default made a sibling tool post
# operational alerts at one team's issue — nonexistent or unrelated elsewhere.
TICKET="${CATALYST_CODEX_USAGE_TICKET:-}"
REPLY_TOOL="${CATALYST_LINEAR_REPLY:-}"
THRESHOLD=80
DRY_RUN=0

while [[ $# -gt 0 ]]; do
	case "$1" in
	--threshold) THRESHOLD="${2-}"; shift 2 ;;
	--ticket) TICKET="${2-}"; shift 2 ;;
	--channel) CHANNEL="${2-}"; shift 2 ;;
	--dry-run) DRY_RUN=1; shift ;;
	-h | --help) sed -n '2,50p' "$0"; exit 0 ;;
	*) echo "codex-usage-page: unknown argument '$1'" >&2; exit 2 ;;
	esac
done
case "$THRESHOLD" in '' | *[!0-9]*) echo "codex-usage-page: --threshold must be an integer (got '$THRESHOLD')" >&2; exit 2 ;; esac

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
touch "$STATE_FILE" 2>/dev/null || true
_state_get() { grep -E "^$1=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }
_state_set() {
	local k="$1" v="$2" tmp="$STATE_FILE.tmp.$$"
	grep -vE "^$k=" "$STATE_FILE" 2>/dev/null >"$tmp"
	echo "$k=$v" >>"$tmp"
	mv "$tmp" "$STATE_FILE"
}

# ── delivery ─────────────────────────────────────────────────────────────────
# Returns 0 only if AT LEAST ONE sink actually accepted the message. Recording a
# crossing that was never delivered suppresses every later run until the window
# falls back below the threshold — hiding the whole exhaustion.
_deliver() { # _deliver <heading> <body>
	local heading="$1" body="$2" delivered=0
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "codex-usage-page: [dry-run] would page — ${heading}"
		return 0
	fi
	local chan="$CHANNEL_DIR/$CHANNEL.md"
	if [ -n "$CHANNEL" ] && [ -f "$chan" ]; then
		if {
			printf '\n## Turn FLEET-AUTO — %s\n\n' "$heading"
			printf '%s\n\n— catalyst-codex-usage-page.sh, %s CT\n' "$body" "$(TZ=America/Chicago date '+%Y-%m-%d %H:%M')"
		} >>"$chan" 2>/dev/null; then
			echo "codex-usage-page: appended to $chan"
			delivered=1
		else
			echo "codex-usage-page: FAILED to append to $chan" >&2
		fi
	else
		echo "codex-usage-page: no channel file at $chan — channel sink unavailable" >&2
	fi
	if [ -n "$TICKET" ] && [ -n "$REPLY_TOOL" ] && [ -f "$REPLY_TOOL" ]; then
		if node "$REPLY_TOOL" "$TICKET" --as FLEET --body "$body" >/dev/null 2>&1; then
			echo "codex-usage-page: commented on $TICKET"
			delivered=1
		else
			echo "codex-usage-page: FAILED to comment on $TICKET (credentials? launchd has no direnv profile)" >&2
		fi
	elif [ -n "$TICKET" ] || [ -n "$REPLY_TOOL" ]; then
		echo "codex-usage-page: Linear sink only PARTLY configured (ticket='${TICKET}' tool='${REPLY_TOOL}') — not used" >&2
	fi
	[ "$delivered" -eq 1 ]
}

# ⛔ Unobservable is a PAGE, not a log line. De-duplicated so a dark source does
# not append every 10 minutes forever, but re-pages once the condition clears and
# returns.
_unobservable() {
	local why="$1"
	echo "codex-usage-page: UNOBSERVABLE — $why" >&2
	echo "codex-usage-page: this is NOT 'under threshold'; Codex account quota is UNWATCHED." >&2
	if [ "$(_state_get unobservable)" != "1" ]; then
		if _deliver "Codex usage source is DARK — account quota is UNWATCHED" \
			"⛔ **The Codex account pager cannot see quota.** ${why}

This is not \"under threshold\" — it is *no reading at all*, which is the condition CTL-2072 exists to make visible. While this holds, nothing is watching whether the fleet's Codex account is about to exhaust its window (the failure behind CTL-2046)."; then
			[ "$DRY_RUN" -eq 0 ] && _state_set unobservable 1
		fi
	else
		echo "codex-usage-page: (already paged that the source is dark — not repeating)"
	fi
	exit 3
}

# ── read the source ──────────────────────────────────────────────────────────
command -v jq >/dev/null 2>&1 || _unobservable "jq is not on PATH — cannot parse the usage payload"
[ -f "$USAGE_SOURCE" ] || _unobservable "no usage source at $USAGE_SOURCE"
if command -v node >/dev/null 2>&1; then RT=node
elif command -v bun >/dev/null 2>&1; then RT=bun
else _unobservable "neither node nor bun is on PATH — cannot run $USAGE_SOURCE"
fi

# A non-zero exit is NOT by itself fatal: codex-accounts-usage.mjs exits 1 when no
# account reached `ok`, and that is exactly the state we most need to page about.
# The payload is what decides.
PAYLOAD="$("$RT" "$USAGE_SOURCE" --json 2>/dev/null)"
[ -n "$PAYLOAD" ] || _unobservable "$USAGE_SOURCE produced no output"
printf '%s' "$PAYLOAD" | jq -e . >/dev/null 2>&1 || _unobservable "the usage payload is not parseable JSON"

ACCOUNT_COUNT="$(printf '%s' "$PAYLOAD" | jq -r '(.accounts // []) | length' 2>/dev/null)"
case "$ACCOUNT_COUNT" in '' | *[!0-9]*) ACCOUNT_COUNT=0 ;; esac
# ⛔ `[].every(p)` is true — an empty account list would otherwise fall straight
# through the loop below and print a clean all-clear having read nothing.
[ "$ACCOUNT_COUNT" -gt 0 ] || _unobservable "the usage payload carries ZERO accounts — nothing was read (is any codex-home-acctN provisioned?)"

# Every account must contribute at least one readable window OR a non-ok status.
# An account with no window and no complaint is an account we failed to read.
READABLE="$(printf '%s' "$PAYLOAD" | jq -r '
  [ .accounts[]
    | select( ((.buckets // []) | map(.windows // []) | flatten | length) > 0
              or ((.status // "") != "ok") )
  ] | length' 2>/dev/null)"
case "$READABLE" in '' | *[!0-9]*) READABLE=0 ;; esac
[ "$READABLE" -gt 0 ] || _unobservable "no account reported a usable quota window or a status — the plane answered, but with nothing to judge"

# The source is readable again — clear the dark flag so a future outage pages afresh.
[ "$(_state_get unobservable)" = "1" ] && [ "$DRY_RUN" -eq 0 ] && _state_set unobservable 0

ACTIVE="$(printf '%s' "$PAYLOAD" | jq -r '.selector.activeHandle // "<none>"' 2>/dev/null)"
echo "codex-usage-page: active=${ACTIVE} accounts=${ACCOUNT_COUNT} threshold=${THRESHOLD}%"

PAGED=0
SUPPRESSED=0
UNDELIVERED=0

# _page KEY HEADING BODY — edge-triggered, delivery-gated.
# The state records the reading AND the threshold it was judged against: recording
# the reading alone let a run at threshold 80 write "28", after which a run at
# threshold 20 announced "already paged at 28%" when nothing had ever been paged.
_page() { # _page <key> <reading> <heading> <body>
	local key="$1" reading="$2" heading="$3" body="$4"
	local prev was_pct was_thr
	prev="$(_state_get "$key")"
	was_pct="${prev%%:*}"
	was_thr="${prev##*:}"
	case "$was_pct" in '' | *[!0-9]*) was_pct=-1 ;; esac
	case "$was_thr" in '' | *[!0-9]*) was_thr=-1 ;; esac
	if [ "$was_pct" -ge "$THRESHOLD" ] && [ "$was_thr" -eq "$THRESHOLD" ]; then
		echo "codex-usage-page: ${key} was already paged at ${was_pct} (threshold ${THRESHOLD}%) — not repeating"
		SUPPRESSED=$((SUPPRESSED + 1))
		return 0
	fi
	if _deliver "$heading" "$body"; then
		PAGED=$((PAGED + 1))
		[ "$DRY_RUN" -eq 0 ] && _state_set "$key" "${reading}:${THRESHOLD}"
	else
		echo "codex-usage-page: ${key} crossed ${THRESHOLD}% but NO SINK ACCEPTED the page — NOT recording it, so the next run retries" >&2
		UNDELIVERED=$((UNDELIVERED + 1))
	fi
}

# ── 1. accounts whose STATUS is itself the alarm ─────────────────────────────
# ⛔ These page regardless of percentage. A rejected account frequently reads a
# low usedPercent (the RPC succeeded; the rejection lives in rateLimitReachedType),
# so a purely numeric pager would call a dead account healthy.
while IFS=$'\t' read -r handle status reason; do
	[ -n "$handle" ] || continue
	_page "${handle}:status:${status}" "100" \
		"Codex account ${handle} is NOT USABLE (${status})" \
		"⛔ **Codex account \`${handle}\` reports status \`${status}\`** — it cannot serve work right now, whatever its percentages read.

Reason: ${reason:-<none>}

A \`rejected\` account still answers \`account/rateLimits/read\` successfully (the rejection rides \`rateLimitReachedType\`), so this is deliberately judged on STATUS, not on used-%. Active account: \`${ACTIVE}\`.

Next step: \`catalyst-stack codex-account status\` to confirm, then \`catalyst-stack codex-account switch <handle> --yes\` to move the fleet onto a healthy account."
done < <(printf '%s' "$PAYLOAD" | jq -r '
  .accounts[] | select((.status // "") != "ok")
  | [.label, (.status // "unknown"), (.reason // "")] | @tsv' 2>/dev/null)

# ── 2. windows at or over the threshold ──────────────────────────────────────
# Window labels come straight from the payload (derived from windowDurationMins in
# lib/codex-account-plane.mjs), so a weekly-only account pages as `weekly` and
# never as a fabricated 5-hour window.
while IFS=$'\t' read -r handle limit_id label pct resets; do
	[ -n "$handle" ] || continue
	case "$pct" in '' | *[!0-9]*) continue ;; esac
	[ "$pct" -ge "$THRESHOLD" ] || continue
	_page "${handle}:${limit_id}:${label}" "$pct" \
		"Codex usage: ${handle} at ${pct}% of its ${label} window" \
		"⚠️ **Codex account \`${handle}\` is at ${pct}% of its \`${label}\` window** on limit \`${limit_id}\` (threshold ${THRESHOLD}%).

Resets at: ${resets}. Active account: \`${ACTIVE}\`.

Source: the \`codex app-server\` account plane via codex-accounts-usage.mjs — a live, zero-token read. The window name is derived from its own \`windowDurationMins\`, not from field position, so it is the window that actually exists.

Next step: \`catalyst-stack codex-account status\`, then \`catalyst-stack codex-account switch <handle> --yes\` if this account is the active one."
done < <(printf '%s' "$PAYLOAD" | jq -r '
  .accounts[] as $a
  | ($a.buckets // [])[] as $b
  | ($b.windows // [])[]
  | [$a.label, $b.limitId, .label, (.usedPercent | floor), (.resetsAt // "unknown" | tostring)] | @tsv' 2>/dev/null)

# ── 3. re-arm windows that fell back below the threshold ─────────────────────
# so the next genuine crossing pages again.
if [ "$DRY_RUN" -eq 0 ]; then
	while IFS=$'\t' read -r handle limit_id label pct; do
		[ -n "$handle" ] || continue
		case "$pct" in '' | *[!0-9]*) continue ;; esac
		[ "$pct" -lt "$THRESHOLD" ] && _state_set "${handle}:${limit_id}:${label}" "${pct}:${THRESHOLD}"
	done < <(printf '%s' "$PAYLOAD" | jq -r '
	  .accounts[] as $a
	  | ($a.buckets // [])[] as $b
	  | ($b.windows // [])[]
	  | [$a.label, $b.limitId, .label, (.usedPercent | floor)] | @tsv' 2>/dev/null)
	# An account that returned to ok re-arms its status alarm too.
	while IFS=$'\t' read -r handle; do
		[ -n "$handle" ] || continue
		for k in $(grep -oE "^${handle}:status:[a-z]+" "$STATE_FILE" 2>/dev/null | sort -u); do
			_state_set "$k" "0:${THRESHOLD}"
		done
	done < <(printf '%s' "$PAYLOAD" | jq -r '.accounts[] | select((.status // "") == "ok") | .label' 2>/dev/null)
fi

if [ "$UNDELIVERED" -gt 0 ]; then
	echo "codex-usage-page: ${UNDELIVERED} alarm(s) raised but could not be delivered"
	exit 4
elif [ "$PAGED" -gt 0 ]; then
	echo "codex-usage-page: paged ${PAGED} alarm(s)"
elif [ "$SUPPRESSED" -gt 0 ]; then
	echo "codex-usage-page: ${SUPPRESSED} alarm(s) still active, already paged — nothing new"
else
	echo "codex-usage-page: no window at or above ${THRESHOLD}% and every account is ok — nothing paged"
fi
exit 0
