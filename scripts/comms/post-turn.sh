#!/bin/bash
# post-turn.sh — queue a channel turn from a REMOTE owner host (mini, mini-2).
#
# Why an outbox instead of writing the channel directly: the md-channel file lives ONLY on the
# laptop, and the laptop does not accept ssh (measured 2026-08-18: `ssh laptop` is refused from
# both minis; Remote Login is off and turning it on needs admin). So the remote owner cannot push.
# It queues here, and the laptop PULLS with drain-remote-turns.sh. That direction is also the one
# that survives the laptop sleeping: turns simply accumulate until it wakes.
#
# Handoff is atomic: the turn is written to <name>.part and only then renamed to <name>.md.
# The drainer reads *.md exclusively, so it can never pick up a half-written turn.
#
# Usage:
#   scripts/comms/post-turn.sh --channel <name> --owner <OWNER> [--file <path>]
#   ... | scripts/comms/post-turn.sh --channel <name> --owner <OWNER>      # body on stdin

set -euo pipefail

OUTBOX_ROOT="${CATALYST_OUTBOX_ROOT:-$HOME/catalyst/comms/outbox}"
CHANNEL="" OWNER="" BODY_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --owner)   OWNER="${2:-}";   shift 2 ;;
    --file)    BODY_FILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "post-turn: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$CHANNEL" ]] || { echo "post-turn: --channel is required" >&2; exit 2; }
[[ -n "$OWNER"   ]] || { echo "post-turn: --owner is required" >&2; exit 2; }
# The channel name becomes a directory name; keep it a plain slug so it cannot escape the outbox.
#
# ⛔ Codex #3517 P2: the character class alone is NOT enough, and the test that "proved" it was
# asserting the neighbour. `..` matches ^[A-Za-z0-9._-]+$ perfectly — no slash required — so
# `--channel ..` resolved DEST_DIR to $OUTBOX_ROOT/../pending and reported success while putting
# the turn where no drainer looks. The original test used `../../etc`, which is rejected for
# containing a slash, so it never exercised the case that actually escapes.
reject_slug() { echo "post-turn: --$1 must be a plain slug matching [A-Za-z0-9._-]+ and not '.' or '..' (got '$2')" >&2; exit 2; }
for pair in "channel:$CHANNEL" "owner:$OWNER"; do
  _name="${pair%%:*}"; _val="${pair#*:}"
  [[ "$_val" =~ ^[A-Za-z0-9._-]+$ ]] || reject_slug "$_name" "$_val"
  [[ "$_val" == "." || "$_val" == ".." ]] && reject_slug "$_name" "$_val"
done

DEST_DIR="$OUTBOX_ROOT/$CHANNEL/pending"
mkdir -p "$DEST_DIR"

# UTC so turns from different hosts sort correctly regardless of local zone; the host name keeps
# two owners posting in the same second from colliding.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="${STAMP}-$(hostname -s)-${OWNER}-$$"
PART="$DEST_DIR/$BASE.part"
FINAL="$DEST_DIR/$BASE.md"

if [[ -n "$BODY_FILE" ]]; then
  [[ -r "$BODY_FILE" ]] || { echo "post-turn: cannot read --file '$BODY_FILE'" >&2; exit 2; }
  cat -- "$BODY_FILE" > "$PART"
else
  cat > "$PART"
fi

# A turn with no body is a bug in the caller, not something to deliver silently.
if [[ ! -s "$PART" ]]; then
  rm -f "$PART"
  echo "post-turn: refusing to queue an EMPTY turn (channel=$CHANNEL owner=$OWNER)" >&2
  exit 3
fi

mv -- "$PART" "$FINAL"
echo "post-turn: queued $FINAL ($(wc -c < "$FINAL" | tr -d ' ') bytes)"
