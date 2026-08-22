#!/usr/bin/env bash
# CAT-60: keep the two publish-routing knobs discoverable in the canonical
# configuration reference.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
REFERENCE="$REPO_ROOT/website/src/content/docs/reference/configuration.md"

failures=0
for key in 'catalyst.pr.pushRemote' 'catalyst.orchestration.publishPreflight.mode'; do
	if grep -Fq "$key" "$REFERENCE"; then
		echo "PASS: configuration reference documents $key"
	else
		echo "FAIL: configuration reference does not document $key"
		failures=$((failures + 1))
	fi
done

[[ $failures -eq 0 ]]
