---
description: Adversarial citation verification for research documents
category: pm
tools: Task, Read, Write, WebFetch, WebSearch
model: opus
version: 1.0.0
---

# Research Citation Verification

Run adversarial citation verification on research documents. Identifies fabricated citations, broken URLs, uncited claims, and produces a verification report.

**Argument**: `$ARGUMENTS` specifies the file or directory to verify.

## Usage

```text
/research-verify <file>              # Verify citations + recover sources
/research-verify <directory>         # Verify all research files in directory
/research-verify                     # Verify recent unverified files
```

## Step 1: Parse Arguments

Parse `$ARGUMENTS`:

- **`<file>`**: Path to specific research file to verify
- **`<directory>`**: Path to directory (verifies all `.md` files)

If no arguments, check for recent unverified files in `thoughts/shared/research/`.

**Note:** Source recovery always runs automatically after verification. There's no reason to verify citations without attempting to recover valid claims that lack proper sources.

## Step 2: Identify Files to Verify

1. If file path provided, verify it exists
2. If directory provided, find all `.md` files
3. If no argument, look for files with `status: unverified` in frontmatter

For each file, check frontmatter:

```yaml
status: unverified  # Needs verification
status: VERIFIED    # Already verified, skip unless --force
```

## Step 3: Run Adversarial Verification

For each file, analyze with this adversarial mindset:

### Citation Checks

For EVERY citation in the document:

1. **URL Completeness**
   - Is URL a full path or just domain? (`https://example.gov` = BAD)
   - Does URL have proper structure?
   - Are query parameters/fragments present if referenced?

2. **URL Validity** (use WebFetch to test)
   - Does URL return 200 OK?
   - Is content related to claim?
   - Is it the current version?

3. **Citation Accuracy**
   - Does the cited content actually support the claim?
   - Is the date/version correct?
   - Are specific sections/pages accurate?

4. **Identifier Verification**
   - PMC articles: Format PMC#######
   - DOI: Format 10.####/...
   - Domain-specific IDs: Validate against known formats for the domain

### Claim Analysis

For EVERY factual claim:

1. **Citation Present?**
   - Is there a citation?
   - Is it inline or in references?

2. **Claim Type**
   - Regulatory fact (needs official source)
   - Industry claim (needs company/analyst source)
   - Academic claim (needs peer-reviewed source)
   - Opinion/analysis (doesn't need citation but should be marked)

3. **Verifiability**
   - Can this claim be independently verified?
   - What type of source would verify it?

## Step 4: Generate Verification Report

Create report with this structure:

```markdown
# Citation Review: [Document Name]

**Document Reviewed:** [path]
**Review Date:** YYYY-MM-DD
**Reviewer:** Adversarial Citation Review Agent

---

## Summary Assessment

**Overall Reliability:** [HIGH/MODERATE/LOW - NEEDS REMEDIATION]

[Brief assessment paragraph]

---

## CRITICAL ISSUES

### 1. [Issue Title]

**Severity: CRITICAL**

[Description of issue]

**Impact:** [What this means for document reliability]

---

## MODERATE ISSUES

### X. [Issue Title]

**Severity: MODERATE**

[Description]

---

## MINOR ISSUES

### X. [Issue Title]

**Severity: MINOR**

[Description]

---

## VERIFIED CLAIMS

| Claim            | Verification Status           |
| ---------------- | ----------------------------- |
| **[Claim text]** | **VERIFIED** - [How verified] |

---

## UNCITED CLAIMS NEEDING SOURCES

| Claim   | Claim Type | Recoverable?          |
| ------- | ---------- | --------------------- |
| [Claim] | Regulatory | Yes - search official databases |
| [Claim] | Industry   | Yes - search company sources    |
| [Claim] | Opinion    | No - mark as analysis |

---

## SUMMARY

| Category     | Count | Status    |
| ------------ | ----- | --------- |
| **CRITICAL** | X     | [Issues]  |
| **MODERATE** | X     | [Issues]  |
| **MINOR**    | X     | [Issues]  |
| **VERIFIED** | X     | [Details] |
| **UNCITED**  | X     | [Details] |

---

## RECOMMENDATION

[Do not use / Use with caution / Suitable for use]

[Specific remediation steps if needed]

---

## Required Actions for Source Recovery

1. [Action 1]
2. [Action 2]
```

## Step 5: Save Verification Report

Save to: `thoughts/shared/research/verification/YYYY-MM-DD-<source-filename>-citation-review.md`

## Step 6: Source Recovery

For each claim in "UNCITED CLAIMS NEEDING SOURCES" or with broken/fabricated citations:

1. **Search for authoritative sources**
   - Use `mcp__exa__web_search_exa` for general search
   - Use `mcp__exa__deep_researcher_start` for complex claims (async: poll with `mcp__exa__deep_researcher_check`)
   - Use `WebFetch` to verify found URLs

2. **Verify found sources**
   - Confirm URL works
   - Confirm content supports claim
   - Note publication date and authority

3. **Update verified sources document**

Save recovered sources to: `thoughts/shared/research/verification/YYYY-MM-DD-<topic>-verified-sources.md`

## Step 7: Summary Output

```text
Verification Complete
====================

File(s) Verified: [count]
- [path 1]
- [path 2]

Results:
- Critical Issues: X
- Moderate Issues: X
- Minor Issues: X
- Claims Verified: X
- Claims Needing Sources: X
- Sources Recovered: X

Reports Created:
- [verification report path]
- [verified sources path]

Next Steps:
- Review verification report
- Create cleansed analysis with verified claims only
```

## Common Fabrication Patterns

Watch for these AI research agent fabrication patterns:

### Fabricated Document IDs

```text
PMCXXXXXX      # Obvious placeholder
DOI 10.0000/fake  # Placeholder DOI
ID-123456      # Suspiciously round or sequential numbers
```

### Fabricated Frameworks

```text
"[Organization] [Made-up Framework Name]"   # Verify against official publications
"[Invented Classification System]"          # Check if real
"Stage 1-4 Classification"                  # Verify against actual standards
```

### Domain-Only URLs

```text
https://example.gov           # Not a page
https://example.com           # Not a specific article
https://example.org           # Not a document
```

### Vague Date References

```text
"2022 Final Guidance"         # Which month? May be outdated
"late 2024/2025"              # Imprecise
"recent guidance"             # When exactly?
```

## Verification Resources

### General Academic Sources

- PubMed: <https://pubmed.ncbi.nlm.nih.gov/>
- PMC: <https://www.ncbi.nlm.nih.gov/pmc/>
- Google Scholar: <https://scholar.google.com/>

### Domain-Specific Resources

Customize these for your project's domain. Examples:

- Government regulatory databases for your industry
- Industry standards body document repositories
- Official registries and filing databases (e.g., SEC EDGAR, patent databases)
- Domain-specific academic indexes
