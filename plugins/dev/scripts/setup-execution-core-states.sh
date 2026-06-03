#!/usr/bin/env bash
# setup-execution-core-states — ensure a team's execution-core Linear-state
# contract (CTL-564, Part A of the Linear State-Machine Trigger Model).
#
# For an execution-core repo this script, idempotently:
#   1. Ensures the contract workflow states exist for the team
#      (Ready + Research, Plan, Implement, Validate, PR — Triage already exists).
#      Missing states are created via raw `workflowStateCreate` GraphQL; on a
#      permission/transport failure it prints admin-in-app fallback instructions.
#   2. Writes the execution-core stateMap — the 9-phase -> 5-state collapse —
#      atomically into .catalyst/config.json.
#   3. Refreshes stateIds by invoking resolve-linear-ids.sh --force.
#   4. Upserts the team's central registry.json entry via registry.mjs.
#
# Standalone and idempotent — safe to re-run; run once per team (CTL, then Adva).
#
# Usage:
#   setup-execution-core-states.sh [--config <path>] [--dry-run] [--json] [--force]
#
# Exit codes:
#   0  success — contract states present or created, config + registry written
#   1  usage error or missing prerequisite
#   2  Linear API call failed (states query)
#   3  states incomplete — a workflowStateCreate failed, fallback printed
#      (callers such as setup-catalyst.sh may tolerate this)
#   4  registry upsert failed — runner crash, missing deps without an installer,
#      or post-upsert verification found the team absent from registry.json
#      (CTL-578)

set -uo pipefail

# --- The contract -----------------------------------------------------------
# The execution-core 9-phase -> 5-state collapse map. `todo` maps to the
# pickable contract state `Ready`; verify+review collapse to `Validate`;
# pr+monitor-merge+monitor-deploy collapse to `PR`.
build_execution_core_state_map() {
  jq -nc '{
    backlog: "Backlog",
    todo: "Ready",
    triage: "Triage",
    research: "Research",
    planning: "Plan",
    inProgress: "Implement",
    verifying: "Validate",
    reviewing: "Validate",
    remediating: "Remediate",
    inReview: "PR",
    done: "Done",
    canceled: "Canceled"
  }'
}

# The contract states this script ensures, each with its Linear `type`.
# Triage is intentionally excluded — it already exists in every team workflow.
contract_states() {
  jq -nc '[
    { name: "Ready",     type: "unstarted" },
    { name: "Research",  type: "unstarted" },
    { name: "Plan",      type: "started"   },
    { name: "Implement", type: "started"   },
    { name: "Validate",  type: "started"   },
    { name: "PR",        type: "started"   }
  ]'
}

# missing_contract_states <fetched-states-json> — the contract state NAMES
# absent from the fetched workflow-state set. Prints a space-separated list
# (empty when the team already carries every contract state — idempotent).
missing_contract_states() {
  local fetched="$1"
  local have name
  have="$(echo "$fetched" | jq -r '.[].name' 2>/dev/null)"
  for name in $(contract_states | jq -r '.[].name'); do
    if ! grep -qxF "$name" <<<"$have"; then
      printf '%s ' "$name"
    fi
  done
}

# The desired Linear git-automation contract (CTL-759). Linear can auto-move a
# ticket on git events (PR opened / under review / merged). The execution-core
# pipeline is the authority on Linear state, so we pin exactly two automations —
# `start`→PR and `merge`→Done — and DELETE any `review` node. Linear's UI-only
# "magic words" toggle (move on branch-name match) must stay OFF; that path is
# the CTL-758 backward-write footgun and is not represented here.
#
# Keep in sync with contract_states() above (Done is a workflow `completed`
# state Linear ships by default; PR is one of our contract states).
desired_git_automations() {
  jq -nc '[
    { event: "start", state: "PR"   },
    { event: "merge", state: "Done" }
  ]'
}

