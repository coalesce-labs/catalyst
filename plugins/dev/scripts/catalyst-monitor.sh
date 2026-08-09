#!/usr/bin/env bash
# catalyst-monitor.sh — On-demand monitor server management.
#
# Commands:
#   start [--port N]     Start monitor server in background (idempotent)
#   stop                 Stop monitor server
#   status [--json]      Check if monitor is running
#   open                 Start monitor if needed, open browser to dashboard
#   url                  Print the monitor URL

set -uo pipefail

# CTL-390: --version handling (early, before any arg parsing or stdin reads).
case "${1:-}" in
  --version|-V)
    _CV_SRC="${BASH_SOURCE[0]}"
    while [[ -L "$_CV_SRC" ]]; do
      _CV_D="$(cd -P "$(dirname "$_CV_SRC")" && pwd)" && _CV_SRC="$(readlink "$_CV_SRC")"
      [[ "$_CV_SRC" != /* ]] && _CV_SRC="$_CV_D/$_CV_SRC"
    done
    _CV_DIR="$(cd -P "$(dirname "$_CV_SRC")" && pwd)"
    [[ -f "${_CV_DIR}/lib/catalyst-version.sh" ]] && . "${_CV_DIR}/lib/catalyst-version.sh" \
      && catalyst_print_version "catalyst-monitor" "${BASH_SOURCE[0]}" && exit 0
    echo "error: catalyst-version helper missing at ${_CV_DIR}/lib/catalyst-version.sh" >&2
    exit 1
    ;;
esac

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
DEFAULT_PORT=7400
PORT="${MONITOR_PORT:-$DEFAULT_PORT}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "error: MONITOR_PORT must be a numeric port, got: $PORT" >&2
  exit 1
fi
PID_FILE="${MONITOR_PID_FILE:-$CATALYST_DIR/monitor.pid}"
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
SERVER_SCRIPT="${MONITOR_SERVER_SCRIPT:-$SCRIPT_DIR/orch-monitor/server.ts}"
MONITOR_DIR="$(cd "$(dirname "$SERVER_SCRIPT")" && pwd)"
# CTL-1088: default out-of-repo dist dir for the vite build (single definition
# used by both bootstrap and cmd_start).
MONITOR_UI_DIST_DIR="${MONITOR_UI_DIST_DIR:-$CATALYST_DIR/monitor-ui-dist}"

# CTL-1223: structured-event emission for silent vite-build failures. Best-effort.
EVENTS_DIR="${CATALYST_EVENTS_DIR:-$CATALYST_DIR/events}"
# shellcheck source=lib/canonical-event.sh
[[ -f "$SCRIPT_DIR/lib/canonical-event.sh" ]] && source "$SCRIPT_DIR/lib/canonical-event.sh" || true
FORWARD_PID_FILE="${CATALYST_DIR}/otel-forward.pid"
FORWARD_LOG="${CATALYST_DIR}/otel-forward.log"
FORWARD_SCRIPT="${SCRIPT_DIR}/otel-forward/index.ts"

# ─── Version drift self-check ───────────────────────────────────────────────
PLUGIN_CACHE_ROOT="${CATALYST_PLUGIN_CACHE_ROOT:-$HOME/.claude/plugins/cache/catalyst/catalyst-dev}"

# Reads the running version from the version.txt adjacent to the script.
# In both the plugin cache layout (cache/.../<X.Y.Z>/version.txt) and the source
# tree (plugins/dev/version.txt), the file lives at SCRIPT_DIR/../version.txt.
read_running_version() {
  local version_file="${CATALYST_VERSION_FILE:-$SCRIPT_DIR/../version.txt}"
  if [[ -f "$version_file" ]]; then
    tr -d '[:space:]' < "$version_file"
    return 0
  fi
  return 1
}

# Highest semver subdirectory under the plugin cache root.
read_latest_available_version() {
  [[ -d "$PLUGIN_CACHE_ROOT" ]] || return 1
  local latest
  latest=$(ls -1 "$PLUGIN_CACHE_ROOT" 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | tail -n1)
  [[ -n "$latest" ]] || return 1
  printf '%s' "$latest"
}

# Returns 0 if v1 < v2, else nonzero. Empty inputs treated as not-less-than.
version_lt() {
  local v1="$1" v2="$2"
  [[ -n "$v1" && -n "$v2" ]] || return 1
  [[ "$v1" == "$v2" ]] && return 1
  local lower
  lower=$(printf '%s\n%s\n' "$v1" "$v2" \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | head -n1)
  [[ "$lower" == "$v1" ]]
}

RUNNING_VERSION="$(read_running_version || true)"
LATEST_AVAILABLE_VERSION="$(read_latest_available_version || true)"
IS_STALE="false"
if version_lt "$RUNNING_VERSION" "$LATEST_AVAILABLE_VERSION"; then
  IS_STALE="true"
fi

read_suppress_warning() {
  local config_path=""
  if [[ -f ".catalyst/config.json" ]]; then
    config_path=".catalyst/config.json"
  elif [[ -f ".claude/config.json" ]]; then
    config_path=".claude/config.json"
  fi
  [[ -n "$config_path" ]] || { echo "false"; return; }
  command -v jq &>/dev/null || { echo "false"; return; }
  local v
  v=$(jq -r '.catalyst.monitor.suppressVersionWarning // false' "$config_path" 2>/dev/null)
  echo "${v:-false}"
}

print_version_warning() {
  [[ "$IS_STALE" == "true" ]] || return 0
  [[ "$(read_suppress_warning)" != "true" ]] || return 0
  echo "warning: catalyst-monitor running v${RUNNING_VERSION}; v${LATEST_AVAILABLE_VERSION} is available locally" >&2
  echo "  remediation: bash \"\$CLAUDE_PLUGIN_ROOT/scripts/install-cli.sh\" install   # or 'git pull' if running from a clone" >&2
  echo "  suppress: add '\"catalyst\":{\"monitor\":{\"suppressVersionWarning\":true}}' to .catalyst/config.json" >&2
}

# JSON-safe string-or-null helper for status output.
json_quote_or_null() {
  if [[ -n "$1" ]]; then
    printf '"%s"' "$1"
  else
    printf 'null'
  fi
}

# CTL-1612 round 5 (Codex P2 follow-up): bash mirror of
# execution-core/config.mjs's getLivenessAnchorIssue() resolution order — used
# ONLY to decide whether cmd_start's app-actor mint has anything to serve
# (the scoped token's sole consumer, the anchor peer-heartbeat read, can never
# fire with no anchor configured — readPeerRecords's `!anchorIssue` early
# return, orch-monitor/lib/peer-liveness.mjs). Deliberately narrower than the
# full secret-contract chain (matches getLayer2ConfigPath's own "legacy path"
# comment: CATALYST_LAYER2_CONFIG_FILE, else ~/.config/catalyst/config.json —
# no CATALYST_MACHINE_CONFIG/XDG tier for this specific reader):
#   1. CATALYST_LIVENESS_ANCHOR_ISSUE env (test/override)
#   2. catalyst.cluster.livenessAnchorIssue in the Layer-2 config
#   3. empty — caller treats as "no anchor configured"
#
# CTL-1612 round 6 (Codex P2 follow-up): this duplication (rather than a
# runtime call into the canonical JS getter) is a deliberate single-source-
# risk tradeoff, not an oversight — see the round-6 report for why a bounded
# `bun -e "import(...)…"` one-shot at every monitor start was rejected (adds
# a runtime dependency + startup cost to the launch path, defeating round 3's
# whole point of skipping the mint cheaply). __tests__/liveness-anchor-parity.test.sh
# is what makes a future divergence between this function and
# getLivenessAnchorIssue() TEST-DETECTABLE instead of a silent landmine — it
# extracts this exact function's source and runs it against the same fixtures
# as the JS getter, three-way-asserting both against a computed-expected
# literal (the __tests__/secret-contract-parity.test.sh pattern). Edit this
# function's resolution order/default path ONLY in lockstep with that test
# and getLivenessAnchorIssue() itself.
resolve_liveness_anchor_issue() {
  if [[ -n "${CATALYST_LIVENESS_ANCHOR_ISSUE:-}" ]]; then
    printf '%s' "$CATALYST_LIVENESS_ANCHOR_ISSUE"
    return 0
  fi
  local _l2_path="${CATALYST_LAYER2_CONFIG_FILE:-$HOME/.config/catalyst/config.json}"
  [[ -f "$_l2_path" ]] || return 0
  if command -v jq &>/dev/null; then
    # CTL-1612 round 6 (Codex P2 follow-up, liveness-anchor-parity.test.sh):
    # `select(type=="string")` rejects a non-string field (e.g. a stray
    # number) the same way getLivenessAnchorIssue's `typeof a === "string"`
    # guard does. Without it, `jq -r 'FIELD // empty'` on a NUMBER prints the
    # number as text instead of treating it as absent — bash would resolve an
    # anchor the JS side never would, diverging on a hostile/malformed config.
    jq -r '(.catalyst.cluster.livenessAnchorIssue | select(type=="string")) // empty' "$_l2_path" 2>/dev/null
    # CTL-1612 post-merge #2978 (Codex P2 follow-up): explicit, unconditional
    # `return 0` — this function's contract everywhere else is "never surface
    # an internal failure as our own; a resolution miss is always a clean
    # empty" (see the two `return 0`s above: env-unset, file-absent). jq
    # itself exits NONZERO on malformed/invalid JSON input, and this branch
    # used to let that raw jq exit code silently become the FUNCTION's own
    # exit status — the parity test's canonical JS side never has this gap
    # (getLivenessAnchorIssue wraps its JSON.parse in try/catch and always
    # returns cleanly; see execution-core/config.mjs), so a malformed Layer-2
    # config made bash and node agree on OUTPUT (both empty) while disagreeing
    # on STATUS (bash nonzero, node 0) — a real robustness gap this closes.
    return 0
  else
    # CTL-1612 round 7 (Codex P2 follow-up): jq is neither a required nor
    # optional repo dependency and bootstrap does not enforce it (a
    # documented-minimal host can genuinely lack it) — a bare `jq` call above
    # would silently resolve "no anchor configured" here while the runtime's
    # node/bun getLivenessAnchorIssue() parses the SAME file and finds one,
    # taking the no-anchor skip branch and clearing the inherited app-actor
    # aliases without ever transferring a usable token to
    # CATALYST_MONITOR_APP_ACTOR_TOKEN. Same jq-absent-degrade shape as
    # create-worktree.sh's #2948 round-5 precedent: fall back to a plain
    # grep/sed sniff of the first "livenessAnchorIssue":"..." QUOTED-STRING
    # occurrence anywhere in the file. Imprecise — it doesn't confirm JSON
    # structure/nesting under catalyst.cluster, and a value spanning multiple
    # lines won't match — but adequate for this boolean-ish "is an anchor
    # configured" check, and the quoted-value requirement naturally rejects a
    # non-string field the same way the jq `select(type=="string")` branch
    # does above. __tests__/liveness-anchor-parity.test.sh exercises this
    # exact path with jq hidden from PATH.
    grep -oE '"livenessAnchorIssue"[[:space:]]*:[[:space:]]*"[^"]*"' "$_l2_path" 2>/dev/null \
      | head -1 \
      | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
    # CTL-1612 post-merge #2978 (Codex P2 follow-up): same unconditional
    # `return 0` as the jq branch above, for a SECOND (broader) reason on
    # this branch specifically: the script runs under `set -o pipefail`
    # (line 11), so a NO-MATCH `grep` (the ordinary, legitimate "field not
    # present" or "no anchor configured" case — not an error) makes the
    # WHOLE pipeline exit 1, even though `head`/`sed` on that empty input
    # exit 0. Without this, most jq-less "resolves to empty" cells — not
    # just malformed input — would report a spurious nonzero status.
    return 0
  fi
}

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && is_alive "$pid"; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE" 2>/dev/null
  fi
  return 1
}

bootstrap() {
  if [[ "${MONITOR_SKIP_BOOTSTRAP:-}" == "1" ]]; then
    return 0
  fi

  local errors=()

  if ! command -v bun &>/dev/null; then
    errors+=("bun is required but not found. Install: curl -fsSL https://bun.sh/install | bash")
  fi

  if [[ ! -f "$SERVER_SCRIPT" ]]; then
    errors+=("server.ts not found at $SERVER_SCRIPT")
  fi

  if ! command -v sqlite3 &>/dev/null; then
    errors+=("sqlite3 is required for session history")
  fi

  if [[ ! -d "$CATALYST_DIR" ]]; then
    errors+=("Catalyst directory missing: $CATALYST_DIR — run /catalyst-foundry:setup-catalyst first")
  fi

  # CTL-841: a missing wt/ dir is a fresh-host normal, not a fatal error. A daemon
  # start script should mkdir -p its own runtime dirs and start, rather than dead-end
  # a headless-host operator at an interactive Claude skill. Self-heal instead of
  # hard-failing. (cmd_start also runs `mkdir -p "$CATALYST_DIR/wt"`, but bootstrap's
  # `return 1` made that line unreachable — proving the auto-create was always intended.)
  if [[ ! -d "$CATALYST_DIR/wt" ]] && [[ -d "$CATALYST_DIR" ]]; then
    mkdir -p "$CATALYST_DIR/wt" 2>/dev/null || true
  fi

  if [[ ${#errors[@]} -gt 0 ]]; then
    echo "Cannot start monitor:" >&2
    for err in "${errors[@]}"; do
      echo "  • $err" >&2
    done
    return 1
  fi

  local db_file="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"
  if [[ ! -f "$db_file" ]]; then
    echo "Warning: Session database not found ($db_file) — session history will be empty"
    echo "  Run /catalyst-foundry:setup-catalyst to initialize"
  fi

  if [[ -d "$MONITOR_DIR" ]]; then
    # CTL-1628: since the 8 per-package bun.lock files were consolidated into a
    # single root workspace lockfile, $MONITOR_DIR/bun.lock (and ui/bun.lock) no
    # longer exist, so the plain "-nt" checks below are permanently false (a
    # nonexistent left operand never compares newer). Resolve the actual
    # workspace-root lockfile via `git rev-parse --show-toplevel` at runtime and
    # OR its mtime into the gate so a root dep bump still triggers reinstall. The
    # original per-dir checks are left in place (harmless no-ops once the lock
    # files are gone) so this stays a superset — it also still fires correctly
    # in a non-git sandbox that supplies its own per-dir bun.lock (CTL-1223 tests).
    local monitor_root_lockfile
    monitor_root_lockfile="$(git -C "$MONITOR_DIR" rev-parse --show-toplevel 2>/dev/null)"
    [[ -n "$monitor_root_lockfile" ]] && monitor_root_lockfile="$monitor_root_lockfile/bun.lock"
    if [[ ! -d "$MONITOR_DIR/node_modules" ]] || [[ "$MONITOR_DIR/bun.lock" -nt "$MONITOR_DIR/node_modules" ]] || { [[ -n "$monitor_root_lockfile" ]] && [[ "$monitor_root_lockfile" -nt "$MONITOR_DIR/node_modules" ]]; }; then
      echo "Installing orch-monitor dependencies..."
      (cd "$MONITOR_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
    fi

    if [[ -d "$MONITOR_DIR/ui" ]]; then
      local ui_root_lockfile
      ui_root_lockfile="$(git -C "$MONITOR_DIR/ui" rev-parse --show-toplevel 2>/dev/null)"
      [[ -n "$ui_root_lockfile" ]] && ui_root_lockfile="$ui_root_lockfile/bun.lock"
      if [[ ! -d "$MONITOR_DIR/ui/node_modules" ]] || [[ "$MONITOR_DIR/ui/bun.lock" -nt "$MONITOR_DIR/ui/node_modules" ]] || { [[ -n "$ui_root_lockfile" ]] && [[ "$ui_root_lockfile" -nt "$MONITOR_DIR/ui/node_modules" ]]; }; then
        echo "Installing orch-monitor UI dependencies..."
        (cd "$MONITOR_DIR/ui" && bun install --frozen-lockfile 2>/dev/null || bun install)
      fi
    fi

    if [[ -d "$MONITOR_DIR/ui" ]]; then
      mkdir -p "$MONITOR_UI_DIST_DIR"
      export MONITOR_UI_DIST_DIR

      # CTL-1088: dist lives out-of-repo; first build happens when index.html is absent.
      # CTL-1118: also rebuild when the UI source has advanced past the last-built
      # commit. We record the SHA of the last commit touching ui/ next to the dist and
      # rebuild on mismatch — this covers EVERY restart path (broker hot-reload and
      # manual restart) with no broker-side plumbing. Escape hatch: MONITOR_FORCE_BUILD=1.
      ui_source_sha="$(git -C "$MONITOR_DIR" log -1 --format='%H' -- ui/ 2>/dev/null || true)"
      built_sha_file="$MONITOR_UI_DIST_DIR/.source-sha"
      built_sha=""
      [[ -f "$built_sha_file" ]] && built_sha="$(cat "$built_sha_file" 2>/dev/null || true)"

      rebuild_reason=""
      if [[ "${MONITOR_FORCE_BUILD:-}" == "1" ]]; then
        rebuild_reason="MONITOR_FORCE_BUILD=1"
      elif [[ ! -f "$MONITOR_UI_DIST_DIR/index.html" ]]; then
        rebuild_reason="no built index.html"
      elif [[ -n "$ui_source_sha" && "$ui_source_sha" != "$built_sha" ]]; then
        rebuild_reason="ui source changed (${built_sha:-none} → $ui_source_sha)"
      fi

      if [[ -n "$rebuild_reason" ]]; then
        echo "Building orch-monitor frontend → $MONITOR_UI_DIST_DIR ($rebuild_reason) ..."
        # CTL-1254: build into a staging dir and atomically swap on success. vite.config
        # sets emptyOutDir:false for this out-of-repo outDir, so building in place piled
        # stale hashed chunks across every rebuild (observed 5759 vs the ~1522 a clean
        # build emits). The served bundle then referenced per-glyph icon chunks that no
        # longer matched → silent 404s → icon-picker glyphs stuck as placeholders, plus
        # unbounded disk growth. Staging keeps the previous dist intact as a fallback if
        # the build fails (preserving the warn-and-serve-previous behaviour below).
        _ui_stage="${MONITOR_UI_DIST_DIR%/}.staging.$$"
        rm -rf "$_ui_stage"
        # CTL-1372: force a PRODUCTION React build. Without NODE_ENV=production, Vite
        # resolves react-dom's `development` export — which calls performance.measure()
        # on EVERY render — and the User Timing buffer is never cleared, leaking GBs over
        # a long-lived PWA session (12 GB / 1.8M PerformanceMeasure entries observed). The
        # build inherits whatever NODE_ENV the daemon was spawned with (no Catalyst code
        # sets it; a dependency side effect can leave it "development"), so pin it here.
        if (cd "$MONITOR_DIR/ui" && MONITOR_UI_DIST_DIR="$_ui_stage" NODE_ENV=production bunx vite build); then
          # CTL-1372: refuse to serve a development react-dom bundle even if one is somehow
          # produced — it is the memory-leak signature. Assert on the staged build; on a hit
          # keep the previous (good) dist rather than swapping in a leaky bundle.
          if grep -rq "react-dom-client.development" "$_ui_stage" 2>/dev/null; then
            rm -rf "$_ui_stage"
            # Fail-closed: if there is no known-good PRODUCTION dist to fall back to — a
            # cold host with no prior build, or a prior dist that is itself the leaky dev
            # bundle from the incident — we have nothing safe to serve, so abort rather
            # than start a monitor that 404s or leaks. (With NODE_ENV=production pinned
            # above, this branch should never fire; it is a backstop.)
            if [[ ! -f "$MONITOR_UI_DIST_DIR/index.html" ]] || grep -rq "react-dom-client.development" "$MONITOR_UI_DIST_DIR" 2>/dev/null; then
              echo "error: orch-monitor build produced a DEVELOPMENT React bundle and no known-good production dist exists — aborting start (rebuild with NODE_ENV=production)" >&2
              exit 1
            fi
            echo "error: orch-monitor build produced a DEVELOPMENT React bundle (leaks memory via performance.measure) — keeping previous (production) dist" >&2
          else
            # Swap fresh build into place (drops ALL stale chunks); the static-asset copy
            # step below re-populates PWA manifest/sw/icons. mv is atomic on one filesystem.
            rm -rf "$MONITOR_UI_DIST_DIR"
            mv "$_ui_stage" "$MONITOR_UI_DIST_DIR"
            # Record the built source SHA ONLY on success so a failed build retries next start.
            [[ -n "$ui_source_sha" ]] && printf '%s\n' "$ui_source_sha" > "$built_sha_file"
          fi
        else
          rm -rf "$_ui_stage"
          echo "warning: orch-monitor vite build failed — serving previous dist (will retry next restart)" >&2
          if declare -f build_canonical_line >/dev/null 2>&1; then
            _bf_line="$(build_canonical_line \
              --ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
              --severity WARN \
              --service catalyst.monitor \
              --event-name "monitor.ui.build_failed" \
              --entity monitor --action ui_build_failed \
              --label "${rebuild_reason:-build_failed}" \
              --payload-json "$(jq -cn --arg dir "$MONITOR_DIR" --arg sha "${ui_source_sha:-}" \
                --arg built "${built_sha:-}" --arg reason "${rebuild_reason:-}" \
                '{monitor_dir:$dir,ui_source_sha:$sha,built_sha:$built,rebuild_reason:$reason}' \
                2>/dev/null || echo '{}')" \
              2>/dev/null)" || _bf_line=""
            [[ -n "$_bf_line" ]] && canonical_jsonl_append "$EVENTS_DIR" "$_bf_line" || true
          fi
        fi
      fi

      # Complete the dist: copy non-vite static assets so the out-of-repo dir is a
      # full served root (server uses one publicDir for everything). Idempotent.
      # CTL-1133: manifest, service worker, and PWA icons join the served root.
      for _asset in history.html favicon.ico favicon.svg \
        manifest.webmanifest service-worker.js \
        icon-192.png icon-512.png apple-touch-icon.png; do
        [[ -f "$MONITOR_DIR/public/$_asset" ]] && cp -f "$MONITOR_DIR/public/$_asset" "$MONITOR_UI_DIST_DIR/" 2>/dev/null || true
      done
      for _dir in vendor mockups; do
        [[ -d "$MONITOR_DIR/public/$_dir" ]] && cp -R "$MONITOR_DIR/public/$_dir" "$MONITOR_UI_DIST_DIR/" 2>/dev/null || true
      done
    fi
  fi
}

cmd_start() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      *) echo "error: unknown flag for start: $1" >&2; return 1 ;;
    esac
  done

  local existing_pid
  if existing_pid=$(read_pid); then
    echo "Monitor already running (pid $existing_pid)"
    return 0
  fi

  print_version_warning

  bootstrap || return 1

  mkdir -p "$(dirname "$PID_FILE")" 2>/dev/null || true
  mkdir -p "$CATALYST_DIR/wt" 2>/dev/null || true

  # CTL-1612: project the webhook signing secret from the SOPS-managed file, matching
  # what the launchd wrapper (orch-monitor/dist/catalyst-monitor-launchd.sh) already
  # does. Without this the two launch paths disagree: webhook-config.ts resolves the
  # GitHub HMAC key from process.env ONLY (no file fallback — unlike the Linear per-team
  # secrets), so a stack-launched monitor on a host whose shell never exported it runs
  # with the GitHub webhook route silently DISABLED. It is also boot-captured (read once
  # at loadWebhookConfig, then closed over per request), so a rotation needs a restart —
  # which is why webhook-secret is now enrolled in cluster-sync's boot-captured registry.
  # FILE-WINS for the same reason as the daemon's GitHub credential: a stale shell export
  # is exactly what we are correcting. Empty/whitespace/absent = no-op, never export ""
  # (an empty secret makes webhook-config treat the route as unconfigured).
  # CTL-1612: arm BOTH cluster-synced credentials this daemon needs, via the one shared
  # resolution chain (lib/catalyst-secret-env.sh).
  #
  # webhook-secret: webhook-config.ts resolves the GitHub HMAC key from process.env ONLY
  # (no file fallback, unlike the Linear per-team secrets) and captures it once at boot, so
  # a monitor started without it runs with the GitHub webhook route silently DISABLED.
  #
  # github-token: the monitor makes 13 `gh` calls across 5 files (pr-status, preview-status,
  # webhook-subscriber, webhook-replay, repo-icon-fetcher) and contains ZERO references to
  # GITHUB_TOKEN/GH_TOKEN — its GitHub auth is purely ambient inheritance, which is exactly
  # the bug this ticket exists to fix. doctor.mjs checkRepoIconTokenScope already exists to
  # warn about this inherited token. Projecting here fixes all 13 sites at once, because they
  # all inherit this launcher's env; none of them need to change.
  # shellcheck disable=SC1090
  source "$SCRIPT_DIR/lib/catalyst-secret-env.sh"
  catalyst_project_webhook_secret
  catalyst_project_github_token

  # Authenticate the monitor's own Linear calls (peer-heartbeat anchor read,
  # CTL-1090/CTL-1217) as the Catalyst Orchestrator app-actor, same as the
  # broker/execution-core start paths (CTL-785/CTL-1577) — without this the
  # monitor process has no app-actor token at all and any direct Linear read
  # it performs (e.g. readPeerHeartbeatsSync) silently fails closed to {}.
  #
  # CTL-1612 (Codex P1 follow-up): the monitor is TWO-IDENTITY, unlike the
  # broker/execution-core. Its inline-reply path (orch-monitor/lib/linear-comment.mjs
  # resolveLinearToken) resolves env (LINEAR_API_TOKEN/LINEAR_API_KEY) BEFORE the
  # operator's Layer-2 personal token, and REFUSES to post as the app-actor
  # (bot_identity gate) — so exporting the mint under LINEAR_API_TOKEN/LINEAR_API_KEY
  # here, as the broker/execution-core do, would silently 502 every operator inline
  # reply. Mint into a SCOPED var instead; only the monitor's own self-read
  # (readPeerHeartbeatsSync, wired in server.ts) consumes it. Personal-token paths
  # (linear-comment.mjs, inbox-conversation*.mjs, estimate/title fallbacks) are
  # untouched — they never look at this variable.
  #
  # CTL-1612 round 3 (Codex P2 follow-up): the scoped token's ONLY consumer is
  # the anchor peer-heartbeat read (server.ts pollAnchorHeartbeats → readAnchor
  # → readPeerHeartbeatsSync). orch-monitor/lib/peer-liveness.mjs readPeerRecords
  # NEVER calls readAnchor when CATALYST_LIVENESS_READ_SOURCE is exactly "loki"
  # (case-insensitive) — that is the one mode with a hard early-return before
  # the anchor tier. Every other value — unset, "auto", "linear", or anything
  # else — either uses the anchor exclusively ("linear") or as the AUTO
  # fallback when Loki has no URL/reader or returns empty, so minting stays the
  # default there. Skip the (real network) mint in loki-only mode: it would
  # authenticate a credential that structurally can never be read.
  #
  # CTL-1612 round 5 (Codex P2 follow-up): readAnchor ALSO can never fire when
  # NO liveness anchor is configured at all — readPeerRecords's `!anchorIssue`
  # early return — regardless of source (AUTO or explicit "linear" included).
  # A fleet running single-host, or one that hasn't set up cross-host liveness
  # yet, would otherwise mint on every start and wait out curl's 30s ceiling
  # for a credential nothing can ever read. Skip that case too.
  #
  # CTL-1612 round 5 (Codex P1 follow-up): BOTH skip branches below now call
  # linear_app_actor_clear_inherited — the round-4 inherited-alias clear lived
  # entirely inside linear_app_actor_auth, so a skip branch that never calls
  # that function never ran it either. A broker stack-reload's `catalyst-monitor
  # restart` in loki-only (or no-anchor) mode would otherwise still carry the
  # broker's bot-valued LINEAR_API_TOKEN/LINEAR_API_KEY straight through to
  # linear-comment.mjs — the same P1 as round 4's fix, just reachable via a
  # path that used to return before ever sourcing the lib.
  source "$SCRIPT_DIR/lib/linear-app-actor.sh"
  _liveness_source="$(printf '%s' "${CATALYST_LIVENESS_READ_SOURCE:-}" | tr '[:upper:]' '[:lower:]' | xargs 2>/dev/null || true)"
  _liveness_anchor_issue="$(resolve_liveness_anchor_issue)"
  if [[ "$_liveness_source" == "loki" ]]; then
    echo "catalyst-monitor: CATALYST_LIVENESS_READ_SOURCE=loki — skipping app-actor mint (peer-heartbeat anchor read is unused in loki-only mode)" >&2
    linear_app_actor_clear_inherited "catalyst-monitor"
  elif [[ -z "$_liveness_anchor_issue" ]]; then
    echo "catalyst-monitor: no liveness anchor configured (CATALYST_LIVENESS_ANCHOR_ISSUE / catalyst.cluster.livenessAnchorIssue) — skipping app-actor mint (peer-heartbeat anchor read has nothing to attach to)" >&2
    linear_app_actor_clear_inherited "catalyst-monitor"
  else
    linear_app_actor_auth "catalyst-monitor" CATALYST_MONITOR_APP_ACTOR_TOKEN
  fi

  # CATALYST_CONFIG_FILE pins the Layer-1 config path explicitly so the spawned
  # server's config resolution (orch-monitor/lib/config-path.ts) never falls back
  # to a cwd-relative `.catalyst/config.json` lookup. Without this, the server
  # inherits whatever directory the operator happened to be in when they ran
  # `catalyst-monitor start` / `catalyst-stack start` — if that directory has no
  # `.catalyst/config.json` (or the wrong one), the team/project roster and the
  # Layer-2 Linear-token resolution both silently degrade (empty project list,
  # board views that never resolve, replies failing with "no Linear credential")
  # even though a correctly-configured `$CATALYST_DIR/.catalyst/config.json`
  # exists. Only default it when the caller hasn't already pointed at a specific
  # file via EITHER var — config-path.ts's documented precedence is
  # CATALYST_CONFIG_FILE > CATALYST_CONFIG_PATH > cwd fallback, so defaulting
  # CATALYST_CONFIG_FILE here whenever it's merely unset would silently override
  # an operator's explicit CATALYST_CONFIG_PATH-only override — and only when the
  # CATALYST_DIR-relative candidate actually exists, so a relocated CATALYST_DIR
  # (state-only root, e.g. /var/lib/catalyst) still falls through to the spawned
  # server's own cwd-relative resolution instead of pinning a nonexistent path.
  _cm_config_file="${CATALYST_CONFIG_FILE:-}"
  if [[ -z "$_cm_config_file" && -z "${CATALYST_CONFIG_PATH:-}" && -f "$CATALYST_DIR/.catalyst/config.json" ]]; then
    _cm_config_file="$CATALYST_DIR/.catalyst/config.json"
  fi
  CATALYST_CONFIG_FILE="$_cm_config_file" \
  CATALYST_CONFIG_PATH="${CATALYST_CONFIG_PATH:-}" \
  MONITOR_PORT="$PORT" \
  MONITOR_PUBLIC_DIR="${MONITOR_UI_DIST_DIR}" \
  nohup bun run "$SERVER_SCRIPT" --pid-file "$PID_FILE" \
    > "$CATALYST_DIR/monitor.log" 2>&1 &
  local server_pid=$!
  disown "$server_pid" 2>/dev/null || true

  local waited=0
  while [[ $waited -lt 20 ]]; do
    if [[ -f "$PID_FILE" ]]; then
      echo "Monitor started (pid $(cat "$PID_FILE")) at http://localhost:$PORT"
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  if is_alive "$server_pid"; then
    echo "$server_pid" > "$PID_FILE"
    echo "Monitor started (pid $server_pid) at http://localhost:$PORT"
    return 0
  fi

  echo "error: failed to start monitor server" >&2
  return 1
}

cmd_stop() {
  local pid
  if ! pid=$(read_pid); then
    echo "Monitor not running"
    return 0
  fi

  kill "$pid" 2>/dev/null || true

  local waited=0
  while [[ $waited -lt 30 ]] && is_alive "$pid"; do
    sleep 0.1
    waited=$((waited + 1))
  done

  if is_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE" 2>/dev/null || true
  echo "Monitor stopped"
}

cmd_restart() {
  if read_pid >/dev/null; then
    cmd_stop
  fi
  cmd_start "$@"
}

cmd_status() {
  local json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      *) echo "error: unknown flag for status: $1" >&2; return 1 ;;
    esac
  done

  local rv lv
  rv=$(json_quote_or_null "$RUNNING_VERSION")
  lv=$(json_quote_or_null "$LATEST_AVAILABLE_VERSION")

  # CTL-343: surface broker key-health alongside monitor status so a single
  # `catalyst-monitor status --json` call answers "is everything healthy?".
  local brokerKeyHealth='null'
  local brokerStateFile="${BROKER_STATE_FILE:-${CATALYST_DIR:-$HOME/catalyst}/broker.state.json}"
  if [[ -f "$brokerStateFile" ]]; then
    brokerKeyHealth=$(jq -c '.keyHealth // null' "$brokerStateFile" 2>/dev/null || echo 'null')
    [[ -z "$brokerKeyHealth" ]] && brokerKeyHealth='null'
  fi

  local pid
  if pid=$(read_pid); then
    if [[ $json -eq 1 ]]; then
      # Fetch webhook tunnel state from the running daemon (2s timeout, silent on error).
      local tunnel
      tunnel=$(curl -s --max-time 2 "http://localhost:${PORT}/api/status/webhook-tunnel" 2>/dev/null || true)
      # If tunnel response is empty or invalid JSON, omit the field (null).
      if ! echo "$tunnel" | jq -e . >/dev/null 2>&1; then
        tunnel='null'
      fi
      jq -n \
        --argjson pid "$pid" \
        --argjson port "$PORT" \
        --argjson rv "$rv" \
        --argjson lv "$lv" \
        --argjson stale "$([ "$IS_STALE" = "true" ] && echo true || echo false)" \
        --argjson tunnel "$tunnel" \
        --argjson brokerKeyHealth "$brokerKeyHealth" \
        '{running:true,pid:$pid,port:$port,url:("http://localhost:"+($port|tostring)),runningVersion:$rv,latestAvailableVersion:$lv,isStale:$stale,webhookTunnel:$tunnel,brokerKeyHealth:$brokerKeyHealth}'
    else
      echo "Monitor running (pid $pid) at http://localhost:$PORT"
    fi
    return 0
  else
    if [[ $json -eq 1 ]]; then
      jq -n \
        --argjson port "$PORT" \
        --argjson rv "$rv" \
        --argjson lv "$lv" \
        --argjson stale "$([ "$IS_STALE" = "true" ] && echo true || echo false)" \
        --argjson brokerKeyHealth "$brokerKeyHealth" \
        '{running:false,pid:null,port:$port,url:("http://localhost:"+($port|tostring)),runningVersion:$rv,latestAvailableVersion:$lv,isStale:$stale,brokerKeyHealth:$brokerKeyHealth}'
    else
      echo "Monitor stopped"
    fi
    return 1
  fi
}

cmd_open() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      *) echo "error: unknown flag for open: $1" >&2; return 1 ;;
    esac
  done

  local pid
  if ! pid=$(read_pid); then
    cmd_start --port "$PORT"
  fi

  local url="http://localhost:$PORT"
  if command -v open &>/dev/null; then
    open "$url"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$url"
  else
    echo "Open $url in your browser"
  fi
}

cmd_url() {
  echo "http://localhost:$PORT"
}

# ─── Forwarder mutation lock (CTL-1502 Codex P1) ────────────────────────────
# forward-start / forward-stop / forward-restart all read-then-write the shared
# pid file. Without a lock spanning the whole transaction, launchd's periodic
# `catalyst-stack start`, an operator's `forward-start`, and the daemon
# watchdog's enforced restart can each pass read_forward_pid and every one of
# them launch a forwarder: the last writer wins the pid file and the others are
# left untracked, tailing and re-delivering the same events, and a later
# forward-stop kills only the recorded pid.
#
# `mkdir` is the portable atomic test-and-set (stock macOS ships no flock).
FORWARD_LOCK_DIR="${CATALYST_DIR}/otel-forward.lock"
FORWARD_LOCK_HELD=""
# The watchdog lifecycle needs the SAME serialization (Codex P1): two concurrent
# `watchdog-start`s (launchd's periodic `catalyst-stack start` overlapping an
# operator start) could both pass read_watchdog_pid before either writes the pid
# file, leaving an untracked enforce-mode watchdog that `watchdog-stop` cannot
# terminate and that could restart otel-forward after a later stack shutdown.
# A SEPARATE lock dir: the two lifecycles are independent, and sharing one lock
# would make a slow forward-restart block watchdog-status for no reason.
WATCHDOG_LOCK_DIR="${CATALYST_DIR}/daemon-watchdog.lock"
WATCHDOG_LOCK_HELD=""

# Stale-lock reaper: a holder that died mid-transaction (SIGKILL, panic) would
# otherwise wedge every future forwarder mutation. The owner pid is recorded
# inside the lock dir; if that process is gone, the lock is debris — drop it.
_forward_lock_is_stale() {
  local owner
  owner="$(cat "${FORWARD_LOCK_DIR}/owner" 2>/dev/null)" || return 1
  [[ -n "$owner" ]] || return 0                 # no owner recorded → debris
  kill -0 "$owner" 2>/dev/null && return 1      # owner alive → genuinely held
  return 0
}

release_forward_lock() {
  [[ -n "$FORWARD_LOCK_HELD" ]] || return 0
  rm -rf "$FORWARD_LOCK_DIR" 2>/dev/null || true
  FORWARD_LOCK_HELD=""
}

# Codex P1: a TERM/INT handler that only releases the lock and RETURNS is worse
# than none — bash resumes the interrupted function, so an aborted restart would
# carry on from _forward_stop_impl into _forward_start_impl and relaunch the
# forwarder after shutdown was requested, while another lifecycle command races
# under the lock we just dropped. Signal handling must terminate the process.
_release_all_catalyst_locks() {
  release_forward_lock
  release_watchdog_lock
}

_forward_lock_signal_exit() {
  _release_all_catalyst_locks
  exit 143 # 128 + SIGTERM — the conventional signal-terminated status
}

# ── watchdog lifecycle lock ────────────────────────────────────────────────
# Same mkdir test-and-set + dead-owner reaper + bounded wait as the forwarder
# lock above, over its own lock dir. Kept as an explicit sibling pair rather than
# a name-ref'd generic: macOS ships bash 3.2, which has no `declare -n`, and the
# indirection needed to fake it is far easier to get subtly wrong than 20 lines
# of duplication in a path whose whole job is not launching two daemons.
_watchdog_lock_is_stale() {
  local owner
  owner="$(cat "${WATCHDOG_LOCK_DIR}/owner" 2>/dev/null)" || return 1
  [[ -n "$owner" ]] || return 0
  kill -0 "$owner" 2>/dev/null && return 1
  return 0
}

release_watchdog_lock() {
  [[ -n "$WATCHDOG_LOCK_HELD" ]] || return 0
  rm -rf "$WATCHDOG_LOCK_DIR" 2>/dev/null || true
  WATCHDOG_LOCK_HELD=""
}

acquire_watchdog_lock() {
  local waited=0
  [[ -n "$WATCHDOG_LOCK_HELD" ]] && return 0
  mkdir -p "$CATALYST_DIR" 2>/dev/null || true
  while [[ $waited -lt 100 ]]; do
    if mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null; then
      echo "$$" > "${WATCHDOG_LOCK_DIR}/owner" 2>/dev/null || true
      WATCHDOG_LOCK_HELD=1
      trap _release_all_catalyst_locks EXIT
      trap _forward_lock_signal_exit INT TERM
      return 0
    fi
    if _watchdog_lock_is_stale; then
      rm -rf "$WATCHDOG_LOCK_DIR" 2>/dev/null || true
      continue
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  return 1
}

# Bounded wait — never blocks a stack start forever. Returns 1 on timeout so the
# caller can decide; callers here treat that as "someone else is mutating, skip".
acquire_forward_lock() {
  local waited=0
  [[ -n "$FORWARD_LOCK_HELD" ]] && return 0     # reentrant: already ours
  mkdir -p "$CATALYST_DIR" 2>/dev/null || true
  while [[ $waited -lt 100 ]]; do               # ~10s at 0.1s per turn
    if mkdir "$FORWARD_LOCK_DIR" 2>/dev/null; then
      echo "$$" > "${FORWARD_LOCK_DIR}/owner" 2>/dev/null || true
      FORWARD_LOCK_HELD=1
      # Release on any exit path. EXIT just unlocks; INT/TERM must also STOP —
      # see _forward_lock_signal_exit.
      trap _release_all_catalyst_locks EXIT
      trap _forward_lock_signal_exit INT TERM
      return 0
    fi
    if _forward_lock_is_stale; then
      rm -rf "$FORWARD_LOCK_DIR" 2>/dev/null || true
      continue                                  # retry immediately
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  return 1
}

# _forward_pid_is_ours PID — identity check, not just liveness (Codex P1).
# `kill -0` proves only that SOME process owns that pid. Pids are recycled, so
# after otel-forward exits an unrelated same-user process can inherit the
# recorded pid — and the watchdog's enforced restart would then SIGTERM/SIGKILL
# it. Match the command line against the forwarder entrypoint before we ever
# signal, and FAIL CLOSED: if `ps` can't tell us, treat the pid as not-ours
# rather than killing something we cannot identify.
_forward_pid_is_ours() {
  local pid="$1" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  [[ -n "$cmd" ]] || return 1
  [[ "$cmd" == *"otel-forward"* ]]
}

read_forward_pid() {
  if [[ -f "$FORWARD_PID_FILE" ]]; then
    local pid
    pid="$(cat "$FORWARD_PID_FILE" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && _forward_pid_is_ours "$pid"; then
      echo "$pid"; return 0
    fi
    # Either dead, or alive but NOT the forwarder (recycled pid) — the pid file
    # is stale either way. Drop it so start/restart can proceed cleanly, and so
    # stop never signals a process that isn't ours.
    rm -f "$FORWARD_PID_FILE" 2>/dev/null || true
  fi
  return 1
}

# _forward_start_impl / _forward_stop_impl — lock-free bodies. The public
# cmd_* wrappers below own the lock so forward-restart can hold ONE lock across
# the whole stop→start transaction rather than two independent ones (which
# would leave the gap this P1 is about wide open between them).
_forward_start_impl() {
  if read_forward_pid >/dev/null; then
    echo "Forwarder already running (pid $(cat "$FORWARD_PID_FILE"))"
    return 0
  fi
  nohup bun run "$FORWARD_SCRIPT" > "$FORWARD_LOG" 2>&1 &
  local fwd_pid=$!
  disown "$fwd_pid" 2>/dev/null || true
  echo "$fwd_pid" > "$FORWARD_PID_FILE"
  echo "Forwarder started (pid $fwd_pid)"
}

_forward_stop_impl() {
  local pid
  if ! pid=$(read_forward_pid); then
    echo "Forwarder not running"; return 0
  fi
  kill "$pid" 2>/dev/null || true
  local waited=0
  while [[ $waited -lt 30 ]] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.1; waited=$((waited + 1))
  done
  # CTL-1502: escalating to SIGKILL used to return immediately with no
  # confirmation the kill took effect — kill -0 can keep reporting a
  # just-SIGKILL'd pid as alive for a brief window (unreaped zombie state)
  # until its parent/init reaps it, so callers observed "stopped" moments
  # before the pid was actually gone (root cause of the CI-flaky
  # forward-restart.test.sh hot-swap assertion). Poll after SIGKILL too,
  # same bound as the SIGTERM wait above, instead of trusting a single check.
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    waited=0
    while [[ $waited -lt 30 ]] && kill -0 "$pid" 2>/dev/null; do
      sleep 0.1; waited=$((waited + 1))
    done
  fi
  rm -f "$FORWARD_PID_FILE" 2>/dev/null || true
  echo "Forwarder stopped"
}

cmd_forward_status() {
  local pid
  if pid=$(read_forward_pid); then
    echo "Forwarder running (pid $pid)"
  else
    echo "Forwarder not running"
  fi
}

cmd_forward_start() {
  if ! acquire_forward_lock; then
    echo "Forwarder busy (another start/stop/restart in progress) — skipping start"
    return 0
  fi
  _forward_start_impl
  local rc=$?
  release_forward_lock
  return $rc
}

cmd_forward_stop() {
  if ! acquire_forward_lock; then
    echo "Forwarder busy (another start/stop/restart in progress) — skipping stop"
    return 0
  fi
  _forward_stop_impl
  local rc=$?
  release_forward_lock
  return $rc
}

cmd_forward_restart() {
  # CTL-1502: atomic restart — stop (SIGTERM→SIGKILL→pid-file cleanup) then start.
  # Both halves are already idempotent/no-op-safe, so a restart from any state
  # (running, dead-pid, not-running) converges to "running with a fresh pid".
  # Used by the stuck-but-alive daemon watchdog as its one restart primitive.
  #
  # Codex P1: ONE lock spans both halves. Holding it across stop→start is what
  # makes this a transaction — a concurrent `catalyst-stack start` can no longer
  # observe the momentarily-stopped forwarder and launch a second, untracked one.
  if ! acquire_forward_lock; then
    echo "Forwarder busy (another start/stop/restart in progress) — skipping restart"
    return 0
  fi
  _forward_stop_impl
  _forward_start_impl
  local rc=$?
  release_forward_lock
  return $rc
}

# ─── Standalone daemon-watchdog (CTL-1502 Codex P1) ─────────────────────────
# On a monitor-class node `catalyst-stack` starts otel-forward but NOT
# execution-core, so the watchdog armed inside startDaemon never runs there and
# the forwarder is supervised by pid-liveness alone. These commands supervise
# daemon-watchdog-run.mjs — the same probe, hosted standalone — so an
# observation node gets the same stuck detection. A worker node keeps the
# in-daemon probe and never starts this, so exactly one supervisor exists either
# way. Same pid-file + identity-check conventions as the forward-* commands.
WATCHDOG_PID_FILE="${CATALYST_DIR}/daemon-watchdog.pid"
# Codex P1: append to the log Alloy ALREADY tails for this service
# (execution-core/daemon.log → service.name catalyst.execution-core) rather than
# inventing a daemon-watchdog.log that no shipper knows about. The watchdog's
# whole point is an alert path independent of the possibly-wedged otel-forward
# egress, so a raised/escalated record written to an unshipped file would never
# reach Loki/Grafana — the exact failure the out-of-band sink exists to avoid.
# The runner emits the same pino-JSON shape as the daemon, so the records parse
# and label identically to the in-daemon probe's on a worker.
# NOTE: this makes the records shippable, not shipped — `catalyst-stack` starts
# Alloy on worker nodes only (CTL-1654), so on a monitor node the durable marker
# ~/catalyst/watchdog/<daemon>.alert.json remains the load-bearing local sink.
# Shipping observation-node logs is tracked separately (CTL-1720).
WATCHDOG_LOG="${CATALYST_DAEMON_LOG:-${CATALYST_DIR}/execution-core/daemon.log}"
WATCHDOG_SCRIPT="${SCRIPT_DIR}/execution-core/daemon-watchdog-run.mjs"

_watchdog_pid_is_ours() {
  local pid="$1" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  [[ -n "$cmd" ]] || return 1
  [[ "$cmd" == *"daemon-watchdog-run"* ]]
}

read_watchdog_pid() {
  if [[ -f "$WATCHDOG_PID_FILE" ]]; then
    local pid
    pid="$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && _watchdog_pid_is_ours "$pid"; then
      echo "$pid"; return 0
    fi
    rm -f "$WATCHDOG_PID_FILE" 2>/dev/null || true
  fi
  return 1
}

# _resolve_watchdog_config_path — the Layer-1 config path to pin for the child,
# echoed (empty when none is found, which leaves the child's own fallback).
#
# Codex P1 (round 4): deriving this from SCRIPT_DIR is wrong. Under the
# supported marketplace-cache fallback (CATALYST_FORCE_CACHE=1, missing
# pluginDirs, or an unhealthy checkout) SCRIPT_DIR lives under
# ~/.claude/plugins/cache/.../<version>/scripts, so `../../..` lands in the cache
# rather than the configured plugin-source repo — and since the LaunchAgent
# supplies no cwd or env, the monitor node's only watchdog would silently keep
# shadow defaults. Resolve independently of which script COPY is executing:
#
#   1. CATALYST_CONFIG_FILE            explicit operator/caller override
#   2. pluginDirs → checkout root      the configured plugin SOURCE (cache-proof)
#   3. <cwd>/.catalyst/config.json     interactive runs from a checkout
#   4. empty                           child falls back to its own resolution
_resolve_watchdog_config_path() {
  if [[ -n "${CATALYST_CONFIG_FILE:-}" ]]; then
    printf '%s' "$CATALYST_CONFIG_FILE"; return 0
  fi
  if [[ -f "${SCRIPT_DIR}/lib/plugin-dirs.sh" ]]; then
    # Subshell: resolve_plugin_dirs sets globals, and this must not leak into
    # the caller's environment.
    local from_plugin_dirs
    from_plugin_dirs="$(
      # shellcheck source=lib/plugin-dirs.sh
      source "${SCRIPT_DIR}/lib/plugin-dirs.sh" 2>/dev/null || exit 0
      resolve_plugin_dirs >/dev/null 2>&1 || true
      # RESOLVED_PLUGIN_DIRS is COLON-separated; split on ':' explicitly rather
      # than relying on word-splitting (paths may contain spaces).
      local _oldifs="$IFS"; IFS=':'
      # shellcheck disable=SC2206
      local _dirs=(${RESOLVED_PLUGIN_DIRS:-})
      IFS="$_oldifs"
      local _pd _root
      for _pd in "${_dirs[@]}"; do
        [[ -n "$_pd" ]] || continue
        _root="$(plugin_checkout_root "$_pd" 2>/dev/null)" || continue
        [[ -n "$_root" && -f "${_root}/.catalyst/config.json" ]] || continue
        printf '%s' "${_root}/.catalyst/config.json"; exit 0
      done
    )" || from_plugin_dirs=""
    if [[ -n "$from_plugin_dirs" ]]; then
      printf '%s' "$from_plugin_dirs"; return 0
    fi
  fi
  if [[ -f "$PWD/.catalyst/config.json" ]]; then
    printf '%s' "$PWD/.catalyst/config.json"; return 0
  fi
  printf ''
}

_watchdog_start_impl() {
  if read_watchdog_pid >/dev/null; then
    echo "Daemon watchdog already running (pid $(cat "$WATCHDOG_PID_FILE"))"
    return 0
  fi
  if [[ ! -f "$WATCHDOG_SCRIPT" ]]; then
    echo "Daemon watchdog script not found ($WATCHDOG_SCRIPT) — not started" >&2
    return 1
  fi
  # Codex P1: PIN the Layer-1 config path for the child. The runner's own
  # fallback is <cwd>/.catalyst/config.json, but the stack LaunchAgent supplies
  # neither WorkingDirectory nor CATALYST_CONFIG_FILE — so after a reboot cwd is
  # `/` and that fallback resolves /.catalyst/config.json, silently reverting the
  # monitor node's only watchdog to shadow defaults and ignoring a configured
  # `enforce`/`off`. Resolve it here (where SCRIPT_DIR is symlink-resolved to the
  # real plugin checkout) and export it, so launchd and an interactive start
  # agree. An explicit CATALYST_CONFIG_FILE always wins.
  local wd_config
  wd_config="$(_resolve_watchdog_config_path)"
  # APPEND (>>), never truncate: this is the shared execution-core daemon log.
  mkdir -p "$(dirname "$WATCHDOG_LOG")" 2>/dev/null || true
  CATALYST_CONFIG_FILE="$wd_config" nohup bun run "$WATCHDOG_SCRIPT" >> "$WATCHDOG_LOG" 2>&1 &
  local wd_pid=$!
  disown "$wd_pid" 2>/dev/null || true
  echo "$wd_pid" > "$WATCHDOG_PID_FILE"
  echo "Daemon watchdog started (pid $wd_pid)"
}

_watchdog_stop_impl() {
  local pid
  if ! pid=$(read_watchdog_pid); then
    echo "Daemon watchdog not running"; return 0
  fi
  kill "$pid" 2>/dev/null || true
  local waited=0
  while [[ $waited -lt 30 ]] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.1; waited=$((waited + 1))
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$WATCHDOG_PID_FILE" 2>/dev/null || true
  echo "Daemon watchdog stopped"
}

cmd_watchdog_start() {
  if ! acquire_watchdog_lock; then
    echo "Daemon watchdog busy (another start/stop in progress) — skipping start"
    return 0
  fi
  _watchdog_start_impl
  local rc=$?
  release_watchdog_lock
  return $rc
}

cmd_watchdog_stop() {
  if ! acquire_watchdog_lock; then
    echo "Daemon watchdog busy (another start/stop in progress) — skipping stop"
    return 0
  fi
  _watchdog_stop_impl
  local rc=$?
  release_watchdog_lock
  return $rc
}

cmd_watchdog_status() {
  local pid
  if pid=$(read_watchdog_pid); then
    echo "Daemon watchdog running (pid $pid)"
  else
    echo "Daemon watchdog not running"
  fi
}

usage() {
  echo "Usage: catalyst-monitor.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  start [--port N]   Start monitor server in background"
  echo "  stop               Stop monitor server"
  echo "  restart [--port N] Stop and re-start monitor server"
  echo "  status [--json]    Check if monitor is running"
  echo "  open               Start if needed, open browser to dashboard"
  echo "  url                Print the monitor URL"
  echo "  forward-start      Start otel-forward daemon in background"
  echo "  forward-stop       Stop otel-forward daemon"
  echo "  forward-status     Check if otel-forward daemon is running"
  echo "  forward-restart    Atomically stop then start the otel-forward daemon"
  echo "  watchdog-start     Start the standalone daemon watchdog (observation nodes)"
  echo "  watchdog-stop      Stop the standalone daemon watchdog"
  echo "  watchdog-status    Check if the standalone daemon watchdog is running"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  start)     cmd_start "$@" ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart "$@" ;;
  status)    cmd_status "$@" ;;
  open)      cmd_open "$@" ;;
  url)       cmd_url ;;
  watchdog-start)  cmd_watchdog_start ;;
  watchdog-stop)   cmd_watchdog_stop ;;
  watchdog-status) cmd_watchdog_status ;;
  forward-start)  cmd_forward_start ;;
  forward-stop)   cmd_forward_stop ;;
  forward-status) cmd_forward_status ;;
  forward-restart) cmd_forward_restart ;;
  help|--help|-h) usage ;;
  *) echo "error: unknown command: $cmd" >&2; exit 1 ;;
esac
