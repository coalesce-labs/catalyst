#!/usr/bin/env bash
# lib/draft-pr.sh — CTL-709. Shared helpers for opening/promoting draft PRs.
# All functions are fail-open (log stderr, return non-zero) and idempotent.
# POSIX/zsh-safe: no ${VAR,,}, no shopt, no ${BASH_SOURCE[0]} at top-level.
#
# Exported functions:
#   draft_pr_push                 — push current branch to origin (idempotent, fail-open)
#   draft_pr_push_verify          — push + prove origin==HEAD; fail-closed; rc=3 when
#                                   the push is rejected for missing 'workflow' OAuth scope
#                                   and no CATALYST_WORKFLOW_GITHUB_TOKEN is configured
#   draft_pr_push_token TOKEN ... — push using an explicit PAT, bypassing GITHUB_TOKEN
#   draft_pr_diff_touches_workflows BASE — 0 iff origin/<BASE>...HEAD adds/modifies a
#                                   .github/workflows/ file (CTL-1119)
#   draft_pr_ensure BASE TICKET   — ensure a draft PR exists; echoes NUM<TAB>URL<TAB>ISDRAFT
#   draft_pr_promote              — promote current branch's PR from draft to ready
#   draft_pr_enabled              — read .catalyst/config.json knob (default true)
#
# Reserved return codes:
#   3 — draft_pr_push_verify: push rejected for missing 'workflow' OAuth scope and no
#       CATALYST_WORKFLOW_GITHUB_TOKEN fallback. Callers translate this into a MANUAL
#       explanation.call_to_action escalation. (CTL-1119/CTL-1130)

_draft_pr_warn() {
  printf 'draft-pr: %s\n' "$*" >&2
}

# Reserved return code for a workflow-scope push rejection (CTL-1119).
_DRAFT_PR_WORKFLOW_SCOPE_RC=3

# _draft_pr_is_workflow_scope_error FILE — returns 0 iff FILE contains the
# GitHub workflow-scope OAuth rejection message. Matches the stable prefix
# "refusing to allow" combined with "workflow" (case-insensitive).
_draft_pr_is_workflow_scope_error() {
  local errfile="$1"
  [[ -f "$errfile" ]] || return 1
  grep -qi 'refusing to allow' "$errfile" && grep -qi 'workflow' "$errfile"
}

# draft_pr_diff_touches_workflows BASE — returns 0 iff the diff from
# origin/<BASE> to HEAD adds or modifies a .github/workflows/ file.
# Falls back to comparing HEAD only when origin/<BASE> is not resolvable.
draft_pr_diff_touches_workflows() {
  local base="${1:-}"; [[ -z "$base" ]] && base="$(_draft_pr_default_base)"
  local range
  if git rev-parse "origin/${base}" >/dev/null 2>&1; then
    range="origin/${base}...HEAD"
  else
    range="HEAD"
  fi
  git diff --name-only "$range" 2>/dev/null | grep -q '^\.github/workflows/'
}

# draft_pr_push_token TOKEN [git push args...] — push using TOKEN as the GitHub
# credential, bypassing the ambient GITHUB_TOKEN / gh credential helper.
# Uses per-invocation GIT_CONFIG_* env vars — never mutates persistent config. (CTL-1119)
#
# The token is handed to the credential helper via the CATALYST_WF_TOK
# environment variable, NOT interpolated into the helper string. git executes a
# `!`-prefixed credential helper through `sh -c`, so a token containing a
# double-quote plus shell metacharacters interpolated into the printf argument
# would break out of the quoting and run arbitrary commands. Env-indirection
# means the helper's `sh` expands $CATALYST_WF_TOK at runtime and never
# re-parses the secret's bytes as shell. (CTL-1119 phase-review remediation)
draft_pr_push_token() {
  local token="$1"; shift
  GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0="credential.https://github.com.helper" GIT_CONFIG_VALUE_0="" \
  GIT_CONFIG_KEY_1="credential.https://github.com.helper" \
  GIT_CONFIG_VALUE_1="!f() { printf 'username=x-access-token\npassword=%s\n' \"\$CATALYST_WF_TOK\"; }; f" \
  CATALYST_WF_TOK="$token" \
    env -u GITHUB_TOKEN git -c core.hooksPath=/dev/null push "$@"
}

# echo "main" or the repo's defaultBranchRef name if gh is available.
_draft_pr_default_base() {
  if command -v gh >/dev/null 2>&1; then
    local base
    base="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || true)"
    [[ -n "$base" ]] && { printf '%s\n' "$base"; return 0; }
  fi
  printf 'main\n'
}