# build_workflow_state_create_mutation <teamId> <name> <type> <color> —
# the raw GraphQL mutation string that creates one workflow state. `color` is
# cosmetic; see CONTRACT_STATE_COLOR.
build_workflow_state_create_mutation() {
  local team_id="$1" name="$2" type="$3" color="$4"
  cat <<MUTATION
mutation {
  workflowStateCreate(input: {
    teamId: "${team_id}",
    name: "${name}",
    type: "${type}",
    color: "${color}"
  }) {
    success
    workflowState { id name }
  }
}
MUTATION
}

# Cosmetic default color for created contract states (a neutral blue).
CONTRACT_STATE_COLOR="#5e6ad2"

# CTL-578: ensure execution-core/ has node_modules before invoking registry.mjs.
# Without this, a fresh worktree checkout silently fails the upsert because
# config.mjs cannot resolve `pino` (under runtimes that don't auto-install).
# Returns 0 on success, non-zero when deps are missing and `bun` is unavailable
# (or when the install itself fails).
ensure_execution_core_deps() {
  local exec_dir="$1"
  if [[ -d "${exec_dir}/node_modules" ]]; then
    return 0
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: ${exec_dir}/node_modules missing and 'bun' not on PATH; cannot install registry.mjs deps" >&2
    return 1
  fi
  echo "Installing execution-core dependencies in ${exec_dir} (CTL-578)..." >&2
  if ! (cd "$exec_dir" && bun install --frozen-lockfile >&2); then
    echo "ERROR: bun install --frozen-lockfile failed in ${exec_dir}" >&2
    return 1
  fi
  return 0
}

# --- GraphQL transport ------------------------------------------------------
# Isolated so tests can stub it via a fake `curl` earlier on PATH.
# linear_graphql_post <token> <payload-json> — prints the raw response body.
linear_graphql_post() {
  local token="$1" payload="$2"
  curl -s -X POST https://api.linear.app/graphql \
    -H "Content-Type: application/json" \
    -H "Authorization: ${token}" \
    -d "$payload" 2>&1
}

