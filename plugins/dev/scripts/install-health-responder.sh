#!/usr/bin/env bash
# install-health-responder.sh — Idempotently install the catalyst cloud-sync
# health-responder LaunchAgent on macOS: substitute template tokens, write the
# plist to ~/Library/LaunchAgents/, then (re)load via launchctl.
#
# Usage:
#   install-health-responder.sh            # install / reinstall
#   install-health-responder.sh --uninstall # unload and remove plist
#   install-health-responder.sh --print-only # emit substituted plist to stdout
#   install-health-responder.sh --help
#
# Re-running is safe: an already-loaded agent is booted out before being
# re-bootstrapped, so the latest plist always wins.
#
# Structure mirrors install-orphan-sweep.sh (CTL-1306) verbatim — same
# pristine-clone path resolution, same ephemeral-path hard-refusal, same
# flags-before-guard ordering — because the failure mode is identical: the
# plist's baked program path is permanent, and baking a worktree/temp path
# means a silently exit-127ing responder after that checkout is deleted.

set -euo pipefail

# Resolve script dir following symlinks (same pattern as health-responder.sh).
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"

# CTL-1968: `gui/$(id -u)` is a PER-USER launchd domain, so a scratch HOME does
# NOT sandbox it — it renders the plist somewhere temporary and then re-binds the
# REAL label to that path. Refuse rather than damage the live domain.
[[ -f "${SCRIPT_DIR}/lib/launchd-domain-guard.sh" ]] || {
  echo "install-health-responder.sh: missing lib/launchd-domain-guard.sh next to this script" >&2; exit 1; }
# shellcheck source=lib/launchd-domain-guard.sh
. "${SCRIPT_DIR}/lib/launchd-domain-guard.sh"
launchd_agent_guard() {
  launchd_guard_ok "the health-responder agent" && return 0
  launchd_guard_message "the health-responder agent" >&2
  echo "install-health-responder.sh: REFUSED (${CATALYST_LAUNCHD_GUARD_REASON})" >&2
  exit 1
}
unset _SRC

# DEST + LABEL do NOT depend on BAKE_DIR — define them up front so --uninstall
# can run without ever resolving (or guarding) a bake dir.
DEST="${HOME}/Library/LaunchAgents/ai.coalesce.catalyst-health-responder.plist"
LABEL="ai.coalesce.catalyst-health-responder"

# ─── flags ──────────────────────────────────────────────────────────────────
#
# Parse flags BEFORE resolving BAKE_DIR or running the ephemeral guard. The guard
# can `exit 1`; running it ahead of flag parsing would mean `--uninstall` and
# `--help` from a /tmp checkout or linked worktree exit 1 WITHOUT uninstalling
# (the CTL-1306 lesson from install-orphan-sweep.sh). The guard only gates the
# install / print paths.

UNINSTALL=0
PRINT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --uninstall)  UNINSTALL=1 ;;
    --print-only) PRINT_ONLY=1 ;;
    --help|-h)
      echo "Usage: install-health-responder.sh [--uninstall|--print-only|--help]"
      echo ""
      echo "  (no flags)    Install / reinstall the LaunchAgent"
      echo "  --uninstall   Unload and remove the plist"
      echo "  --print-only  Print the substituted plist to stdout without installing"
      echo "  --help        Show this message"
      exit 0
      ;;
    *)
      # Reject unknown args (Codex P2): a typo like --uninstalll must not fall
      # through to a full install/reload, nor --print-onl to a side-effecting run.
      printf 'install-health-responder.sh: unknown argument: %s (see --help)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

# ─── helpers ────────────────────────────────────────────────────────────────
#
# CTL-1306 (inherited): the plist's program path is permanent. Installing from a
# throwaway worktree (e.g. /private/tmp/... or ~/catalyst/wt/<TICKET>) would
# bake a path that later gets deleted — the responder then exit-127s silently
# every interval, which for THIS agent means the fleet loses its cloud-sync
# self-healer exactly when nobody is watching. So:
#   1. Prefer the registered pristine clone (catalyst.orchestration.pluginDirs →
#      the main-only ~/catalyst/plugin-source that wrappers + daemons resolve to).
#   2. HARD-REFUSE to bake a path inside a *linked git worktree* or a temp dir —
#      those are exactly the paths that vanish. A real clone (plugin-source, a
#      main checkout) has git-dir == git-common-dir; a linked worktree does not.
#
# CATALYST_LAYER2_CONFIG_FILE overridable for tests; CATALYST_FORCE_BAKE_DIR lets
# tests inject a resolved dir without a real config/clone.