# draft_pr_push — idempotent push of current branch to origin. Fail-open.
# CTL-693: suppress local pre-push hooks (trunk trufflehog/fmt/tests) on the
# automated phase-agent push path — CI on origin/main already runs those gates.
# Per-invocation `-c core.hooksPath=/dev/null` only; never mutates persistent
# config and never affects human-interactive pushes. NOT `--no-verify` (prohibited
# by rebase-prompt.md / phase-review).
draft_pr_push() {
  command -v git >/dev/null 2>&1 || { _draft_pr_warn "git unavailable"; return 1; }
  local errf
  errf="$(mktemp -t draft-pr-push-XXXXXX 2>/dev/null || echo "/tmp/draft-pr-push-$$")"
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    if ! git -c core.hooksPath=/dev/null push 2>"$errf"; then
      if _draft_pr_is_workflow_scope_error "$errf"; then
        _draft_pr_warn "git push failed: missing 'workflow' OAuth scope (continuing)"
      else
        _draft_pr_warn "git push failed (continuing)"
      fi
      rm -f "$errf"; return 1
    fi
  else
    if ! git -c core.hooksPath=/dev/null push -u origin HEAD 2>"$errf"; then
      if _draft_pr_is_workflow_scope_error "$errf"; then
        _draft_pr_warn "git push -u failed: missing 'workflow' OAuth scope (continuing)"
      else
        _draft_pr_warn "git push -u failed (continuing)"
      fi
      rm -f "$errf"; return 1
    fi
  fi
  rm -f "$errf"
}

# draft_pr_title TICKET SUBJECT — normalize a PR title to the work-record
# convention `<type>(<scope>): <ticket> ...` (CTL-783). Never fabricates
# type/scope; injects TICKET when absent. Pure function, safe under zsh.
draft_pr_title() {
  local ticket="${1:-}" subject="${2:-}"
  [[ -z "$subject" ]] && { printf '%s\n' "$ticket"; return 0; }
  [[ -z "$ticket" ]] && { printf '%s\n' "$subject"; return 0; }
  case "$subject" in
    *"$ticket"*) printf '%s\n' "$subject"; return 0 ;;
  esac
  if printf '%s' "$subject" | grep -qE '^[a-z]+(\([a-z0-9-]+\))?!?: '; then
    local prefix rest
    prefix="${subject%%: *}"
    rest="${subject#*: }"
    printf '%s: %s %s\n' "$prefix" "$ticket" "$rest"
  else
    printf '%s: %s\n' "$ticket" "$subject"
  fi
}

# draft_pr_ensure BASE TICKET — ensure a PR exists for the current branch.
# Echoes "<number>\t<url>\t<isDraft>". No-op if a PR already exists.
# Falls back to a non-draft PR if --draft is rejected. Fail-open.
draft_pr_ensure() {
  local base="${1:-}" ticket="${2:-}"
  [[ -z "$base" ]] && base="$(_draft_pr_default_base)"

  command -v gh >/dev/null 2>&1 || { _draft_pr_warn "gh unavailable"; return 1; }

  # Idempotency: check for an existing open PR on this branch.
  local existing_json
  existing_json="$(gh pr view --json number,url,isDraft 2>/dev/null || true)"
  if [[ -n "$existing_json" ]]; then
    local ex_num ex_url ex_draft
    ex_num="$(printf '%s' "$existing_json" | jq -r '.number // empty' 2>/dev/null || true)"
    ex_url="$(printf '%s' "$existing_json" | jq -r '.url // empty' 2>/dev/null || true)"
    ex_draft="$(printf '%s' "$existing_json" | jq -r '.isDraft // false' 2>/dev/null || true)"
    if [[ -n "$ex_num" ]]; then
      printf '%s\t%s\t%s\n' "$ex_num" "$ex_url" "$ex_draft"
      return 0
    fi
  fi

  # Build PR title from first commit message (no Claude attribution).
  local branch commit_subj title body
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  commit_subj="$(git log --no-merges --format='%s' "origin/${base}..HEAD" 2>/dev/null | head -1 || true)"
  if [[ -z "$commit_subj" ]]; then
    commit_subj="$(git log --no-merges --format='%s' --max-count=1 HEAD 2>/dev/null || true)"
  fi
  title="$(draft_pr_title "${ticket}" "${commit_subj}")"
  [[ -z "$title" ]] && title="${ticket:-${branch}}"

  # Build PR body: commit list + "Refs: TICKET" — no Claude attribution.
  local commit_list
  commit_list="$(git log --no-merges --oneline "origin/${base}..HEAD" 2>/dev/null | head -20 || true)"
  [[ -z "$commit_list" ]] && commit_list="$(git log --no-merges --oneline --max-count=5 HEAD 2>/dev/null || true)"
  body="$(printf '%s\n\nRefs: %s' "${commit_list}" "${ticket:-}")"

  # Try --draft first.
  local create_out
  if create_out="$(gh pr create --draft --base "$base" --title "$title" --body "$body" 2>/dev/null)"; then
    local new_num new_url
    new_url="$(printf '%s' "$create_out" | grep -oE 'https://[^ ]*/pull/[0-9]+' | head -1 || true)"
    new_num="$(printf '%s' "$new_url" | grep -oE '[0-9]+$' || true)"
    printf '%s\t%s\ttrue\n' "${new_num:-}" "${new_url:-}"
    return 0
  fi

  # --draft rejected; retry without --draft (graceful fallback per deliverable #3).
  _draft_pr_warn "--draft rejected, retrying without --draft"
  if create_out="$(gh pr create --base "$base" --title "$title" --body "$body" 2>/dev/null)"; then
    local new_num new_url
    new_url="$(printf '%s' "$create_out" | grep -oE 'https://[^ ]*/pull/[0-9]+' | head -1 || true)"
    new_num="$(printf '%s' "$new_url" | grep -oE '[0-9]+$' || true)"
    printf '%s\t%s\tfalse\n' "${new_num:-}" "${new_url:-}"
    return 0
  fi

  _draft_pr_warn "gh pr create failed (continuing)"
  return 1
}

