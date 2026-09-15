#!/usr/bin/env bash
# review-scope.sh — CTL-2309. Compute the review scope for review-code / review-security.
#
# The runner computes a validate session's scope (a base ref `refs/catalyst/validate-base` and
# a changed-file list); a hand-run session names a base itself. Either way the review is of
# `git diff <base> HEAD` bounded to that list — never the whole tree — and the three non-review
# outcomes are decided HERE, deterministically, so a session never guesses them:
#
#   status: review        exit 0   at least one code file changed against a resolved base
#   status: skipped       exit 3   the bounded diff is empty, or touches only non-code files
#   status: unavailable   exit 4   no base can be resolved (no argument and no planted ref, an
#                                  unknown ref, or no repository here) — never a guessed base
#   usage error           exit 2
#
# Usage: review-scope.sh [--base <ref-or-sha> | <ref-or-sha>] [--files <list-file>] [--help]
#   --base   a ref or sha. A branch name resolves to its MERGE-BASE with HEAD (the fork point),
#            never to the branch tip. Default: refs/catalyst/validate-base.
#   --files  the caller's changed-file list, one repo-relative path per line. The diff is bounded
#            to it; a listed path the diff never touched is counted under `not_in_diff`.
#   When the arguments arrive as ONE word (the SKILL.md's "$SKILL_ARGS"), quote a path that
#   contains spaces inside it: --files '/tmp/my list.txt'.
#
# Identical copies live in review-code/scripts and review-security/scripts: a skill runs from its
# own directory on every harness (CTL-2306), so it cannot reach a sibling's file. Bash-3.2 safe.
set -uo pipefail

DEFAULT_BASE="refs/catalyst/validate-base"

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

emit_unavailable() {
  printf 'status: unavailable\nreason: %s\n' "$1"
  exit 4
}

# The SKILL.md hands the whole argument text over as ONE word ("$SKILL_ARGS"; zsh would not
# word-split it anyway). Re-split it here, PRESERVING quotes so `--files '/tmp/my list.txt'`
# stays one path: `eval` does that, and is safe only because the text is first restricted to
# characters that cannot start a command, expansion or redirection. A literal `$ARGUMENTS`
# token (a harness that did not substitute it) is no argument at all.
if [ $# -eq 1 ]; then
  case "$1" in
    '$ARGUMENTS'|'') set -- ;;
    *[[:space:]]*)
      one="$(printf '%s' "$1" | tr '\n\t' '  ')"
      case "$one" in
        *[!A-Za-z0-9_./=:~@+,%\ \'\"-]*)
          echo "review-scope: refusing to re-split an argument word with shell-significant characters: $one" >&2
          echo "review-scope: pass each argument separately (--base <ref> --files <list-file>)" >&2
          exit 2 ;;
      esac
      eval "set -- $one" ;;
  esac
fi

BASE_INPUT=""
LIST_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --base) shift; [ $# -gt 0 ] || { echo "review-scope: --base needs a value" >&2; exit 2; }; BASE_INPUT="$1" ;;
    --base=*) BASE_INPUT="${1#--base=}" ;;
    --files) shift; [ $# -gt 0 ] || { echo "review-scope: --files needs a value" >&2; exit 2; }; LIST_FILE="$1" ;;
    --files=*) LIST_FILE="${1#--files=}" ;;
    --) shift; break ;;
    -*) echo "review-scope: unknown option: $1" >&2; usage >&2; exit 2 ;;
    # Claude Code substitutes a skill's $ARGUMENTS token; another harness leaves it literal, and
    # an empty invocation leaves nothing. Neither names a base.
    '$ARGUMENTS'|'') ;;
    *) if [ -n "$BASE_INPUT" ]; then echo "review-scope: more than one base given: $BASE_INPUT, $1" >&2; exit 2; fi; BASE_INPUT="$1" ;;
  esac
  shift
done

