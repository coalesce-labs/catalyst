#!/usr/bin/env bash
# Catalyst Setup Health Check
# Validates the full Catalyst environment: tools, database, config, OTel, direnv, thoughts.
# Run from any Catalyst-configured project directory.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
DIRENV_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/direnv"
CATALYST_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"

pass_count=0
warn_count=0
fail_count=0

pass()  { echo -e "  ${GREEN}✅  ${NC}$1"; pass_count=$((pass_count + 1)); }
warn()  { echo -e "  ${YELLOW}⚠️   ${NC}$1"; warn_count=$((warn_count + 1)); }
fail()  { echo -e "  ${RED}❌  ${NC}$1"; fail_count=$((fail_count + 1)); }
info()  { echo -e "  ${BLUE}ℹ   ${NC}$1"; }
header() { echo ""; echo -e "${BOLD}$1${NC}"; }

# ─── 1. Platform ────────────────────────────────────────────────────────────

header "Platform"

if [[ "$(uname -s)" == "Darwin" ]]; then
    pass "macOS detected"
else
    warn "Non-macOS detected ($(uname -s)) — Catalyst assumes macOS"
fi

# ─── 2. Required Tools ──────────────────────────────────────────────────────

header "Required Tools"

TOOLS=(
    "git:Git"
    "jq:jq"
    "sqlite3:SQLite"
    "node:Node.js"
    "npm:npm"
    "bun:Bun runtime"
    "gh:GitHub CLI"
    "humanlayer:HumanLayer CLI"
    "linearis:Linearis CLI"
)

for spec in "${TOOLS[@]}"; do
    IFS=: read -r cmd name <<<"$spec"
    if command -v "$cmd" &>/dev/null; then
        pass "$name"
    else
        fail "$name not found"
    fi
done

header "Optional Tools"

OPT_TOOLS=(
    "agent-browser:agent-browser"
    "sentry-cli:Sentry CLI"
    "direnv:direnv"
    "smee:smee-client (webhook tunnel)"
    "mitmproxy:mitmproxy (optional — only needed for catalyst-stack --proxy)"
    "alloy:Grafana Alloy (log-shipper — installed by install-cli.sh)"
)

for spec in "${OPT_TOOLS[@]}"; do
    IFS=: read -r cmd name <<<"$spec"
    if command -v "$cmd" &>/dev/null; then
        pass "$name"
    else
        warn "$name not found (optional)"
    fi
done

# ─── 2b. Catalyst CLI Install ───────────────────────────────────────────────

header "Catalyst CLI Install"

CLI_BIN_DIR="${CATALYST_CLI_BIN_DIR:-$HOME/.catalyst/bin}"
CLI_NAMES=(catalyst catalyst-broker catalyst-comms catalyst-events catalyst-execution-core catalyst-filter catalyst-linear-reconcile catalyst-otel-forward catalyst-transitions catalyst-why catalyst-session catalyst-state catalyst-statusline catalyst-db catalyst-monitor catalyst-thoughts catalyst-claude catalyst-stack)

if [[ -d "$CLI_BIN_DIR" ]]; then
    pass "Bin dir exists: $CLI_BIN_DIR"

    case ":${PATH:-}:" in
        *":$CLI_BIN_DIR:"*) pass "$CLI_BIN_DIR is on PATH" ;;
        *) warn "$CLI_BIN_DIR not on PATH — add: export PATH=\"\$HOME/.catalyst/bin:\$PATH\"" ;;
    esac

    for cli in "${CLI_NAMES[@]}"; do
        link="$CLI_BIN_DIR/$cli"
        if [[ -L "$link" && -e "$link" ]]; then
            pass "$cli → $(readlink "$link")"
        elif [[ -L "$link" ]]; then
            fail "$cli symlink target missing — run install-cli.sh to repair"
        else
            warn "$cli not installed — run plugins/dev/scripts/install-cli.sh"
        fi
    done
else
    warn "$CLI_BIN_DIR missing — run plugins/dev/scripts/install-cli.sh"
    info "After install, add to PATH: export PATH=\"\$HOME/.catalyst/bin:\$PATH\""
fi

# ─── 3. Catalyst Directory ──────────────────────────────────────────────────

header "Catalyst Directory ($CATALYST_DIR)"

if [[ -d "$CATALYST_DIR" ]]; then
    pass "Directory exists"
else
    fail "Directory missing — run setup-catalyst.sh"
fi

if [[ -d "$CATALYST_DIR/wt" ]]; then
    pass "Worktree root exists (wt/)"
else
    warn "Worktree root missing ($CATALYST_DIR/wt/) — orchestration won't work"
fi

if [[ -d "$CATALYST_DIR/events" ]]; then
    pass "Events directory exists"
else
    warn "Events directory missing ($CATALYST_DIR/events/)"
fi

# ─── 4. SQLite Database ─────────────────────────────────────────────────────

header "Session Database"

DB_FILE="${CATALYST_DB_FILE:-$CATALYST_DIR/catalyst.db}"