# _pristine_scripts_dir: the scripts dir of the registered pristine clone, or "".
_pristine_scripts_dir() {
  # Codex P2: honor the CANONICAL pluginDirs precedence (lib/plugin-dirs.sh —
  # env CATALYST_PLUGIN_DIRS, then repo .catalyst/config.json, then machine
  # config) instead of a machine-config-only read, which could bake a
  # removable marketplace-cache path while a pristine source is explicitly
  # registered upstream. Source the shared lib when present; fall back to the
  # legacy Layer-2 read when it isn't (a partial checkout must still install).
  local pd=""
  if [[ -r "${SCRIPT_DIR}/lib/plugin-dirs.sh" ]]; then
    # shellcheck source=/dev/null
    . "${SCRIPT_DIR}/lib/plugin-dirs.sh" 2>/dev/null || true
    if command -v resolve_plugin_dirs >/dev/null 2>&1; then
      # resolve_plugin_dirs POPULATES RESOLVED_PLUGIN_DIRS (it emits NO stdout)
      # — call it in THIS shell and read the variable; a $(subshell) capture is
      # always empty and would silently discard the env/repo-config precedence
      # (Codex P2 round 2). Anchor at SCRIPT_DIR so the repo-config walk
      # resolves the checkout the installer itself lives in (CTL-1349 pattern).
      resolve_plugin_dirs "$SCRIPT_DIR" 2>/dev/null || true
      pd="${RESOLVED_PLUGIN_DIRS%%:*}"
    fi
  fi
  if [[ -z "$pd" ]]; then
    local cfg="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"
    [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1 || return 0
    # pluginDirs is polymorphic (join-bundle.mjs:61): a string, or an array whose
    # first element is the active dir. Normalize both to a single path.
    pd="$(jq -r '.catalyst.orchestration.pluginDirs | if type=="array" then .[0] elif type=="string" then . else empty end' "$cfg" 2>/dev/null || true)"
  fi
  # pluginDirs points at <clone>/plugins/dev; health-responder.sh lives under scripts/.
  [[ -n "$pd" && -f "${pd}/scripts/health-responder.sh" ]] && echo "${pd}/scripts"
  # FAIL OPEN (CTL-1306): a false [[ ... ]] test would otherwise make this
  # function return 1, and under `set -euo pipefail` the caller's
  # BAKE_DIR="$(_pristine_scripts_dir)" would abort the whole installer BEFORE
  # the SCRIPT_DIR fallback — stranding a host whose config exists but has
  # stale/absent pluginDirs with NO responder. Always exit 0.
  return 0
}

# _is_ephemeral_dir <dir>: true if the dir is a linked git worktree or under a
# temp root — i.e. a path that can be deleted out from under the LaunchAgent.
# A linked worktree's git dir is always <main>/.git/worktrees/<name>; a real
# clone's is <clone>/.git — so the /worktrees/ segment cleanly distinguishes them.
_is_ephemeral_dir() {
  local d="$1"
  case "$d" in
    /private/tmp/*|/tmp/*|/var/tmp/*|/var/folders/*|*/.Trash/*) return 0 ;;
  esac
  command -v git >/dev/null 2>&1 || return 1
  local gd
  gd="$(git -C "$d" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  case "$gd" in
    */worktrees/*) return 0 ;;
  esac
  return 1
}

# _os: returns 'Darwin' or 'Linux', controllable via CATALYST_FORCE_OS.
_os() {
  echo "${CATALYST_FORCE_OS:-$(uname -s)}"
}

# _interval_seconds: read .catalyst/config.json for responder.intervalSeconds,
# clamp to 60–900 (default 180).
_interval_seconds() {
  local secs=180
  local config_candidate=""

  # Walk up from $PWD looking for .catalyst/config.json.
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.catalyst/config.json" ]]; then
      config_candidate="$dir/.catalyst/config.json"
      break
    fi
    dir="$(dirname "$dir")"
  done

  if [[ -n "$config_candidate" ]] && command -v jq >/dev/null 2>&1; then
    local raw
    raw="$(jq -r '.catalyst.responder.intervalSeconds // empty' "$config_candidate" 2>/dev/null || true)"
    if [[ -n "$raw" ]] && [[ "$raw" =~ ^[0-9]+$ ]]; then
      secs="$raw"
    fi
  fi

  # Clamp to 60–900: below 60 the responder churns launchctl/pgrep for nothing;
  # above 900 a dead writer outlives the read tier's 300s serve gate too long.
  if [[ "$secs" -lt 60 ]]; then
    secs=60
  elif [[ "$secs" -gt 900 ]]; then
    secs=900
  fi

  echo "$secs"
}

# ─── template substitution ──────────────────────────────────────────────────

# PATH for launchd's/cron's otherwise-minimal environment (Codex P2): homebrew
# jq (the breadcrumb parser — without it the settling hold + no-respawn
# detection go dark), bun, and the member CLI dirs. Mirrors catalyst-stack's
# _stack_agent_path (CTL-1289) — keep the two in sync. Shared by the plist
# substitution AND the cron backstop line (CTL-1510 item 6).
_agent_path() {
  echo "${HOME}/.catalyst/bin:${HOME}/.local/node/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# _escape_repl VALUE — make VALUE safe to inject into the plist via sed
# (CTL-1510 item 3). A path like "/Volumes/Catalyst & Data" otherwise breaks
# TWICE: `&` is sed's whole-match metacharacter (mangled program path → silent
# exit-127 loop) and a raw `&`/`<`/`>` is invalid inside an XML <string>.
# Implemented as a sed pipeline, NOT bash parameter expansion (Codex P1): the
# plist/cron runtime is /bin/bash 3.2 on macOS, where `${v//&/\\&}` drops the
# intended backslash and the corruption returns. Order matters: backslash-
# double first (before we add our own backslashes), XML-entity-escape second,
# sed-metacharacter-escape last (so the `&` in `&amp;` is itself protected).
_escape_repl() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/[&|]/\\&/g'
}

_substitute() {
  local interval
  interval="$(_interval_seconds)"
  sed \
    -e "s|REPLACE_WITH_ABSOLUTE|$(_escape_repl "$BAKE_DIR")|g" \
    -e "s|REPLACE_HOME|$(_escape_repl "$HOME")|g" \
    -e "s|REPLACE_START_INTERVAL|${interval}|g" \
    -e "s|REPLACE_PATH|$(_escape_repl "$(_agent_path)")|g" \
    -e "s|REPLACE_CATALYST_DIR|$(_escape_repl "${CATALYST_DIR:-${HOME}/catalyst}")|g" \
    "$TEMPLATE"
}

# ─── --uninstall ─────────────────────────────────────────────────────────────
#
# Runs BEFORE any BAKE_DIR resolution / ephemeral guard / TEMPLATE — uninstall
# only needs DEST + LABEL, so it must work even from a /tmp checkout or linked
# worktree (CTL-1306). The guard never gates uninstall.

# Tag marking the responder's cron backstop line (CTL-1510 item 6). A trailing
# `# comment` inside a crontab COMMAND is a shell comment (cron hands the line
# to sh), so one self-tagged line is both greppable and inert.
CRON_TAG="# ai.coalesce.catalyst-health-responder backstop CTL-1510"

# _remove_cron_backstop: drop our tagged line from the user crontab, keeping
# everything else. No crontab binary / no crontab at all → silent no-op.
_remove_cron_backstop() {
  command -v crontab >/dev/null 2>&1 || return 0
  local existing
  existing="$(crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true)"
  if [[ -n "$existing" ]]; then
    printf '%s\n' "$existing" | crontab -
  else
    crontab -r 2>/dev/null || true
  fi
  return 0
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchd_agent_guard
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  _remove_cron_backstop
  echo "install-health-responder.sh: uninstalled ${LABEL} (launchd agent + cron backstop)"
  exit 0
fi

# ─── non-Darwin early exit (install path only) ───────────────────────────────
#
# --print-only proceeds on ANY platform (Codex P2): `catalyst-stack
# install-services --print` directs non-macOS users to preview the plists, and
# rendering needs no launchctl — only the actual install is macOS-only.

if [[ "$(_os)" != "Darwin" && "$PRINT_ONLY" -ne 1 ]]; then
  echo "install-health-responder.sh: non-Darwin platform detected ($(_os))." >&2
  echo "  Linux scheduling (systemd timer) is a follow-up. No launchctl action taken." >&2
  exit 0
fi

# ─── resolve BAKE_DIR + ephemeral guard + TEMPLATE (install / print only) ─────
#
# Only reached for the install and --print-only paths; uninstall + help have
# already exited. BAKE_DIR: prefer the pristine clone; else SCRIPT_DIR. The guard
# STILL fires for a plain install and for --print-only.

BAKE_DIR="${CATALYST_FORCE_BAKE_DIR:-$(_pristine_scripts_dir)}"
[[ -z "$BAKE_DIR" ]] && BAKE_DIR="$SCRIPT_DIR"
if _is_ephemeral_dir "$BAKE_DIR"; then
  echo "install-health-responder.sh: refusing to install from an ephemeral path (CTL-1306):" >&2
  echo "  $BAKE_DIR" >&2
  echo "  A linked worktree / temp dir can be deleted, which silently kills the responder." >&2
  echo "  Run from the pristine clone (e.g. ~/catalyst/plugin-source/plugins/dev/scripts)," >&2
  echo "  or register catalyst.orchestration.pluginDirs in ~/.config/catalyst/config.json." >&2
  exit 1
fi

TEMPLATE="${BAKE_DIR}/orch-monitor/dist/ai.coalesce.catalyst-health-responder.plist"

# ─── template sanity check ──────────────────────────────────────────────────

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-health-responder.sh: plist template not found at ${TEMPLATE}" >&2
  exit 1
fi

# ─── --print-only ────────────────────────────────────────────────────────────

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  _substitute
  exit 0
fi

# ─── install ─────────────────────────────────────────────────────────────────

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/catalyst"

local_tmp="${DEST}.tmp"
_substitute > "$local_tmp"
mv "$local_tmp" "$DEST"
echo "install-health-responder.sh: wrote ${DEST}"

# Reload idempotently: bootout any existing instance (ignore failure when not
# loaded), then bootstrap the fresh plist.
launchd_agent_guard
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-health-responder.sh: loaded ${LABEL} into gui/$(id -u)"
echo "install-health-responder.sh: verify with 'launchctl list | grep ${LABEL}'"

# ─── cron backstop (CTL-1510 item 6) ─────────────────────────────────────────
#
# launchd cannot be the responder's only scheduler: a fleet host (mini-2,
# 2026-07-25) was observed accepting this job into its gui domain and then
# refusing ALL automatic spawns — StartInterval pended indefinitely and even
# RunAtLoad stopped firing after a clean bootout/bootstrap, while kickstart
# ran the sweep fine and an older StartInterval job kept firing in the same
# domain. The watchdog's own scheduling layer therefore has the exact
# unreliability class it exists to guard against, so a second, independent
# dispatch path is installed unconditionally: a self-tagged user crontab line.
# Overlap with a working launchd schedule is serialized by the responder's
# whole-sweep lock (item 5) — worst case is a skipped-heartbeat sweep, never a
# double kickstart. Env is inline (cron's default env is bare): the same PATH
# the plist bakes (jq lives in homebrew) + CATALYST_DIR.
if command -v crontab >/dev/null 2>&1; then
  CRON_MINUTES=$(( ( $(_interval_seconds) + 59 ) / 60 ))
  [[ "$CRON_MINUTES" -lt 1 ]] && CRON_MINUTES=1
  [[ "$CRON_MINUTES" -gt 59 ]] && CRON_MINUTES=59
  # _cron_quote VALUE — single-quote a value for the cron COMMAND field
  # (Codex P2: double quotes let cron's /bin/sh re-expand `$`, backticks, and
  # backslashes inside configured paths). Single quotes preserve everything
  # except `'` itself (closed-escaped-reopened) and `%`, which crontab turns
  # into a newline unless backslash-escaped — both handled via sed (NOT bash
  # parameter expansion; /bin/bash 3.2 mangles the escapes, same class as
  # _escape_repl).
  _cron_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed -e "s/'/'\\\\''/g" -e 's/%/\\%/g')"
  }
  CRON_LINE="*/${CRON_MINUTES} * * * * PATH=$(_cron_quote "$(_agent_path)") CATALYST_DIR=$(_cron_quote "${CATALYST_DIR:-${HOME}/catalyst}") /bin/bash $(_cron_quote "${BAKE_DIR}/health-responder.sh") >> $(_cron_quote "${CATALYST_DIR:-${HOME}/catalyst}/health-responder.log") 2>&1 ${CRON_TAG}"
  EXISTING_CRON="$(crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true)"
  if [[ -n "$EXISTING_CRON" ]]; then
    printf '%s\n%s\n' "$EXISTING_CRON" "$CRON_LINE" | crontab -
  else
    printf '%s\n' "$CRON_LINE" | crontab -
  fi
  echo "install-health-responder.sh: installed cron backstop (*/${CRON_MINUTES} min; launchd StartInterval is not trusted alone — CTL-1510)"
else
  echo "install-health-responder.sh: crontab not found — no cron backstop; launchd StartInterval is the ONLY scheduler (unreliable on some hosts, CTL-1510)" >&2
fi