if [ -n "$LIST_FILE" ] && [ ! -r "$LIST_FILE" ]; then
  echo "review-scope: --files list is not readable: $LIST_FILE" >&2; exit 2
fi

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  emit_unavailable "not inside a git repository ($(pwd))"
fi
HEAD_SHA="$(git rev-parse --verify HEAD^{commit} 2>/dev/null)" || emit_unavailable "HEAD does not resolve to a commit (empty repository?)"

BASE_NAME="${BASE_INPUT:-$DEFAULT_BASE}"
BASE_TIP="$(git rev-parse --verify --quiet "${BASE_NAME}^{commit}" 2>/dev/null)" || true
if [ -z "$BASE_TIP" ]; then
  if [ -z "$BASE_INPUT" ]; then
    emit_unavailable "no base given and ${DEFAULT_BASE} is not planted in this repository — pass an explicit base"
  fi
  emit_unavailable "base '${BASE_INPUT}' does not resolve to a commit"
fi

# A branch name or a moved ref must review the FORK POINT, never the tip. When the merge-base can be
# computed the base is that; when it cannot (a shallow clone whose history stops short) the given
# commit is used as-is and the scope is marked unproven, the same distinction the runner draws.
ANCESTRY="unproven"
BASE_SHA="$BASE_TIP"
if MB="$(git merge-base "$BASE_TIP" "$HEAD_SHA" 2>/dev/null)" && [ -n "$MB" ]; then
  BASE_SHA="$MB"
  ANCESTRY="proven"
fi

