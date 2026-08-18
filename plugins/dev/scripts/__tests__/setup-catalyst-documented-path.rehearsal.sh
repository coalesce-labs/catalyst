#!/usr/bin/env bash
# setup-catalyst-documented-path.rehearsal.sh — CTL-1914 / CTL-1917 / CTL-1918.
#
# Runs the DOCUMENTED install (a lone downloaded setup-catalyst.sh, --non-interactive)
# inside a sealed prefix, and reports which provisioning steps actually fired.
#
# ⛔ It runs TWO scripts against the SAME sealed prefix and stub set: the working-tree
# version and the one at a baseline ref (default origin/main). A single run cannot tell
# "this step fires" from "my instrument records everything"; the pair can, because the
# baseline is expected to come back EMPTY on exactly the lines the fix is about. That
# baseline is the positive control, and it is why this is a rehearsal rather than a demo.
#
# Nothing here touches the real HOME, the network, or launchd: HOME is a scratch dir,
# `git clone` is stubbed to a local copy of this checkout, and every helper the install
# invokes is a recording stub.
#
# Usage: bash plugins/dev/scripts/__tests__/setup-catalyst-documented-path.rehearsal.sh [baseline-ref]

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../../.." && pwd)"
BASELINE_REF="${1:-origin/main}"
WORK="$(mktemp -d)"
# REHEARSAL_KEEP=1 preserves the sealed prefix so the transcripts outlive the run —
# needed whenever the answer is "nothing fired", which is indistinguishable from
# "the harness died early" until you can read the transcript.
if [[ -z ${REHEARSAL_KEEP:-} ]]; then trap 'rm -rf "$WORK"' EXIT; fi

# ── the sealed prefix ─────────────────────────────────────────────────────────
# $1 = run label, $2 = path to the setup-catalyst.sh under test
run_sealed() {
  local label="$1" setup="$2"
  local root="$WORK/$label"
  rm -rf "$root"
  mkdir -p "$root/home" "$root/dl" "$root/stubs" "$root/proj"

  # The documented layout, exactly: ONE file in the directory you run from.
  cp "$setup" "$root/dl/setup-catalyst.sh"
  chmod +x "$root/dl/setup-catalyst.sh"

  local log="$root/invocations.log"
  : > "$log"

  # Recording stubs. `git clone` copies this checkout instead of hitting the network,
  # so the bootstrap-clone path is exercised for real and the helpers it lands are the
  # real ones — then those helpers are themselves shadowed by stubs below.
  cat > "$root/stubs/git" <<STUB
#!/usr/bin/env bash
echo "git \$*" >> "$log"
if [[ "\$1" == "clone" ]]; then
  dest="\${@: -1}"
  mkdir -p "\$dest"
  /bin/cp -R "$REPO_ROOT/plugins" "\$dest/" 2>/dev/null
  /bin/cp "$REPO_ROOT/setup-catalyst.sh" "\$dest/" 2>/dev/null
  echo "CLONE-PLANTED \$dest" >> "$log"
  exit 0
fi
case "\$1" in
  rev-parse)
    # --git-dir and --show-toplevel both point at the sealed project dir
    case "\$2" in --git-dir) echo "$root/proj/.git" ;; *) echo "$root/proj" ;; esac
    exit 0 ;;
  config)
    # A plausible GitHub remote. Returning empty here stops setup at
    # "Cannot detect GitHub org/repo" — i.e. the whole rehearsal reports
    # "nothing fired" for a reason that has nothing to do with what it measures.
    case "\$*" in *remote.origin.url*) echo "https://github.com/acme-widgets/widget.git" ;; *) echo "" ;; esac
    exit 0 ;;
esac
exit 0
STUB

  # The four helper scripts whose invocation is the whole question. Shadowing them by
  # NAME on PATH is not enough — setup calls them by absolute path — so they are
  # planted over the cloned tree after the clone stub runs. Done via a wrapper on
  # `bash` that records any invocation of a helper path and returns success.
  cat > "$root/stubs/bash" <<STUB
