#!/usr/bin/env bash
# catalyst-statusline.sh — Claude Code statusLine wrapper that also emits
# `session.context` canonical events when the Claude session is bound to
# a Catalyst session (CTL-374).
#
# Install by pointing `~/.claude/settings.json` `statusLine.command` at this
# script. Each statusLine tick (default ~30s), Claude Code pipes JSON to
# stdin; we forward to ccstatusline (or whatever CATALYST_STATUSLINE_CMD
# resolves to) for rendering, and — in the background — call
# `catalyst-session.sh emit-context` so the event log gets a periodic
# context/cost/turn snapshot.
#
# Foreground (stdout / render) MUST NEVER fail. Any emit failure is silenced
# so a broken Catalyst install can't poison Claude Code's status bar.

set -u

# ─── Render path (foreground) ───────────────────────────────────────────────

INPUT="$(cat || true)"

RENDER_CMD="${CATALYST_STATUSLINE_CMD:-bunx -y ccstatusline@latest}"

# Forward stdin to the renderer. If RENDER_CMD has spaces, treat as a shell
# command; otherwise treat as an executable path.
if [[ "$RENDER_CMD" == *" "* ]]; then
  # shellcheck disable=SC2086
  printf '%s' "$INPUT" | eval "$RENDER_CMD"
  RENDER_EXIT=$?
else
  printf '%s' "$INPUT" | "$RENDER_CMD"
  RENDER_EXIT=$?
fi

# ─── Emit path (background, best-effort) ────────────────────────────────────
#
# All errors are swallowed. We never want the emit path to surface a non-zero
# exit code or stderr noise into Claude Code.
(
  # Resolve catalyst-session.sh — env override wins (used by tests).
  SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || exit 0
  SESSION_BIN="${CATALYST_SESSION_BIN:-${SCRIPT_DIR}/catalyst-session.sh}"
  [[ -x "$SESSION_BIN" ]] || exit 0

  command -v jq >/dev/null 2>&1 || exit 0

  # Pull the Claude Code session UUID. Bail if missing or not a string.
  CLAUDE_SID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)" || exit 0
  [[ -n "$CLAUDE_SID" ]] || exit 0

  # Find the Catalyst session bound to this Claude UUID. Skip silently if none.
  CATALYST_DIR_LOCAL="${CATALYST_DIR:-$HOME/catalyst}"
  DB_FILE="${CATALYST_DB_FILE:-$CATALYST_DIR_LOCAL/catalyst.db}"
  [[ -f "$DB_FILE" ]] || exit 0
  CAT_SID="$(sqlite3 "$DB_FILE" \
    "SELECT session_id FROM sessions
     WHERE claude_session_id = '${CLAUDE_SID//\'/\'\'}'
       AND status != 'done' AND status != 'failed'
     ORDER BY started_at DESC LIMIT 1;" 2>/dev/null)" || exit 0
  [[ -n "$CAT_SID" ]] || exit 0

  # Extract fields. Each defaults to empty on miss; emit-context handles nulls.
  PCT="$(printf '%s' "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)"
  TOK="$(printf '%s' "$INPUT" | jq -r '.context_window.current_usage // empty' 2>/dev/null)"
  MAX="$(printf '%s' "$INPUT" | jq -r '.context_window.context_window_size // empty' 2>/dev/null)"
  TURN="$(printf '%s' "$INPUT" | jq -r '.turn // empty' 2>/dev/null)"
  COST="$(printf '%s' "$INPUT" | jq -r '.cost.total_cost_usd // empty' 2>/dev/null)"
  MODEL="$(printf '%s' "$INPUT" | jq -r '.model.id // .model // empty' 2>/dev/null)"
  EFFORT="$(printf '%s' "$INPUT" | jq -r '.effort.level // empty' 2>/dev/null)"

  # Without a percentage there's nothing meaningful to emit — bail.
  [[ -n "$PCT" ]] || exit 0

  ARGS=(emit-context "$CAT_SID" --context-pct "$PCT")
  [[ -n "$TOK" ]]    && ARGS+=(--context-tokens "$TOK")
  [[ -n "$MAX" ]]    && ARGS+=(--context-max "$MAX")
  [[ -n "$TURN" ]]   && ARGS+=(--turn "$TURN")
  [[ -n "$MODEL" ]]  && ARGS+=(--model "$MODEL")
  [[ -n "$COST" ]]   && ARGS+=(--cost-usd "$COST")
  [[ -n "$EFFORT" ]] && ARGS+=(--effort "$EFFORT")

  bash "$SESSION_BIN" "${ARGS[@]}" >/dev/null 2>&1 || true
) </dev/null >/dev/null 2>&1 &

# Render exit code propagates to Claude Code. The background fork is detached.
exit "$RENDER_EXIT"