# draft_pr_promote — promote current branch's PR from draft to ready. Idempotent. Fail-open.
draft_pr_promote() {
  command -v gh >/dev/null 2>&1 || { _draft_pr_warn "gh unavailable"; return 1; }
  local pr_json is_draft num
  pr_json="$(gh pr view --json number,isDraft 2>/dev/null || true)"
  [[ -z "$pr_json" ]] && { _draft_pr_warn "no PR found for current branch"; return 1; }
  is_draft="$(printf '%s' "$pr_json" | jq -r '.isDraft // false' 2>/dev/null || echo 'false')"
  num="$(printf '%s' "$pr_json" | jq -r '.number // empty' 2>/dev/null || true)"
  if [[ -z "$num" ]]; then
    _draft_pr_warn "no PR found for current branch"
    return 1
  fi
  if [[ "$is_draft" == "true" ]]; then
    gh pr ready "$num" 2>/dev/null || { _draft_pr_warn "gh pr ready failed (continuing)"; return 1; }
  fi
  return 0
}

# draft_pr_push_verify — push current HEAD to origin and PROVE the remote tip
# equals local HEAD. Unlike draft_pr_push (fail-open), this is fail-CLOSED: it
# returns 0 ONLY when origin/<branch> == local HEAD after the push, so callers
# can fail the phase rather than announce/merge a stale ref (CTL-1051).
#   - First attempt: plain push (fast-forward). CTL-693 hook suppression.
#   - Workflow-scope rejection (rc=3): when CATALYST_WORKFLOW_GITHUB_TOKEN is
#     configured, retries through that credential transparently. When unset,
#     returns 3 so callers can escalate with a MANUAL explanation.call_to_action. (CTL-1119/CTL-1130)
#   - Non-fast-forward (branch rebased/amended after a prior push): retry with
#     --force-with-lease (mirrors the BEHIND handler in phase-monitor-merge).
#   - Verify: git fetch the branch, compare origin/<branch> to local HEAD.
# Echoes the verified SHA on success; nothing on failure.
draft_pr_push_verify() {
  command -v git >/dev/null 2>&1 || { _draft_pr_warn "git unavailable"; return 1; }
  local branch local_sha remote_sha errf
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [[ -z "$branch" || "$branch" == "HEAD" ]] && { _draft_pr_warn "detached HEAD; cannot push-verify"; return 1; }
  local_sha="$(git rev-parse HEAD 2>/dev/null || true)"
  [[ -z "$local_sha" ]] && { _draft_pr_warn "cannot resolve local HEAD"; return 1; }

  errf="$(mktemp -t draft-pr-push-XXXXXX 2>/dev/null || echo "/tmp/draft-pr-push-verify-$$")"

  if ! git -c core.hooksPath=/dev/null push -u origin HEAD >/dev/null 2>"$errf"; then
    if _draft_pr_is_workflow_scope_error "$errf"; then
      _draft_pr_warn "push rejected: missing 'workflow' OAuth scope"
      rm -f "$errf"
      # Phase 2 (CTL-1119): route through the configured workflow-scoped credential.
      if [[ -n "${CATALYST_WORKFLOW_GITHUB_TOKEN:-}" ]]; then
        _draft_pr_warn "retrying push with CATALYST_WORKFLOW_GITHUB_TOKEN"
        local tok_errf
        tok_errf="$(mktemp -t draft-pr-tok-XXXXXX 2>/dev/null || echo "/tmp/draft-pr-tok-$$")"
        if draft_pr_push_token "$CATALYST_WORKFLOW_GITHUB_TOKEN" -u origin HEAD >/dev/null 2>"$tok_errf"; then
          rm -f "$tok_errf"
        else
          _draft_pr_warn "token-routed push also failed"
          rm -f "$tok_errf"
          return "$_DRAFT_PR_WORKFLOW_SCOPE_RC"
        fi
      else
        return "$_DRAFT_PR_WORKFLOW_SCOPE_RC"
      fi
    else
      _draft_pr_warn "fast-forward push failed; retrying with --force-with-lease"
      if ! git -c core.hooksPath=/dev/null push --force-with-lease -u origin HEAD >/dev/null 2>"$errf"; then
        if _draft_pr_is_workflow_scope_error "$errf"; then
          _draft_pr_warn "force-with-lease push rejected: missing 'workflow' OAuth scope"
          rm -f "$errf"
          if [[ -n "${CATALYST_WORKFLOW_GITHUB_TOKEN:-}" ]]; then
            _draft_pr_warn "retrying force-with-lease with CATALYST_WORKFLOW_GITHUB_TOKEN"
            local tok_errf2
            tok_errf2="$(mktemp -t draft-pr-tok-XXXXXX 2>/dev/null || echo "/tmp/draft-pr-tok2-$$")"
            if draft_pr_push_token "$CATALYST_WORKFLOW_GITHUB_TOKEN" --force-with-lease -u origin HEAD >/dev/null 2>"$tok_errf2"; then
              rm -f "$tok_errf2"
            else
              rm -f "$tok_errf2"
              return "$_DRAFT_PR_WORKFLOW_SCOPE_RC"
            fi
          else
            return "$_DRAFT_PR_WORKFLOW_SCOPE_RC"
          fi
        else
          _draft_pr_warn "force-with-lease push failed"
          rm -f "$errf"
          return 1
        fi
      else
        rm -f "$errf"
      fi
    fi
  else
    rm -f "$errf"
  fi

  git fetch --quiet origin "$branch" 2>/dev/null || true
  remote_sha="$(git rev-parse "origin/${branch}" 2>/dev/null || true)"
  if [[ -n "$remote_sha" && "$remote_sha" == "$local_sha" ]]; then
    printf '%s\n' "$local_sha"
    return 0
  fi
  _draft_pr_warn "post-push verify mismatch: local=${local_sha} origin/${branch}=${remote_sha:-<none>}"
  return 1
}

