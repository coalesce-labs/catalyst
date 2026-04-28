---
name: code-first-draft
description: "Scaffolds initial feature implementation from a PRD or feature description using TDD (Red-Green-Refactor). Generates project structure, boilerplate code, tests, and wires up dependencies. **ALWAYS use when** the user wants to build a new feature, implement a PRD, create a first draft of code, or says things like 'build this feature', 'implement this PRD', 'code this up', 'create the initial implementation'. Not for incremental changes or bug fixes. Also use when there's no existing codebase and user needs a standalone reference prototype."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task
version: 1.0.0
---

## Quick Start

1. Point me to a PRD or describe the feature to build
2. I explore your codebase (framework, patterns, structure) or switch to Prototype Mode if no codebase exists
3. I create an implementation plan and ask for your approval before writing code
4. I follow TDD: write failing tests first, then implement to make them pass, then refactor
5. I deliver a summary with files created/modified, test coverage, and next steps

**Example:** "Build the user preferences feature from thoughts/shared/prds/preferences.md"

**Output:** Code in your codebase + summary saved to `thoughts/shared/prototypes/[feature]-first-draft.md`

**Time:** 1-3 hours depending on feature complexity

## Purpose

Connect to codebase and build initial implementation of a feature. Single-pass development with manual iteration.

## Usage

- `/code-first-draft` - Build feature from PRD
- `/code-first-draft [prd-name]` - Build specific PRD
- `/code-first-draft --explore-only` - Just explore codebase, don't write code yet

---

## Context Routing

**Check first:**

1. `thoughts/shared/prds/` - PRD for requirements (if available)
2. Codebase (`.git` directory, source files)

---

## Workflow

### Step 1: Codebase Setup (First Time Only)

**Detect codebase:**

```bash
# Check if in codebase directory
ls -la | grep ".git"
```

**If not in codebase:**

