#!/usr/bin/env bash
# install-account-rotation.sh — CTL-2145. Idempotently install the account-rotation
# LaunchAgent on macOS: substitute template tokens, write the plist to
# ~/Library/LaunchAgents/, materialize the coord kit into the durable runtime dir,
# retire any stray legacy rotation/lane loop, then (re)load via launchctl.
#
# Usage:
#   install-account-rotation.sh             # install / reinstall
#   install-account-rotation.sh --uninstall # unload and remove plist
#   install-account-rotation.sh --print-only # emit substituted plist to stdout
#   install-account-rotation.sh --print       # alias for --print-only
#   install-account-rotation.sh --help
#
# Re-running is safe: an already-loaded agent is booted out before being
# re-bootstrapped, so the latest plist always wins.
#
# Structure deliberately mirrors install-orphan-sweep.sh — the pristine-path guard,
# _escape_repl, the mode-precedence ladder, and the bootout-then-bootstrap idiom are
# the same mechanisms, and a second divergent opinion about any of them is how one of
# them silently stops matching reality.

set -euo pipefail

# Resolve script dir following symlinks.
_SRC="${BASH_SOURCE[0]}"
while [[ -L "$_SRC" ]]; do _SRC="$(readlink "$_SRC")"; done
SCRIPT_DIR="$(cd "$(dirname "$_SRC")" && pwd)"

# CTL-1968: `gui/$(id -u)` is a PER-USER launchd domain, so a scratch HOME does NOT
# sandbox it — it renders the plist somewhere temporary and then re-binds the REAL
# label to that path. Refuse rather than damage the live domain.
[[ -f "${SCRIPT_DIR}/lib/launchd-domain-guard.sh" ]] || {
  echo "install-account-rotation.sh: missing lib/launchd-domain-guard.sh next to this script" >&2
  exit 1
}
# shellcheck source=lib/launchd-domain-guard.sh
. "${SCRIPT_DIR}/lib/launchd-domain-guard.sh"
launchd_agent_guard() {
  launchd_guard_ok "the account-rotation agent" && return 0
  launchd_guard_message "the account-rotation agent" >&2
  echo "install-account-rotation.sh: REFUSED (${CATALYST_LAUNCHD_GUARD_REASON})" >&2
  exit 1
}
unset _SRC

# DEST + LABEL do NOT depend on BAKE_DIR — define them up front so --uninstall can run
# without ever resolving (or guarding) a bake dir.
DEST="${HOME}/Library/LaunchAgents/ai.coalesce.catalyst-account-rotation.plist"
LABEL="ai.coalesce.catalyst-account-rotation"

# D5 — the node classes this agent belongs on, as ONE constant so the set is trivially
# adjustable. Rotation is a laptop/concierge-side function and the handles only exist
# where claude-accounts.env is provisioned; today that is the same class that already
# receives install-services.
ROTATION_NODE_CLASSES="worker"

ACCOUNTS_ENV="${CLAUDE_ACCOUNTS_ENV:-${HOME}/.config/catalyst/claude-accounts.env}"

# ─── flags ──────────────────────────────────────────────────────────────────
#
# Parsed BEFORE any guard runs. The guards can `exit 1`, and running them ahead of
# flag parsing meant `--uninstall`/`--help` from a temp checkout exited 1 WITHOUT
# uninstalling (CTL-1306), so `uninstall-services` could not remove the agent.

UNINSTALL=0
PRINT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    # `--print` is accepted as an alias because `catalyst-stack install-services
    # --print` routes its delegates to `--print-only` while operators (and this
    # ticket's own acceptance criteria) reach for `--print`. Accepting one and
    # silently ignoring the other is how a "renders fine" check ends up testing
    # nothing: an unrecognized flag here would just install for real.
    --print-only | --print) PRINT_ONLY=1 ;;
    --help | -h)
      echo "Usage: install-account-rotation.sh [--uninstall|--print-only|--help]"
      echo ""
      echo "  (no flags)    Install / reinstall the LaunchAgent"
      echo "  --uninstall   Unload and remove the plist"
      echo "  --print-only  Print the substituted plist to stdout without installing"
      echo "  --print       Alias for --print-only"
      echo "  --help        Show this message"
      exit 0
      ;;
    *)
      echo "install-account-rotation.sh: unknown argument '${arg}'" >&2
      exit 2
      ;;
  esac
