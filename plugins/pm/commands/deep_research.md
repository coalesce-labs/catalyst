---
description: Deep research with citation verification pipeline
model: opus
---

# Research Pipeline

Execute deep research on a topic with automatic citation verification and source recovery. Uses parallel sub-agents for efficient execution.

**Argument**: `$ARGUMENTS` specifies the research topic or action.

## Usage

```text
/research <topic>                    # Full pipeline: research → verify → recover → cleanse
/research status                     # Check status of running research tasks
/research list                       # List all research in /research directory
```

## Overview

This pipeline uses specialized sub-agents running in parallel:

```text
                                    ┌─────────────────────┐
                               ┌───▶│ external-researcher │───┐
                               │    │     (Gemini)        │   │
┌────────────┐    ┌────────┐   │    └─────────────────────┘   │    ┌──────────────┐
│   Topic    │───▶│ Build  │───┤                              ├───▶│  Save Raw    │
│   Input    │    │ Brief  │   │    ┌─────────────────────┐   │    │  Outputs     │
└────────────┘    └────────┘   └───▶│ external-researcher │───┘    └──────────────┘
                                    │       (Exa)         │              │
                                    └─────────────────────┘              │
                                                                         ▼
┌────────────┐    ┌────────────────┐    ┌─────────────────────┐    ┌──────────────┐
│   Final    │◀───│    Cleanse     │◀───│  source-recoverer   │◀───│   citation-  │
│  Analysis  │    │   & Merge      │    │    (parallel)       │    │   verifier   │
└────────────┘    └────────────────┘    └─────────────────────┘    │  (parallel)  │
                                                                    └──────────────┘
```

## Sub-Agents Used

| Agent                 | Purpose                         | Tools                           | When Used         |
| --------------------- | ------------------------------- | ------------------------------- | ----------------- |
| `catalyst-pm:external-researcher` | Deep research with citations    | WebSearch, WebFetch, Read       | Step 3 (parallel) |
| `catalyst-pm:citation-verifier`   | Find citation problems          | Read, WebFetch, WebSearch, Grep | Step 5 (parallel) |
| `catalyst-pm:source-recoverer`    | Find sources for uncited claims | WebSearch, WebFetch, Read, Grep | Step 6            |

## Step 0: Check Follow-Ups (Always)

**Before starting research, check `_internal/FOLLOW_UPS.md`:**

1. **Read the follow-ups file** to see if:
   - There's a pending research item related to this topic
   - Someone requested this research and there's a deadline
   - This research connects to other pending items

2. **Update follow-ups after research completes:**
   - If research was a follow-up item, mark it complete
   - If research reveals new action items, add them
   - Note what deliverables depend on this research

---

## Step 1: Parse Arguments

Parse `$ARGUMENTS` to determine action:

- **`<topic>`**: Research topic (e.g., "competitive landscape for AI coding tools")
- **`status`**: Check status of any running research tasks
- **`list`**: List existing research documents

If no arguments, show usage and ask what to research.

## Step 2: Initialize & Build Context (BEFORE spawning agents)

**CRITICAL**: Read any directly relevant existing files FIRST, before spawning sub-agents.

1. **Check what we already know:**

   ```text
   Use source-locator agent (or direct search) to find:
   - Existing research on this topic in thoughts/shared/research/
   - Related meeting notes or transcripts
   - Any prior analyses
   ```

2. **Generate date-stamped filenames:**
   - Raw: `thoughts/shared/research/YYYY-MM-DD-<agent>-<topic-slug>-research.md`
   - Verification: `thoughts/shared/research/verification/YYYY-MM-DD-<topic-slug>-<agent>-citation-review.md`
   - Verified sources: `thoughts/shared/research/verification/YYYY-MM-DD-<topic-slug>-verified-sources.md`
   - Final: `thoughts/shared/research/YYYY-MM-DD-<topic-slug>-analysis.md`

3. **Create research brief with citation requirements:**

   ```text
   Research Topic: [topic]

   Context from existing sources:
   [Summary of what we already know from internal sources]

   CRITICAL REQUIREMENTS:
   1. Every factual claim MUST include a citation with:
      - Source name/title
      - Full URL (not domain-only like https://example.gov)
      - Publication date if available
      - Specific section/page if applicable

   2. For regulatory/legal claims, cite:
      - Official/authoritative sources for the domain
      - Docket numbers, document IDs
      - Effective dates

   3. For industry claims, cite:
      - Company announcements, SEC filings
      - Industry analyst reports
      - Academic publications

   4. DO NOT make claims without citations
   5. If uncertain, note uncertainty explicitly
   ```

## Step 3: Execute Deep Research (PARALLEL)

**Launch BOTH research agents in parallel using Task tool.**

Use a SINGLE message with MULTIPLE Task tool calls:

### Task 1: Gemini Deep Research

```text
Task tool call:
- subagent_type: Use mcp__gemini__gemini-deep-research directly
- prompt: [research brief]
- description: "Gemini research: [topic]"
- run_in_background: true
```

### Task 2: Exa Deep Research

```text
Task tool call:
- subagent_type: Use mcp__exa__deep_researcher_start directly
- prompt: [research brief]
- description: "Exa research: [topic]"
- run_in_background: true
```

**Monitor both and save results as they complete.**

## Step 4: Save Raw Outputs

For EACH completed research agent, create raw file with frontmatter:

```yaml
---
type: raw-research
date: YYYY-MM-DD
source_agent: gemini|exa
topic: "<topic>"
topics: [<detected-topics>]
tags: [external-research, unverified]
status: unverified
task_id: "<agent-task-id>"
---
# Raw Research: <Topic>

[Full agent output exactly as received]
```

