#!/bin/bash
# drain-remote-turns.sh — run on the CHANNEL HOST (the laptop). Pulls queued turns from remote
# owner hosts and appends them to the md-channel file.
#
# Direction is pull-only, and deliberately: the laptop does not accept ssh (measured 2026-08-18:
# refused from both minis), and a pull keeps working while the laptop sleeps — remote turns queue
# in the mini's outbox and land on the next drain.
#
# Delivery is AT-LEAST-ONCE, on purpose. The turn is appended to the channel FIRST and only marked
# sent afterwards, so a crash in between re-delivers a turn (a visible duplicate) instead of
# dropping one (a silent loss). Losing an owner's turn is the worse failure.
#
# Usage:
#   scripts/comms/drain-remote-turns.sh --channel <name> [--hosts mini,mini-2] [--dry-run]

set -euo pipefail

CHANNEL_DIR="${CATALYST_MD_CHANNELS:-$HOME/catalyst/comms/md-channels}"
REMOTE_OUTBOX_ROOT="${CATALYST_REMOTE_OUTBOX_ROOT:-catalyst/comms/outbox}"   # relative to remote $HOME
CHANNEL="" HOSTS="mini,mini-2" DRY_RUN=0
SSH_CMD="${CATALYST_SSH:-ssh}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --hosts)   HOSTS="${2:-}";   shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "drain: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$CHANNEL" ]] || { echo "drain: --channel is required" >&2; exit 2; }
CHANNEL_FILE="$CHANNEL_DIR/$CHANNEL.md"
[[ -f "$CHANNEL_FILE" ]] || { echo "drain: no such channel file: $CHANNEL_FILE" >&2; exit 2; }

# One appender at a time: two concurrent drains would interleave turns mid-line.
LOCK="$CHANNEL_FILE.drain.lock"
exec 9>"$LOCK"
if ! /usr/bin/env flock -n 9 2>/dev/null; then
  # macOS has no flock(1) by default; fall back to an atomic mkdir lock.
  LOCKDIR="$CHANNEL_FILE.drain.lockdir"
  if ! mkdir "$LOCKDIR" 2>/dev/null; then
    echo "drain: another drain holds the lock ($LOCKDIR) — skipping this pass" >&2
    exit 0
  fi
  trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT
fi

drained=0 failed=0
IFS=',' read -r -a HOST_LIST <<< "$HOSTS"

for host in "${HOST_LIST[@]}"; do
  [[ -n "$host" ]] || continue
  remote_dir="$REMOTE_OUTBOX_ROOT/$CHANNEL/pending"

  # `|| true`: an unreachable or outbox-less host must not abort the other hosts' turns.
  files="$($SSH_CMD -o BatchMode=yes -o ConnectTimeout=10 "$host" \
            "ls -1 '$remote_dir'/*.md 2>/dev/null | sort" 2>/dev/null || true)"
  [[ -n "$files" ]] || { echo "drain: $host — nothing queued"; continue; }

  while IFS= read -r rf; do
    [[ -n "$rf" ]] || continue
    body="$($SSH_CMD -o BatchMode=yes -o ConnectTimeout=10 "$host" "cat -- '$rf'" 2>/dev/null || true)"
    if [[ -z "$body" ]]; then
      echo "drain: $host — could not read '$rf' (or it is empty); LEAVING it queued" >&2
      failed=$((failed + 1))
      continue
    fi

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "drain: [dry-run] would append $host:$rf ($(printf '%s' "$body" | wc -c | tr -d ' ') bytes)"
      drained=$((drained + 1))
      continue
    fi

    # Append first, ack second — see the at-least-once note above.
    { printf '\n'; printf '%s\n' "$body"; } >> "$CHANNEL_FILE"

    if $SSH_CMD -o BatchMode=yes -o ConnectTimeout=10 "$host" \
         "mkdir -p '$REMOTE_OUTBOX_ROOT/$CHANNEL/sent' && mv -- '$rf' '$REMOTE_OUTBOX_ROOT/$CHANNEL/sent'/" 2>/dev/null; then
      echo "drain: $host — delivered $(basename "$rf")"
    else
      # Delivered but not acked: say so loudly, because the next pass WILL duplicate it.
      echo "drain: $host — APPENDED '$rf' but could not mark it sent; the next drain will DUPLICATE it" >&2
      failed=$((failed + 1))
    fi
    drained=$((drained + 1))
  done <<< "$files"
done

echo "drain: $drained turn(s) delivered, $failed problem(s), channel=$CHANNEL_FILE"
[[ "$failed" -eq 0 ]]