is_non_code() {
  # Docs, images, fonts, lockfiles: a diff of only these has nothing for a code or security review.
  # Markdown under a BEHAVIOURAL path is not docs: a SKILL.md, an agent definition, AGENTS.md or
  # CLAUDE.md, and anything under .agents/ or .claude/ is what an agent executes (Codex P1 on
  # #4144). Only plain documentation is skippable.
  local p="$1" b
  b="$(basename "$p")"
  case "$b" in SKILL.md|AGENTS.md|CLAUDE.md) return 1 ;; esac
  case "$p" in
    plugins/*/skills/*|plugins/*/agents/*|plugins/*/*/skills/*|plugins/*/*/agents/*|.agents/*|.claude/*|*/.agents/*|*/.claude/*) return 1 ;;
  esac
  case "$(printf '%s' "$b" | tr '[:upper:]' '[:lower:]')" in
    *.md|*.mdx|*.markdown|*.txt|*.rst|*.adoc|*.png|*.jpg|*.jpeg|*.gif|*.ico|*.webp|*.pdf|*.woff|*.woff2|*.ttf|*.eot|*.snap) return 0 ;;
    bun.lock|bun.lockb|package-lock.json|yarn.lock|pnpm-lock.yaml|cargo.lock|gemfile.lock|poetry.lock|uv.lock|go.sum|composer.lock) return 0 ;;
    license|license.*|changelog|changelog.*) return 0 ;;
  esac
  return 1
}

# The diff, NUL-delimited so a path carrying a newline stays one entry. Renames arrive as
# R<score> old NUL new: the review reads the NEW path.
DIFF_TMP="$(mktemp)"
trap 'rm -f "$DIFF_TMP"' EXIT
if ! git -c core.quotePath=false diff --name-status -z --no-renames "$BASE_SHA" "$HEAD_SHA" > "$DIFF_TMP" 2>/dev/null; then
  emit_unavailable "git diff ${BASE_SHA} ${HEAD_SHA} failed"
fi

list_has() {
  # Exact-line match against the caller's list.
  [ -n "$LIST_FILE" ] || return 0
  grep -qxF -- "$1" "$LIST_FILE"
}

CODE_FILES=""
NON_CODE_FILES=""
CODE_N=0
NON_CODE_N=0
CHANGED_N=0
BOUNDED_OUT=0
NEWLINE_PATH=""
while IFS= read -r -d '' st && IFS= read -r -d '' path; do
  CHANGED_N=$((CHANGED_N+1))
  # The scope below is newline-delimited (the files: block, the --files list, the diff command).
  # A git-valid path carrying a newline cannot ride it faithfully, and a quietly split path would
  # make the mandated diff_command diff the wrong files (Codex P2 on #4144): refuse, by name.
  case "$path" in *"
"*) NEWLINE_PATH="$(printf '%s' "$path" | tr '\n' '?')" ;; esac
  if ! list_has "$path"; then BOUNDED_OUT=$((BOUNDED_OUT+1)); continue; fi
  if is_non_code "$path"; then
    NON_CODE_N=$((NON_CODE_N+1))
    NON_CODE_FILES="${NON_CODE_FILES}  ${st} ${path}
"
  else
    CODE_N=$((CODE_N+1))
    CODE_FILES="${CODE_FILES}  ${st} ${path}
"
  fi
done < "$DIFF_TMP"
if [ -n "$NEWLINE_PATH" ]; then
  emit_unavailable "a changed path contains a newline and cannot be scoped faithfully: ${NEWLINE_PATH} (newline shown as ?)"
fi

NOT_IN_DIFF=0
if [ -n "$LIST_FILE" ]; then
  while IFS= read -r listed || [ -n "$listed" ]; do
    [ -n "$listed" ] || continue
    if ! git -c core.quotePath=false diff --name-only "$BASE_SHA" "$HEAD_SHA" -- "$listed" 2>/dev/null | grep -qxF -- "$listed"; then
      NOT_IN_DIFF=$((NOT_IN_DIFF+1))
    fi
  done < "$LIST_FILE"
fi

IN_SCOPE_N=$((CODE_N+NON_CODE_N))
STATUS="review"
REASON=""
RC=0
if [ "$IN_SCOPE_N" -eq 0 ]; then
  STATUS="skipped"; RC=3
  if [ "$CHANGED_N" -eq 0 ]; then
    REASON="empty diff: ${BASE_SHA} and HEAD ${HEAD_SHA} have no changed files"
  else
    REASON="empty scope: the ${CHANGED_N} changed file(s) are all outside the --files list"
  fi
elif [ "$CODE_N" -eq 0 ]; then
  STATUS="skipped"; RC=3
  REASON="non-code only: the ${NON_CODE_N} changed file(s) in scope are docs, images or lockfiles"
else
  REASON="${CODE_N} code file(s) changed against ${BASE_SHA}"
fi

printf 'status: %s\n' "$STATUS"
printf 'reason: %s\n' "$REASON"
printf 'base_input: %s\n' "$BASE_NAME"
printf 'base: %s\n' "$BASE_SHA"
printf 'ancestry: %s\n' "$ANCESTRY"
printf 'head: %s\n' "$HEAD_SHA"
printf 'changed: %s\n' "$CHANGED_N"
printf 'code: %s\n' "$CODE_N"
printf 'non_code: %s\n' "$NON_CODE_N"
if [ -n "$LIST_FILE" ]; then
  printf 'bounded_to_list: yes\n'
  printf 'outside_list: %s\n' "$BOUNDED_OUT"
  printf 'not_in_diff: %s\n' "$NOT_IN_DIFF"
else
  printf 'bounded_to_list: no\n'
fi
if [ "$STATUS" = "review" ]; then
  # One diff, bounded to the code files in scope — the thing the review reads.
  args=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    args="${args} '$(printf '%s' "${line#  ? }" | sed "s/'/'\\\\''/g")'"
  done <<EOF_FILES
${CODE_FILES}
EOF_FILES
  printf 'diff_command: git -c core.quotePath=false diff %s HEAD --%s\n' "$BASE_SHA" "$args"
fi
printf 'files:\n%s' "$CODE_FILES"
if [ "$NON_CODE_N" -gt 0 ]; then
  printf 'non_code_files:\n%s' "$NON_CODE_FILES"
fi
exit "$RC"
