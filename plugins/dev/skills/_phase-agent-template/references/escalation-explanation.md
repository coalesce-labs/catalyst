# Structured escalation explanation (CTL-1130)

Read this when a phase can escalate to a human — it defines the typed explanation and the
phrase gates that stop a tautological one.


Whenever a phase writes a failed/stalled signal that will be shown to the
operator (e.g. via the Inbox "Needs you" section), it MUST populate an
`explanation` block alongside `failureReason`. The contract is a **tagged
union** discriminated by `escalation_type`:

```json
// MANUAL: the agent physically cannot execute any path (missing credential/scope)
{
  "escalation_type": "manual",
  "problem":              "<specific symptom>",
  "call_to_action":       "<one specific, answerable question for the operator>",
  "blocked_capability":   "<what the agent cannot do>",
  "instructions":         ["<step 1>", "<step 2>"],
  "remediation_then_retry": "<what to do then re-run>",
  "why_not_auto":         "<concrete capability boundary — not a vague phrase>"
}

// AUTHORIZATION: agent can act; only risk/blast-radius stops it
{
  "escalation_type": "authorization",
  "problem":                    "<specific symptom>",
  "call_to_action":             "<one specific, answerable question>",
  "recommendation":             "<what the agent recommends>",
  "risk":                       "<concrete risk — not a vague phrase>",
  "why_asking":                 "<risk-authority gate, not a capability gap>",
  "could_higher_tier_resolve":  false,
  "authorize_label":            "<short label for the authorize button>"
}

// DECISION: 2+ non-dominated paths; tie-break is human preference
{
  "escalation_type": "decision",
  "problem":      "<specific symptom>",
  "call_to_action": "<one specific, answerable question>",
  "options":      [{"label":"<choice>","tradeoff":"<what is risked/lost>"}],
  "why_you":      "<why the agent cannot compute the tie-break>"
}
```

All types accept optional `observed` (object) and `attempts` (array)
passthrough fields.

Use the CLI shim so the shell can build the JSON without risk of syntax
errors or missing fields:

```bash
# MANUAL example (push rejected — workflow OAuth scope missing)
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type manual \
  --problem "{{ specific symptom }}" \
  --call-to-action "{{ specific question for the operator }}" \
  --blocked-capability "{{ what the agent cannot do }}" \
  --instructions '["{{ step 1 }}","{{ step 2 }}"]' \
  --remediation-then-retry "{{ what to do, then re-run }}" \
  --why-not-auto "{{ concrete capability boundary }}" \
  --can-execute false \
  --observed "$(jq -nc '{key:"value"}' 2>/dev/null || echo '{}')" \
  2>/dev/null || echo '{}')"

# AUTHORIZATION example (restart with risk)
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type authorization \
  --problem "{{ specific symptom }}" \
  --call-to-action "{{ specific question }}" \
  --recommendation "{{ what to do }}" \
  --risk "{{ concrete risk — specific file/line/data at stake }}" \
  --why-asking "risk-authority gate, not a capability gap" \
  --authorize-label "{{ short label }}" \
  --could-higher-tier-resolve false \
  --can-execute true \
  2>/dev/null || echo '{}')"

# DECISION example (multiple non-dominated paths)
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type decision \
  --problem "{{ specific symptom }}" \
  --call-to-action "{{ specific question }}" \
  --options '[{"label":"{{ choice A }}","tradeoff":"{{ what is risked }}"},{"label":"{{ choice B }}","tradeoff":"{{ what is lost }}"}]' \
  --why-you "{{ why the agent cannot compute the tie-break }}" \
  2>/dev/null || echo '{}')"
```

Then merge it into the signal alongside `failureReason`. Guard the value on a
prior line and pass the variable directly — never inline `${EXPL_JSON:-{}}`: the
bash parser closes the parameter expansion at the FIRST `}`, so a non-empty value
like `{"a":1}` expands to `{"a":1}}` (trailing brace → invalid JSON → jq exits
non-zero → the `&& mv` is skipped and the signal is never written). Verified in
bash 3.2 and 5.x.

```bash
[ -n "$EXPL_JSON" ] || EXPL_JSON='{}'
jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson expl "$EXPL_JSON" \
   '.status = "failed" | .failureReason = "{{ reason }}" | .explanation = $expl | .updatedAt = $ts' \
   "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp.$$" && mv "$SIGNAL_FILE.tmp.$$" "$SIGNAL_FILE"
```

### Banned call_to_action phrases (tautology gate)

The CLI shim rejects these with `degraded: true` and substitutes a
generic fallback. Never write:

- "needs a human" / "requires human intervention" / "needs human review"
- "a human must decide" / "someone must decide"
- "escalate to operator" / "escalate to human"
- "requires intervention" / "requires action" (bare)
- "needs attention" (bare)

Write the **specific question** instead:
- Bad: "this phase needs human attention"
- Good: "should the rebase conflict in foo/bar.ts be resolved by discarding
  the local change or by cherry-picking the remote version?"

### Banned risk / why_not_auto phrases (RISK_VAGUE_RE)

These vague bare platitudes are also rejected (anchored `^…$` — a concrete
sentence that *contains* one of these phrases is accepted):

- "involves trade-offs" (bare)
- "no single fix path" / "no single automated fix path…"
- "requires human judgment" / "requires human judgement"

Write a **concrete** risk instead:
- Bad: "involves trade-offs"
- Good: "restarting discards 42 minutes of elapsed work and 0 commits on the CTL-1 branch"