# --- Linear git-automation reconcile (CTL-759) ------------------------------
# reconcile_git_automation_states <team_id> <token> <fetched_states_json>
#
# Drives the team's git automations to the desired_git_automations() contract:
#   start → PR    (create or update the existing node's stateId)
#   merge → Done  (create or update)
#   review        → delete every existing node (we never auto-move on review)
#
# Reuses linear_graphql_post. State-ids are resolved from the already-fetched
# workflow states (no extra round-trip). Tolerant: every Linear failure prints a
# WARNING and continues — this is a best-effort hardening step, NOT a gate, so it
# never alters the exit codes (3/4) the caller depends on. A target state that
# does not exist in the team's workflow → WARN and skip that automation; we never
# issue a create/update with a null stateId.
#
# Idempotent: the live CTL team is already start→PR / merge→Done (review cleared),
# so this is a no-op there; value is durability at install + drift correction +
# coverage for ADV / future teams.
reconcile_git_automation_states() {
  local team_id="$1" token="$2" fetched_states="$3"

  # Resolve target state-ids from the fetched workflow states (by name).
  local pr_state_id done_state_id
  pr_state_id=$(echo "$fetched_states" | jq -r 'map(select(.name == "PR")) | .[0].id // empty')
  done_state_id=$(echo "$fetched_states" | jq -r 'map(select(.name == "Done")) | .[0].id // empty')

  # Fetch existing git automations for the team (id + event + target state id).
  local ga_query ga_payload ga_resp existing
  # shellcheck disable=SC2016
  ga_query='query($teamId: String!) { team(id: $teamId) { gitAutomationStates { nodes { id event state { id name } } } } }'
  ga_payload=$(jq -nc --arg q "$ga_query" --arg t "$team_id" '{query: $q, variables: {teamId: $t}}')
  ga_resp=$(linear_graphql_post "$token" "$ga_payload")
  if echo "$ga_resp" | jq -e '.errors' >/dev/null 2>&1; then
    local ga_err
    ga_err=$(echo "$ga_resp" | jq -r '.errors[0].message // "unknown error"')
    echo "WARNING: could not read git automations for team — skipping reconcile: $ga_err" >&2
    return 0
  fi
  existing=$(echo "$ga_resp" | jq -c '.data.team.gitAutomationStates.nodes // []' 2>/dev/null)
  if [[ -z $existing || $existing == "null" ]]; then
    existing='[]'
  fi

  # upsert <event> <target_state_id> — create the node if absent, else update
  # its stateId. Never called with an empty target id (caller guards).
  _ga_upsert() {
    local event="$1" state_id="$2"
    local node_id mutation payload resp
    node_id=$(echo "$existing" | jq -r --arg e "$event" 'map(select(.event == $e)) | .[0].id // empty')
    if [[ -n $node_id ]]; then
      # No change needed if the node already points at the desired state.
      local cur_state_id
      cur_state_id=$(echo "$existing" | jq -r --arg e "$event" 'map(select(.event == $e)) | .[0].state.id // empty')
      if [[ $cur_state_id == "$state_id" ]]; then
        echo "Git automation '${event}' already correct"
        return 0
      fi
      # shellcheck disable=SC2016
      mutation='mutation($id: String!, $input: GitAutomationStateUpdateInput!) { gitAutomationStateUpdate(id: $id, input: $input) { success } }'
      payload=$(jq -nc --arg q "$mutation" --arg id "$node_id" --arg s "$state_id" \
        '{query: $q, variables: {id: $id, input: {stateId: $s}}}')
    else
      # shellcheck disable=SC2016
      mutation='mutation($input: GitAutomationStateCreateInput!) { gitAutomationStateCreate(input: $input) { success } }'
      payload=$(jq -nc --arg q "$mutation" --arg t "$team_id" --arg e "$event" --arg s "$state_id" \
        '{query: $q, variables: {input: {teamId: $t, event: $e, stateId: $s}}}')
    fi
    resp=$(linear_graphql_post "$token" "$payload")
    if echo "$resp" | jq -e '.errors' >/dev/null 2>&1 \
      || [[ "$(echo "$resp" | jq -r '.data.gitAutomationStateCreate.success // .data.gitAutomationStateUpdate.success // false')" != "true" ]]; then
      echo "WARNING: failed to set git automation '${event}' → state ${state_id}" >&2
    else
      echo "Set git automation '${event}' → desired state"
    fi
  }

  # START → PR
  if [[ -z $pr_state_id ]]; then
    echo "WARNING: target state 'PR' not found in team workflow — skipping 'start' git automation (no null stateId issued)" >&2
  else
    _ga_upsert "start" "$pr_state_id"
  fi

  # MERGE → Done
  if [[ -z $done_state_id ]]; then
    echo "WARNING: target state 'Done' not found in team workflow — skipping 'merge' git automation (no null stateId issued)" >&2
  else
    _ga_upsert "merge" "$done_state_id"
  fi

  # REVIEW → delete each existing review node (we never auto-move on review).
  local review_id review_ids del_mutation del_payload del_resp
  review_ids=$(echo "$existing" | jq -r 'map(select(.event == "review")) | .[].id')
  for review_id in $review_ids; do
    [[ -z $review_id ]] && continue
    # shellcheck disable=SC2016
    del_mutation='mutation($id: String!) { gitAutomationStateDelete(id: $id) { success } }'
    del_payload=$(jq -nc --arg q "$del_mutation" --arg id "$review_id" '{query: $q, variables: {id: $id}}')
    del_resp=$(linear_graphql_post "$token" "$del_payload")
    if echo "$del_resp" | jq -e '.errors' >/dev/null 2>&1 \
      || [[ "$(echo "$del_resp" | jq -r '.data.gitAutomationStateDelete.success // false')" != "true" ]]; then
      echo "WARNING: failed to delete 'review' git automation node ${review_id}" >&2
    else
      echo "Deleted 'review' git automation node"
    fi
  done

  unset -f _ga_upsert
  return 0
}