Save to: `thoughts/shared/research/YYYY-MM-DD-<agent>-<topic-slug>-research.md`

## Step 5: Adversarial Citation Verification (PARALLEL)

**Launch verification agents in parallel - one per raw research file.**

Use a SINGLE message with MULTIPLE Task tool calls:

### Task 1: Verify Gemini Research

```text
Task tool call:
- subagent_type: general-purpose (with catalyst-pm:citation-verifier instructions)
- prompt: |
    You are a catalyst-pm:citation-verifier agent. Read the agent definition.

    Then verify the research document at:
    thoughts/shared/research/YYYY-MM-DD-gemini-<topic>-research.md

    Output a verification report following the format in the agent definition.
- description: "Verify Gemini citations"
- run_in_background: true
```

### Task 2: Verify Exa Research

```text
Task tool call:
- subagent_type: general-purpose (with catalyst-pm:citation-verifier instructions)
- prompt: [same pattern for Exa file]
- description: "Verify Exa citations"
- run_in_background: true
```

**Wait for BOTH verification agents to complete before proceeding.**

Save reports to: `thoughts/shared/research/verification/YYYY-MM-DD-<topic-slug>-<agent>-citation-review.md`

## Step 6: Source Recovery

After verification completes, compile claims needing sources:

```text
From verification reports, extract:
- BROKEN citations (URL doesn't work)
- FABRICATED citations (placeholder IDs, fake frameworks)
- UNCITED claims (valid claim, no source)
```

**Launch source-recoverer agent:**

```text
Task tool call:
- subagent_type: general-purpose (with catalyst-pm:source-recoverer instructions)
- prompt: |
    You are a catalyst-pm:source-recoverer agent. Read the agent definition.

    Find sources for these claims:
    [List of claims needing sources]

    Output a recovery report following the format in the agent definition.
- description: "Recover sources for uncited claims"
```

Save to: `thoughts/shared/research/verification/YYYY-MM-DD-<topic-slug>-verified-sources.md`

## Step 7: Synthesize Final Analysis

**WAIT for all sub-agents to complete before synthesizing.**

Compile results from:

- Both raw research files
- Both verification reports
- Source recovery report

Create final document with ONLY verified claims:

```yaml
---
type: analysis
date: YYYY-MM-DD
topics: [<topic-list>]
tags: [verified, <domain-tags>]
status: VERIFIED - All citations checked
sources:
  - "[[thoughts/shared/research/YYYY-MM-DD-gemini-<topic>-research.md]]"
  - "[[thoughts/shared/research/YYYY-MM-DD-exa-<topic>-research.md]]"
verification:
  - "[[thoughts/shared/research/verification/YYYY-MM-DD-<topic>-gemini-citation-review.md]]"
  - "[[thoughts/shared/research/verification/YYYY-MM-DD-<topic>-exa-citation-review.md]]"
  - "[[thoughts/shared/research/verification/YYYY-MM-DD-<topic>-verified-sources.md]]"
confidence: high
---

# [Topic] Analysis

**Analysis Date:** YYYY-MM-DD
**Status:** VERIFIED - All citations checked

---

## Executive Summary

[Key findings - only verified claims]

---

## [Section 1]

[Content with inline citations to verified sources]

**Source:** [Full URL] | [Date] | [Authority]

---

## Appendix: Verification Summary

| Metric | Count |
|--------|-------|
| Claims Verified | X |
| Claims Removed (fabricated) | X |
| Sources Recovered | X |

See [[verification docs]] for full audit trail.

---

*This analysis synthesizes research from Gemini and Exa, verified through adversarial citation review.
Fabricated citations and unsupported claims have been removed.*
```

Save to: `thoughts/shared/research/YYYY-MM-DD-<topic-slug>-analysis.md`

## Step 8: Summary

```text
Research Pipeline Complete
==========================

Topic: [topic]

Sub-Agents Used:
- external-researcher (Gemini): completed
- external-researcher (Exa): completed
- citation-verifier (x2): completed
- source-recoverer: completed

Files Created:
- Raw (Gemini): [[thoughts/shared/research/...]]
- Raw (Exa): [[thoughts/shared/research/...]]
- Verification (Gemini): [[thoughts/shared/research/verification/...]]
- Verification (Exa): [[thoughts/shared/research/verification/...]]
- Verified Sources: [[thoughts/shared/research/verification/...]]
- Final Analysis: [[thoughts/shared/research/...]]

Statistics:
- Total claims reviewed: X
- Verified: X
- Removed (fabricated/unsupported): X
- Sources recovered: X

The final analysis contains only verified claims with working citations.
```

## Parallelization Strategy

### Phase 1 - Research (Parallel)

- Gemini researcher and Exa researcher run simultaneously
- No dependencies between them
- Save results as each completes

### Phase 2 - Verification (Parallel)

- Verify Gemini results and Exa results simultaneously
- Each verifier works on one raw file
- Wait for BOTH to complete before Phase 3

### Phase 3 - Recovery (Sequential)

- Depends on verification results
- Single agent processes all uncited claims
- Must complete before synthesis

### Phase 4 - Synthesis (Sequential)

- Depends on all previous phases
- Main agent compiles final document
- No sub-agents needed

## Agent Definitions

The following agents are used by this pipeline:

- `catalyst-pm:external-researcher` - Deep research with citations
- `catalyst-pm:citation-verifier` - Adversarial verification
- `catalyst-pm:source-recoverer` - Find sources for valid claims

## Integration

- **Before research**: Use `/context <topic>` to see what we already know
- **After research**: Use `/ingest` to process any new meetings on the topic
- **For visuals**: Use `/infographic` to create visual summaries
