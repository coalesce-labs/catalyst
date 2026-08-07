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
echo "$P passed, $F failed"; [[ $F -eq 0 ]]
