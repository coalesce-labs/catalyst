# Reading Broker Wake Payloads

_Read this when parsing a `filter.wake.*` event from the broker and need to extract PR number,
CI conclusion, review state, or other typed fields without hand-rolling jq paths._

When the broker daemon is running and a `filter.wake.*` event arrives, the payload contains
richer context than just the `reason` string. Use `catalyst-events wake-extract` to normalize
the varied payload shapes into a single predictable object:

```bash
EVENT=$(catalyst-events wait-for \
  --filter ".attributes.\"event.name\" | startswith(\"filter.wake.${CATALYST_SESSION_ID}\")" \
  --timeout 600)

# Narrate the wake (mandatory — see narration-fixture.md)
FIELDS=$(echo "$EVENT" | catalyst-events wake-extract)
REASON=$(echo "$FIELDS"   | jq -r '.reason // "unknown"')
INTEREST=$(echo "$FIELDS" | jq -r '.interest_id // "unknown"')
echo "wake: filter.wake [interest=${INTEREST}] — ${REASON}"

# Branch on normalized fields instead of re-querying GitHub/Linear
CI_CONCLUSION=$(echo "$FIELDS" | jq -r '.ci_conclusion // empty')
REVIEW_STATE=$(echo "$FIELDS"  | jq -r '.review_state // empty')
MERGED=$(echo "$FIELDS"        | jq -r '.merged // empty')

case "$CI_CONCLUSION" in
  failure|timed_out)
    # CI failed — pull logs, fix, push without a separate gh api call
    ;;
esac
case "$MERGED" in
  true)
    # PR merged event in the payload — still confirm via gh api REST before declaring done
    ;;
esac
```

See `plugins/dev/skills/broker/references/wake-payload-reference.md` for the complete
`wake-extract` output schema and
`plugins/dev/skills/broker/references/wake-reason-strings.md` for the per-interest-type
reason string catalogue (moved there after the broker split — `[[broker]] §10` no longer
exists).

**When `source_events` is empty** (watchdog wakes, some Groq prose wakes): all `wake-extract`
fields are `null` except `interest_id` and `reason`. Treat the wake as a "go re-check" signal
and fall back to the authoritative REST check.

**Pattern 2/3 fallback (no broker):** the raw event patterns in this skill use raw
`github.*` events from `wait-for`, not `filter.wake.*` wakes — `wake-extract` does not apply
to those paths.
