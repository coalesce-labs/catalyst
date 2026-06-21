#!/usr/bin/env bash
# Tests for .github/workflows/gitleaks.yml (CTL-1204): asserts the license-free
# OSS-binary design — pinned version + checksum, correct triggers, the repo
# config, PR-range vs full-history scanning, and a TRUE exit-code gate with no
# silent false-green. Replaces the old gitleaks-action assertions.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
WF="${REPO_ROOT}/.github/workflows/gitleaks.yml"
fail=0
chk()  { grep -Eq -- "$2" "$WF" || { echo "FAIL: $1"; fail=1; }; }
absent() { grep -Eq -- "$2" "$WF" && { echo "FAIL: $1"; fail=1; } || true; }

[[ -f "$WF" ]] || { echo "FAIL: workflow missing"; exit 1; }

# --- No paid action, no license anywhere ---------------------------------
absent "must NOT use gitleaks-action"      'gitleaks/gitleaks-action'
absent "must NOT reference a license"      'GITLEAKS_LICENSE'

# --- Triggers ------------------------------------------------------------
chk "pull_request trigger"                 '^\s*pull_request:'
chk "push to main trigger"                 'branches:\s*\[.*main.*\]|- main'
chk "workflow_dispatch trigger"            '^\s*workflow_dispatch:'
chk "weekly schedule sweep"                'cron:\s*"0 6 \* \* 1"'

# --- Checkout + history --------------------------------------------------
chk "pinned checkout action"               'actions/checkout@v4'
chk "fetch-depth 0"                        'fetch-depth:\s*0'

# --- Pinned, checksum-verified supply chain ------------------------------
chk "pinned gitleaks version"              'GITLEAKS_VERSION:\s*"?8\.28\.0"?'
chk "pinned sha256 of release tarball"     'GITLEAKS_SHA256:\s*"?[0-9a-f]{64}"?'
chk "downloads official release tarball"   'github\.com/gitleaks/gitleaks/releases/download'
chk "verifies checksum"                    'sha256sum (--check|-c)'
chk "curl fails on http error"             'curl .*--fail'
chk "asserts installed version"            'test "\$\{installed\}" = "\$\{GITLEAKS_VERSION\}"'

# --- Uses the repo config ------------------------------------------------
chk "passes --config .gitleaks.toml"       '--config\s+\.gitleaks\.toml'

# --- Correct v8.28 subcommand (NOT the deprecated detect) ----------------
chk "uses 'gitleaks git' subcommand"       'gitleaks "\$\{args\[@\]\}"|^\s*args=\(git'
chk "PR range via --log-opts"              '--log-opts'
chk "PR scan conditional on pull_request"  'GITHUB_EVENT_NAME.*=.*pull_request'
chk "guards against empty PR SHAs"         '-z "\$\{PR_BASE_SHA\}"|-z "\$\{PR_HEAD_SHA\}"'

# --- TRUE gate + no silent false-green -----------------------------------
# Custom leak exit code distinguishes leaks (gate red) from operational errors.
chk "custom leak exit code set"            '--exit-code\s+"?\$\{GITLEAKS_LEAK_EXIT\}"?|GITLEAKS_LEAK_EXIT:\s*"?7"?'
chk "captures exit code"                   'code=\$\?'
chk "leak case exits nonzero"              'GITLEAKS_LEAK_EXIT\}"?\)'
chk "error catch-all branch"               '\*\)'
chk "error branch emits FAILURE exit 1"    'treating as FAILURE'

# No swallowing of failures.
absent "no '|| true' swallowing"           '\|\|\s*true'
absent "no 'continue-on-error'"            'continue-on-error'

[[ $fail -eq 0 ]] && echo "PASS: gitleaks workflow well-formed" || exit 1
