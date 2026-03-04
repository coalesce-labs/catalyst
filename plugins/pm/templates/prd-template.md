# PRD Template

> **How to use:** Copy this template for your feature. Delete sections that don't apply. Expand sections as the PRD matures through stages. For guided creation, run `/prd-draft` in Claude Code.
>
> **Stage guidance:** Start short. A Team Kickoff PRD is 300-500 words. A Launch Readiness PRD is 1500-2000 words. Expand as you learn, not before.

---

## 0) Meta

| Field | Value |
|-------|-------|
| **Feature / Experiment** | [Name] |
| **DRI (PM)** | [Your name] |
| **Stage** | Draft / Team Kickoff / Planning Review / XFN Kickoff / Solution Review / Launch Readiness / Impact Review |
| **Last Updated** | [Date] |
| **Status** | Draft / In Review / Approved / Shipped |
| **Links** | [design tool]() | [Prototype]() | [Tracking]() | [Dashboard]() | [Runbook]() |

---

## 1) Problem and Hypothesis

**Problem** (2 sentences max):
[What user pain exists? Be specific about who feels it and how often.]

**Hypothesis:**
If we [build X], then [Y metric] will [change by Z], because [assumption about user behavior].

**Strategy Fit:**
This supports [specific strategic bet/pillar] because [why now, not later].

**Supporting Evidence:**
- [User quote or data point]
- [User quote or data point]
- [Competitive pressure or market signal, if relevant]

---

## 2) Scope and Non-Goals

