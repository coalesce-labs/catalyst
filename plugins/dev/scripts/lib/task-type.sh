#!/usr/bin/env bash
# lib/task-type.sh — shared helper for tagging Claude sessions with task.type
# (CTL-495).
#
# Every Claude session emits OTEL metrics under the
# `claude_code_cost_usage_USD_total` series. The series is sliced by
# resource attributes carried in OTEL_RESOURCE_ATTRIBUTES — project,
# linear.key, catalyst.orchestration, branch, model, etc. CTL-495 adds
# `task.type=<activity>` so the Grafana dashboard can slice cost by what
# the session was doing (phase-research, phase-implement, interactive,
# orchestrate, briefing-followup, ...).
#
# Usage:
#   . "$(dirname "$0")/lib/task-type.sh"
#   __catalyst_append_task_type "<value>"
#
# Contract:
#   - Exports OTEL_RESOURCE_ATTRIBUTES with `task.type=<value>` appended.
#   - Initialises the var to `task.type=<value>` when empty.
#   - Idempotent: if a `task.type=` pair is already present, leaves the
#     value unchanged. The first writer wins. This matters because the
#     helper may be invoked from a shell that already has `task.type=…`
#     set (e.g. a nested `claude` call from inside a phase agent during
#     dogfooding); we never clobber caller intent.
#   - Exits non-zero on empty value argument.
#
# Designed to be `source`d. Safe under `set -u` (uses `${var:-}` defaults).

__catalyst_append_task_type() {
  local value="${1:?task type value required}"
  if [[ -n "${OTEL_RESOURCE_ATTRIBUTES:-}" ]]; then
    if [[ "$OTEL_RESOURCE_ATTRIBUTES" == *"task.type="* ]]; then
      return 0
    fi
    OTEL_RESOURCE_ATTRIBUTES="${OTEL_RESOURCE_ATTRIBUTES},task.type=${value}"
  else
    OTEL_RESOURCE_ATTRIBUTES="task.type=${value}"
  fi
  export OTEL_RESOURCE_ATTRIBUTES
}
