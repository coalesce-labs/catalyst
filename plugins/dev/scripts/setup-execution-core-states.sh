#!/usr/bin/env bash
# setup-execution-core-states — ensure a team's execution-core Linear-state
# contract (CTL-564, Part A of the Linear State-Machine Trigger Model).
#
# For an execution-core repo this script, idempotently:
#   1. Ensures the contract workflow states exist for the team
#      (Todo + Research, Plan, Implement, Validate, PR — Triage already exists).
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

# CTL-722: decide whether to (over)write the stateMap.
# Detect the legacy default by VALUES: "In Progress" / "In Review" mark the old
# 8-key template. A map that already satisfies the contract — or any
# user-customised map without those legacy values — is preserved untouched.
# Returns 0 (needs write) or 1 (skip).
statemap_needs_write() {
	local current="$1"
	[[ -z $current || $current == "null" || $current == "{}" ]] && return 0
	# contract satisfied? (all 6 values present) -> skip
	if jq -e '
        [to_entries[].value] as $v
        | (["Todo","Research","Plan","Implement","Validate","PR"]
           | all(. as $s | $v | index($s)))' <<<"$current" >/dev/null 2>&1; then
		return 1
	fi
	# legacy signature present? -> rewrite
	if jq -e '[to_entries[].value] | (index("In Progress") or index("In Review"))' \
		<<<"$current" >/dev/null 2>&1; then
		return 0
	fi
	# non-legacy, non-contract custom map -> preserve
	return 1
}

# The execution-core 9-phase -> 5-state collapse map. `todo` maps to the
# pickable contract state `Todo`; verify+review collapse to `Validate`;
# pr+monitor-merge+monitor-deploy collapse to `PR`.
build_execution_core_state_map() {
	jq -nc '{
    backlog: "Backlog",
    todo: "Todo",
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
    { name: "Todo",      type: "unstarted" },
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

# --- worker-status label group reconcile (CTL-764) --------------------------
# Idempotently ensures a workspace-scoped exclusive 'worker-status' label group
# with 4 members (queued/blocked/needs-input/needs-human) via issueLabelCreate.
# Workspace-scoped (no teamId) so it applies across CTL + ADV teams without
# duplication. Re-parents/supersedes CTL-755's team-level blocked/waiting labels
# (no API delete — avoids stripping labels off historical tickets).

# worker_status_group_name — the workspace-scoped exclusive label group name.
worker_status_group_name() { echo "worker-status"; }

# worker_status_members — jq array of {name,color} for the 4 group members.
# Single source of truth: the daemon applies labels by these exact names.
worker_status_members() {
	jq -nc '[
    {"name":"queued",      "color":"#0099cc"},
    {"name":"blocked",     "color":"#eb5757"},
    {"name":"needs-input", "color":"#f2c94c"},
    {"name":"needs-human", "color":"#ff6b00"}
  ]'
}

# build_issue_label_group_create_mutation <name> <color>
# Workspace-scoped: omits teamId so Linear assigns the label to the workspace,
# not a specific team (the daemon applies via linearis which lists workspace labels).
# CTL-1483: the live API now REQUIRES isGroup:true on the parent create — a plain parent
# rejects child attaches ("parent label is not a group", observed 2026-07-15). Inverts
# the CTL-764 #2631-era shape. See build_worker_host_group_create_payload for the
# variable-form twin (used where name/color are host-derived untrusted input).
build_issue_label_group_create_mutation() {
	local name="$1" color="$2"
	cat <<MUTATION
mutation {
  issueLabelCreate(input: {
    name: "${name}",
    color: "${color}",
    isGroup: true
  }) {
    success
    issueLabel { id name }
  }
}
MUTATION
}

# build_issue_label_group_create_mutation_plain <name> <color>
# The pre-drift shape (no isGroup) — fallback when the API generation rejects the
# isGroup input field (the CTL-764 #2631-era behavior). See build_worker_host_group_create_payload_plain
# for the variable-form twin.
build_issue_label_group_create_mutation_plain() {
	local name="$1" color="$2"
	cat <<MUTATION
mutation {
  issueLabelCreate(input: {
    name: "${name}",
    color: "${color}"
  }) {
    success
    issueLabel { id name }
  }
}
MUTATION
}

