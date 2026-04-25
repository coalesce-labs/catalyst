#!/usr/bin/env bash
# emit-otel-metric.sh — POST an OTLP/HTTP counter metric to the local
# OTel Collector. Silent no-op when the collector is unreachable or no
# endpoint is configured.
#
# Used by catalyst-session.sh cmd_end to flush per-session counters that
# downstream analysis consumes via Prometheus (see CTL-158).
#
# Contract:
#   emit-otel-metric.sh <metric-name> \
#     --kind plan|fix \
#     --count <int> \
#     --linear-key <KEY> \
#     [--start-ns <unix-ns>] \
#     [--scope <scope-name>]
#
# Emits a single counter data point tagged {kind, linear.key}. The metric
# aggregation temporality is CUMULATIVE and isMonotonic=true, matching the
# other claude_code_*_total counters in the Prometheus store.
#
# Endpoint resolution: we hit the OTLP/HTTP `/v1/metrics` path. The base
# URL is derived from OTEL_EXPORTER_OTLP_ENDPOINT — if its port is 4317
# (the gRPC convention) we swap to 4318 (the HTTP convention). Any other
# port is used verbatim.
#
# Exits 0 on all failure paths (silent no-op is intentional — a session
# end must never fail because the collector is down).

set -uo pipefail

die_silent() { exit 0; }  # explicit shorthand for "fail silently"

# ─── Parse args ─────────────────────────────────────────────────────────────

METRIC_NAME="${1:-}"
[[ -n "$METRIC_NAME" ]] || die_silent
shift

KIND=""
COUNT=""
LINEAR_KEY=""
START_NS=""
SCOPE="catalyst.session"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind)       KIND="$2";       shift 2 ;;
    --count)      COUNT="$2";      shift 2 ;;
    --linear-key) LINEAR_KEY="$2"; shift 2 ;;
    --start-ns)   START_NS="$2";   shift 2 ;;
    --scope)      SCOPE="$2";      shift 2 ;;
    *) die_silent ;;  # unknown flag — silent noop, we're on the session-end hot path
  esac
done

# Minimal validation; anything odd → silent noop.
[[ -n "$KIND" && -n "$COUNT" ]] || die_silent
[[ "$COUNT" =~ ^[0-9]+$ ]] || die_silent

# ─── Endpoint resolution ────────────────────────────────────────────────────

ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
[[ -n "$ENDPOINT" ]] || die_silent

# Strip trailing slashes.
ENDPOINT="${ENDPOINT%/}"

# Swap the default gRPC port (4317) → HTTP port (4318). Any other port
# configuration is used verbatim; users running a non-standard setup can
# point OTEL_EXPORTER_OTLP_METRICS_ENDPOINT at the explicit HTTP URL.
HTTP_ENDPOINT="${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:-}"
if [[ -z "$HTTP_ENDPOINT" ]]; then
  HTTP_ENDPOINT="${ENDPOINT/:4317/:4318}"
fi
METRICS_URL="${HTTP_ENDPOINT}/v1/metrics"

# ─── Build payload ──────────────────────────────────────────────────────────

NOW_NS="$(date -u +%s)000000000"
: "${START_NS:=$NOW_NS}"

SERVICE_NAME="${OTEL_SERVICE_NAME:-claude-code}"

# Emit the OTLP/HTTP payload. Uses `jq -n` with --arg so caller-supplied
# values can never break the JSON structure.
PAYLOAD=$(jq -nc \
  --arg metric     "$METRIC_NAME" \
  --arg scope      "$SCOPE" \
  --arg service    "$SERVICE_NAME" \
  --arg kind       "$KIND" \
  --arg linear_key "$LINEAR_KEY" \
  --arg count      "$COUNT" \
  --arg start_ns   "$START_NS" \
  --arg now_ns     "$NOW_NS" \
  '{
    resourceLogs: null,
    resourceMetrics: [{
      resource: {
        attributes: [
          {key: "service.name", value: {stringValue: $service}},
          (if $linear_key == "" then empty else
            {key: "linear.key", value: {stringValue: $linear_key}}
          end)
        ]
      },
      scopeMetrics: [{
        scope: {name: $scope},
        metrics: [{
          name: $metric,
          unit: "1",
          sum: {
            dataPoints: [{
              attributes: [{key: "kind", value: {stringValue: $kind}}],
              startTimeUnixNano: $start_ns,
              timeUnixNano: $now_ns,
              asInt: $count
            }],
            aggregationTemporality: 2,
            isMonotonic: true
          }
        }]
      }]
    }]
  } | del(.resourceLogs)')

# ─── POST (best-effort, silent) ─────────────────────────────────────────────

# `--max-time 2` bounds the session-end hot path. A slow or unreachable
# collector must not block `catalyst-session.sh end` for more than a blink.
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$PAYLOAD" | curl -s -S \
    --max-time 2 \
    -X POST \
    -H "Content-Type: application/json" \
    --data @- \
    "$METRICS_URL" >/dev/null 2>&1 || true
fi

exit 0
