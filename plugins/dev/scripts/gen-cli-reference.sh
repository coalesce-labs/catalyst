#!/usr/bin/env bash
# gen-cli-reference.sh — CTL-1387. Generate the consolidated catalyst CLI
# reference page (website/src/content/docs/reference/catalyst-cli.md) from a
# curated in-script manifest covering every tool in install-cli.sh's CLI_ENTRIES.
#
# For the SAFE subset (scrapeable=1) it scrapes `<tool> --help 2>&1` (never bare,
# always under a timeout) to fill the "Key subcommands" line; for the unsafe ~9
# stdin/daemon/TUI/backup hooks (scrapeable=0) it emits the curated purpose only
# and NEVER invokes them. A single scrape miss never fails the generator.
#
# Usage:
#   gen-cli-reference.sh                 # print the page to stdout (pure; no write)
#   gen-cli-reference.sh --write         # write the page to its canonical path
#   gen-cli-reference.sh --list-manifest # print the raw manifest (name|cat|scrape|purpose)
#   gen-cli-reference.sh --help
#
# The page carries a DO-NOT-EDIT header — regenerate it instead of hand-editing.
# The CI drift test (__tests__/cli-reference-drift.test.sh) keeps the committed
# page, this manifest, and CLI_ENTRIES in lock-step.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # plugins/dev/scripts
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
INSTALL_CLI="${SCRIPT_DIR}/install-cli.sh"
PAGE="${REPO_ROOT}/website/src/content/docs/reference/catalyst-cli.md"
GH_BLOB="https://github.com/coalesce-labs/catalyst/blob/main"

# ── Manifest ────────────────────────────────────────────────────────────────
# One row per installed CLI: name|category|scrapeable|purpose
# - name      : the installed command name (the part after the colon in CLI_ENTRIES)
# - category  : a display group (rendered as a "## <category>" section, in the
#               CATEGORY_ORDER below)
# - scrapeable: 1 → safe to run `<tool> --help 2>&1` for subcommands; 0 → unsafe
#               (no --help handler and/or bare invocation reads stdin / execs a
#               daemon / TUI / writes a backup) → curated purpose only, never run.
# - purpose   : one-line description (copied from each tool's source header).
# Keep in lock-step with install-cli.sh CLI_ENTRIES (cli-reference-drift.test.sh).
manifest() {
  cat <<'EOF'
catalyst-broker|Daemons|1|Manage the Catalyst event broker daemon (agent identity, ticket↔PR correlation, ticket_lifecycle routing).
catalyst-execution-core|Daemons|1|Manage the execution-core composing daemon (Todo-state monitor + pull-loop scheduler + recovery contract).
catalyst-monitor|Daemons|1|On-demand orch-monitor web-dashboard server management.
catalyst-otel-forward|Daemons|1|Entry wrapper for the otel-forward daemon (forwards OTel telemetry).
catalyst-events|Event & comms|1|Tail and wait-for primitives over the global append-only event log.
catalyst-comms|Event & comms|1|File-based JSONL agent communication channels (no HTTP, no server).
catalyst-filter|Event & comms|1|DEPRECATED alias for catalyst-broker (delegates so legacy callers keep working).
catalyst-why|Event & comms|1|Explain why the daemon believes a worker is alive, stuck, or dead (belief→rule→facts trace).
catalyst-transitions|Event & comms|0|Live, human-readable Linear-state + phase transition log (tails the event stream — bare runs forever).
catalyst-session|Session & state|1|Lifecycle CLI for Catalyst agent sessions (start/phase/metric/tool/pr → SQLite + event log).
catalyst-state|Session & state|1|Manage global orchestrator state at ~/catalyst/state.json (flock-protected RMW + event log).
catalyst-db|Session & state|1|SQLite-backed durable session store for agent runs (init/migrate, sessions, events, metrics).
workflow-context|Session & state|1|Workflow context management utilities (recent docs, orchestration pointers, skill chaining).
catalyst-thoughts|Thoughts|1|Repair and verify the HumanLayer thoughts system for a Catalyst project.
register-thought|Thoughts|0|PostToolUse Write hook that auto-registers thoughts/shared writes (reads hook JSON on stdin).
thoughts-pull-sync|Thoughts|0|Fast-forward every HumanLayer thoughts checkout so cross-host research reads fresh peer state.
catalyst-cluster|Cluster & Linear|1|Cluster administration — join tokens, roster, drain, concurrency tuning.
catalyst-linear-reconcile|Cluster & Linear|1|Reconcile Linear ticket state from PR reality (merged→Done, open→In-Review); report or --write.
catalyst-statusline|HUD & display|0|Claude Code statusLine wrapper that also emits session.context events (reads JSON on stdin each tick).
catalyst-hud|HUD & display|0|Ink TUI for the catalyst event stream (bare invocation starts the full-screen TUI).
catalyst-hud-classic|HUD & display|0|Color-coded terminal HUD for the event stream (minimal-deps fallback; bare runs forever).
catalyst|Umbrella & lifecycle|1|The single front-door router for the Catalyst toolchain (git-style dispatch to every catalyst-* tool).
catalyst-stack|Umbrella & lifecycle|1|Bring the Catalyst service stack up or down on this host (idempotent, dependency-ordered).
catalyst-install|Umbrella & lifecycle|1|Provision or tear down this node for its class (composes setup scripts; install/uninstall/reinstall).
catalyst-doctor|Umbrella & lifecycle|1|Fail-closed activation gate — class-aware health/activation grade (exit 0 ⇒ safe to activate).
catalyst-backup|Umbrella & lifecycle|0|Capture / restore a node's restorable identity + state bundle (bare backup writes a secrets bundle).
catalyst-claude|Umbrella & lifecycle|0|Wrapper that registers a Catalyst session around claude, then execs the interactive claude process.
emit-lifecycle-event|Hooks|0|Claude Code Stop/SubagentStop hook — fallback agent.checkout emitter for the broker.
EOF
}

