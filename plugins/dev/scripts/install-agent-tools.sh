#!/usr/bin/env bash
# install-agent-tools.sh — CTL-1958 / CTL-2026 option (a). Symlink the DEPLOYED out-of-tree
# owner comms tools (~/catalyst/comms/tools/<name>) to the repo copies, so:
#   • the AC gate `grep -rl 'client_credentials' ~/catalyst/comms/tools/` passes and STAYS
#     passing across updates (the deployed file IS the repo file, which has no mint), and
#   • `catalyst doctor`'s agent-tools-write-path check reports WRAPPER/PASS.
#
# Repeatable + idempotent: re-running relinks in place (`ln -sfn`). The deployed copies were
# historically placed by hand and DIVERGED (CTL-2026: an avatar was edited into the
# out-of-tree linear-reply.mjs); this replaces that hand-copy with a symlink that cannot
# re-drift. Point the link at THIS scripts dir (resolved from the script's own location) so it
# tracks whatever plugin-source is deployed here.
#
# Deploy is an OPERATOR step, per host: run this on each mini after the mint-free repo copies
# land. Not automatic (the PR ships the mechanism; the host run closes the AC).
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
TOOLS_DIR="${CATALYST_DIR}/comms/tools"

# The tool list is the doctor's AGENT_TOOLS registry — read it from there so the installer and
# the health check can never name different files. Fall back to the known pair only if the
# module cannot be loaded (bare host without node on PATH), and say so out loud.
TOOLS="$(node -e "import('${SCRIPTS_DIR}/execution-core/agent-tools-write-path-health.mjs').then((m) => console.log(m.AGENT_TOOLS.join(' ')))" 2>/dev/null || true)"
if [[ -z "${TOOLS// /}" ]]; then
  echo "install-agent-tools: WARN — could not read AGENT_TOOLS from the doctor module; using the built-in fallback list" >&2
  TOOLS="linear-reply.mjs linear-ack.mjs"
fi

mkdir -p "$TOOLS_DIR"
installed=0
for name in $TOOLS; do
  src="${SCRIPTS_DIR}/${name}"
  link="${TOOLS_DIR}/${name}"
  if [[ ! -f "$src" ]]; then
    echo "install-agent-tools: ERROR — repo copy missing: ${src}" >&2
    exit 1
  fi
  # -s symlink, -f replace an existing entry, -n do not dereference an existing symlink-to-dir
  # (so a re-run relinks the entry itself, never creates a link INSIDE a previously-linked dir).
  ln -sfn "$src" "$link"
  echo "install-agent-tools: linked ${link} -> ${src}"
  installed=$((installed + 1))
done

echo "install-agent-tools: ${installed} tool(s) linked under ${TOOLS_DIR}"
