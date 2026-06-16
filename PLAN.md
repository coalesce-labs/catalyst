# CTL-1176 Implementation Plan: LLM Recovery Sweep

## Goal
Build rung 3 (LLM tier) of the self-healing recovery ladder that reasons over stuck/failed/needs-human tickets and either autonomously fixes them or escalates genuine human decisions.

## Architecture Overview

### 3-Rung Ladder
1. **Deterministic seams** (CTL-1219, CTL-1219) — registered typed fixes
2. **Evidence capture** (CTL-937) — diagnostician's forensics (DARK, shipped)
3. **THIS — LLM reasoning recovery** — DIAGNOSE → PROPOSE → GUARDED-FIX

### Flow: DIAGNOSE → PROPOSE → GUARDED-FIX

**DIAGNOSE (read-only):** Reuse `diagnostician.captureEvidence()` from CTL-937
- `claude logs` + job state + stuck signal + belief state
- No writes

**PROPOSE (side-effect free):** Classify per CTL-828 boundary
- **DETERMINISTIC** — invoke unstuck-sweep seam (CTL-1219)
- **BOUNDED-LLM** — one capped phase-remediate run (CTL-653)
- **HUMAN** — escalate to executive-notification

**GUARDED-FIX (act + verify):**
- One seam call OR one capped remediate run (never both, never open-ended)
- Record recovery-pass intent + cooldown
- Post audit comment with action log
- Emit recovery outcome event
- Stop for that item

## Implementation Tasks

### 1. Create `recovery-reasoning.mjs`
- Export `reasoningRecoveryPass(items, opts)` — the main entry point
- Parameters:
  - `items` — stuck/failed/needs-human tickets with their signals + evidence
  - `opts` — injectable:
    - `classifyTicket(evidence)` → {reason, fix_class, details}
    - `invokeSeam(ticket, seam_id, brief)` → {success, reason}
    - `invokeRemediateCapped(ticket, brief)` → {success, reason, attempts}
    - `recordIntent(ticket, intent)` → void
    - `postComment(ticket, comment)` → void
    - `emitEvent(event)` → void
    - `shouldSkipItem(ticket)` → boolean (cooldown, already escalated)

### 2. Implement LLM Classification (`classifyTicket`)
Decision tree per CTL-828:
- Input: evidence envelope (logs, job state, signal, belief state)
- Output: {reason: "deterministic" | "bounded-llm" | "human", fix_class: "...", details: {}}
- Classify by root cause:
  - **Deterministic** if: typed error in logs matching known seam registry (CTL-1219)
  - **Bounded-LLM** if: small + verifiable fix (e.g., "rebase needed", "clear cache")
  - **Human** if: trade-off, approval, untyped, ambiguous

### 3. Integrate Existing Systems
- **diagnostician.captureEvidence()** for DIAGNOSE phase
- **CTL-1219 seam registry** (when available) for DETERMINISTIC case
- **phase-remediate** wrapper for BOUNDED-LLM case (hard cycle cap from CTL-653)
- **escalation-explanation.mjs** for structured escalation payload
- **label-guard.mjs** cooldown logic (reuse diagnostician's dual-layer cooldown)
- **event-cursor.mjs** for recovery outcome event tracking

### 4. Emission & Records
- **recovery-pass intent** — ticket, decision (fix/escalate), seam_id/brief, outcome
- **recovery.would-fix** event (shadow mode) — decision + what would happen
- **recovery.would-escalate** event (shadow mode)
- **recovery.fixed** event (enforce mode) — decision + what happened + verification
- **recovery.escalated** event (enforce mode)

### 5. Guarding & Safety
- **Turn cap** — single read pass per item per invocation (no loops)
- **Action gate** — one seam OR one remediate, never both
- **Cooldown** — reuse diagnostician's dual-layer (R11 + max_attempts=2 → R12 force escalate)
- **No re-dispatch** — never spawn phase workers directly; only hand briefs to remediate
- **Fenced like phase worker** — claim / turn-cap / reclaim-eligible

### 6. Rollout Strategy
- **OFF** → **SHADOW** (emit `recovery.would-*` events, post evidence, invoke NO seams)
- **ENFORCE** (after shadow shows proposals match operator decisions)
- Config: `catalyst.recoveryPass.mode` ∈ {off, shadow, enforce}
- Env kill-switch: `CATALYST_RECOVERY_PASS`

### 7. Testing
Shadow-mode test harness:
- Drive a stuck queue with typed + untyped items
- Assert correct classification (DETERMINISTIC / BOUNDED-LLM / HUMAN)
- Assert events emitted correctly
- Assert intents recorded + cooldown honored
- Assert max_attempts → escalate forces escalation
- No actual seam invocation or remediate dispatch

## Dependencies (Blocked-by/Uses)
- **Blocked-by** CTL-1219 (unstuck-sweep seams) — can stub for shadow mode
- **Uses** CTL-937 (diagnostician evidence)
- **Uses** CTL-828 (guardrail pattern)
- **Uses** CTL-653 (remediate envelope + cap)

## Defaults (Shadow Mode)
By default, ship in SHADOW mode (off):
- Classify all items
- Emit `recovery.would-*` events
- Post diagnoses as comments
- Record intents
- Invoke NO seams, spawn NO workers
- Operator can inspect results in event log + comments before enabling enforce

## Commit Convention
```
feat(dev): CTL-1176 — LLM recovery reasoning pass (shadow/off mode)
```

## Verification
- Unit tests for classification logic
- Integration test for full flow (all three paths)
- Shadow-mode test with mixed queue (deterministic + bounded-llm + human items)
- No regressions in existing recovery/reclaim logic