# Section render order (categories not listed here are appended alphabetically).
CATEGORY_ORDER=(
  "Daemons"
  "Event & comms"
  "Session & state"
  "Thoughts"
  "Cluster & Linear"
  "HUD & display"
  "Umbrella & lifecycle"
  "Hooks"
)

# ── install-cli.sh CLI_ENTRIES parsing (source name → repo-relative path) ─────
# Echoes "src:dest" lines from the CLI_ENTRIES array block.
cli_entries() {
  sed -n '/^CLI_ENTRIES=(/,/^)/p' "$INSTALL_CLI" |
    grep -oE '"[^"]+"' | tr -d '"'
}

# Map an installed name → its repo-relative source path (for the GitHub link).
src_relpath_for() {
  local want="$1" entry src dest
  while IFS= read -r entry; do
    src="${entry%%:*}"
    dest="${entry##*:}"
    if [[ "$dest" == "$want" ]]; then
      case "$src" in
        ../*) echo "plugins/dev/${src#../}" ;; # ../hooks/foo.sh → plugins/dev/hooks/foo.sh
        *) echo "plugins/dev/scripts/${src}" ;;
      esac
      return 0
    fi
  done < <(cli_entries)
  return 1
}

# Map an installed name → its source name (the file under scripts/ to scrape).
src_name_for() {
  local want="$1" entry src dest
  while IFS= read -r entry; do
    src="${entry%%:*}"
    dest="${entry##*:}"
    [[ "$dest" == "$want" ]] && {
      echo "$src"
      return 0
    }
  done < <(cli_entries)
  return 1
}

# Run a command under a wall-clock cap. Prefers GNU `timeout`/`gtimeout`; falls
# back to a plain run when neither exists (e.g. a stock macOS dev box). The
# fallback is safe here because scrape_help only ever runs the scrapeable=1
# subset, all of which have a fast, non-blocking `--help` that exits.
run_capped() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    "$@"
  fi
}

# ── --help scrape (safe subset only; never bare, always timed, never fatal) ──
# Echoes a space-separated list of subcommand tokens, or nothing on any miss.
scrape_help() {
  local src="$1" path out
  path="${SCRIPT_DIR}/${src}"
  [[ -f "$path" ]] || return 0
  out="$(run_capped 10 bash "$path" --help 2>&1)" || return 0
  # Grab the first token of each indented line in the Commands/Subcommands/Verbs
  # block. Keep only pure-lowercase verb tokens ([a-z][a-z0-9_-]*) so wrapped
  # description continuations ("Usage:", "Resolves", capitalized prose, flags)
  # are filtered out. Best-effort: this cell is a convenience, not a gated value.
  printf '%s\n' "$out" |
    awk '
      tolower($0) ~ /^(commands|subcommands|verbs):/ { grab=1; next }
      grab && NF==0 { grab=0 }
      grab && $0 ~ /^[[:space:]]+[a-z][a-z0-9_-]*([[:space:]]|$)/ {
        gsub(/^[[:space:]]+/,""); print $1
      }
    ' | awk '/^[a-z][a-z0-9_-]*$/ && !seen[$0]++' | head -10 | tr '\n' ' '
}

# Format a scraped token list as inline-code, comma-separated.
fmt_subcommands() {
  local tokens="$1" out="" t
  for t in $tokens; do
    [[ -n "$out" ]] && out+=", "
    out+="\`${t}\`"
  done
  echo "$out"
}

# ── Page renderer ────────────────────────────────────────────────────────────
render_page() {
  local total
  total="$(manifest | grep -c .)"

  cat <<EOF
---
title: catalyst CLI reference
description: Consolidated reference for every catalyst-* command-line tool installed by install-cli.sh — purpose plus key subcommands.
sidebar:
  order: 5
---

<!-- DO NOT EDIT — generated by plugins/dev/scripts/gen-cli-reference.sh.
     Regenerate with \`bash plugins/dev/scripts/gen-cli-reference.sh --write\`.
     The tool list is sourced from install-cli.sh CLI_ENTRIES and guarded by
     __tests__/cli-reference-drift.test.sh — do not hand-edit. -->

Every \`catalyst-*\` CLI is installed onto your \`PATH\` by
[\`install-cli.sh\`](${GH_BLOB}/plugins/dev/scripts/install-cli.sh) (into
\`~/.catalyst/bin\` by default). This page lists all ${total} of them — one line of
purpose plus the key subcommands — grouped by area. Run any tool with \`--help\`
for full syntax. The richer tools have their own reference pages (e.g.
[catalyst-stack](/reference/catalyst-stack/)).
EOF

  local cat
  for cat in "${CATEGORY_ORDER[@]}"; do
    render_category "$cat"
  done

  # Any category present in the manifest but absent from CATEGORY_ORDER
  # (defensive — keeps a newly-added group from silently disappearing).
  local known extra
  known="$(printf '%s\n' "${CATEGORY_ORDER[@]}")"
  while IFS= read -r extra; do
    grep -qxF "$extra" <<<"$known" || render_category "$extra"
  done < <(manifest | cut -d'|' -f2 | awk '!seen[$0]++')
}

render_category() {
  local want="$1" line name cat scrape purpose
  local printed_header=0
  while IFS='|' read -r name cat scrape purpose; do
    [[ -z "$name" ]] && continue
    [[ "$cat" == "$want" ]] || continue
    if [[ "$printed_header" -eq 0 ]]; then
      printf '\n## %s\n' "$want"
      printed_header=1
    fi
    render_tool "$name" "$scrape" "$purpose"
  done < <(manifest)
}

render_tool() {
  local name="$1" scrape="$2" purpose="$3"
  local relpath subname tokens subline=""

  relpath="$(src_relpath_for "$name" || true)"

  if [[ "$scrape" == "1" ]]; then
    subname="$(src_name_for "$name" || true)"
    if [[ -n "$subname" ]]; then
      tokens="$(scrape_help "$subname" || true)"
      if [[ -n "$tokens" ]]; then
        subline="$(fmt_subcommands "$tokens")"
      fi
    fi
  fi

  printf '\n### %s\n\n' "$name"
  printf '%s\n' "$purpose"
  if [[ -n "$subline" ]]; then
    printf '\n**Key subcommands:** %s\n' "$subline"
  elif [[ "$scrape" == "1" ]]; then
    printf '\n**Key subcommands:** _(run `%s --help`)_\n' "$name"
  fi
  if [[ -n "$relpath" ]]; then
    printf '\n[Source](%s/%s)\n' "$GH_BLOB" "$relpath"
  fi
}

# ── CLI ──────────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
Usage: gen-cli-reference.sh [--write] [--list-manifest] [--help]

  (no args)         Print the generated catalyst CLI reference page to stdout.
  --write           Write the page to website/src/content/docs/reference/catalyst-cli.md.
  --list-manifest   Print the raw manifest rows (name|category|scrapeable|purpose).
  --help, -h        Show this help.
EOF
}

main() {
  case "${1:-}" in
    --help | -h)
      usage
      exit 0
      ;;
    --list-manifest)
      manifest
      exit 0
      ;;
    --write)
      mkdir -p "$(dirname "$PAGE")"
      render_page >"$PAGE"
      echo "Wrote $PAGE" >&2
      exit 0
      ;;
    "")
      render_page
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