# build_issue_label_group_upgrade_mutation <labelId>
# issueLabelUpdate isGroup:true — upgrades an adopted plain parent so children can attach.
# Returns a wrapped {query,variables} JSON envelope (pass directly to linear_graphql_post,
# do NOT re-wrap). See build_worker_host_group_upgrade_payload for the variable-form twin.
build_issue_label_group_upgrade_mutation() {
	local label_id="$1"
	jq -nc --arg id "$label_id" '{
    query: "mutation($id: String!) { issueLabelUpdate(id: $id, input: { isGroup: true }) { success issueLabel { id isGroup } } }",
    variables: { id: $id }
  }'
}

# build_issue_label_child_create_mutation <name> <color> <parentId>
# Workspace-scoped child label: omits teamId, sets parentId for group membership.
build_issue_label_child_create_mutation() {
	local name="$1" color="$2" parent_id="$3"
	cat <<MUTATION
mutation {
  issueLabelCreate(input: {
    name: "${name}",
    color: "${color}",
    parentId: "${parent_id}"
  }) {
    success
    issueLabel { id name }
  }
}
MUTATION
}

# reconcile_worker_status_labels <token>
# Ensures the workspace-scoped 'worker-status' group and its 4 children exist.
# Idempotent: re-runs issue zero mutations when all present. Tolerant: any
# Linear failure WARNs and returns 0 — never alters exit codes 0/2/3/4.
reconcile_worker_status_labels() {
	local token="$1"
	local group_name
	group_name=$(worker_status_group_name)

	if [[ ${dry_run:-0} -eq 1 ]]; then
		echo "DRY-RUN: would ensure worker-status label group (${group_name}) with 4 members (queued/blocked/needs-input/needs-human)"
		return 0
	fi

	# Query workspace labels (team:null = workspace-scoped, not per-team).
	local query payload resp
	query='query { issueLabels(filter: {team: {null: true}}, first: 250) { nodes { id name isGroup parent { id } } } }'
	payload=$(jq -nc --arg q "$query" '{query: $q}')
	resp=$(linear_graphql_post "$token" "$payload")

	# 4a: transport validation before .errors — a curl failure yields non-JSON text
	# (mirrors reconcile_worker_host_labels :515-518).
	if ! jq -e . >/dev/null 2>&1 <<<"$resp"; then
		echo "WARNING: reconcile_worker_status_labels: non-JSON/transport response — skipping" >&2
		return 0
	fi

	if echo "$resp" | jq -e '.errors' >/dev/null 2>&1; then
		local err
		err=$(echo "$resp" | jq -r '.errors[0].message // "unknown error"')
		echo "WARNING: reconcile_worker_status_labels: could not query workspace labels: ${err}" >&2
		return 0
	fi

	# Parse the response into a JSON array once; all subsequent lookups use jq over this.
	local labels_json
	labels_json=$(echo "$resp" | jq -c '.data.issueLabels.nodes // []')

	# Find the existing workspace parent by name at the top level (parent == null).
	# Match on parent==null, NOT isGroup==true — a partial-failure prior run may have
	# created the parent without isGroup (or without children), and requiring isGroup
	# would wrongly re-create a duplicate.
	# 4b: also extract group_is_group for the upgrade branch below (mirrors host :535-539).
	local group_id group_is_group
	group_id=$(echo "$labels_json" | jq -r --arg n "$group_name" \
		'.[] | select(.name == $n and .parent == null) | .id // empty' | head -1)
	group_is_group=$(echo "$labels_json" | jq -r --arg n "$group_name" \
		'.[] | select(.name == $n and .parent == null) | .isGroup // false' | head -1)

	if [[ -z $group_id ]]; then
		# 4c: Create the group with isGroup:true — the live API REJECTS attaching a child
		# to a non-group parent ("parent label is not a group", observed 2026-07-15). If
		# this API generation rejects the isGroup field, fall back to the pre-drift plain create.
		local group_mutation group_payload group_resp
		group_mutation=$(build_issue_label_group_create_mutation "$group_name" "#5e6ad2")
		group_payload=$(jq -nc --arg q "$group_mutation" '{query: $q}')
		group_resp=$(linear_graphql_post "$token" "$group_payload")
		if ! jq -e . >/dev/null 2>&1 <<<"$group_resp"; then
			echo "WARNING: reconcile_worker_status_labels: non-JSON/transport response — skipping" >&2
			return 0
		fi
		if echo "$group_resp" | jq -e '.errors' >/dev/null 2>&1; then
			local group_err
			group_err=$(echo "$group_resp" | jq -r '.errors[0].message // "unknown error"')
			if [[ $group_err == *isGroup* ]]; then
				echo "reconcile_worker_status_labels: isGroup rejected by this API generation — retrying plain create" >&2
				group_mutation=$(build_issue_label_group_create_mutation_plain "$group_name" "#5e6ad2")
				group_payload=$(jq -nc --arg q "$group_mutation" '{query: $q}')
				group_resp=$(linear_graphql_post "$token" "$group_payload")
				if ! jq -e . >/dev/null 2>&1 <<<"$group_resp" || echo "$group_resp" | jq -e '.errors' >/dev/null 2>&1; then
					group_err=$(echo "$group_resp" | jq -r '.errors[0].message // "transport/non-JSON"' 2>/dev/null)
					echo "WARNING: reconcile_worker_status_labels: could not create group '${group_name}': ${group_err}" >&2
					return 0
				fi
			else
				echo "WARNING: reconcile_worker_status_labels: could not create group '${group_name}': ${group_err}" >&2
				return 0
			fi
		fi
		group_id=$(echo "$group_resp" | jq -r '.data.issueLabelCreate.issueLabel.id // empty')
		echo "reconcile_worker_status_labels: created group '${group_name}' (id: ${group_id})"
	else
		echo "reconcile_worker_status_labels: group '${group_name}' already present (id: ${group_id})"
		if [[ $group_is_group != "true" ]]; then
			# Adopted plain parent (pre-drift partial run): upgrade it to a group so
			# child creates below can attach. WARN-and-continue on failure.
			local upgrade_payload upgrade_resp
			upgrade_payload=$(build_issue_label_group_upgrade_mutation "$group_id")
			upgrade_resp=$(linear_graphql_post "$token" "$upgrade_payload")
			if ! jq -e . >/dev/null 2>&1 <<<"$upgrade_resp" || echo "$upgrade_resp" | jq -e '.errors' >/dev/null 2>&1; then
				local upgrade_err
				upgrade_err=$(echo "$upgrade_resp" | jq -r '.errors[0].message // "transport/non-JSON"' 2>/dev/null)
				echo "WARNING: reconcile_worker_status_labels: could not upgrade '${group_name}' to a group: ${upgrade_err}" >&2
			else
				echo "reconcile_worker_status_labels: upgraded plain '${group_name}' to a group (isGroup:true)"
			fi
		fi
		# Note any pre-existing CTL-755 team-level labels now superseded by the workspace
		# group (daemon applies by name). No API delete — avoids stripping historical tickets.
		local stale
		stale=$(echo "$labels_json" | jq -r \
			'[ .[] | select((.name == "blocked" or .name == "waiting") and .isGroup == false and (.parent == null)) | .name ] | join(", ")' \
			2>/dev/null || true)
		[[ -n $stale ]] && echo "INFO: CTL-755 team-level labels (${stale}) superseded by workspace group (no API delete)" >&2
	fi

	# Create only missing children (those whose parentId matches the group).
	local members_json child_names
	members_json=$(worker_status_members)
	child_names=$(echo "$members_json" | jq -r '.[].name')

	while IFS= read -r member_name; do
		local already
		already=$(echo "$labels_json" | jq -r --arg n "$member_name" --arg pid "$group_id" \
			'.[] | select(.name == $n and .parent.id == $pid) | .name // empty' | head -1)
		if [[ -n $already ]]; then continue; fi

		local member_color child_mutation child_payload child_resp
		member_color=$(echo "$members_json" | jq -r --arg n "$member_name" \
			'.[] | select(.name == $n) | .color // "#5e6ad2"')
		child_mutation=$(build_issue_label_child_create_mutation "$member_name" "$member_color" "$group_id")
		child_payload=$(jq -nc --arg q "$child_mutation" '{query: $q}')
		child_resp=$(linear_graphql_post "$token" "$child_payload")
		# 4d: transport validation before .errors (mirrors host :605-608).
		if ! jq -e . >/dev/null 2>&1 <<<"$child_resp"; then
			echo "WARNING: reconcile_worker_status_labels: non-JSON/transport response for '${member_name}' — skipping" >&2
			continue
		fi
		if echo "$child_resp" | jq -e '.errors' >/dev/null 2>&1; then
			local child_err
			child_err=$(echo "$child_resp" | jq -r '.errors[0].message // "unknown error"')
			echo "WARNING: reconcile_worker_status_labels: could not create '${member_name}': ${child_err}" >&2
		else
			echo "reconcile_worker_status_labels: created child '${member_name}' under '${group_name}'"
		fi
	done <<<"$child_names"

	return 0
}

