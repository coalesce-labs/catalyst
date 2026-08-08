#!/usr/bin/env bash
set -uo pipefail
ROOT="$(mktemp -d -t worktree-resolve-test-XXXXXX)"; trap 'rm -rf "$ROOT"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/worktree-resolve.sh"; source "$LIB"
P=0; F=0
ok() { P=$((P+1)); echo "PASS: $1"; }; bad() { F=$((F+1)); echo "FAIL: $1"; }
eq() { [[ $1 == "$2" ]] && ok "$3" || bad "$3 (expected $1 got $2)"; }
REPO="$ROOT/repo"; git init -q -b main "$REPO"; (cd "$REPO" && touch seed && git add seed && git commit -qm seed && git branch CAT-100 && git branch CAT-1000)
WT="$ROOT/wt"; git -C "$REPO" worktree add -q "$WT" CAT-100
mkdir -p "$ROOT/catalyst/execution-core" "$ROOT/unrelated"; printf '{"projects":[{"team":"CAT","repoRoot":"%s"}]}' "$REPO" > "$ROOT/catalyst/execution-core/registry.json"
export CATALYST_DIR="$ROOT/catalyst"
capture() { local dir="$1" ticket="$2" explicit="${3:-}" tmp="$ROOT/out"; (cd "$dir" && resolve_ticket_worktree "$ticket" "$explicit" > "$tmp" && printf '%s' "$WT_RESOLVE_SOURCE" > "$tmp.source"); out="$(cat "$tmp")"; source_value="$(cat "$tmp.source")"; }
capture "$ROOT/unrelated" CAT-100 "$WT"; eq "$(cd "$WT" && pwd -P)" "$out" "explicit path"; eq explicit "$source_value" "explicit source"
capture "$ROOT/unrelated" CAT-100; eq "$(cd "$WT" && pwd -P)" "$out" "registry path"; eq registry "$source_value" "registry source"
capture "$ROOT/unrelated" CAT-999; eq "$(cd "$ROOT/unrelated" && pwd -P)" "$out" "fallback path"; eq fallback-cwd "$source_value" "fallback source"
CATALYST_DIR="$ROOT/missing" capture "$REPO" CAT-100; eq "$(cd "$WT" && pwd -P)" "$out" "cwd repo rung"; eq cwd-repo "$source_value" "cwd repo source"
printf '{' > "$ROOT/catalyst/execution-core/registry.json"; capture "$ROOT/unrelated" CAT-100; eq "$(cd "$ROOT/unrelated" && pwd -P)" "$out" "malformed registry"
eq CAT "$(_wtr_team_of CAT-31)" "team derivation"

# ─── CAT-31 review P1s ──────────────────────────────────────────────────────
printf '{"projects":[{"team":"CAT","repoRoot":"%s"}]}' "$REPO" > "$ROOT/catalyst/execution-core/registry.json"

# P1: a stale/mistyped --worktree must fall through to the by-ticket rungs
# instead of silently returning the caller's unrelated cwd.
capture "$ROOT/unrelated" CAT-100 "$ROOT/does-not-exist"
eq "$(cd "$WT" && pwd -P)" "$out" "stale explicit falls through to registry"
eq registry "$source_value" "stale explicit resolves by ticket, not cwd"

# ...and when NOTHING resolves by ticket it still reports explicit-missing so
# CATALYST_DISPATCH_WORKTREE_STRICT=1 keeps refusing the dispatch.
capture "$ROOT/unrelated" CAT-999 "$ROOT/does-not-exist"
eq "$(cd "$ROOT/unrelated" && pwd -P)" "$out" "unresolvable stale explicit falls back to cwd"
eq explicit-missing "$source_value" "unresolvable stale explicit keeps strict-mode source"

# P1: a legacy "<orch-id>-<ticket>" worktree that is ALREADY correct must not be
# redirected into the same-ticket execution-core checkout by the registry rung.
LEGACY="$ROOT/legacy-CAT-100"
(cd "$REPO" && git branch orch7-CAT-100)
git -C "$REPO" worktree add -q "$LEGACY" orch7-CAT-100
capture "$LEGACY" CAT-100
eq "$(cd "$LEGACY" && pwd -P)" "$out" "legacy worktree keeps its own cwd"
eq cwd-serves-ticket "$source_value" "legacy worktree source"

# The ticket-named worktree is likewise kept in place (same rung, no redirect).
capture "$WT" CAT-100
eq "$(cd "$WT" && pwd -P)" "$out" "ticket worktree keeps its own cwd"
eq cwd-serves-ticket "$source_value" "ticket worktree source"

# A worktree serving a DIFFERENT ticket must still be redirected by the registry —
# the keep-cwd rung is scoped to the ticket being dispatched, not to any worktree.
WT1000="$ROOT/wt-CAT-1000"; git -C "$REPO" worktree add -q "$WT1000" CAT-1000
capture "$LEGACY" CAT-1000
eq "$(cd "$WT1000" && pwd -P)" "$out" "cwd serving another ticket still redirects"
eq registry "$source_value" "redirect uses the registry rung"

# The ticket suffix must match on a boundary: CAT-100 must not satisfy CAT-1000.
_wtr_branch_serves_ticket orch7-CAT-100 CAT-1000 && bad "CAT-100 must not serve CAT-1000" || ok "ticket suffix matches on a boundary"
echo "$P passed, $F failed"; [[ $F -eq 0 ]]
