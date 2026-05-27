#!/usr/bin/env bash
# scripts/ci/docs-paths-changed.sh — CTL-670.
# Decide whether a PR's changed paths are "docs-relevant" (i.e. would change what
# the Cloudflare Pages docs build deploys). Reads newline-delimited changed paths
# on stdin. Prints "docs" + exit 0 if any path is docs-relevant; else "nodocs" + exit 1.
#
# Docs-relevant = anything under website/, or any plugins/<name>/CHANGELOG.md (the docs
# build renders changelog pages from ../plugins/*/CHANGELOG.md — see
# website/astro.config.mjs). Pure string matching; no git, no network.
#
# Consumed by .github/workflows/docs-gate.yml: that workflow is the sole required
# check for merges to main and runs on every PR (no path filter), so the required
# context always reports. The build step it gates only runs when this helper says
# "docs". Keep the two docs-relevant patterns here in sync with the Cloudflare Pages
# "Build watch paths" include set (website/* + plugins/*/CHANGELOG.md) — see
# docs/ci-required-checks-rollout.md.
set -uo pipefail

is_docs_path() {
  local p="$1"
  case "$p" in
    website/*) return 0 ;;
  esac
  # plugins/<name>/CHANGELOG.md — exactly one path segment after plugins/.
  if [[ "$p" =~ ^plugins/[^/]+/CHANGELOG\.md$ ]]; then
    return 0
  fi
  return 1
}

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if is_docs_path "$line"; then
    echo "docs"
    exit 0
  fi
done

echo "nodocs"
exit 1