- Ask: "Where's your codebase?"
- Options:
  1. "Navigate me there" (cd to directory)
  2. "Clone from GitHub" (provide repo URL, I'll clone with `gh repo clone`)
  3. "Connect via MCP" (GitHub MCP for remote access)

**Explore codebase:**

```bash
# Detect framework
ls package.json || ls requirements.txt || ls Gemfile || ls go.mod

# Find key directories
find . -type d -name "components" -o -name "src" -o -name "app" | head -10

# Understand structure
tree -L 2 -I 'node_modules|__pycache__|.git'
```

---

### Step 2: PRD to Technical Requirements

**Read PRD and extract:**

- User stories → Features to build
- Success metrics → Analytics to instrument
- Edge cases → Error handling needed
- Non-goals → What NOT to build

**Map to code:**

- Which files need modification?
- Which new files needed?
- Which APIs to create/modify?
- Which database changes required?

---

### Step 3: Implementation Plan

**Before writing code, create plan:**

```markdown
# Implementation Plan: [Feature]

## Files to Create

- `tests/feature.test.ts` - Unit tests (written FIRST)
- `tests/feature.integration.test.ts` - Integration tests (written FIRST)
- `src/components/NewFeature.tsx` - Main component
- `src/api/feature.ts` - API routes

## Files to Modify

- `src/components/Dashboard.tsx` - Add new feature entry point
- `src/api/index.ts` - Register new routes
- `src/types/index.ts` - Add type definitions

## API Endpoints

- `POST /api/feature` - Create new item
- `GET /api/feature/:id` - Fetch item
- `PUT /api/feature/:id` - Update item

## Database Changes

- Add `features` table with columns: id, user_id, data, created_at

## Testing Approach (TDD)

Tests are written BEFORE implementation using Red → Green → Refactor:
1. **Red** — Write failing tests describing expected behavior
2. **Green** — Implement minimum code to make tests pass
3. **Refactor** — Clean up while keeping tests green

- Unit tests for core business logic (written first)
- Integration tests for API endpoints (written first)
- Edge case tests for error states (written first)
- E2E test for happy path
```

**Ask user for approval:** "This is my plan. Approve before I write code?"

---

### Step 4: Implementation (TDD — Red → Green → Refactor)

Follow Test-Driven Development for each unit of work:

**Step 4a: Write Failing Tests (Red)**

- Write test files FIRST, before any implementation code
- Tests should describe the expected behavior from the PRD
- Run tests to confirm they fail (this validates the tests are meaningful)
- Cover: core logic, API contracts, edge cases, error states

**Step 4b: Implement to Pass (Green)**

- Write the minimum code to make tests pass
- Follow existing code patterns (match style)
- Follow framework conventions
- Don't over-engineer — just make the tests green

**Step 4c: Refactor (Clean)**

- Clean up implementation while keeping all tests green
- Extract shared logic, improve naming, simplify
- Run tests after each refactor step to ensure nothing breaks

**Add inline comments for:**

- Complex logic
- Edge case handling
- TODOs for future work

**TDD rhythm per feature unit:**
```
1. Write test → run → see it fail (Red)
2. Write implementation → run → see it pass (Green)
3. Clean up → run → still passing (Refactor)
4. Repeat for next unit
```

---

### Step 5: Summary Document

Save to `thoughts/shared/prototypes/[feature]-first-draft.md`:

```markdown
# First Draft Implementation: [Feature]

**Date:** [Date]
**PRD:** [Link]

## What Was Built

**Files created:** [X]
**Files modified:** [Y]
**Tests added:** [Z]

## Implementation Approach

[Brief description of technical approach]

## Testing

**Coverage:** [%]
**Tests passing:** [Y/N]
**Manual testing needed:** [What to test]

## Known Issues / TODOs

- [ ] [Issue 1]
- [ ] [TODO 1]

## Next Steps

- Run tests
- Manual QA
- For complex features: Consider `/catalyst-dev:create-plan` + `/catalyst-dev:implement-plan` for structured iteration
```

---

## Prototype Mode (No Codebase Detected)

If no codebase is detected (no `.git` directory, no `package.json`, no source files in the workspace), switch to **Prototype Mode** automatically.

### Tech Stack Detection (Prototype Mode)

Infer the tech stack from the user's request or use sensible defaults:

**What changes:**

- Instead of modifying an existing codebase, generate a **standalone reference implementation**
- Fall back to the most common stack for the feature type:
  - **UI features:** React + TypeScript + Tailwind CSS
  - **Backend/API features:** Python (FastAPI) or Node.js (Express + TypeScript)
  - **Full-stack features:** Next.js + TypeScript
  - **Data processing:** Python with standard libraries
- Include a `README.md` with setup instructions (`npm install && npm run dev` or equivalent)
- Add a header comment in every file: `// Reference prototype - not production code.`

**Output:** Save all files to `thoughts/shared/prototypes/[feature]-reference-impl/`

**When presenting:**

> "No codebase detected, so I built a standalone reference prototype using [stack]. This is not production code — adapt it to your actual codebase patterns, auth system, and infrastructure."

---

## Accessibility Guidance

For UI features, include basic accessibility in all generated code:

**Required accessibility patterns:**

- **ARIA labels** on all interactive elements (buttons, inputs, links, toggles)
- **Keyboard navigation** -- all interactive elements reachable via Tab, activatable via Enter/Space
- **Sufficient color contrast** -- avoid light-gray-on-white text; use WCAG AA minimum (4.5:1 for normal text)
- **Screen reader-friendly ordering** -- logical DOM order matches visual order; use semantic HTML (`<nav>`, `<main>`, `<section>`, `<button>`)
- **Focus indicators** -- visible focus ring on interactive elements (do not remove `outline`)
- **Alt text** on images and icons that convey meaning
- **Error messages** associated with form fields via `aria-describedby`

Check for additional accessibility requirements in project documentation (e.g., WCAG AAA, specific assistive technology support).

**In code comments:**

```typescript
// a11y: Label describes the action for screen readers
<button aria-label="Save user preferences">Save</button>

// a11y: Error message linked to input for screen readers
<input aria-describedby="email-error" />
<span id="email-error" role="alert">Please enter a valid email</span>
```

---

## Testing Depth (TDD)

**All tests are written BEFORE implementation code** using the detected testing framework. If no testing framework is detected, default to the standard for the stack (Jest for React/Node, Pytest for Python, Vitest for Vite-based projects).

**TDD workflow per test tier:**

### 1. Unit Tests (Core Logic) — Written First

- Write tests for every function with business logic BEFORE implementing the function
- Include edge cases: null inputs, empty arrays, boundary values
- Include error handling: what happens when things fail
- Run tests → confirm they fail → then implement

### 2. Integration Tests (Main User Flow) — Written First

- Write tests for the primary happy path BEFORE building the flow
- Write tests for API endpoint responses (status codes, response shapes)
- Write tests for database operations if applicable (create, read, update, delete)
- Run tests → confirm they fail → then implement

### 3. Edge Case Tests (Error States) — Written First

- Write tests for invalid inputs BEFORE adding validation
- Write tests for missing required fields
- Write tests for unauthorized access (if auth exists)
- Write tests for network failures / timeouts (mock these)
- Run tests → confirm they fail → then implement

**Target:** 80% coverage of new code. Always include test data fixtures.

**Test file naming:**

- `[feature].test.ts` for unit tests
- `[feature].integration.test.ts` for integration tests
- `__fixtures__/[feature]-data.ts` for test data

**In the summary document, report:**

```markdown
## Testing

**Framework:** [Jest/Vitest/Pytest]
**Tests written:** [X] unit, [Y] integration, [Z] edge case
**Coverage:** [%] (of new code)
**All passing:** [Yes/No]
**Manual testing needed:** [List specific flows to test manually]
```

---

## Integration with Other Skills

**Before:**

- `/catalyst-dev:create-plan` - Create a detailed implementation plan first (for complex features)
- `/catalyst-dev:research-codebase` - Research existing patterns before building

**After:**

- `/catalyst-dev:commit` - Commit the implementation
- `/catalyst-dev:create-pr` - Create a pull request for review
- `/catalyst-dev:validate-plan` - Verify implementation matches requirements

---

## Output Quality Self-Check

Before delivering the first draft, verify:

- [ ] **Implementation plan was approved** -- PM confirmed the plan before code was written
- [ ] **Existing code patterns followed** -- New code matches the codebase's naming conventions, file structure, and architectural patterns
- [ ] **PRD requirements covered** -- Every acceptance criterion from the PRD maps to implemented code
- [ ] **TDD followed** -- Tests were written BEFORE implementation code (Red → Green → Refactor)
- [ ] **Tests written and passing** -- Unit tests for core logic, integration test for main flow, edge case tests for error states
- [ ] **Test coverage target met** -- At least 80% coverage of new code
- [ ] **Accessibility included** -- ARIA labels, keyboard navigation, focus indicators, semantic HTML (for UI features)
- [ ] **No codebase = Prototype Mode** -- If no codebase detected, standalone reference implementation generated with setup instructions
- [ ] **Tech stack checked** -- Matches company stack from business-info or defaults noted
- [ ] **Edge cases handled** -- Error states, empty states, loading states, and validation are implemented
- [ ] **Inline comments for complex logic** -- Non-obvious code is explained; TODOs are marked for future work
- [ ] **Summary document complete** -- Files created/modified, test coverage, known issues, and next steps documented
- [ ] **Output saved to correct path** -- Summary at `thoughts/shared/prototypes/[feature]-first-draft.md`, not `thoughts/shared/development/`

If any check fails, fix it before delivering. A first draft with failing tests or missing accessibility is not ready to share.
