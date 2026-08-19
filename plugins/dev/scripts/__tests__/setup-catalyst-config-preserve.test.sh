#!/usr/bin/env bash
# Tests for setup_project_config()'s ticketPrefix/teamKey/stateMap preservation
# across a config regeneration (CTL-2076). A non-interactive setup run must NOT
# clobber a committed CTL config back to PROJ + a generic stateMap (the mechanism
# that rewrote mini-2's CTL checkout to team PROJ, wedging the lane-claim guard).
#
# Mirrors the existing thoughts.* (CTL-1214) and deployment.mode (CTL-1622)
# preservation-vs-fresh matrices in setup-catalyst-noninteractive.test.sh.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"
FAILURES=0; PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1${2:+ ($2)}"; }

echo "=== CTL-2076: setup_project_config preserves committed Linear identity ==="

# T1: regen over a CTL config with a DIFFERING projectKey (forces the re-write
# path) must PRESERVE the committed ticketPrefix/teamKey and the real stateMap —
# NOT clobber them to PROJ / In Progress / In Review.
spc_scratch=$(mktemp -d)
mkdir -p "$spc_scratch/proj/.catalyst"
cat > "$spc_scratch/proj/.catalyst/config.json" <<'JSON'
{
  "catalyst": {
    "projectKey": "old-key",
    "project": { "ticketPrefix": "CTL", "name": "Catalyst" },
    "linear": {
      "teamKey": "CTL",
      "stateMap": {
        "backlog": "Backlog",
        "todo": "Todo",
        "research": "Research",
        "planning": "Plan",
        "inProgress": "Implement",
        "inReview": "PR",
        "done": "Done",
        "canceled": "Canceled"
      }
    }
  }
}
JSON
spc_out=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=coalesce-labs
  REPO_NAME=catalyst
  PROJECT_KEY=new-key
  PROJECT_DIR='$spc_scratch/proj'
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.project.ticketPrefix + \"|\" + .catalyst.linear.teamKey + \"|\" + .catalyst.linear.stateMap.inProgress + \"|\" + .catalyst.linear.stateMap.inReview + \"|\" + .catalyst.linear.stateMap.research' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_out" == "CTL|CTL|Implement|PR|Research" ]] \
  && pass "regen preserves committed ticketPrefix/teamKey/stateMap (CTL/Implement/PR/Research)" \
  || fail "regen preserves committed ticketPrefix/teamKey/stateMap" "$spc_out"

# T2: a truly-fresh setup (NO existing config) is byte-identical to today's
# documented defaults: ticketPrefix=PROJ, teamKey=PROJ, generic 8-key stateMap
# (inProgress=In Progress, inReview=In Review).
spc_scratch=$(mktemp -d)
spc_fresh=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=acme-org
  PROJECT_DIR='$spc_scratch/proj'
  mkdir -p \"\$PROJECT_DIR\"
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.project.ticketPrefix + \"|\" + .catalyst.linear.teamKey + \"|\" + .catalyst.linear.stateMap.inProgress + \"|\" + .catalyst.linear.stateMap.inReview + \"|\" + (.catalyst.linear.stateMap | length | tostring)' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_fresh" == 'PROJ|PROJ|In Progress|In Review|8' ]] \
  && pass "fresh setup keeps documented defaults (PROJ/PROJ/generic 8-key stateMap)" \
  || fail "fresh setup keeps documented defaults" "$spc_fresh"

# T3: the regenerated file over a CTL config is still VALID JSON and the untouched
# fields behave as before — projectKey updates to the detected key, repository is
# written, and the fresh-install invariants (thoughts.*) stay non-null.
spc_scratch=$(mktemp -d)
mkdir -p "$spc_scratch/proj/.catalyst"
cat > "$spc_scratch/proj/.catalyst/config.json" <<'JSON'
{
  "catalyst": {
    "projectKey": "old-key",
    "project": { "ticketPrefix": "CTL", "name": "Catalyst" },
    "linear": { "teamKey": "CTL", "stateMap": { "inProgress": "Implement", "inReview": "PR" } }
  }
}
JSON
spc_valid=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=coalesce-labs
  REPO_NAME=catalyst
  PROJECT_KEY=new-key
  PROJECT_DIR='$spc_scratch/proj'
  setup_project_config >/dev/null 2>&1
  cfg=\"\$PROJECT_DIR/.catalyst/config.json\"
  if jq empty \"\$cfg\" 2>/dev/null; then
    jq -r '.catalyst.projectKey + \"|\" + .catalyst.repository.name + \"|\" + (.catalyst.thoughts.directory != null and .catalyst.thoughts.directory != \"\" | tostring)' \"\$cfg\"
  else
    echo INVALID_JSON
  fi
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_valid" == "new-key|catalyst|true" ]] \
  && pass "regen writes valid JSON with untouched fields (projectKey/repo/thoughts) intact" \
  || fail "regen writes valid JSON with untouched fields intact" "$spc_valid"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