# --- worker:<host> label group reconcile (CTL-1481) -------------------------
# Idempotently ensures a workspace-scoped exclusive 'worker' label group with
# one 'worker:<host>' child per cluster host, via issueLabelCreate. Mirrors
# reconcile_worker_status_labels above exactly in shape and tolerance — this is
# a best-effort VISIBILITY PROJECTION of which host currently owns/last-claimed
# a ticket, NEVER the claim arbiter (cluster-claim.mjs's Linear-attachment CAS
# + generation stay authoritative).

# worker_host_group_name — the workspace-scoped exclusive label group name.
worker_host_group_name() { echo "worker"; }

# worker_host_color — single hex color shared by every worker:<host> child. An
# ownership stamp isn't a disposition palette (unlike worker_status_members'
# 4 distinct colors), so one harmonious color suffices — picked to read
# distinctly from the existing queued/blocked/needs-input/needs-human hues.
worker_host_color() { echo "#26a69a"; }

# worker_host_self_name — this host's coordination name. Bash mirror of
# config.mjs getHostName()'s precedence:
#   1. CATALYST_HOST_NAME env (test/alias override)
#   2. catalyst.host.name in the Layer-2 (machine-local) config file
#   3. hostname, reduced to its first DNS label (strips .local, .rozich, etc.)
# Never fails — always echoes something.
worker_host_self_name() {
	if [[ -n ${CATALYST_HOST_NAME:-} ]]; then
		echo "$CATALYST_HOST_NAME"
		return 0
	fi
	local layer2 name
	layer2="${CATALYST_LAYER2_CONFIG_FILE:-$HOME/.config/catalyst/config.json}"
	if [[ -f $layer2 ]]; then
		name=$(jq -r '.catalyst.host.name // empty' "$layer2" 2>/dev/null)
		if [[ -n $name ]]; then
			echo "$name"
			return 0
		fi
	fi
	local h
	h=$(hostname -s 2>/dev/null)
	[[ -z $h ]] && h=$(hostname 2>/dev/null)
	echo "${h%%.*}"
}

