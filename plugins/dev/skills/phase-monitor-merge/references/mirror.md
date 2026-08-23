# End Block — Mirror to Linear

Mirror the merge outcome to Linear as a single comment (CTL-632). Best-effort end-of-loop summary
(per the design decision — per-finding detail like individual CI fix-up commits or bot review
threads stays on the PR itself): merge commit + base branch, the final CI check rollup
(passed/total), and a count of bot reviews handled (e.g. Codex) whose threads were resolved before
the merge. Merge metadata is re-read from the signal file (`.pr.mergeCommitSha` / `.pr.mergedAt`,
written in the merge step above); CI + reviews are pulled once from `gh pr view`. Runs inside the
ticket worktree (CTL-703: no auto-teardown `cd` here; the skill stays in the ticket worktree and
relies on absolute signal paths and the PR number). Body hard-truncated to 30,000 bytes. Fail-open
and idempotent via the per-phase marker file. Uniquely-named fence so the e2e test can extract just
this block.

```bash phase-monitor-merge-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  MM_SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
  MM_PR_NUMBER="$(jq -r '.pr.number // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  [[ -n "${MM_PR_NUMBER}" ]] || MM_PR_NUMBER="${PR_NUMBER:-}"
  MERGE_SHA="$(jq -r '.pr.mergeCommitSha // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  MERGED_AT="$(jq -r '.pr.mergedAt // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  PR_VIEW="{}"
  if [[ -n "${MM_PR_NUMBER}" ]]; then
    PR_VIEW="$(gh pr view "${MM_PR_NUMBER}" --json url,baseRefName,createdAt,statusCheckRollup,reviews 2>/dev/null || echo '{}')"
  fi
  PR_URL="$(printf '%s' "${PR_VIEW}" | jq -r '.url // empty' 2>/dev/null || true)"
  BASE_REF="$(printf '%s' "${PR_VIEW}" | jq -r '.baseRefName // "main"' 2>/dev/null || echo 'main')"
  CREATED_AT="$(printf '%s' "${PR_VIEW}" | jq -r '.createdAt // empty' 2>/dev/null || true)"
  CHECKS_TOTAL="$(printf '%s' "${PR_VIEW}" | jq -r '(.statusCheckRollup // []) | length' 2>/dev/null || echo 0)"
  CHECKS_PASSED="$(printf '%s' "${PR_VIEW}" | jq -r '[(.statusCheckRollup // [])[] | select((.conclusion // .state) == "SUCCESS")] | length' 2>/dev/null || echo 0)"
  BOT_REVIEWS="$(printf '%s' "${PR_VIEW}" | jq -r '[(.reviews // [])[] | select((.author.login // "" | ascii_downcase) | test("codex|bot"))] | length' 2>/dev/null || echo 0)"
  if [[ "${CHECKS_TOTAL}" == "0" ]]; then
    CI_LINE="_no CI checks reported_"
  else
    CI_LINE="${CHECKS_PASSED}/${CHECKS_TOTAL} checks passed"
  fi
  if [[ -n "${MERGE_SHA}" ]]; then
    MERGE_LINE="\`${MERGE_SHA}\` into \`${BASE_REF}\`${MERGED_AT:+ at ${MERGED_AT}}"
  else
    MERGE_LINE="_merge commit unavailable_"
  fi
  # Wall-clock time the PR was open (opened → merged). This is total elapsed,
  # most of it spent WAITING on GitHub (CI, reviews) — the agent's actual
  # working time is the "active" figure in the footer below, so
  # waiting ≈ time-to-merge − active. fromdateiso8601 is portable (needs the Z).
  TIME_TO_MERGE="_unknown_"
  if [[ -n "${CREATED_AT}" && -n "${MERGED_AT}" ]]; then
    TTM_SECS="$(jq -n --arg a "${CREATED_AT}" --arg b "${MERGED_AT}" \
      '(($b|fromdateiso8601) - ($a|fromdateiso8601)) | floor' 2>/dev/null || echo "")"
    if [[ "${TTM_SECS}" =~ ^[0-9]+$ ]]; then
      TTM_H=$(( TTM_SECS / 3600 )); TTM_M=$(( (TTM_SECS % 3600) / 60 ))
      if [[ "${TTM_H}" -gt 0 ]]; then TIME_TO_MERGE="${TTM_H}h ${TTM_M}m"; else TIME_TO_MERGE="${TTM_M}m"; fi
    fi
  fi
  MIRROR_BODY="$(cat <<EOF
**Phase Monitor-Merge** — PR #${MM_PR_NUMBER:-?} merged

- **PR**: ${PR_URL:-_url unavailable_}
- **Merge commit**: ${MERGE_LINE}
- **Time to merge** (PR opened → merged): ${TIME_TO_MERGE} — mostly waiting on CI/reviews; see the footer's _active_ figure for actual working time
- **CI**: ${CI_LINE}
- **Bot reviews handled** (e.g. Codex): ${BOT_REVIEWS} — threads resolved before merge

_Posted automatically by phase-monitor-merge (CTL-632). Per-finding detail —
individual CI fix-up commits and review threads — lives on the PR itself._
EOF
)"
  MIRROR_FOOTER=""
  if [[ -n "${PLUGIN_ROOT:-}" && -x "${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" ]]; then
    MIRROR_FOOTER="$("${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" --orch-dir "${ORCH_DIR}" --ticket "${TICKET}" --phase "${PHASE}" 2>/dev/null || true)"
  fi
  [[ -n "${MIRROR_FOOTER}" ]] && MIRROR_BODY="${MIRROR_BODY}
${MIRROR_FOOTER}"
  if [[ ${#MIRROR_BODY} -gt 30000 ]]; then
    MIRROR_BODY="${MIRROR_BODY:0:30000}

_... (truncated)_"
  fi
  COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [[ ! -x "$COMMENT_POST" ]]; then COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"; fi
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-monitor-merge: linear-comment-post failed (continuing)" >&2
  fi
fi
```