# draft_pr_head_oid — echo the open PR's headRefOid (the remote SHA the PR
# points at) for the current branch. Empty + non-zero when unavailable.
draft_pr_head_oid() {
  command -v gh >/dev/null 2>&1 || return 1
  local oid
  oid="$(gh pr view --json headRefOid -q '.headRefOid' 2>/dev/null || true)"
  [[ -n "$oid" ]] && { printf '%s\n' "$oid"; return 0; }
  return 1
}

# draft_pr_enabled — read .catalyst/config.json knob. Returns "true" (default) or "false".
# Fail-open to "true" when jq or the config file are absent.
# NOTE: cannot use jq's `// true` default — jq's alternative operator treats `false` as
# falsy, so `false // true` → `true`. Read the raw string and test it directly.
draft_pr_enabled() {
  local config_path="${CATALYST_CONFIG_PATH:-.catalyst/config.json}"
  if [[ -f "$config_path" ]] && command -v jq >/dev/null 2>&1; then
    local raw
    raw="$(jq -r '.catalyst.orchestration.draftPr.enabled' "$config_path" 2>/dev/null || echo 'null')"
    if [[ "$raw" == "false" ]]; then
      printf 'false\n'
    else
      printf 'true\n'
    fi
  else
    printf 'true\n'
  fi
}