**In Scope:**
- [What we're building in v1]
- [And this]

**Non-Goals** (max 3):
- [What we're NOT doing] -- [why]
- [What we're NOT doing] -- [why]

**Tradeoffs Accepted:**
- [e.g., +200-300ms latency for improved precision]
- [e.g., Manual config for v1, self-serve later]

---

## 3) AI Behavior Contract

> **Include this section for AI/ML features only.** Delete for non-AI features.

| Dimension | Specification |
|-----------|--------------|
| **Primary Task(s)** | summarize / extract / classify / generate / route |
| **Inputs Available** | [fields, context, tools, RAG sources] |
| **Constraints and Guardrails** | [brand voice, privacy rules, compliance] |
| **Disallowed** | [PII echo, policy violations, jailbreak classes] |
| **Params (if fixed)** | temperature, max tokens, tool call policy |
| **Latency Budget** | P50: [X]ms / P95: [Y]ms |

**Behavior Examples:**

| Scenario | User Input | Expected Output | Rejection Criteria |
|----------|------------|-----------------|-------------------|
| Happy path | [Example] | [What should happen] | N/A |
| Edge case | [Example] | [Graceful handling] | N/A |
| Should reject | [Example] | [Error/refusal message] | [Why rejected] |

---

## 4) Solution Overview

> **Include this section for non-AI features.** Delete for AI features (use Behavior Contract above instead).

**User Flow:**
1. [Step 1: User does X]
2. [Step 2: System responds with Y]
3. [Step 3: User completes Z]

**Key Interactions:**
- [Interaction]: [What happens and why]

**Edge Cases:**
- [Edge case]: [How we handle it]

**Mockup/Prototype:** [Link or embed]

---

## 5) Success Metrics and Evaluation

**Primary Metric:**
- Metric: [name]
- Baseline: [current value]
- Target: [goal]
- Timeline: [when we expect impact]

**Guardrail Metrics** (must not harm):
- [Metric]: [acceptable range]
- [Metric]: [acceptable range]

**Kill Criteria:**
If [specific condition], we will [rollback/pause/iterate].

### Evaluation Plan (for AI features or experiments)

| Type | Detail |
|------|--------|
| **Offline eval** | [metric(s), golden set size, target (e.g., F1 >= 0.85)] |
| **Human review** | [sample size, quality target (e.g., >= 4/5)] |
| **Online eval** | [primary metric(s), guardrails, MDE, duration] |
| **Graduate when** | [thresholds] |
| **Fail action** | [rollback criteria or iterate plan] |

---

## 6) Rollout Plan

**Approach:** A/B Test / Phased Rollout / Full Launch

| Phase | Audience | Duration | Pass Criteria |
|-------|----------|----------|---------------|
| Phase 1 | [who, % traffic, segments] | [duration] | [metrics to hit] |
| Phase 2 | [expand to] | [duration] | [metrics to hit] |
| GA | [everyone] | Ongoing | [steady-state monitoring] |

**Eligibility Rules:** [who qualifies, randomization unit]

**Ramp Gates:** [what must be true to advance each phase]

**Comms:** [release notes, in-product messaging, support docs]

---

## 7) Risks and Recovery

| Risk | Detection | Fallback | Kill Switch |
|------|-----------|----------|-------------|
| [e.g., Hallucination] | [signal, threshold, alert] | [deterministic path or previous model] | [where, who owns] |
| [e.g., PII leakage] | [signal, threshold, alert] | [human handoff] | [where, who owns] |
| [e.g., Performance degradation] | [latency spike > Xms] | [disable feature flag] | [where, who owns] |

---

## 8) Owners and Next Steps

**DRI:** [PM name]
**Reviewers:** [Eng], [DS], [Design], [Legal/Sec], [Support]

**Open Questions:**
- [ ] [Question] -- @[owner]
- [ ] [Question] -- @[owner]

**Next Milestones:**

| Target Date | Milestone | Exit Criteria |
|-------------|-----------|---------------|
| [date] | [milestone] | [what must be true] |
| [date] | [milestone] | [what must be true] |

---

## 9) Appendix

**Changelog:**

| Date | Change | Who |
|------|--------|-----|
| [date] | [what changed] | [name] |

**Impact Sizing Detail:**

| Funnel Stage | Users | Drop-off Reason |
|-------------|-------|-----------------|
| See feature | [number] | -- |
| Eligible | [number] | [reason] |
| Engage | [number] | [friction] |
| Complete | [number] | [friction] |

**Alternatives Considered:**
- [Alternative A]: Not doing because [reason]
- [Alternative B]: Not doing because [reason]

**Meeting Notes:** [Link to relevant meeting notes or paste key excerpts]

---

## PRD Quality Checklist

> Use this to self-review before sharing. Check items relevant to your current stage.

### Planning Stage
- [ ] Problem clearly defined in 1-2 sentences
- [ ] Current state described (how the problem goes unaddressed today)
- [ ] Business metrics identified (what this moves)
- [ ] Qualitative evidence included (user quotes, research)
- [ ] Competitive landscape surveyed
- [ ] User insight or anecdote that motivates the feature
- [ ] Gaps in understanding identified with owners and deadlines

### Kickoff Stage
- [ ] Solution mock or description added
- [ ] North-star, secondary, and guardrail metrics defined
- [ ] Impact sizing modeled (input and output metrics)

### Solution Review Stage
- [ ] Edge cases documented
- [ ] Rollout plan specified (experiment vs. full launch)
- [ ] XFN requirements outlined
- [ ] Tracking and analytics requirements specified
- [ ] Go-to-market strategy addressed
- [ ] Risks and mitigation identified

### Launch Readiness Stage
- [ ] All eng concerns addressed
- [ ] Design files complete
- [ ] Tickets created and estimated
- [ ] GTM teams enabled (sales, marketing, CS)
- [ ] User adoption plan ready (not just build it)
- [ ] Financial costs reviewed
- [ ] Kill criteria and rollback plan documented
- [ ] QA/test plan ready

### Impact Review Stage
- [ ] No blind spots that would make you regret shipping
- [ ] Statistical analysis passes sniff test
- [ ] Continuous monitoring plan in place
- [ ] Improvement ideas captured for future iteration

---

> **Tip:** You don't need every section at every stage. A Team Kickoff PRD might only have sections 0, 1, 2, and 8. Expand as the feature matures. The checklist tells you what to add at each stage.
>
> **Tip:** For guided PRD creation with automatic context from your workspace (strategy docs, user research, stakeholder profiles), run `/prd-draft` instead of filling this template manually.