done

# ─── helpers ────────────────────────────────────────────────────────────────

# _pristine_scripts_dir: the scripts dir of the registered pristine clone, or "".
# Identified by the presence of the actor this agent runs — not by orphan-sweep.sh,
# so a clone that has one but not the other cannot be mistaken for a valid bake dir.
_pristine_scripts_dir() {
  local cfg="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"
  [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1 || return 0
  local pd
  # pluginDirs is polymorphic (join-bundle.mjs): a string, or an array whose first
  # element is the active dir. Normalize both to a single path.
  pd="$(jq -r '.catalyst.orchestration.pluginDirs | if type=="array" then .[0] elif type=="string" then . else empty end' "$cfg" 2>/dev/null || true)"
  [[ -n "$pd" && -f "${pd}/scripts/coord/account-rotation-watch.sh" ]] && echo "${pd}/scripts"
  # FAIL OPEN: a false [[ ]] would make this return 1, and under `set -euo pipefail`
  # the caller's BAKE_DIR="$(...)" would abort the installer BEFORE the SCRIPT_DIR
  # fallback — stranding a host whose config exists but has stale pluginDirs.
  return 0
}

# _is_ephemeral_dir <dir>: true if the dir is a linked git worktree or under a temp
# root — a path that can be deleted out from under the LaunchAgent. A linked
# worktree's git dir is always <main>/.git/worktrees/<name>; a real clone's is
# <clone>/.git, so the /worktrees/ segment cleanly distinguishes them.
_is_ephemeral_dir() {
  local d="$1"
  case "$d" in
    /private/tmp/* | /tmp/* | /var/tmp/* | /var/folders/* | */.Trash/*) return 0 ;;
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

# _node_class — this node's catalyst.node.class.
#
# DELEGATED, not re-implemented. catalyst-stack's _resolve_node_class carries a
# fail-closed three-case ladder (absent ⇒ worker, recognized ⇒ honored,
# present-but-invalid ⇒ monitor) that is itself a mirror of the canonical
# resolveNodeClass(); a third hand-written copy here would be the one that drifts.
# So: the env var the canonical resolver honors first, else the canonical resolver
# itself, else the empty string meaning UNKNOWN — never a guessed default.
_node_class() {
  if [[ -n "${CATALYST_NODE_CLASS:-}" ]]; then
    printf '%s' "$CATALYST_NODE_CLASS"
    return 0
  fi
  local cfgmjs="${SCRIPT_DIR}/execution-core/config.mjs"
  if command -v bun >/dev/null 2>&1 && [[ -f "$cfgmjs" ]]; then
    local out
    if out="$(CFG_MJS="$cfgmjs" bun -e '
        const m = await import(process.env.CFG_MJS);
        try { process.stdout.write(String(m.resolveNodeClass().class || "")); }
        catch { process.stdout.write(""); }
      ' 2>/dev/null)" && [[ -n "$out" ]]; then
      printf '%s' "$out"
      return 0
    fi
  fi
  printf ''
}

# _interval_seconds: .catalyst/config.json → catalyst.accountRotation.intervalSeconds,
# clamped to [60, 3600], default 300. Clamped rather than trusted: a 1-second interval
# would spawn a process every second forever, and launchd would happily oblige.
_interval_seconds() {
  local secs=300 cfg="" dir="$PWD"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -f "$dir/.catalyst/config.json" ]]; then
      cfg="$dir/.catalyst/config.json"
      break
    fi
    dir="$(dirname "$dir")"
  done
  if [[ -n "$cfg" ]] && command -v jq >/dev/null 2>&1; then
    local raw
    raw="$(jq -r '.catalyst.accountRotation.intervalSeconds // empty' "$cfg" 2>/dev/null || true)"
    [[ "$raw" =~ ^[0-9]+$ ]] && secs="$raw"
  fi
  ((secs < 60)) && secs=60
  ((secs > 3600)) && secs=3600
  echo "$secs"
}

# ─── template substitution ──────────────────────────────────────────────────

# _escape_repl VALUE — make VALUE safe to inject into the plist via sed (kept in
# lockstep with install-orphan-sweep.sh / install-health-responder.sh): a path like
# "/Volumes/Catalyst & Data" otherwise breaks TWICE — `&` is sed's whole-match
# metacharacter (mangled program path → silent exit-127 loop) and a raw `&`/`<`/`>`
# is invalid inside an XML <string>. A sed pipeline, NOT bash parameter expansion
# (/bin/bash 3.2 drops the backslash from `${v//&/\\&}`). Backslash-double first,
# XML-entity-escape second, sed-metacharacter-escape last.
_escape_repl() {
  printf '%s' "$1" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/[&|]/\\&/g'
}

# _agent_path — the PATH baked into the LaunchAgent's EnvironmentVariables.
#
# THIS IS THE HIGH-SEVERITY ONE. launchd gives a job only its built-in
# /usr/bin:/bin:/usr/sbin:/sbin unless a PATH is declared in the plist, and the
# actor's default switch verb is `catalyst-stack claude-account switch` —
# catalyst-stack installs to ~/.catalyst/bin, which is not on that list. An agent
# without this key exits 127 on every enforce tick, and since the actor records
# the cap attempt BEFORE invoking the verb, three such ticks exhaust the hourly
# cap and every later tick logs "CAPPED", which reads like a healthy circuit
# breaker. Kept in lockstep with install-health-responder.sh's _agent_path.
_agent_path() {
  echo "${HOME}/.catalyst/bin:${HOME}/.local/node/bin:${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# ── The rollout knob must SURVIVE reinstallation ────────────────────────────
#
# Precedence (each step only applies when it yields off|shadow|enforce):
#   1. an explicit CATALYST_ACCOUNT_ROTATION in the installing environment
#   2. .catalyst/config.json → catalyst.accountRotation.mode
#   3. the value ALREADY IN the installed plist  ← makes a hand-flip survive a reinstall
#   4. "shadow" — dark-by-default
# Anything unrecognized falls back to shadow LOUDLY and SHORT-CIRCUITS: it must not
# fall through to a lower-precedence source, or a mistyped rollback
# (CATALYST_ACCOUNT_ROTATION=shdow) would be warned about and then ignored in favour
# of an `enforce` already sitting in config or the installed plist — the operator's
# attempt to DISARM would re-arm it.

_installed_rotation_mode() {
  [[ -f "$DEST" ]] || {
    printf ''
    return 0
  }
  grep -A2 '<key>CATALYST_ACCOUNT_ROTATION</key>' "$DEST" 2>/dev/null |
    sed -n 's|.*<string>\(.*\)</string>.*|\1|p' |
    head -1
}

# _config_rotation_path — the nearest .catalyst/config.json walking up from $PWD, or
# empty. Split out so an invalid-value warning can name the ACTUAL file it read.
_config_rotation_path() {
  local dir="$PWD"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -f "$dir/.catalyst/config.json" ]]; then
      printf '%s' "$dir/.catalyst/config.json"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  printf ''
}

_config_rotation_mode() {
  local cfg
  cfg="$(_config_rotation_path)"
  [[ -n "$cfg" ]] && command -v jq >/dev/null 2>&1 || {
    printf ''
    return 0
  }
  jq -r '.catalyst.accountRotation.mode // empty' "$cfg" 2>/dev/null || printf ''
}

# The warning NAMES ITS SOURCE. This ladder has THREE sources, so a message hardcoding
# CATALYST_ACCOUNT_ROTATION sends an operator to grep the one place the bad value is not
# when the typo actually sits in config or in the already-installed plist. Pairs are
# `source|value`, split on the FIRST `|` only.
_resolve_rotation_mode() {
  local pair mode_source candidate cfg
  cfg="$(_config_rotation_path)"
  for pair in "env CATALYST_ACCOUNT_ROTATION|${CATALYST_ACCOUNT_ROTATION:-}" \
    "${cfg:-.catalyst/config.json} (catalyst.accountRotation.mode)|$(_config_rotation_mode)" \
    "the installed plist at ${DEST}|$(_installed_rotation_mode)"; do
    mode_source="${pair%%|*}"
    candidate="${pair#*|}"
    case "$candidate" in
      off | shadow | enforce)
        printf '%s' "$candidate"
        return 0
        ;;
      "") ;;
      *)
        echo "install-account-rotation.sh: account rotation mode '${candidate}' from ${mode_source} is not one of off|shadow|enforce — falling back to 'shadow' (NOT to any lower-precedence value)" >&2
        printf 'shadow'
        return 0
        ;;
    esac
  done
  printf 'shadow'
}

_substitute() {
  local interval mode
  interval="$(_interval_seconds)"
  # No _escape_repl on mode/interval: both are constrained to a fixed literal set /
  # digits above, so neither can carry a sed metacharacter or an XML-unsafe byte.
  mode="$(_resolve_rotation_mode)"
  sed \
    -e "s|REPLACE_WITH_ABSOLUTE|$(_escape_repl "$BAKE_DIR")|g" \
    -e "s|REPLACE_HOME|$(_escape_repl "$HOME")|g" \
    -e "s|REPLACE_START_INTERVAL|${interval}|g" \
    -e "s|REPLACE_ROTATION_MODE|${mode}|g" \
    -e "s|REPLACE_PATH|$(_escape_repl "$(_agent_path)")|g" \
    -e "s|REPLACE_CATALYST_DIR|$(_escape_repl "${CATALYST_DIR:-${HOME}/catalyst}")|g" \
    "$TEMPLATE"
}

# ─── --uninstall ─────────────────────────────────────────────────────────────
#
# Runs BEFORE any BAKE_DIR resolution / ephemeral guard / applicability gate —
# uninstall only needs DEST + LABEL, so it must work even from a temp checkout or a
# linked worktree (CTL-1306), and must NOT be gated on node class or on
# claude-accounts.env still being present. Removing an agent that should not be there
# is exactly what uninstall is for.

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchd_agent_guard
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-account-rotation.sh: uninstalled ${LABEL}"
  exit 0
fi

# ─── non-Darwin early exit (INSTALL path only) ───────────────────────────────
#
# --print-only is deliberately EXEMPT and is handled further down, after TEMPLATE
# resolution. Print mode is documented as a side-effect-free preview, and
# `catalyst-stack install-services --print` calls this delegate BEFORE its own Darwin
# gate — so gating the preview on the platform silently omitted the account-rotation
# plist from every non-Darwin preview. Silently is the operative word: the caller
# suppresses this delegate's stderr and accepts exit 0, so "rendered nothing" and
# "rendered fine" were indistinguishable, and the only way to see the plist was the
# test-only CATALYST_FORCE_OS=Darwin override (CTL-2145).
#
# The INSTALL path still exits HERE, before BAKE_DIR resolution, so a non-Darwin host
# never reaches the ephemeral-path refusal below — which would turn this documented
# no-op into a hard exit-1 failure of an otherwise fine install-services run.
if [[ "$PRINT_ONLY" -ne 1 && "$(_os)" != "Darwin" ]]; then
  echo "install-account-rotation.sh: non-Darwin platform detected ($(_os))." >&2
  echo "  This agent is a macOS LaunchAgent; no launchctl action taken." >&2
  exit 0
fi

# ─── resolve BAKE_DIR + ephemeral guard + TEMPLATE ───────────────────────────
#
# Reached for the install and --print-only paths; uninstall + help have exited.
# The ephemeral guard fires for BOTH, deliberately: --print-only exists to show what
# WOULD be installed, and a print that happily renders a path the installer would
# refuse is a preview of a thing that cannot happen.

BAKE_DIR="${CATALYST_FORCE_BAKE_DIR:-$(_pristine_scripts_dir)}"
[[ -z "$BAKE_DIR" ]] && BAKE_DIR="$SCRIPT_DIR"
if _is_ephemeral_dir "$BAKE_DIR"; then
  echo "install-account-rotation.sh: refusing to install from an ephemeral path (CTL-1306):" >&2
  echo "  $BAKE_DIR" >&2
  echo "  A linked worktree / temp dir can be deleted, which silently kills the agent." >&2
  echo "  Run from the pristine clone (e.g. ~/catalyst/plugin-source/plugins/dev/scripts)," >&2
  echo "  or register catalyst.orchestration.pluginDirs in ~/.config/catalyst/config.json." >&2
  exit 1
fi

TEMPLATE="${BAKE_DIR}/coord/ai.coalesce.catalyst-account-rotation.plist"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "install-account-rotation.sh: plist template not found at ${TEMPLATE}" >&2
  exit 1
fi

# ─── --print-only ────────────────────────────────────────────────────────────
#
# Before the applicability gate AND after the platform gate's install-path exit above:
# `install-services --print` must be able to show the rendered agent on any host —
# including one where it would not actually be installed, and including a non-Darwin
# one (CTL-2145).

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  _substitute
  exit 0
fi

# ─── applicability gate (D5) ─────────────────────────────────────────────────
#
# Two conditions, and the SECOND is the real one. A host with no provisioned accounts
# has nothing to rotate between, so installing there would give it a tick that can
# only ever report `inconclusive`. Both refusals are NON-FATAL (exit 0) because this
# runs as one of install-services' non-fatal delegates — but neither is SILENT, which
# is the property that matters: "no agent installed" and "agent installed and quietly
# broken" must not look the same from the install log.
#
# ⚠️ "Not applicable" must also RETRACT, not merely decline (CTL-2145). A host that
# qualified yesterday and does not today — reclassified out of ROTATION_NODE_CLASSES,
# or with its claude-accounts.env removed — still has the old LaunchAgent LOADED, baked
# with whatever mode it carried at install time (potentially `enforce`). Exiting 0 and
# leaving it there means a host the gate now explicitly excludes keeps rotating accounts
# and restarting the stack on its own schedule, and every routine install-services run
# re-affirms that state while logging a line that reads like the agent is absent. So
# each refusal below retires an existing install before it exits.

# _retire_installed_agent REASON — boot out + remove an already-installed agent on a
# host that no longer qualifies. Idempotent (nothing installed = nothing to do) and
# NON-FATAL in every direction, because it runs on the delegate's exit-0 refusal paths.
#
# The launchd guard is consulted DIRECTLY (launchd_guard_ok) rather than through the
# exiting launchd_agent_guard wrapper: under a sealed/foreign HOME the right move is to
# touch nothing AND to keep the delegate's exit 0, not to abort the caller's whole
# install-services run. Refusing loudly is the point — a skipped retraction that printed
# nothing would leave the operator believing the agent was gone.
_retire_installed_agent() {
  local reason="$1"
  [[ -e "$DEST" ]] || return 0
  if ! launchd_guard_ok "the account-rotation agent"; then
    echo "install-account-rotation.sh: ${LABEL} is still installed at ${DEST} and this host no longer qualifies (${reason}), but the launchd domain guard REFUSED (${CATALYST_LAUNCHD_GUARD_REASON}) — NOT retiring it here. Remove it by hand with '$0 --uninstall' from a normal session." >&2
    return 0
  fi
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$DEST"
  echo "install-account-rotation.sh: retired the previously-installed ${LABEL} — this host no longer qualifies (${reason})"
}

NODE_CLASS="$(_node_class)"
if [[ -n "$NODE_CLASS" ]]; then
  _permitted=0
  for _c in $ROTATION_NODE_CLASSES; do
    [[ "$NODE_CLASS" == "$_c" ]] && _permitted=1
  done
  if [[ "$_permitted" -eq 0 ]]; then
    echo "install-account-rotation.sh: node class '${NODE_CLASS}' is not in '${ROTATION_NODE_CLASSES}' — not installing ${LABEL} (not an error)"
    _retire_installed_agent "node class '${NODE_CLASS}' is not in '${ROTATION_NODE_CLASSES}'"
    exit 0
  fi
else
  # UNKNOWN, not "assume worker". Say so, then let the accounts-env gate decide —
  # it is host-specific and strictly stronger than a class we could not read.
  echo "install-account-rotation.sh: could not determine this node's class (no CATALYST_NODE_CLASS, no resolvable config.mjs) — deferring to the claude-accounts.env check"
fi

if [[ ! -f "$ACCOUNTS_ENV" ]]; then
  echo "install-account-rotation.sh: no claude-accounts.env at ${ACCOUNTS_ENV} — this host has no accounts to rotate between; not installing ${LABEL} (not an error)"
  _retire_installed_agent "no claude-accounts.env at ${ACCOUNTS_ENV}"
  exit 0
fi

# ─── materialize the coord kit ───────────────────────────────────────────────
#
# Before bootstrap, so the runtime dir the actor and the lane watchdog read from is
# populated the moment the agent can first fire. Non-fatal: the agent itself runs from
# the pristine clone, so a failed materialize degrades the LANE side of the kit, not
# the rotation side — but it is reported rather than swallowed.

# COORD_RT — the DURABLE runtime dir materialize-coord-kit.sh bakes the kit into. Mirrors
# that script's own `COORD_RT="${CATALYST_DIR:-$HOME/catalyst}/comms/coord"`; both must
# name the same dir or the stray-retire exclusion below stops covering the copy that is
# actually running.
COORD_RT="${CATALYST_DIR:-$HOME/catalyst}/comms/coord"

MATERIALIZE="${BAKE_DIR}/coord/materialize-coord-kit.sh"
if [[ -x "$MATERIALIZE" ]]; then
  if bash "$MATERIALIZE"; then
    echo "install-account-rotation.sh: materialized the coord kit"
  else
    echo "install-account-rotation.sh: WARNING — materialize-coord-kit.sh failed; the lane kit under ~/catalyst/comms/coord may be incomplete" >&2
  fi
else
  echo "install-account-rotation.sh: WARNING — no materialize-coord-kit.sh at ${MATERIALIZE}" >&2
fi

# ─── retire any stray legacy loop (deliverable 4) ────────────────────────────
#
# The incident's zombie was a `nohup`'d rotation/lane loop owned by a dead concierge
# session (historically pid 50403). That pid is long gone; what this ticket owes is the
# REPEATABLE, idempotent form — so this runs on every install and is a no-op when the
# machine is already clean.
#
# FAIL CLOSED, per AGENTS.md: verify with a POSITIVE assertion (`ps -p` must report the
# pid GONE), never `kill -0 "$p" && echo STILL_ALIVE`, which prints nothing when the
# probe itself errors and lets the script self-certify success either way.
#
# Scope is deliberately narrow. It targets ONLY loops running a lane-relaunch /
# account-rotation script from a path that is NOT the current bake dir — i.e. a copy
# under a deleted job dir or an old checkout. A `pkill -f account-rotation` would also
# match this installer's own command line, the LaunchAgent's legitimate tick, and any
# operator's editor.
_retire_stray_loops() {
  local pids=() pid cmd stale=0
  # `ps -eo pid=,command=` + a bash-side match, not `pgrep -f`: pgrep's pattern would
  # also match this very process, and its -f matching gives no way to inspect the path
  # before deciding.
  #
  # ⚠️ Split with `read -r pid cmd`, NOT `${line%% *}` / `${line#* }` on a whole line.
  # ps RIGHT-ALIGNS the pid column, so a line for pid 3880 is "  3880 bash …" and
  # `${line%% *}` strips the longest ` *` suffix — which starts at the LEADING space —
  # yielding the EMPTY string. Every line then fails the numeric test and is skipped, so
  # the retire found nothing on any machine and still printed "nothing to retire": a
  # check that cannot fail, self-certifying a clean host (AGENTS.md → positive control).
  # `read` with the default IFS discards the leading padding and puts the remainder of
  # the line in `cmd`, which is what the path match below needs.
  while read -r pid cmd; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" ]] && continue
    case "$cmd" in
      *lane-relaunch.sh* | *account-rotation-watch.sh*) ;;
      *) continue ;;
    esac
    # Leave anything running out of the CURRENT bake dir alone: that is the supervised,
    # correct copy, not a stray.
    case "$cmd" in
      *"$BAKE_DIR"*) continue ;;
    esac
    # ...and leave the MATERIALIZED runtime copy alone too. coord/lane-relaunch.sh's own
    # Usage header tells operators "Run it from the materialized location, not from the
    # repo", so ${COORD_RT}/lane-relaunch.sh is the copy that is actually running on a
    # real host — and it is NOT under BAKE_DIR. With only the bake-dir exclusion above,
    # every routine `catalyst-stack install-services` classified the fleet's live lane
    # watchdog as a stray and TERM/KILLed it, logging "retiring stray" (which reads like
    # correct behavior) while nothing restarted it: the new LaunchAgent supervises only
    # account-rotation-watch.sh, and lane-relaunch is deliberately unsupervised. That is
    # the same unnoticed-dead-lanes failure CTL-2097/CTL-2145 exist to prevent.
    #
    # Guarded on non-empty: an empty COORD_RT would make `*""*` match EVERY command line,
    # silently turning the whole retire into a no-op that still prints its all-clear — a
    # check that cannot fail (AGENTS.md).
    if [[ -n "$COORD_RT" ]]; then
      case "$cmd" in
        *"$COORD_RT"*) continue ;;
      esac
    fi
    pids+=("$pid")
  done < <(ps -eo pid=,command= 2>/dev/null || true)

  # zsh does NOT word-split an unquoted parameter (AGENTS.md), so the pid list is an
  # ARRAY iterated directly — never a string built with `PIDS="$PIDS $!"`, which
  # iterates once with the whole string and dies with `illegal pid`.
  ((${#pids[@]} == 0)) && {
    echo "install-account-rotation.sh: no stray lane/rotation loop found (nothing to retire)"
    return 0
  }
  for pid in "${pids[@]}"; do
    echo "install-account-rotation.sh: retiring stray lane/rotation loop pid ${pid}"
    kill "$pid" 2>/dev/null || true
  done
  # Give them a moment, then escalate to KILL for anything still standing.
  local waited=0
  while ((waited < 5)); do
    local remaining=0
    for pid in "${pids[@]}"; do ps -p "$pid" >/dev/null 2>&1 && remaining=1; done
    ((remaining == 0)) && break
    sleep 1
    waited=$((waited + 1))
  done
  for pid in "${pids[@]}"; do
    ps -p "$pid" >/dev/null 2>&1 && kill -9 "$pid" 2>/dev/null || true
  done
  # POSITIVE final assertion — this is the fail-closed check.
  for pid in "${pids[@]}"; do
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "install-account-rotation.sh: WARNING — stray loop pid ${pid} SURVIVED both TERM and KILL; retire it by hand before trusting the agent" >&2
      stale=1
    fi
  done
  # ⚠️ The survival probe's verdict is RETURNED, not merely printed (CTL-2145). TERM and
  # KILL can both fail to remove a match — it is owned by another user, or it lingers as
  # an unreaped zombie — and the old unconditional `return 0` let the install proceed and
  # report success with the old loop still running alongside the new actor. That is a
  # check that cannot fail: the assertion above is written as a positive control
  # precisely so it CAN fail, and swallowing its result put the failure back.
  #
  # Written as an explicit if/return rather than `((stale == 0)) && echo …` — that form
  # yields the AND-list's status, which `set -e` deliberately exempts (the failing command
  # is not the one following the final &&), so it looked fail-closed while returning 0.
  if ((stale != 0)); then
    return 1
  fi
  echo "install-account-rotation.sh: verified all retired stray loops are gone"
  return 0
}

if [[ "${CATALYST_SKIP_STRAY_RETIRE:-0}" != "1" ]]; then
  if ! _retire_stray_loops; then
    echo "install-account-rotation.sh: REFUSING to install ${LABEL} — a stray lane/rotation loop survived both TERM and KILL (see the WARNING above)." >&2
    echo "  Installing now would leave that loop running alongside the new actor, which is the" >&2
    echo "  duplicate-supervisor state this retire exists to prevent. Retire it by hand and re-run," >&2
    echo "  or set CATALYST_SKIP_STRAY_RETIRE=1 to install deliberately without the retire." >&2
    exit 1
  fi
fi

# ─── install ─────────────────────────────────────────────────────────────────

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/catalyst"

local_tmp="${DEST}.tmp"
_substitute >"$local_tmp"
mv "$local_tmp" "$DEST"
echo "install-account-rotation.sh: wrote ${DEST}"

# Reload idempotently: bootout any existing instance (ignore failure when not loaded),
# then bootstrap the fresh plist.
launchd_agent_guard
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "install-account-rotation.sh: loaded ${LABEL} into gui/$(id -u) (mode=$(_resolve_rotation_mode), interval=$(_interval_seconds)s)"
echo "install-account-rotation.sh: verify with 'launchctl list | grep ${LABEL}'"