# worker_host_roster — cluster.json roster hosts (newline-separated). Fail-soft:
# a missing or malformed cluster repo/file yields empty output, never an error.
worker_host_roster() {
	local cluster_dir cluster_file
	# Mirror config.mjs getClusterRepoDir: CATALYST_CLUSTER_DIR, else the
	# catalyst data dir (CATALYST_DIR, default ~/catalyst) + /catalyst-cluster.
	cluster_dir="${CATALYST_CLUSTER_DIR:-${CATALYST_DIR:-$HOME/catalyst}/catalyst-cluster}"
	cluster_file="${cluster_dir}/cluster.json"
	[[ -f $cluster_file ]] || return 0
	jq -r '.roster[]?' "$cluster_file" 2>/dev/null || true
}

# worker_host_static_roster_env — CATALYST_STATIC_ROSTER escape-hatch leg
# (CTL-1481 finding 1). Comma-separated host list; mirrors config.mjs
# getStaticRoster()'s env leg exactly (split, trim, drop blanks). Fail-soft:
# unset/empty contributes nothing.
worker_host_static_roster_env() {
	local env="${CATALYST_STATIC_ROSTER:-}"
	[[ -z $env ]] && return 0
	tr ',' '\n' <<<"$env" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | awk 'NF'
}

# worker_host_static_roster_layer2 — catalyst.cluster.staticRoster escape-hatch
# leg (CTL-1481 finding 1). Mirrors config.mjs getStaticRoster()'s file leg: a
# JSON array of host-name strings at .catalyst.cluster.staticRoster in the
# Layer-2 (machine-local) config. Fail-soft: a missing file, malformed JSON,
# non-array value, or non-string/empty entries contribute nothing.
worker_host_static_roster_layer2() {
	local layer2
	layer2="${CATALYST_LAYER2_CONFIG_FILE:-$HOME/.config/catalyst/config.json}"
	[[ -f $layer2 ]] || return 0
	jq -r '.catalyst.cluster.staticRoster // [] | .[] | select(type == "string" and length > 0)' \
		"$layer2" 2>/dev/null || true
}