# --- main -------------------------------------------------------------------
main() {
  local config="" dry_run=0 json_out=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --config)  config="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      --json)    json_out=1; shift ;;
      # --force is accepted for CLI parity with resolve-linear-ids.sh. This
      # script is unconditionally idempotent — it always rewrites stateMap and
      # re-resolves stateIds (resolve-linear-ids.sh is called with --force
      # below) — so --force is a documented no-op, kept so callers can pass it
      # uniformly.
      --force)   shift ;;
      -h|--help) sed -n '2,24p' "$0" >&2; return 0 ;;
      *) echo "ERROR: unknown arg: $1" >&2; return 1 ;;
    esac
  done

  for tool in jq curl git; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "ERROR: $tool required" >&2
      return 1
    fi
  done

  # --- resolve config path ---
  if [[ -z $config ]]; then
    local dir; dir="$(pwd)"
    while [[ $dir != "/" ]]; do
      if [[ -f "${dir}/.catalyst/config.json" ]]; then
        config="${dir}/.catalyst/config.json"; break
      fi
      dir="$(dirname "$dir")"
    done
  fi
  if [[ -z $config || ! -f $config ]]; then
    echo "ERROR: .catalyst/config.json not found" >&2
    return 1
  fi

  local team_key project_key
  team_key=$(jq -r '.catalyst.linear.teamKey // empty' "$config" 2>/dev/null)
  project_key=$(jq -r '.catalyst.projectKey // empty' "$config" 2>/dev/null)
  if [[ -z $team_key ]]; then
    echo "ERROR: catalyst.linear.teamKey not set in $config" >&2
    return 1
  fi
  if [[ -z $project_key ]]; then
    echo "ERROR: catalyst.projectKey not set in $config" >&2
    return 1
  fi

  # --- resolve repo root ---
  # Use --git-common-dir so a worktree resolves to its canonical repo (matching
  # orchestrate-execution-core-route.sh) — the registry must agree with it.
  local config_dir repo_root common_dir
  config_dir="$(cd "$(dirname "$config")/.." && pwd)"
  if common_dir=$(git -C "$config_dir" rev-parse --git-common-dir 2>/dev/null); then
    case "$common_dir" in
      /*) : ;;
      *)  common_dir="${config_dir}/${common_dir}" ;;
    esac
    repo_root="$(cd "$(dirname "$common_dir")" && pwd)"
  else
    repo_root="$config_dir"
  fi

  # --- resolve the Linear admin token ---
  # Both shapes exist in the codebase: setup-catalyst.sh writes
  # .catalyst.linear.apiToken, resolve-linear-ids.sh reads .linear.apiToken.
  local secrets_path token
  secrets_path="${HOME}/.config/catalyst/config-${project_key}.json"
  if [[ ! -f $secrets_path ]]; then
    echo "ERROR: secrets config not found at $secrets_path" >&2
    return 1
  fi
  token=$(jq -r '.catalyst.linear.apiToken // .linear.apiToken // empty' "$secrets_path" 2>/dev/null)
  if [[ -z $token ]]; then
    echo "ERROR: Linear apiToken not found in $secrets_path" >&2
    return 1
  fi

  # --- fetch the team's current workflow states ---
  local query payload response
  # $teamKey is a GraphQL variable inside this single-quoted query, not a shell var.
  # shellcheck disable=SC2016
  query='query($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states { nodes { id name type } } } } }'
  payload=$(jq -nc --arg q "$query" --arg k "$team_key" '{query: $q, variables: {teamKey: $k}}')
  response=$(linear_graphql_post "$token" "$payload")

  if echo "$response" | jq -e '.errors' >/dev/null 2>&1; then
    local err
    err=$(echo "$response" | jq -r '.errors[0].message // "unknown error"')
    echo "ERROR: Linear API error fetching workflow states: $err" >&2
    return 2
  fi

  local team_node team_id fetched_states
  team_node=$(echo "$response" | jq -c '.data.teams.nodes[0] // empty' 2>/dev/null)
  if [[ -z $team_node || $team_node == "null" ]]; then
    echo "ERROR: team '$team_key' not found in Linear" >&2
    return 2
  fi
  team_id=$(echo "$team_node" | jq -r '.id')
  fetched_states=$(echo "$team_node" | jq -c '.states.nodes // []')

  # --- diff against the contract ---
  local missing
  missing="$(missing_contract_states "$fetched_states")"
  missing="${missing% }"  # trim trailing space

  local state_map registry_query
  state_map="$(build_execution_core_state_map)"
  # CTL-582: triageStatus is the →Triage trigger state the daemon watches,
  # distinct from `status` (the scheduler-eligible state). resolveEligibleQuery
  # defaults it to "Triage" too, but pin it here so the registry entry is
  # self-describing.
  registry_query=$(jq -nc \
    '{ status: "Ready", triageStatus: "Triage", project: null, label: null, priority: null }')

  # --- dry-run: report intent, write nothing ---
  if [[ $dry_run -eq 1 ]]; then
    if [[ $json_out -eq 1 ]]; then
      jq -nc \
        --arg team "$team_key" \
        --arg repoRoot "$repo_root" \
        --argjson stateMap "$state_map" \
        --arg missing "$missing" \
        '{
          action: "dry-run",
          team: $team,
          repoRoot: $repoRoot,
          missingStates: ($missing | if . == "" then [] else (. / " ") end),
          stateMap: $stateMap
        }'
    else
      echo "Dry run — execution-core state contract for team $team_key:"
      if [[ -z $missing ]]; then
        echo "  contract states: all present"
      else
        echo "  would create: $missing"
      fi
      echo "  would write stateMap:"
      echo "$state_map" | jq -r 'to_entries[] | "    \(.key): \(.value)"'
      echo "  would upsert registry entry: team=$team_key repoRoot=$repo_root"
    fi
    return 0
  fi

  # --- ensure missing contract states via workflowStateCreate ---
  local states_incomplete=0 name type create_payload create_resp
  if [[ -n $missing ]]; then
    for name in $missing; do
      type=$(contract_states | jq -r --arg n "$name" '.[] | select(.name==$n) | .type')
      local mutation
      mutation="$(build_workflow_state_create_mutation "$team_id" "$name" "$type" "$CONTRACT_STATE_COLOR")"
      create_payload=$(jq -nc --arg q "$mutation" '{query: $q}')
      create_resp=$(linear_graphql_post "$token" "$create_payload")
      if echo "$create_resp" | jq -e '.errors' >/dev/null 2>&1 \
        || [[ "$(echo "$create_resp" | jq -r '.data.workflowStateCreate.success // false')" != "true" ]]; then
        states_incomplete=1
        echo "WARNING: failed to create workflow state '$name'" >&2
      else
        echo "Created workflow state '$name' ($type)"
      fi
    done
  fi

  if [[ $states_incomplete -eq 1 ]]; then
    echo "" >&2
    echo "Could not create one or more contract states automatically." >&2
    echo "Ask a Linear workspace admin to create them manually in the Linear app" >&2
    echo "(Settings -> Teams -> ${team_key} -> Workflow), then re-run this script." >&2
    echo "Missing states: $missing" >&2
  fi

  # --- check the Linear app-actor identity (CTL-749) ---
  # The execution-core daemon reads catalyst.monitor.linear.botUserId at startup
  # to filter the agent's OWN mirror comments/description-updates out of each
  # worker's inbox.jsonl (self-echo / write-loop guard). Without it set, the
  # agent's comments are written back as if a human replied, and bot-authored
  # issue events feed back into the event log as loops. This is a prerequisite,
  # not a hard failure here — warn and continue.
  local bot_id
  bot_id=$(jq -r '.catalyst.monitor.linear.botUserId // empty' "$config" 2>/dev/null)
  if [[ -z $bot_id ]]; then
    echo "WARNING: catalyst.monitor.linear.botUserId not set in $config" >&2
    echo "  execution-core needs it for CTL-749 self-echo filtering of the agent's own" >&2
    echo "  Linear comments/updates. Obtain it by querying viewer.id with the app-actor" >&2
    echo "  token from ~/.config/catalyst/config-${project_key}.json, then set it here." >&2
  fi

  # --- write the execution-core stateMap (atomic tmp + mv) ---
  jq --argjson stateMap "$state_map" '.catalyst.linear.stateMap = $stateMap' \
    "$config" > "${config}.tmp" && mv "${config}.tmp" "$config"
  echo "Wrote execution-core stateMap to $config"

  # --- refresh the machine-local stateIds cache via resolve-linear-ids.sh --force ---
  # CTL-577: stateIds is cached in ~/.config/catalyst/linear-state-ids.json,
  # keyed by teamKey — not committed to .catalyst/config.json.
  local script_dir resolve
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  resolve="${script_dir}/resolve-linear-ids.sh"
  if [[ -x $resolve ]]; then
    if bash "$resolve" --config "$config" --force >/dev/null 2>&1; then
      echo "Refreshed stateIds cache (~/.config/catalyst/linear-state-ids.json)"
    else
      echo "WARNING: resolve-linear-ids.sh failed — stateIds cache may be stale" >&2
    fi
  else
    echo "WARNING: resolve-linear-ids.sh not found — stateIds cache not refreshed" >&2
  fi

  # --- upsert the central registry entry via registry.mjs (CTL-578) ---
  # Three things changed vs. the original silent flow:
  #   1. `ensure_execution_core_deps` runs `bun install` if node_modules is
  #      missing, so a fresh worktree never silently no-ops on a pino import.
  #   2. Stderr is captured (not 2>&1-suppressed) and surfaced on failure.
  #   3. The runner's exit 0 is cross-checked by jq-reading registry.json —
  #      a runner that "succeeds" without writing the team fails the script.
  local registry_mjs runner=""
  local exec_dir="${script_dir}/execution-core"
  registry_mjs="${exec_dir}/registry.mjs"
  if command -v bun >/dev/null 2>&1; then
    runner="bun"
  elif command -v node >/dev/null 2>&1; then
    runner="node"
  fi

  local registry_failed=0
  if [[ -z $runner || ! -f $registry_mjs ]]; then
    echo "ERROR: cannot run registry.mjs (no bun/node, or module missing at ${registry_mjs})" >&2
    registry_failed=1
  elif ! ensure_execution_core_deps "$exec_dir"; then
    registry_failed=1
  else
    local upsert_err
    upsert_err="$(mktemp)"
    if "$runner" "$registry_mjs" upsert \
      --team "$team_key" \
      --repo-root "$repo_root" \
      --eligible-query "$registry_query" 2>"$upsert_err" >/dev/null; then
      local registry_path="${CATALYST_DIR:-$HOME/catalyst}/execution-core/registry.json"
      if [[ -f $registry_path ]] && \
         jq -e --arg t "$team_key" '.projects[]? | select(.team == $t)' \
           "$registry_path" >/dev/null 2>&1; then
        echo "Upserted registry entry for team $team_key"
      else
        echo "ERROR: registry.mjs upsert exited 0 but team '$team_key' not present in $registry_path" >&2
        registry_failed=1
      fi
    else
      echo "ERROR: registry.mjs upsert failed for team $team_key" >&2
      sed 's/^/  /' "$upsert_err" >&2
      registry_failed=1
    fi
    rm -f "$upsert_err"
  fi

  # --- reconcile Linear git automations (CTL-759) — the LAST Linear step ---
  # Best-effort hardening: pins start→PR / merge→Done and removes any review
  # automation, the install-time complement to the daemon's CTL-758 backward-
  # write guard. Tolerant by design — it prints WARNINGs and continues, and
  # never touches the 3/4 exit codes the caller (setup-catalyst.sh) consumes.
  reconcile_git_automation_states "$team_id" "$token" "$fetched_states" || true

  # --- summary ---
  if [[ $json_out -eq 1 ]]; then
    jq -nc \
      --arg team "$team_key" \
      --arg repoRoot "$repo_root" \
      --argjson incomplete "$states_incomplete" \
      '{
        action: (if $incomplete == 1 then "states_incomplete" else "complete" end),
        team: $team,
        repoRoot: $repoRoot
      }'
  fi

  if [[ $states_incomplete -eq 1 ]]; then
    return 3
  fi
  if [[ $registry_failed -eq 1 ]]; then
    return 4
  fi
  return 0
}

# Sourcing guard — when sourced (by the test suite) main does not run, so the
# pure helpers above can be asserted directly.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
  exit $?
fi