if [[ -f "$DB_FILE" ]]; then
    pass "Database file exists ($DB_FILE)"

    if command -v sqlite3 &>/dev/null; then
        tables=$(sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" 2>/dev/null || echo "")
        core_tables=("session_events" "session_metrics" "session_prs" "session_tools" "sessions")
        all_core=true

        for t in "${core_tables[@]}"; do
            if ! echo "$tables" | grep -q "^${t}$"; then
                all_core=false
                break
            fi
        done

        if [[ "$all_core" == true ]]; then
            pass "Schema initialized (all 5 core tables present)"

            if echo "$tables" | grep -q "^schema_migrations$"; then
                migration=$(sqlite3 "$DB_FILE" "SELECT version FROM schema_migrations LIMIT 1;" 2>/dev/null || echo "")
                if [[ -n "$migration" ]]; then
                    pass "Migration tracked: $migration"
                fi
            else
                warn "schema_migrations table missing — run: plugins/dev/scripts/catalyst-db.sh init"
                info "Tables exist but weren't created by the migration system"
            fi
        else
            fail "Schema incomplete — run: plugins/dev/scripts/catalyst-db.sh init"
            info "Missing tables. Found: $(echo "$tables" | tr '\n' ', ' | sed 's/,$//')"
        fi

        journal=$(sqlite3 "$DB_FILE" "PRAGMA journal_mode;" 2>/dev/null || echo "unknown")
        if [[ "$journal" == "wal" ]]; then
            pass "WAL mode enabled"
        else
            warn "Journal mode is '$journal' (expected 'wal') — run: sqlite3 $DB_FILE 'PRAGMA journal_mode=WAL;'"
        fi
    else
        warn "sqlite3 not available — can't verify schema"
    fi
else
    fail "Database missing ($DB_FILE) — run: plugins/dev/scripts/catalyst-db.sh init"
fi

# Annotations DB
ANN_DB="$CATALYST_DIR/annotations.db"
if [[ -f "$ANN_DB" ]]; then
    pass "Annotations database exists"
else
    warn "Annotations database missing ($ANN_DB) — created on first orch-monitor use"
fi

# ─── 5. Project Config ──────────────────────────────────────────────────────

header "Project Config (current directory)"

CONFIG_PATH=""
if [[ -f ".catalyst/config.json" ]]; then
    CONFIG_PATH=".catalyst/config.json"
    pass "Config found: .catalyst/config.json"
elif [[ -f ".claude/config.json" ]]; then
    CONFIG_PATH=".claude/config.json"
    warn "Config in deprecated location (.claude/config.json) — move to .catalyst/"
else
    fail "No project config found — run setup-catalyst.sh"
fi

if [[ -n "$CONFIG_PATH" ]]; then
    PROJECT_KEY=$(jq -r '.catalyst.projectKey // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$PROJECT_KEY" ]]; then
        pass "Project key: $PROJECT_KEY"
    else
        fail "Missing catalyst.projectKey in $CONFIG_PATH"
    fi

    TICKET_PREFIX=$(jq -r '.catalyst.project.ticketPrefix // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$TICKET_PREFIX" ]]; then
        pass "Ticket prefix: $TICKET_PREFIX"
    else
        warn "Missing catalyst.project.ticketPrefix"
    fi

    TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$TEAM_KEY" ]]; then
        pass "Linear team key: $TEAM_KEY"
    else
        warn "Missing catalyst.linear.teamKey"
    fi

    STATE_MAP=$(jq -r '.catalyst.linear.stateMap // empty' "$CONFIG_PATH" 2>/dev/null)
    if [[ -n "$STATE_MAP" ]]; then
        pass "Linear state map configured"
    else
        warn "Missing catalyst.linear.stateMap"
    fi
fi

# ─── 6. Secrets Config ──────────────────────────────────────────────────────

header "Secrets Config"

if [[ -n "${PROJECT_KEY:-}" ]]; then
    SECRETS_FILE="$CATALYST_CONFIG/config-${PROJECT_KEY}.json"
    if [[ -f "$SECRETS_FILE" ]]; then
        pass "Secrets file exists: config-${PROJECT_KEY}.json"

        token=$(jq -r '.linear.apiToken // empty' "$SECRETS_FILE" 2>/dev/null)
        if [[ -n "$token" && "$token" != "[NEEDS_SETUP]" ]]; then
            pass "Linear API token configured"
        else
            warn "Linear API token not set in $SECRETS_FILE"
        fi
    else
        warn "Secrets file missing: $SECRETS_FILE"
        info "Create with: setup-catalyst.sh or manually"
    fi
else
    warn "Can't check secrets — no projectKey found"
fi

# ─── 6b. Webhook Pipeline ──────────────────────────────────────────────────

header "Webhook Pipeline"

HOME_CONFIG_PATH="$CATALYST_CONFIG/config.json"
if [[ -f "$HOME_CONFIG_PATH" ]]; then
    smee_channel=$(jq -r '.catalyst.monitor.github.smeeChannel // empty' "$HOME_CONFIG_PATH" 2>/dev/null)
    if [[ -n "$smee_channel" ]]; then
        pass "smeeChannel configured ($smee_channel)"
    else
        warn "Missing catalyst.monitor.github.smeeChannel in $HOME_CONFIG_PATH — webhook tunnel won't start"
        info "Run: bash plugins/dev/scripts/setup-webhooks.sh"
    fi
else
    warn "Cross-project Layer 2 config missing: $HOME_CONFIG_PATH — webhook tunnel not configured"
    info "Run: bash plugins/dev/scripts/setup-webhooks.sh"
fi

if [[ -f "$HOME_CONFIG_PATH" ]]; then
    # Check for both single-object (legacy) and keyed-object (CTL-273) formats
    linear_config=$(jq -r '.catalyst.monitor.linear // {}' "$HOME_CONFIG_PATH" 2>/dev/null)

    if [[ "$linear_config" == "{}" || "$linear_config" == "null" ]]; then
        warn "Linear webhook not registered — Linear events won't reach the event log"
        info "Register: bash plugins/dev/scripts/setup-webhooks.sh --linear-register"
    else
        # Check if this is the legacy single-object format or keyed object
        single_object_id=$(echo "$linear_config" | jq -r 'select(type == "object" and .webhookId != null) | .webhookId // empty' 2>/dev/null)
        if [[ -n "$single_object_id" ]]; then
            # Legacy single-object format
            pass "Linear webhook registered (legacy single-object, id: ${single_object_id:0:8}…)"
        else
            # Keyed-object format (CTL-273) — surface all registered webhooks
            while IFS= read -r key; do
                webhook_id=$(echo "$linear_config" | jq -r ".\"$key\".webhookId // empty" 2>/dev/null || true)
                if [[ -n "$webhook_id" ]]; then
                    if [[ "$key" == "workspace" ]]; then
                        pass "Linear webhook registered (workspace-wide, id: ${webhook_id:0:8}…)"
                    else
                        pass "Linear webhook registered (team: ${key:0:8}…, id: ${webhook_id:0:8}…)"
                    fi
                fi
            done < <(echo "$linear_config" | jq -r 'keys[]? // empty' 2>/dev/null)
        fi
    fi
fi

# ─── Linear Git Automation (CTL-759) ───────────────────────────────────────

header "Linear Git Automation"

# The execution-core pipeline is the single authority on Linear ticket state.
# Linear's branch-name "magic words" toggle (Settings → Team → Workflow → Git)
# auto-moves a ticket when a branch/PR name matches the ticket id — which races
# the daemon and produces the CTL-758 backward-write footgun. This is a UI-only
# setting with no API surface, so we cannot read or fix it from here; surface a
# static reminder. The git-automation STATE moves (start→PR, merge→Done) are
# managed for you by setup-execution-core-states.sh.
warn "Linear 'magic words' auto-move must be OFF (Settings → Team → Workflow → Git)"
info "It races the execution-core daemon (CTL-758 backward-write). Disable it in the Linear UI."
info "Git-automation state moves (start→PR, merge→Done) are reconciled by setup-execution-core-states.sh."

# botUserId (CTL-749) — the execution-core daemon now reads a SET from two sources:
#   NEW: ~/.config/catalyst/config.json  catalyst.linear.bot.{worker,orchestrator}.botUserId
#   OLD: .catalyst/config.json           catalyst.monitor.linear.botUserId (back-compat)
# Check both; pass if either is set.
_GLOBAL_WORKER_BOT=$(jq -r '.catalyst.linear.bot.worker.botUserId // empty' "${CATALYST_CONFIG}/config.json" 2>/dev/null)
_GLOBAL_ORCH_BOT=$(jq -r '.catalyst.linear.bot.orchestrator.botUserId // empty' "${CATALYST_CONFIG}/config.json" 2>/dev/null)
_LAYER1_BOT=""
if [[ -n "$CONFIG_PATH" && -f "$CONFIG_PATH" ]]; then
    _LAYER1_BOT=$(jq -r '.catalyst.monitor.linear.botUserId // empty' "$CONFIG_PATH" 2>/dev/null)
fi
if [[ -n "$_GLOBAL_WORKER_BOT" || -n "$_GLOBAL_ORCH_BOT" || -n "$_LAYER1_BOT" ]]; then
    _bot_ids=""
    [[ -n "$_GLOBAL_WORKER_BOT" ]] && _bot_ids="${_GLOBAL_WORKER_BOT:0:8}… (worker)"
    [[ -n "$_GLOBAL_ORCH_BOT" ]] && _bot_ids="${_bot_ids:+$_bot_ids, }${_GLOBAL_ORCH_BOT:0:8}… (orchestrator)"
    [[ -n "$_LAYER1_BOT" ]] && _bot_ids="${_bot_ids:+$_bot_ids, }${_LAYER1_BOT:0:8}… (layer-1 legacy)"
    pass "Linear app-actor identity: $_bot_ids"
else
    warn "No Linear bot user IDs configured — execution-core comms won't filter bot self-echo"
    info "NEW: set catalyst.linear.bot.worker.botUserId in ~/.config/catalyst/config.json"
    info "OLD fallback: set catalyst.monitor.linear.botUserId in .catalyst/config.json; see /catalyst-foundry:setup-catalyst"
fi

# Orchestrator Linear OAuth app (CTL-785) — the daemon mints its app-actor token
# from these creds at start; absent/partial creds silently fall back to the
# personal LINEAR_API_TOKEN (re-pinning the shared 2,500/hr bucket).
_ORCH_CID=$(jq -r '.catalyst.linear.bot.orchestrator.clientId // empty' "${CATALYST_CONFIG}/config.json" 2>/dev/null)
_ORCH_CSEC=$(jq -r '.catalyst.linear.bot.orchestrator.clientSecret // empty' "${CATALYST_CONFIG}/config.json" 2>/dev/null)
if [[ -n "$_ORCH_CID" && -n "$_ORCH_CSEC" ]]; then
    pass "Orchestrator Linear app credentials configured (clientId ${_ORCH_CID:0:8}…)"
elif [[ -n "$_ORCH_CID" || -n "$_ORCH_CSEC" ]]; then
    warn "Orchestrator Linear app credentials incomplete — need BOTH clientId and clientSecret"
    info "Set catalyst.linear.bot.orchestrator.{clientId,clientSecret} in ${CATALYST_CONFIG}/config.json"
else
    warn "Orchestrator Linear app not configured — daemon will fall back to the personal LINEAR_API_TOKEN (CTL-785)"
    info "Create a 'Catalyst Orchestrator' OAuth app in Linear, then set catalyst.linear.bot.orchestrator.{clientId,clientSecret} in ${CATALYST_CONFIG}/config.json"
fi

# ─── 7. OTel Observability Stack (optional) ────────────────────────────────

header "Observability Stack (optional)"

if command -v docker &>/dev/null; then
    pass "Docker available"

    otel_containers=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -cE "otel|prometheus|loki|grafana|lgtm" || true)
    if [[ "$otel_containers" -gt 0 ]]; then
        pass "OTel containers running ($otel_containers found)"

        get_host_port() {
            local container_pattern="$1" internal_port="$2"
            local ports_str
            ports_str=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -i "$container_pattern" || echo "")
            if [[ -z "$ports_str" ]]; then echo ""; return; fi
            # Match "0.0.0.0:HOST_PORT->INTERNAL_PORT/tcp" (exact port)
            local port
            port=$(echo "$ports_str" | grep -oE "0\.0\.0\.0:[0-9]+->${internal_port}/tcp" | head -1 | sed 's/0\.0\.0\.0:\([0-9]*\)->.*/\1/')
            if [[ -n "$port" ]]; then echo "$port"; return; fi
            # Match port range "0.0.0.0:START-END->START-END/tcp" where internal_port falls in range
            local range_start
            range_start=$(echo "$ports_str" | grep -oE "0\.0\.0\.0:[0-9]+-[0-9]+->[0-9]+-[0-9]+/tcp" | head -1 | sed 's/0\.0\.0\.0:\([0-9]*\)-.*/\1/')
            if [[ -n "$range_start" ]]; then echo "$internal_port"; return; fi
            echo ""
        }

        collector_port=$(get_host_port "collector" "4318")
        if [[ -n "$collector_port" ]]; then
            if (echo >/dev/tcp/localhost/"$collector_port") 2>/dev/null; then
                pass "OTel Collector reachable (:$collector_port)"
            else
                warn "OTel Collector mapped to :$collector_port but not responding"
            fi
        else
            warn "OTel Collector port mapping not found"
        fi

        prom_port=$(get_host_port "prometheus" "9090")
        if [[ -n "$prom_port" ]] && curl -sf --max-time 3 "http://localhost:${prom_port}/api/v1/status/buildinfo" &>/dev/null; then
            pass "Prometheus reachable (:$prom_port)"
        elif [[ -n "$prom_port" ]]; then
            warn "Prometheus mapped to :$prom_port but not responding"
        else
            warn "Prometheus port mapping not found"
        fi

        loki_port=$(get_host_port "loki" "3100")
        if [[ -n "$loki_port" ]] && curl -sf --max-time 3 "http://localhost:${loki_port}/ready" &>/dev/null; then
            pass "Loki reachable (:$loki_port)"
        elif [[ -n "$loki_port" ]]; then
            warn "Loki mapped to :$loki_port but not responding"
        else
            warn "Loki port mapping not found"
        fi

        grafana_port=$(get_host_port "grafana" "3000")
        if [[ -n "$grafana_port" ]] && curl -sf --max-time 3 "http://localhost:${grafana_port}/api/health" &>/dev/null; then
            pass "Grafana reachable (:$grafana_port)"
        elif [[ -n "$grafana_port" ]]; then
            warn "Grafana mapped to :$grafana_port but not responding"
        else
            warn "Grafana port mapping not found"
        fi
    else
        info "No OTel containers running — observability not configured"
        info "Optional: https://github.com/ryanrozich/claude-code-otel"
    fi
else
    info "Docker not found — skipping OTel stack check (optional)"
fi

# OTel config file
OTEL_CONFIG="$CATALYST_CONFIG/config.json"
if [[ -n "${PROJECT_KEY:-}" ]]; then
    OTEL_CONFIG="$CATALYST_CONFIG/config-${PROJECT_KEY}.json"
fi
if [[ -f "$OTEL_CONFIG" ]]; then
    otel_enabled=$(jq -r '.otel.enabled // empty' "$OTEL_CONFIG" 2>/dev/null)
    if [[ "$otel_enabled" == "true" ]]; then
        pass "OTel enabled in config"
    elif [[ -n "$otel_enabled" ]]; then
        warn "OTel disabled in config ($OTEL_CONFIG)"
    fi
fi

# ─── 7b. Orchestration Monitor (optional) ──────────────────────────────────

header "Orchestration Monitor (optional)"

MONITOR_PORT="${MONITOR_PORT:-7400}"

LAUNCHER=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-monitor.sh" ]]; then
    LAUNCHER="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-monitor.sh"
elif [[ -f "plugins/dev/scripts/catalyst-monitor.sh" ]]; then
    LAUNCHER="plugins/dev/scripts/catalyst-monitor.sh"
fi

# Prefer querying the wrapper for structured status (running + version drift).
# Fall back to a raw TCP probe when the wrapper or jq is unavailable.
if [[ -n "$LAUNCHER" ]] && command -v jq &>/dev/null; then
    STATUS_JSON=$(bash "$LAUNCHER" status --json 2>/dev/null || true)
    if [[ -n "$STATUS_JSON" ]]; then
        MONITOR_RUNNING=$(echo "$STATUS_JSON" | jq -r '.running // false')
        MONITOR_RV=$(echo "$STATUS_JSON" | jq -r '.runningVersion // "?"')
        MONITOR_LV=$(echo "$STATUS_JSON" | jq -r '.latestAvailableVersion // "?"')
        MONITOR_STALE=$(echo "$STATUS_JSON" | jq -r '.isStale // false')
        if [[ "$MONITOR_RUNNING" == "true" ]]; then
            pass "Monitor running on :$MONITOR_PORT (v$MONITOR_RV)"
        else
            warn "Monitor not running on :$MONITOR_PORT — catalyst-events wait-for falls back to 600s polling timeout"
            info "Start with: bash $LAUNCHER start"
        fi
        if [[ "$MONITOR_STALE" == "true" ]]; then
            warn "Monitor version drift: running v$MONITOR_RV, v$MONITOR_LV available — bash $LAUNCHER restart"
        fi
    elif (echo >/dev/tcp/localhost/"$MONITOR_PORT") 2>/dev/null; then
        pass "Monitor running on :$MONITOR_PORT"
    else
        warn "Monitor not running on :$MONITOR_PORT — catalyst-events wait-for falls back to 600s polling timeout"
        info "Start with: bash $LAUNCHER start"
    fi
elif (echo >/dev/tcp/localhost/"$MONITOR_PORT") 2>/dev/null; then
    pass "Monitor running on :$MONITOR_PORT"
else
    warn "Monitor not running on :$MONITOR_PORT — catalyst-events wait-for falls back to 600s polling timeout"
    if [[ -n "$LAUNCHER" ]]; then
        info "Start with: bash $LAUNCHER start"
    else
        info "Start with: bash plugins/dev/scripts/catalyst-monitor.sh start"
    fi
fi

# ─── 7b2. Log Shipper (Grafana Alloy) (optional) ───────────────────────────
# CTL-1263: verify the off-the-shelf Alloy daemon-log shipper is installed +
# configured + (best-effort) running, consistent with the other daemon checks.
# Warn/info-level only so a fresh node / non-running shipper never reds the
# whole health check.

header "Log Shipper (Alloy)"

# Config present — resolve the same way the monitor launcher above is resolved.
SHIPPER_CONFIG_PATH=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/scripts/log-shipper/config.alloy" ]]; then
    SHIPPER_CONFIG_PATH="${CLAUDE_PLUGIN_ROOT}/scripts/log-shipper/config.alloy"
elif [[ -f "plugins/dev/scripts/log-shipper/config.alloy" ]]; then
    SHIPPER_CONFIG_PATH="plugins/dev/scripts/log-shipper/config.alloy"
fi
if [[ -n "$SHIPPER_CONFIG_PATH" ]]; then
    pass "Shipper config present ($SHIPPER_CONFIG_PATH)"
else
    warn "Shipper config (log-shipper/config.alloy) not found — set CLAUDE_PLUGIN_ROOT or run from the repo root"
fi

# Binary present.
if command -v alloy &>/dev/null; then
    pass "alloy installed ($(command -v alloy))"
else
    warn "alloy not found — run install-cli.sh (installs Grafana Alloy)"
fi

# Running (best-effort) — read catalyst-stack's pid file.
SHIPPER_PID_FILE="$CATALYST_DIR/alloy.pid"
if [[ -f "$SHIPPER_PID_FILE" ]]; then
    SHIPPER_PID_VAL="$(cat "$SHIPPER_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$SHIPPER_PID_VAL" ]] && kill -0 "$SHIPPER_PID_VAL" 2>/dev/null; then
        pass "log-shipper running (pid $SHIPPER_PID_VAL)"
    else
        info "log-shipper not running — starts with: catalyst-stack start"
    fi
else
    info "log-shipper not running — starts with: catalyst-stack start"
fi

# ─── 7c. Execution-core Daemon Env / Proxy Audit (optional) ────────────────

header "Execution-core Daemon Env / Proxy Audit (optional)"

# The execution-core daemon sources a machine-local env file on `start`/`restart`
# (catalyst-execution-core cmd_start). It is OPT-IN: an absent file is a no-op,
# and is the common case. When it IS present and configures a proxy (routing the
# daemon's Linear/gh fetch traffic through a local mitmproxy audit), a broken
# proxy silently breaks the daemon's Linear connectivity on a fresh/changed
# machine — hard to debug. So: surface the file, and when a proxy is configured,
# verify it actually works.
DAEMON_ENV_FILE="${CATALYST_EXECUTION_CORE_ENV:-$CATALYST_CONFIG/execution-core.env}"
DAEMON_ENV_EXAMPLE="plugins/dev/templates/execution-core.env.example"
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/templates/execution-core.env.example" ]]; then
    DAEMON_ENV_EXAMPLE="${CLAUDE_PLUGIN_ROOT}/templates/execution-core.env.example"
fi

if [[ ! -f "$DAEMON_ENV_FILE" ]]; then
    # Absent file = intended default; not a problem. Surface it for discoverability.
    info "No daemon env at $DAEMON_ENV_FILE (optional) — used for proxy/CA tuning"
    info "To enable: copy $DAEMON_ENV_EXAMPLE there, uncomment what you need, then catalyst-execution-core restart"
else
    pass "Daemon env present: $DAEMON_ENV_FILE"

    # Read the file's exports in an isolated subshell so we don't pollute this
    # script's own environment, then pipe the values back as a single line.
    # (set -a exports everything the file assigns; the subshell is discarded.)
    daemon_env_vals=$(
        set +euo pipefail
        set -a
        # shellcheck disable=SC1090
        . "$DAEMON_ENV_FILE" 2>/dev/null
        set +a
        printf 'HTTPS_PROXY=%s\nHTTP_PROXY=%s\nNODE_USE_ENV_PROXY=%s\nNODE_EXTRA_CA_CERTS=%s\n' \
            "${HTTPS_PROXY:-}" "${HTTP_PROXY:-}" "${NODE_USE_ENV_PROXY:-}" "${NODE_EXTRA_CA_CERTS:-}"
    )
    de_https_proxy=$(printf '%s\n' "$daemon_env_vals" | sed -n 's/^HTTPS_PROXY=//p')
    de_http_proxy=$(printf '%s\n' "$daemon_env_vals" | sed -n 's/^HTTP_PROXY=//p')
    de_use_env_proxy=$(printf '%s\n' "$daemon_env_vals" | sed -n 's/^NODE_USE_ENV_PROXY=//p')
    de_ca_certs=$(printf '%s\n' "$daemon_env_vals" | sed -n 's/^NODE_EXTRA_CA_CERTS=//p')

    de_proxy="$de_https_proxy"
    [[ -z "$de_proxy" ]] && de_proxy="$de_http_proxy"

    if [[ -z "$de_proxy" ]]; then
        # File exists but configures no proxy — nothing to verify. Still report the
        # CA-cert path if one is set on its own (rare, but check it anyway).
        info "No proxy configured in $DAEMON_ENV_FILE — skipping proxy health check"
        if [[ -n "$de_ca_certs" && ! -f "$de_ca_certs" ]]; then
            warn "NODE_EXTRA_CA_CERTS in $DAEMON_ENV_FILE points at a missing file: $de_ca_certs"
            info "Fix the path or re-run mitmproxy to regenerate its CA at \$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
        fi
    else
        # Parse host:port from the proxy URL with pure parameter expansion:
        # strip scheme, strip optional userinfo, strip any path/query.
        de_hostport="${de_proxy#*://}"   # drop scheme://
        de_hostport="${de_hostport##*@}" # drop user:pass@
        de_hostport="${de_hostport%%/*}" # drop /path
        de_proxy_host="${de_hostport%:*}"
        de_proxy_port="${de_hostport##*:}"
        [[ "$de_proxy_host" == "$de_hostport" ]] && de_proxy_host="127.0.0.1" # no colon → default host
        [[ "$de_proxy_port" == "$de_hostport" ]] && de_proxy_port="" # no colon → no port

        # (a) Is the proxy port actually listening? Probe with bash /dev/tcp (same
        #     idiom as the OTel/monitor checks above); fall back to `nc -z` if a
        #     port couldn't be parsed or /dev/tcp is unavailable.
        if [[ -z "$de_proxy_port" ]]; then
            warn "Could not parse a port from proxy '$de_proxy' in $DAEMON_ENV_FILE — cannot probe liveness"
        else
            proxy_listening=""
            if (echo >/dev/tcp/"$de_proxy_host"/"$de_proxy_port") 2>/dev/null; then
                proxy_listening="yes"
            elif command -v nc &>/dev/null && nc -z -w 1 "$de_proxy_host" "$de_proxy_port" 2>/dev/null; then
                proxy_listening="yes"
            fi
            if [[ -n "$proxy_listening" ]]; then
                pass "Proxy reachable ($de_proxy_host:$de_proxy_port)"
            else
                warn "Daemon is set to route Linear/gh through $de_proxy_host:$de_proxy_port but nothing is LISTENING there"
                info "Start the proxy: mitmdump -s \"\$HOME/catalyst/mitm_linear_addon.py\" --listen-port $de_proxy_port"
                info "…or unset HTTPS_PROXY/HTTP_PROXY in $DAEMON_ENV_FILE to go direct"
            fi
        fi

        # (b) NODE_EXTRA_CA_CERTS must point at an existing file or MITM'd Linear
        #     TLS will fail cert validation.
        if [[ -z "$de_ca_certs" ]]; then
            warn "Proxy is set in $DAEMON_ENV_FILE but NODE_EXTRA_CA_CERTS is not — MITM'd Linear TLS will fail cert validation"
            info "Add: export NODE_EXTRA_CA_CERTS=\$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
        elif [[ ! -f "$de_ca_certs" ]]; then
            warn "MITM CA cert not found at $de_ca_certs — Linear TLS will fail"
            info "Fix the path in $DAEMON_ENV_FILE, or re-run mitmproxy to regenerate its CA"
        else
            pass "MITM CA cert present ($de_ca_certs)"
        fi

        # (c) *_PROXY set but NODE_USE_ENV_PROXY unset → Node fetch SILENTLY ignores
        #     the proxy. This is the highest-value catch: calls bypass the audit and
        #     nothing visibly breaks.
        if [[ "$de_use_env_proxy" != "1" ]]; then
            warn "Proxy vars are set but NODE_USE_ENV_PROXY=1 is missing from $DAEMON_ENV_FILE — Node fetch will IGNORE the proxy (Linear calls bypass the audit silently)"
            info "Add: export NODE_USE_ENV_PROXY=1"
        else
            pass "NODE_USE_ENV_PROXY=1 (Node fetch will honor the proxy)"
        fi
    fi
fi

# ─── 7d. Proxy leak into interactive shells (CTL-869, CTL-846 regression class) ──
#
# The mitmproxy HTTP(S)_PROXY in execution-core.env is DAEMON-launch-scoped only:
# catalyst-execution-core cmd_start sources the file right before nohup'ing the
# daemon, so the proxy lives only in the daemon's process tree. If instead a shell
# profile (~/.zshrc, ~/.zshenv, ~/.zprofile, ~/.bashrc, ~/.bash_profile, ~/.profile)
# `source`s execution-core.env — or exports HTTP(S)_PROXY directly — the proxy
# leaks into EVERY interactive shell. A fresh terminal then routes all traffic
# (including interactive `claude`) through mitmproxy, and when the proxy is down
# every API call dies with "connection refused". This check catches that leak and
# prints the exact one-line removal. No repo script writes such a line — it is
# always a hand-edit — so the fix is to delete it from the profile, never to widen
# the daemon env's reach.
header "Proxy Leak Into Interactive Shells (CTL-869)"

# de_proxy is set in section 7c only when the daemon env file exists; default it
# here so the messages below are safe under `set -u` when the file is absent.
de_proxy="${de_proxy:-(the daemon proxy)}"
leak_found=""
# (a) Any profile that sources the daemon env file directly leaks every export in
#     it (proxy + CA) into interactive shells. The grep ignores commented lines.
PROFILE_CANDIDATES=(
    "$HOME/.zshenv"
    "$HOME/.zprofile"
    "$HOME/.zshrc"
    "$HOME/.bash_profile"
    "$HOME/.bashrc"
    "$HOME/.profile"
)
for prof in "${PROFILE_CANDIDATES[@]}"; do
    [[ -f "$prof" ]] || continue
    # Match a non-comment line that sources execution-core.env (with or without
    # the `source`/`.` builtin spelled out, quoted or not).
    if grep -nE '^[[:space:]]*(source|\.)[[:space:]]+.*execution-core\.env' "$prof" 2>/dev/null \
        | grep -vE '^[0-9]+:[[:space:]]*#' >/dev/null; then
        leak_found="yes"
        leak_line=$(grep -nE '^[[:space:]]*(source|\.)[[:space:]]+.*execution-core\.env' "$prof" 2>/dev/null \
            | grep -vE '^[0-9]+:[[:space:]]*#' | head -1)
        fail "$prof sources the DAEMON-only env file into every interactive shell (line ${leak_line%%:*})"
        info "This leaks HTTP(S)_PROXY=$de_proxy into all terminals — fresh shells get 'connection refused' when mitmproxy is down (CTL-846 regression class)"
        info "REMOVE this line from $prof:"
        info "    ${leak_line#*:}"
        info "The daemon already sources this file itself at launch (catalyst-execution-core cmd_start) — the proxy stays daemon-scoped without it."
    fi
done

# (b) A profile may also export HTTP(S)_PROXY directly (not via the env file).
#     Flag any non-comment proxy export in a profile.
for prof in "${PROFILE_CANDIDATES[@]}"; do
    [[ -f "$prof" ]] || continue
    if grep -nE '^[[:space:]]*export[[:space:]]+(HTTPS?_PROXY|ALL_PROXY)=' "$prof" 2>/dev/null \
        | grep -vE '^[0-9]+:[[:space:]]*#' >/dev/null; then
        leak_found="yes"
        leak_line=$(grep -nE '^[[:space:]]*export[[:space:]]+(HTTPS?_PROXY|ALL_PROXY)=' "$prof" 2>/dev/null \
            | grep -vE '^[0-9]+:[[:space:]]*#' | head -1)
        fail "$prof exports a proxy var into every interactive shell (line ${leak_line%%:*})"
        info "REMOVE: ${leak_line#*:}"
        info "Proxy belongs ONLY in the daemon launch env (execution-core.env, sourced by catalyst-execution-core at start), never in a shell profile."
    fi
done

# (c) Live check: this very (interactive) shell already has a proxy set. This is
#     only a *leak* worth hard-failing on if the proxy is the catalyst mitmproxy
#     audit proxy (matching the daemon env's de_proxy, or the conventional
#     mitmproxy host:port) — a developer behind a legitimate corporate proxy
#     (HTTPS_PROXY=http://corp-proxy:…) must NOT get a false-positive failure
#     (and an untrue "routes through mitmproxy" claim) that flips the whole
#     health check non-zero. So: fail only on a confirmed mitmproxy match,
#     otherwise emit an informational note. (CTL-869)
live_proxy="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
if [[ -n "$live_proxy" ]]; then
    # de_proxy is the daemon env's configured proxy when the env file exists; it
    # is the literal placeholder "(the daemon proxy)" otherwise (set at line ~620
    # under set -u). Treat the live proxy as the catalyst mitmproxy when it equals
    # that real de_proxy, or when it points at the conventional mitmproxy host:port
    # (127.0.0.1:8080 / localhost:8080), the default this repo's tooling uses.
    is_catalyst_proxy=""
    if [[ "$de_proxy" != "(the daemon proxy)" && "$live_proxy" == "$de_proxy" ]]; then
        is_catalyst_proxy="yes"
    elif [[ "$live_proxy" == *"127.0.0.1:8080"* || "$live_proxy" == *"localhost:8080"* ]]; then
        is_catalyst_proxy="yes"
    fi

    if [[ -n "$is_catalyst_proxy" ]]; then
        leak_found="yes"
        fail "HTTP(S)_PROXY is set in THIS shell ($live_proxy) — interactive processes (incl. claude) route through the catalyst mitmproxy"
        info "If mitmproxy is down, every API call here fails with 'connection refused'. Find and remove the export/source from your shell profile (see above), then open a fresh terminal."
    else
        # An unrelated proxy (e.g. a corporate HTTP proxy). Do NOT hard-fail the
        # whole health check on it; just note it in case it is in fact a down
        # catalyst audit proxy under a non-default address.
        info "A proxy is set in this shell ($live_proxy) — if it is the catalyst mitmproxy audit proxy and it is down, interactive claude calls will fail with connection refused. If it is an unrelated (e.g. corporate) proxy, this is fine."
    fi
fi

if [[ -z "$leak_found" ]]; then
    pass "No proxy leak into interactive shells (proxy stays daemon-launch-scoped)"
fi

# ─── 8. direnv ──────────────────────────────────────────────────────────────

header "direnv"

if command -v direnv &>/dev/null; then
    pass "direnv installed ($(direnv version))"

    if [[ -f "$DIRENV_CONFIG/lib/profiles.sh" ]]; then
        pass "Library: profiles.sh"
    else
        warn "Missing $DIRENV_CONFIG/lib/profiles.sh — use_profile won't work"
    fi

    # CTL-637: compare installed copy against vendored source-of-truth.
    VENDORED_OTEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/direnv/lib/otel.sh"
    INSTALLED_OTEL="$DIRENV_CONFIG/lib/otel.sh"
    if [[ -f "$INSTALLED_OTEL" ]]; then
        if [[ -f "$VENDORED_OTEL" ]] && ! cmp -s "$VENDORED_OTEL" "$INSTALLED_OTEL"; then
            warn "Library: otel.sh present but differs from vendored copy (CTL-637 dedup may be missing)"
            info "Re-install: cp '$VENDORED_OTEL' '$INSTALLED_OTEL' && direnv reload"
        else
            pass "Library: otel.sh (matches vendored copy)"
        fi
    else
        warn "Missing $INSTALLED_OTEL — use_otel_context won't work"
        [[ -f "$VENDORED_OTEL" ]] && info "Install: cp '$VENDORED_OTEL' '$INSTALLED_OTEL'"
    fi

    profile_count=$(ls "$DIRENV_CONFIG/profiles/"*.env 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$profile_count" -gt 0 ]]; then
        pass "$profile_count profile(s) in $DIRENV_CONFIG/profiles/"
    else
        warn "No profiles found in $DIRENV_CONFIG/profiles/"
    fi

    if [[ -f ".envrc" ]]; then
        pass ".envrc exists in current project"
        if grep -q "use_profile" .envrc 2>/dev/null; then
            profiles_used=$(grep "use_profile" .envrc | sed 's/.*use_profile[[:space:]]*//' | tr -d '"' | tr '\n' ', ' | sed 's/,$//')
            pass "Profiles loaded: $profiles_used"

            for p in $(grep "use_profile" .envrc | sed 's/.*use_profile[[:space:]]*//' | tr -d '"'); do
                if [[ ! -f "$DIRENV_CONFIG/profiles/${p}.env" ]]; then
                    fail "Profile '$p' referenced in .envrc but $DIRENV_CONFIG/profiles/${p}.env missing"
                fi
            done
        fi
        if grep -q "use_otel_context" .envrc 2>/dev/null; then
            pass "OTel context configured in .envrc"
        fi
    else
        warn "No .envrc in current project — direnv not active here"
    fi
else
    warn "direnv not installed (recommended for multi-repo API key isolation)"
    info "Install: brew install direnv"
fi

# ─── 9. Thoughts System ─────────────────────────────────────────────────────

header "Thoughts System"

if [[ -d "thoughts" ]]; then
    pass "thoughts/ directory exists"

    # Fatal: regular directory (or dangling symlink) where humanlayer expects a symlink.
    # This is the bug state where writes silently land in the local repo instead of
    # syncing to the central thoughts store. Only fires when thoughts is expected
    # to be symlinked (humanlayer is configured for this repo, or .catalyst/config.json
    # declares catalyst.thoughts.directory).
    thoughts_expected=0
    if [[ -f ".catalyst/config.json" ]] && \
       [[ -n "$(jq -r '.catalyst.thoughts.directory // empty' .catalyst/config.json 2>/dev/null)" ]]; then
        thoughts_expected=1
    fi
    if command -v humanlayer &>/dev/null && \
       humanlayer thoughts config --json 2>/dev/null | \
         jq -e --arg cwd "$(pwd)" '.repoMappings[$cwd] // empty' &>/dev/null; then
        thoughts_expected=1
    fi

    if [[ $thoughts_expected -eq 1 ]]; then
        for top in shared global; do
            if [[ -e "thoughts/$top" && ! -L "thoughts/$top" ]]; then
                fail "thoughts/$top is a regular directory but should be a symlink — humanlayer init was bypassed"
                info "Recovery: bash plugins/dev/scripts/catalyst-thoughts.sh check"
            elif [[ -L "thoughts/$top" && ! -e "thoughts/$top" ]]; then
                fail "thoughts/$top is a symlink with a missing target"
                info "Recovery: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
            fi
        done
    fi

    for dir in research plans handoffs prs reports; do
        if [[ -d "thoughts/shared/$dir" ]]; then
            pass "thoughts/shared/$dir/"
        else
            warn "Missing thoughts/shared/$dir/ — run: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
        fi
    done

    if command -v humanlayer &>/dev/null; then
        hl_status=$(humanlayer thoughts status 2>&1 || true)
        if echo "$hl_status" | grep -q "Repository:"; then
            repo_path=$(echo "$hl_status" | grep "Repository:" | sed 's/.*Repository:[[:space:]]*//')
            pass "Thoughts repo: $repo_path"
        else
            warn "humanlayer thoughts not configured for this directory"
        fi

        if echo "$hl_status" | grep -q "Profile:"; then
            profile=$(echo "$hl_status" | grep "Profile:" | sed 's/.*Profile:[[:space:]]*//')
            pass "Thoughts profile: $profile"
        fi

        # Profile / directory drift check: catches the scenario where humanlayer was
        # init'd under a different profile than .catalyst/config.json declares.
        if [[ -f ".catalyst/config.json" ]]; then
            cat_profile=$(jq -r '.catalyst.thoughts.profile // empty' .catalyst/config.json 2>/dev/null)
            cat_dir=$(jq -r '.catalyst.thoughts.directory // empty' .catalyst/config.json 2>/dev/null)
            hl_map=$(humanlayer thoughts config --json 2>/dev/null | jq -r --arg cwd "$(pwd)" '.repoMappings[$cwd] // empty' 2>/dev/null)
            if [[ -n "$hl_map" ]]; then
                hl_profile=$(echo "$hl_map" | jq -r '.profile // empty' 2>/dev/null)
                hl_repo=$(echo "$hl_map" | jq -r '.repo // empty' 2>/dev/null)
                if [[ -n "$cat_profile" && -n "$hl_profile" && "$cat_profile" != "$hl_profile" ]]; then
                    fail "Profile drift: .catalyst/config.json='$cat_profile', humanlayer='$hl_profile' for this repo"
                    info "Fix: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
                    info "  (or manually: humanlayer thoughts uninit --force && humanlayer thoughts init --profile $cat_profile --directory ${cat_dir:-<directory>})"
                fi
                if [[ -n "$cat_dir" && -n "$hl_repo" && "$cat_dir" != "$hl_repo" ]]; then
                    fail "Directory drift: .catalyst/config.json='$cat_dir', humanlayer='$hl_repo' for this repo"
                fi
            fi
        fi
    fi
else
    warn "thoughts/ not found — run: bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair"
fi

# ─── 9b. Catalyst Marketplace Drift ─────────────────────────────────────────

header "Catalyst Marketplace"

DRIFT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIFT_SCRIPT="$DRIFT_SCRIPT_DIR/check-marketplace-drift.sh"
if [[ -x "$DRIFT_SCRIPT" ]]; then
    set +e
    drift_out=$("$DRIFT_SCRIPT" 2>&1)
    drift_rc=$?
    set -e
    if [[ $drift_rc -eq 2 ]]; then
        fail "check-marketplace-drift.sh setup error: $drift_out"
    elif [[ -z "$drift_out" ]]; then
        info "No local dev marketplace registered (public marketplace only)"
    else
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            case "$line" in
                "✅ "*) pass "${line#✅ }" ;;
                "⚠️ "*) warn "${line#⚠️ }" ;;
                "❌ "*) fail "${line#❌ }" ;;
                "ℹ "*)  info "${line#ℹ }" ;;
                *)      info "$line" ;;
            esac
        done <<< "$drift_out"
    fi
