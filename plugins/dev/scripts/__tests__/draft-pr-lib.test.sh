#!/usr/bin/env bash
# Wrapper so run-tests.sh's scripts/__tests__ glob discovers the lib suite (CTL-783).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/../lib/__tests__/draft-pr.test.sh"