# worker_host_list — union of the cluster.json roster, the
# CATALYST_STATIC_ROSTER env escape hatch, the Layer-2
# catalyst.cluster.staticRoster escape hatch, and this host's own name, deduped
# (newline-separated). CTL-1481 finding 1: unlike config.mjs's
# resolveClusterHosts (which picks ONE source by precedence for roster
# membership), label provisioning wants a child label for every host that
# could ever claim a ticket, so all sources are unioned rather than
# precedence-selected — over-provisioning a label is harmless and idempotent.
# Each leg is independently fail-soft; never empty in practice —
# worker_host_self_name always resolves to something.
worker_host_list() {
	{ worker_host_roster
		worker_host_static_roster_env
		worker_host_static_roster_layer2
		worker_host_self_name
	} | awk 'NF' | sort -u
}

# build_worker_host_group_create_payload <name> <color>
# CTL-1481 finding 2: unlike build_issue_label_group_create_mutation above
# (used only with the static worker-status group name/color literals), the
# name here is a host-derived string (cluster.json roster / env / Layer-2
# config) — untrusted input that could contain a double-quote or backslash and
# break or inject into a spliced-in GraphQL query. So name/color travel as
# GraphQL variables and the query text stays a fixed string.
build_worker_host_group_create_payload() {
	local name="$1" color="$2"
	jq -nc --arg name "$name" --arg color "$color" '{
    query: "mutation($name: String!, $color: String!) { issueLabelCreate(input: { name: $name, color: $color, isGroup: true }) { success issueLabel { id name } } }",
    variables: { name: $name, color: $color }
  }'
}

# build_worker_host_group_create_payload_plain <name> <color>
# The pre-drift shape (no isGroup) — the fallback when the API generation
# rejects the isGroup input field (the CTL-764 #2631-era behavior). See the
# group-create fallback in reconcile_worker_host_labels.
build_worker_host_group_create_payload_plain() {
	local name="$1" color="$2"
	jq -nc --arg name "$name" --arg color "$color" '{
    query: "mutation($name: String!, $color: String!) { issueLabelCreate(input: { name: $name, color: $color }) { success issueLabel { id name } } }",
    variables: { name: $name, color: $color }
  }'
}

# build_worker_host_group_upgrade_payload <labelId>
# issueLabelUpdate isGroup:true — upgrades an adopted plain parent (a
# pre-drift partial run, or a customer label adopted by name) so children can
# attach: the live API now REJECTS issueLabelCreate(parentId:) against a
# non-group parent ("parent label is not a group", observed 2026-07-15).
build_worker_host_group_upgrade_payload() {
	local label_id="$1"
	jq -nc --arg id "$label_id" '{
    query: "mutation($id: String!) { issueLabelUpdate(id: $id, input: { isGroup: true }) { success issueLabel { id isGroup } } }",
    variables: { id: $id }
  }'
}

# build_worker_host_child_create_payload <name> <color> <parentId>
# Same variables treatment as build_worker_host_group_create_payload, plus
# parentId (also untrusted-shaped — derived from the group's resolved id, but
# kept as a variable for consistency and to avoid re-introducing splicing).
build_worker_host_child_create_payload() {
	local name="$1" color="$2" parent_id="$3"
	jq -nc --arg name "$name" --arg color "$color" --arg parentId "$parent_id" '{
    query: "mutation($name: String!, $color: String!, $parentId: String!) { issueLabelCreate(input: { name: $name, color: $color, parentId: $parentId }) { success issueLabel { id name } } }",
    variables: { name: $name, color: $color, parentId: $parentId }
  }'
}