else
    warn "check-marketplace-drift.sh not found or not executable"
fi

# ─── 10. CLAUDE.md ──────────────────────────────────────────────────────────

header "CLAUDE.md"

if [[ -f "CLAUDE.md" ]]; then
    if grep -qi "catalyst" CLAUDE.md 2>/dev/null; then
        pass "CLAUDE.md exists with Catalyst context"
    else
        warn "CLAUDE.md exists but may be missing the Catalyst snippet"
        info "Add with: cat plugins/dev/templates/CLAUDE_SNIPPET.md >> CLAUDE.md"
    fi
else
    warn "No CLAUDE.md — agents won't have project-level workflow context"
fi

# ─── 11. Global Lifecycle Hooks ─────────────────────────────────────────────

header "Global Lifecycle Hooks (agent.checkout fallback)"

GLOBAL_SETTINGS="${HOME}/.claude/settings.json"

if [[ -f "$GLOBAL_SETTINGS" ]] && command -v jq &>/dev/null; then
    # Hooks are nested: .hooks.<Event>[].hooks[].command
    if jq -r '.hooks.Stop[]?.hooks[]?.command // empty' "$GLOBAL_SETTINGS" 2>/dev/null \
            | grep -q "emit-lifecycle-event" 2>/dev/null; then
        pass "Stop hook → emit-lifecycle-event"
    else
        warn "Stop hook not wired — broker won't receive agent.checkout on unclean session exit"
        info "Add to ~/.claude/settings.json via: /update-config"
        info '  hooks.Stop entry: {"type":"command","command":"~/.catalyst/bin/emit-lifecycle-event"}'
    fi

    if jq -r '.hooks.SubagentStop[]?.hooks[]?.command // empty' "$GLOBAL_SETTINGS" 2>/dev/null \
            | grep -q "emit-lifecycle-event" 2>/dev/null; then
        pass "SubagentStop hook → emit-lifecycle-event"
    else
        warn "SubagentStop hook not wired — broker won't receive agent.checkout on subagent crash"
        info "Add to ~/.claude/settings.json via: /update-config"
        info '  hooks.SubagentStop entry: {"type":"command","command":"~/.catalyst/bin/emit-lifecycle-event"}'
    fi
else
    if [[ ! -f "$GLOBAL_SETTINGS" ]]; then
        warn "~/.claude/settings.json not found — cannot verify global lifecycle hooks"
    else
        warn "jq not available — skipping global lifecycle hook check"
    fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ $fail_count -eq 0 && $warn_count -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All checks passed ($pass_count/${pass_count})${NC}"
elif [[ $fail_count -eq 0 ]]; then
    echo -e "${YELLOW}${BOLD}$pass_count passed, $warn_count warnings${NC}"
else
    echo -e "${RED}${BOLD}$pass_count passed, $warn_count warnings, $fail_count failures${NC}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit $fail_count