#!/bin/bash
for a in "\$@"; do
  case "\$a" in
    */install-orphan-sweep.sh)          echo "HELPER install-orphan-sweep.sh" >> "$log"; exit 0 ;;
    */setup-execution-core-states.sh)   echo "HELPER setup-execution-core-states.sh" >> "$log"; exit 0 ;;
    */setup-plugin-source.sh)           echo "HELPER setup-plugin-source.sh" >> "$log"; exit 0 ;;
    */install-cli.sh)                   echo "HELPER install-cli.sh" >> "$log"; exit 0 ;;
  esac
done
exec /bin/bash "\$@"
STUB

  for c in launchctl humanlayer linearis claude curl gh sqlite3 bun node npm brew; do
    cat > "$root/stubs/$c" <<STUB
#!/bin/bash
echo "$c \$*" >> "$log"
exit 0
STUB
  done
  chmod +x "$root/stubs/"*

  # `--no-clone-source` is deliberately NOT passed: cloning is the documented path's
  # only route to the helpers, so suppressing it would rehearse a different install.
  ( cd "$root/dl" && env -i \
      HOME="$root/home" \
      PATH="$root/stubs:/usr/bin:/bin:/usr/sbin:/sbin" \
      TERM=dumb \
      CATALYST_FORCE_OS=Darwin \
      PROJECT_DIR="$root/proj" \
      /bin/bash ./setup-catalyst.sh --non-interactive ) > "$root/transcript.txt" 2>&1
  echo "$?" > "$root/rc"
  echo "$root"
}

probe() { # label, human-readable question, grep pattern
  local root="$1" q="$2" pat="$3"
  if grep -qF -- "$pat" "$root/invocations.log" 2>/dev/null; then echo "  FIRED     $q"; else echo "  did-not   $q"; fi
}

echo "═══════════════════════════════════════════════════════════════"
echo " Documented-path rehearsal — sealed prefix, --non-interactive"
echo " repo:     $REPO_ROOT"
echo " baseline: $BASELINE_REF"
echo "═══════════════════════════════════════════════════════════════"

git -C "$REPO_ROOT" show "${BASELINE_REF}:setup-catalyst.sh" > "$WORK/baseline-setup.sh" 2>/dev/null || {
  echo "cannot read ${BASELINE_REF}:setup-catalyst.sh — is the ref fetched?"; exit 2; }

BASE_ROOT="$(run_sealed baseline "$WORK/baseline-setup.sh")"
HEAD_ROOT="$(run_sealed working  "$REPO_ROOT/setup-catalyst.sh")"

for pair in "BASELINE (${BASELINE_REF}):$BASE_ROOT" "WORKING TREE:$HEAD_ROOT"; do
  label="${pair%%:*}"; root="${pair#*:}"
  echo ""
  echo "── $label ── exit rc=$(cat "$root/rc" 2>/dev/null)"
  probe "$root" "orphan-sweep scheduler installed"        "HELPER install-orphan-sweep.sh"
  probe "$root" "Linear state contract provisioned"       "HELPER setup-execution-core-states.sh"
  probe "$root" "plugin-source provisioned"               "HELPER setup-plugin-source.sh"
  probe "$root" "catalyst-* CLIs installed"               "HELPER install-cli.sh"
  probe "$root" "a source tree was obtained (clone)"      "CLONE-PLANTED"
done

echo ""
echo "── deferred-step ledger, working tree ──"
# The ledger body contains blank lines, so a /^$/ range terminator truncates it to
# the header — printing "1 step(s) were DEFERRED" and then nothing, which reads as a
# tool that lost the answer. Take everything from the header to the end instead.
if grep -q "No steps were deferred" "$HEAD_ROOT/transcript.txt"; then
  grep "No steps were deferred" "$HEAD_ROOT/transcript.txt"
else
  sed -n '/were DEFERRED/,$p' "$HEAD_ROOT/transcript.txt" | head -30
fi
echo ""
echo "transcripts: $BASE_ROOT/transcript.txt  |  $HEAD_ROOT/transcript.txt"
echo "(the temp prefix is removed on exit — copy them now if you need them)"