# reconcile_worker_host_labels <token>
# Ensures the workspace-scoped 'worker' group and one 'worker:<host>' child per
# cluster host exist. Idempotent: re-runs issue zero mutations when all
# present. Tolerant: any Linear failure WARNs and returns 0 — never alters
# exit codes 0/2/3/4. CTL-1481 finding 3: every response is checked for valid
# JSON before `.errors` is consulted — a curl transport failure (timeout, TLS
# error, connection refused) yields non-JSON text on stdout, and `jq -e
# '.errors'` on unparseable input silently evaluates falsy, which would read as
# "no errors" and log a false success.
reconcile_worker_host_labels() {
	local token="$1"
	local group_name
	group_name=$(worker_host_group_name)

	local hosts
	hosts=$(worker_host_list)
	if [[ -z $hosts ]]; then
		echo "WARNING: reconcile_worker_host_labels: no hosts resolved (empty roster and self) — skipping" >&2
		return 0
	fi

	if [[ ${dry_run:-0} -eq 1 ]]; then
		echo "DRY-RUN: would ensure worker label group (${group_name}) with children: $(echo "$hosts" | tr '\n' ' ')"
		return 0
	fi

	# Query workspace labels (team:null = workspace-scoped, not per-team).
	local query payload resp
	# Narrowed server-side to names starting "worker" so the group + every
	# worker:<host> child always fit one page — a >250-label workspace cannot
	# push them past the first-page bound (Codex #2650 round-3).
	query='query { issueLabels(filter: {team: {null: true}, name: {startsWith: "worker"}}, first: 250) { nodes { id name isGroup parent { id } } } }'
	payload=$(jq -nc --arg q "$query" '{query: $q}')
	resp=$(linear_graphql_post "$token" "$payload")

	if ! jq -e . >/dev/null 2>&1 <<<"$resp"; then
		echo "WARNING: reconcile_worker_host_labels: non-JSON/transport response — skipping" >&2
		return 0
	fi

	if echo "$resp" | jq -e '.errors' >/dev/null 2>&1; then
		local err
		err=$(echo "$resp" | jq -r '.errors[0].message // "unknown error"')
		echo "WARNING: reconcile_worker_host_labels: could not query workspace labels: ${err}" >&2
		return 0
	fi

	# Parse the response into a JSON array once; all subsequent lookups use jq over this.
	local labels_json
	labels_json=$(echo "$resp" | jq -c '.data.issueLabels.nodes // []')

	# Find the existing workspace parent by name at the top level (parent == null).
	# Same #2631 rationale as reconcile_worker_status_labels: match on parent==null
	# (not isGroup==true) so a partial-failure prior run — or a customer's plain
	# label adopted by name — is found rather than re-created.
	local group_id group_is_group
	group_id=$(echo "$labels_json" | jq -r --arg n "$group_name" \
		'.[] | select(.name == $n and .parent == null) | .id // empty' | head -1)
	group_is_group=$(echo "$labels_json" | jq -r --arg n "$group_name" \
		'.[] | select(.name == $n and .parent == null) | .isGroup // false' | head -1)

	if [[ -z $group_id ]]; then
		# Create the group with isGroup:true — the live API REJECTS attaching a
		# child to a non-group parent ("parent label is not a group", observed
		# 2026-07-15; inverts the CTL-764 #2631-era behavior where isGroup was
		# itself rejected). If THIS API generation rejects the isGroup field,
		# fall back to the pre-drift plain create.
		local group_payload group_resp
		group_payload=$(build_worker_host_group_create_payload "$group_name" "$(worker_host_color)")
		group_resp=$(linear_graphql_post "$token" "$group_payload")
		if ! jq -e . >/dev/null 2>&1 <<<"$group_resp"; then
			echo "WARNING: reconcile_worker_host_labels: non-JSON/transport response — skipping" >&2
			return 0
		fi
		if echo "$group_resp" | jq -e '.errors' >/dev/null 2>&1; then
			local group_err
			group_err=$(echo "$group_resp" | jq -r '.errors[0].message // "unknown error"')
			if [[ $group_err == *isGroup* ]]; then
				echo "reconcile_worker_host_labels: isGroup rejected by this API generation — retrying plain create" >&2
				group_payload=$(build_worker_host_group_create_payload_plain "$group_name" "$(worker_host_color)")
				group_resp=$(linear_graphql_post "$token" "$group_payload")
				if ! jq -e . >/dev/null 2>&1 <<<"$group_resp" || echo "$group_resp" | jq -e '.errors' >/dev/null 2>&1; then
					group_err=$(echo "$group_resp" | jq -r '.errors[0].message // "transport/non-JSON"' 2>/dev/null)
					echo "WARNING: reconcile_worker_host_labels: could not create group '${group_name}': ${group_err}" >&2
					return 0
				fi
			else
				echo "WARNING: reconcile_worker_host_labels: could not create group '${group_name}': ${group_err}" >&2
				return 0
			fi
		fi
		group_id=$(echo "$group_resp" | jq -r '.data.issueLabelCreate.issueLabel.id // empty')
		echo "reconcile_worker_host_labels: created group '${group_name}' (id: ${group_id})"
	else
		echo "reconcile_worker_host_labels: group '${group_name}' already present (id: ${group_id})"
		if [[ $group_is_group != "true" ]]; then
			# Adopted plain parent (pre-drift partial run or a same-name customer
			# label): upgrade it to a group so the child creates below can attach.
			# WARN-and-continue on failure — the per-child WARNs then surface it.
			local upgrade_payload upgrade_resp
			upgrade_payload=$(build_worker_host_group_upgrade_payload "$group_id")
			upgrade_resp=$(linear_graphql_post "$token" "$upgrade_payload")
			if ! jq -e . >/dev/null 2>&1 <<<"$upgrade_resp" || echo "$upgrade_resp" | jq -e '.errors' >/dev/null 2>&1; then
				local upgrade_err
				upgrade_err=$(echo "$upgrade_resp" | jq -r '.errors[0].message // "transport/non-JSON"' 2>/dev/null)
				echo "WARNING: reconcile_worker_host_labels: could not upgrade '${group_name}' to a group: ${upgrade_err}" >&2
			else
				echo "reconcile_worker_host_labels: upgraded plain '${group_name}' to a group (isGroup:true)"
			fi
		fi
	fi

	# Create only missing children (one per host, name "worker:<host>").
	local host_name
	while IFS= read -r host_name; do
		[[ -z $host_name ]] && continue
		local child_name already
		child_name="worker:${host_name}"
		already=$(echo "$labels_json" | jq -r --arg n "$child_name" --arg pid "$group_id" \
			'.[] | select(.name == $n and .parent.id == $pid) | .name // empty' | head -1)
		if [[ -n $already ]]; then continue; fi

		local child_payload child_resp
		child_payload=$(build_worker_host_child_create_payload "$child_name" "$(worker_host_color)" "$group_id")
		child_resp=$(linear_graphql_post "$token" "$child_payload")
		if ! jq -e . >/dev/null 2>&1 <<<"$child_resp"; then
			echo "WARNING: reconcile_worker_host_labels: non-JSON/transport response for '${child_name}' — skipping" >&2
			continue
		fi
		if echo "$child_resp" | jq -e '.errors' >/dev/null 2>&1; then
			local child_err
			child_err=$(echo "$child_resp" | jq -r '.errors[0].message // "unknown error"')
			echo "WARNING: reconcile_worker_host_labels: could not create '${child_name}': ${child_err}" >&2
		else
			echo "reconcile_worker_host_labels: created child '${child_name}' under '${group_name}'"
		fi
	done <<<"$hosts"

	return 0
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
		if echo "$resp" | jq -e '.errors' >/dev/null 2>&1 ||
			[[ "$(echo "$resp" | jq -r '.data.gitAutomationStateCreate.success // .data.gitAutomationStateUpdate.success // false')" != "true" ]]; then
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
		if echo "$del_resp" | jq -e '.errors' >/dev/null 2>&1 ||
			[[ "$(echo "$del_resp" | jq -r '.data.gitAutomationStateDelete.success // false')" != "true" ]]; then
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
		--config)
			config="$2"
			shift 2
			;;
		--dry-run)
			dry_run=1
			shift
			;;
		--json)
			json_out=1
			shift
			;;
		# --force is accepted for CLI parity with resolve-linear-ids.sh. This
		# script is unconditionally idempotent — it always rewrites stateMap and
		# re-resolves stateIds (resolve-linear-ids.sh is called with --force
		# below) — so --force is a documented no-op, kept so callers can pass it
		# uniformly.
		--force) shift ;;
		-h | --help)
			sed -n '2,24p' "$0" >&2
			return 0
			;;
		*)
			echo "ERROR: unknown arg: $1" >&2
			return 1
			;;
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
		local dir
		dir="$(pwd)"
		while [[ $dir != "/" ]]; do
			if [[ -f "${dir}/.catalyst/config.json" ]]; then
				config="${dir}/.catalyst/config.json"
				break
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
		*) common_dir="${config_dir}/${common_dir}" ;;
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
	missing="${missing% }" # trim trailing space

	local state_map registry_query
	state_map="$(build_execution_core_state_map)"
	# CTL-582: triageStatus is the →Triage trigger state the daemon watches,
	# distinct from `status` (the scheduler-eligible state). resolveEligibleQuery
	# defaults it to "Triage" too, but pin it here so the registry entry is
	# self-describing.
	registry_query=$(jq -nc \
		'{ status: "Todo", triageStatus: "Triage", project: null, label: null, priority: null }')

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
			if echo "$create_resp" | jq -e '.errors' >/dev/null 2>&1 ||
				[[ "$(echo "$create_resp" | jq -r '.data.workflowStateCreate.success // false')" != "true" ]]; then
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
	# The execution-core daemon reads a SET of bot user UUIDs at startup:
	#   NEW: ~/.config/catalyst/config.json  catalyst.linear.bot.worker.botUserId
	#        ~/.config/catalyst/config.json  catalyst.linear.bot.orchestrator.botUserId
	#   OLD: .catalyst/config.json           catalyst.monitor.linear.botUserId (back-compat)
	# Without at least one set, the agent's OWN comments/updates are not filtered
	# out of inbox.jsonl and are treated as human input (false "human replied").
	# This is a prerequisite, not a hard failure here — warn and continue.
	local _global_cfg="$HOME/.config/catalyst/config.json"
	local _bot_worker _bot_orch _bot_layer1
	_bot_worker=$(jq -r '.catalyst.linear.bot.worker.botUserId // empty' "$_global_cfg" 2>/dev/null)
	_bot_orch=$(jq -r '.catalyst.linear.bot.orchestrator.botUserId // empty' "$_global_cfg" 2>/dev/null)
	_bot_layer1=$(jq -r '.catalyst.monitor.linear.botUserId // empty' "$config" 2>/dev/null)
	if [[ -z $_bot_worker && -z $_bot_orch && -z $_bot_layer1 ]]; then
		echo "WARNING: No Linear bot user IDs configured — CTL-749 self-echo guard is inactive" >&2
		echo "  NEW: set catalyst.linear.bot.worker.botUserId in ~/.config/catalyst/config.json" >&2
		echo "  OLD fallback: set catalyst.monitor.linear.botUserId in $config" >&2
	fi

	# --- write the execution-core stateMap (atomic tmp + mv), only if needed (CTL-722) ---
	local current_map
	current_map="$(jq -c '.catalyst.linear.stateMap // {}' "$config" 2>/dev/null || echo '{}')"
	if statemap_needs_write "$current_map"; then
		jq --argjson stateMap "$state_map" '.catalyst.linear.stateMap = $stateMap' \
			"$config" >"${config}.tmp" && mv "${config}.tmp" "$config"
		echo "Wrote execution-core stateMap to $config"
	else
		echo "stateMap already satisfies the contract or is user-customised — preserved ($config)"
	fi

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
			if [[ -f $registry_path ]] &&
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

	# --- reconcile worker-status label group (CTL-764) -------------------------
	# Must run before git automations so the group exists before the daemon starts
	# applying labels. Best-effort — never alters exit codes 0/2/3/4.
	reconcile_worker_status_labels "$token" || true

	# --- reconcile worker:<host> label group (CTL-1481) ------------------------
	# Best-effort visibility projection — never gates the exit code. Runs right
	# after the worker-status reconcile (same install-time step, same tolerance).
	reconcile_worker_host_labels "$token" || true

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
if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
	main "$@"
	exit $?
fi
