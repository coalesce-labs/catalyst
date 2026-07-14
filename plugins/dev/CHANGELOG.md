# Changelog

## [12.29.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.29.0...catalyst-dev-v12.29.1)

Jul 14, 2026

<!-- ai-enhanced -->

### Thenable-Aware Removal Confirmation

The `removeLabel` async bug is fixed — previously, inspecting a Promise's `.removed` property always returned `undefined`, so failed removals were silently treated as successful. The fix makes the result handler thenable-aware, deferring the admission clear emission until the async write actually resolves or rejects.



### PRs

* **dev:** CTL-764 follow-up — round-5: thenable-aware removal confirmation ([#2636](https://github.com/coalesce-labs/catalyst/issues/2636)) ([2df9d10](https://github.com/coalesce-labs/catalyst/commit/2df9d109504f8f8dad451bd4bd0d24a7dd186799))

## [12.29.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.28.0...catalyst-dev-v12.29.0)

Jul 13, 2026

<!-- ai-enhanced -->

### Two-Axis Worker State Model

Worker state transitions now fan out through a single `recordTransition` chokepoint that writes to all five sinks — Linear Status, worker-status label, event log, OTLP, and broker table — on every confirmed state change, with per-sink fail-open isolation so one unavailable sink can't block the others. A new `convergeDispositionLabel` function enforces full disposition precedence (`needs-human > needs-input > blocked > queued`), and the `worker-status` Linear label group is provisioned automatically by `setup-execution-core-states.sh`. The HUD queue UI now reflects the corrected disposition buckets, and `waiting` has been renamed to `queued` throughout.



### PRs

* **dev:** CTL-764 two-axis worker-state model — recordTransition chokepoint, worker-status labels, convergeDispositionLabel ([#2597](https://github.com/coalesce-labs/catalyst/issues/2597)) ([2ebbed3](https://github.com/coalesce-labs/catalyst/commit/2ebbed317d76f7963b2c22544c85060440e3f482))
* **dev:** CTL-764 follow-up — Codex round-3 emission gating + gitleaks allowlist (greens main) ([#2631](https://github.com/coalesce-labs/catalyst/issues/2631)) ([27781cf](https://github.com/coalesce-labs/catalyst/commit/27781cfd3df2d0ebe6efceb55d9bb26474b87a10))
* **dev:** CTL-764 follow-up — Codex round-4 emission/fallback edge cases ([#2632](https://github.com/coalesce-labs/catalyst/issues/2632)) ([3fa0429](https://github.com/coalesce-labs/catalyst/commit/3fa04294909c120fe30351ef8e8d6bf93e384f7b))
* **dev:** CTL-764 follow-up — declare synthesizeOrphanTickets in board-data.d.mts (greens main quality gate) ([#2630](https://github.com/coalesce-labs/catalyst/issues/2630)) ([96ea021](https://github.com/coalesce-labs/catalyst/commit/96ea0213ab6b7a6bafb2b325ecdfbe278dabc2aa))

## [12.28.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.27.0...catalyst-dev-v12.28.0)

Jul 09, 2026

<!-- ai-enhanced -->

### Liveness Off Linear

Cross-host dead-host detection now reads from Loki instead of Linear, eliminating the ~120 heartbeat writes per hour that were tripping the rate-limit breaker. Two live-deploy bugs in the initial reader were caught and fixed: stale streams no longer win the newest-host race, and in-flight ticket enrichment now runs as a separate fail-open query. The switch is gated behind `CATALYST_LIVENESS_READ_SOURCE=loki` — set it on all hosts simultaneously to enable; unset to revert instantly.



### PRs

* **dev:** CTL-1420 ([#17](https://github.com/coalesce-labs/catalyst/issues/17)) — move cross-host liveness off Linear → event log + Loki (PR1a: heartbeat carries in-flight tickets) ([#2575](https://github.com/coalesce-labs/catalyst/issues/2575)) ([ff99913](https://github.com/coalesce-labs/catalyst/commit/ff9991380ea87f283df83ccc3318f9ef44ca0bf1))
* **dev:** CTL-1420 ([#17](https://github.com/coalesce-labs/catalyst/issues/17)) — read cross-host liveness from Loki + retire the Linear heartbeat publish (PR1b) ([#2604](https://github.com/coalesce-labs/catalyst/issues/2604)) ([9924aa2](https://github.com/coalesce-labs/catalyst/commit/9924aa2f94f03a7613a8df6bfdb56be06ce1314f))
* **dev:** CTL-1420 ([#17](https://github.com/coalesce-labs/catalyst/issues/17)) follow-up — loki-liveness reader: newest-across-streams + two-query tickets ([#2606](https://github.com/coalesce-labs/catalyst/issues/2606)) ([4aa925b](https://github.com/coalesce-labs/catalyst/commit/4aa925bf95e830ebf591f92da90536a4efb48172))
* **dev:** CTL-1443 follow-up — sync CLI reference for boot-resume-approve (unblocks CI) ([#2603](https://github.com/coalesce-labs/catalyst/issues/2603)) ([7d34bd8](https://github.com/coalesce-labs/catalyst/commit/7d34bd8a0aaacc8081d44f7dbe08e8ce324da581))
* **dev:** CTL-1451 (A4 final widening) — probeBackoff on the recovery-filter + reclaim terminal reads (kills the ADV-1433 read-storm) ([#2608](https://github.com/coalesce-labs/catalyst/issues/2608)) ([6d4928f](https://github.com/coalesce-labs/catalyst/commit/6d4928f34a463aa3e31f9f59a06dcbcd4f5f0f6f))
* **dev:** CTL-1452 — parity test exempts action:skip STALL_CATEGORY_MAP entries (restores exec-core CI on main) ([#2610](https://github.com/coalesce-labs/catalyst/issues/2610)) ([6e550ba](https://github.com/coalesce-labs/catalyst/commit/6e550baad3517eca8dbdce9bc93a5d474e2612c8))

## [12.27.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.26.0...catalyst-dev-v12.27.0)

Jul 08, 2026

<!-- ai-enhanced -->

### Recovery Loop Elimination & Escalation Fixes

This release closes five compounding loops that caused the recovery pass to silently discard verdicts, re-triage tickets indefinitely, and emit no-progress escalations forever. Recovery-pass sessions now persist a single verdict (`fixed`, `leave-alone`, or `escalate`) to the event log, ledger, and Linear in every case — and exhausted intents surface loudly as needs-human with a rendered brief instead of latching silently. Infinite escalation loops are capped and go terminal, triage re-dispatches are bounded per ticket, and the boot-resume approval gate finally has a CLI (`boot-resume-approve.mjs --list` / `<ticket>`) so gated recovery passes can actually be unblocked.



### PRs

* **dev:** CTL-1439 (P0a) — recovery-pass verdict persistence + surfacing (stop act-and-discard) ([#2586](https://github.com/coalesce-labs/catalyst/issues/2586)) ([af29551](https://github.com/coalesce-labs/catalyst/commit/af295516601800db3ccbddb0a3af2ebcabfc661f))
* **dev:** CTL-1440 (P0b) — attempts-exhausted → loud escalation, RC3 defer-storm decoupling, truthful skip reasons ([#2593](https://github.com/coalesce-labs/catalyst/issues/2593)) ([1ef0e57](https://github.com/coalesce-labs/catalyst/commit/1ef0e57f34c671d2f5d5455ba5530f5dcf35d601))
* **dev:** CTL-1443 (P1-loop-3) — operable boot-resume approval gate (approve CLI + 48h expiry into Needs-You + alert) ([#2596](https://github.com/coalesce-labs/catalyst/issues/2596)) ([a6aa271](https://github.com/coalesce-labs/catalyst/commit/a6aa2716bc303453ce54142c8611557ec2ecf4f6))
* **dev:** CTL-1441 (P1-loop-2) — terminate the triage re-dispatch loop (cap + mismatch surfacing + WORKER_DIR hardening) ([#2588](https://github.com/coalesce-labs/catalyst/issues/2588)) ([9dd5309](https://github.com/coalesce-labs/catalyst/commit/9dd5309ebfa6185bd748f9f62badcec06ee33e7e))
* **dev:** CTL-1442 (P1-loop-1) — no-progress escalations go terminal after N asks (stop the every-10-min forever loop) ([#2590](https://github.com/coalesce-labs/catalyst/issues/2590)) ([001557c](https://github.com/coalesce-labs/catalyst/commit/001557cd7ce6498496c8cd0b16e6c840391c3d1f))

## [12.26.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.25.0...catalyst-dev-v12.26.0)

Jul 08, 2026

<!-- ai-enhanced -->

### Linear Read Observability & Actuation Liveness

Every Linear read now emits a `catalyst.linear.read` event with `source` and `result` attributes, so your OTEL collector can derive read totals and a staleness histogram — and alert on replica bypasses before the 429 breaker trips. The delegate's board-scan events now record whether a proposed move was actually dispatched, and a new `checkActuationLiveness` invariant flags sustained propose-but-never-dispatch conditions automatically. A negative cache on terminal-probe and census reads stops replica-miss tickets from firing live Linear reads every tick, which was the primary driver of breaker flaps.



### PRs

* **dev:** CTL-1403 — emit reads-by-source (catalyst.linear.read{source,result}) on every Linear read ([#2582](https://github.com/coalesce-labs/catalyst/issues/2582)) ([d23e8b1](https://github.com/coalesce-labs/catalyst/commit/d23e8b15ac71c8a020c85b950dc76ca6802c00fa))
* **dev:** CTL-1435 (WS-C C1+C2) — self-observing actuation-liveness (act-outcome on board-scan + checkActuationLiveness invariant) ([#2576](https://github.com/coalesce-labs/catalyst/issues/2576)) ([06bb61f](https://github.com/coalesce-labs/catalyst/commit/06bb61f29c0afbf6830861d0fd82d2a9ea6c3794))
* **dev:** CTL-1436 (WS-A A4) — negative-cache fetchTicketState replica-MISS live reads (stop the issues-read breaker flap) ([#2579](https://github.com/coalesce-labs/catalyst/issues/2579)) ([7f99ddc](https://github.com/coalesce-labs/catalyst/commit/7f99ddcbad765101540d6581928f4667b1136c69))
* **dev:** CTL-1437 (A4 follow-up) — widen probeBackoff to the every-tick terminal-Done sweep ([#2581](https://github.com/coalesce-labs/catalyst/issues/2581)) ([52d58cc](https://github.com/coalesce-labs/catalyst/commit/52d58cc8e8cece98e950a27083c1c5ef8686c091))

## [12.25.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.24.0...catalyst-dev-v12.25.0)

Jul 07, 2026

<!-- ai-enhanced -->

### Linear Breaker Observability & Board Health Actuation

The Linear circuit breaker now records why it opened (rate-limit 429 vs. timeout) and which caller triggered it, making the 12–22 daily trips on mini attributable and falsifiable from logs for the first time. On the board-health side, deferred recovery intents now have a live consumer so they actually dispatch instead of rotting, operator-sanctioned needs-human latches are suppressed from re-proposal so genuinely stuck tickets surface, and stale escalated recovery intents expire after 7 days instead of pinning tickets in needs-human forever. The top measured breaker driver — eligible empty-reconfirm firing a live Linear read every quiet tick — is also removed entirely; a replica-empty is now trusted directly with zero live Linear reads.



### PRs

* **dev:** CTL-1430 (WS-A A1) — instrument the Linear breaker (reason+caller on OPEN + durable linear.ratelimit.breaker event) ([#2565](https://github.com/coalesce-labs/catalyst/issues/2565)) ([ec03e6f](https://github.com/coalesce-labs/catalyst/commit/ec03e6ff5fef75845cccdc4edaa9141b782107e5))
* **dev:** CTL-1431 (WS-B B1) — TTL on terminal recovery-intents + one-time June sweep ([#2567](https://github.com/coalesce-labs/catalyst/issues/2567)) ([9c5bb13](https://github.com/coalesce-labs/catalyst/commit/9c5bb13487f3c66ce5bd87d86ea4871f8ee1a392))
* **dev:** CTL-1432 (WS-B B2+B3) — dispatch deferred board-health intents + suppress sanctioned needs-human latches ([#2570](https://github.com/coalesce-labs/catalyst/issues/2570)) ([880261e](https://github.com/coalesce-labs/catalyst/commit/880261eb7e487ef39ecba6199a359c9d741e1ba9))
* **dev:** CTL-1433 (WS-A A2) — raise the eligible empty-reconfirm TTL above the reconcile interval (cut the top breaker driver, keep drift validation) ([#2572](https://github.com/coalesce-labs/catalyst/issues/2572)) ([96ea944](https://github.com/coalesce-labs/catalyst/commit/96ea944ce707f0feacb7ed473be0523fff276889))

## [12.24.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.23.1...catalyst-dev-v12.24.0)

Jul 04, 2026

<!-- ai-enhanced -->

### Durable Fence Event Log & Done Path Fix

The fence write path now appends durable `fence.claimed`/`fence.released` events to the canonical event log instead of relying solely on Linear, eliminating the risk of fence emits triggering the admission freeze. A bug in `fenceGuard` that caused it to compare the wrong generation counter — blocking every ticket from reaching `Done` automatically on multi-host rosters — is now fixed by reading the correct cross-host claim generation from `cluster-generation.json`. Pino log levels are also now mapped to OTel `SeverityNumber`/`SeverityText` at emit time, so operational logs no longer arrive in Loki as UNKNOWN severity.



### PRs

* **dev:** CTL-1424 — otel-forward pino level → OTel SeverityNumber/Text at emit ([#2558](https://github.com/coalesce-labs/catalyst/issues/2558)) ([514fd7e](https://github.com/coalesce-labs/catalyst/commit/514fd7eb818ee999d202b82918ee04130f163a7a))
* **dev:** CTL-863 — durable fence→event-log migration (N=1-gated), supersedes the interim ReadFence cache ([#2553](https://github.com/coalesce-labs/catalyst/issues/2553)) ([0e70424](https://github.com/coalesce-labs/catalyst/commit/0e704242c402233b1713ec098a888e0f1590c3f4))
* **dev:** CTL-1157 (A1) — fence-guard reads the cross-host claim generation (unblocks the Done path) ([#2563](https://github.com/coalesce-labs/catalyst/issues/2563)) ([cb35036](https://github.com/coalesce-labs/catalyst/commit/cb35036f324b3167917d99cde786089819710d15))

## [12.23.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.23.0...catalyst-dev-v12.23.1)

Jul 03, 2026

<!-- ai-enhanced -->

### Linear Rate-Limit Freeze Fixes

A cluster of fixes targeting the shared Linear bucket saturation that was freezing fleet dispatch and silently stalling replicas. Fence-guard reads are now cached (45s TTL), anchor UUID lookups are cached permanently, and dispatch reads route through the replica instead of hitting Linear live — together dropping breaker trips from ~18 per 3 minutes to near zero. A cloud-sync stall watchdog now detects frozen replica sockets and self-heals via process restart rather than sitting silent for hours, and interactive `claude` sessions now load plugins from `~/catalyst/plugin-source` on the same path as workers.



### PRs

* **dev:** cloud-sync stall watchdog + loud alert — stop silent replica freezes ([#2547](https://github.com/coalesce-labs/catalyst/issues/2547)) ([fd74bda](https://github.com/coalesce-labs/catalyst/commit/fd74bda299288d5ca6992e1b438cb1e83cd9312d))
* **dev:** cluster-heartbeat — back off the shared bucket on a rate-class Linear 400/429 (CTL-1420 follow-up) ([#2539](https://github.com/coalesce-labs/catalyst/issues/2539)) ([01d8844](https://github.com/coalesce-labs/catalyst/commit/01d88449f3845db47f33bad6ec346a0797e8a71e))
* **dev:** CTL-1420 — dispatch reads via replica (Stage 0: ownership→replica, eligible breaker-aware) ([#2551](https://github.com/coalesce-labs/catalyst/issues/2551)) ([32f34dd](https://github.com/coalesce-labs/catalyst/commit/32f34dd39780ab1846ff77fdab6a97fb0976784b))
* **dev:** CTL-863 — cache the fence entourage (ResolveIssueId anchor-UUID + GetIssueByIdentifier) to fully clear the shared bucket ([#2554](https://github.com/coalesce-labs/catalyst/issues/2554)) ([19e5a66](https://github.com/coalesce-labs/catalyst/commit/19e5a66f625db000a9806d354f33d4253146ca49))
* **dev:** CTL-863 — interim in-process TTL cache for fence ReadFence to unfreeze the shared Linear bucket ([#2552](https://github.com/coalesce-labs/catalyst/issues/2552)) ([3cc975e](https://github.com/coalesce-labs/catalyst/commit/3cc975e60755fa9c131ee45c2ef986036f3aa5d5))
* **dev:** standard plugin-source loading for interactive sessions + drop marketplace guidance ([#2549](https://github.com/coalesce-labs/catalyst/issues/2549)) ([8c96b1f](https://github.com/coalesce-labs/catalyst/commit/8c96b1faa74c9642cb0bc7b1176557f149c477aa))

## [12.23.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.22.0...catalyst-dev-v12.23.0)

Jul 02, 2026

<!-- ai-enhanced -->

### Warm Resume & Replica-First Reads

A daemon restart now continues in-flight SDK work from its existing transcript instead of cold-restarting — making fleet-wide stop/restart-all a routine, low-cost operation. Alongside that, replica-first Linear reads are now a standard reflex across every agent path: enforced in core context, phase-worker preambles, and a new PreToolUse hook that can catch and block bare `linearis issues read` calls before they hit the rate-limited API key.



### PRs

* **dev:** CTL-1397 enforcement — replica-first Linear reads as a standard prerequisite reflex ([#2543](https://github.com/coalesce-labs/catalyst/issues/2543)) ([98dfbac](https://github.com/coalesce-labs/catalyst/commit/98dfbac7216d6ede87b6edf22d690b1188d7cbd1))
* **dev:** CTL-1422 — warm resume: a daemon restart continues in-flight SDK work ([#2544](https://github.com/coalesce-labs/catalyst/issues/2544)) ([cca2892](https://github.com/coalesce-labs/catalyst/commit/cca2892b8182a5f9a8b93cf7c812d9337c5ea566))

## [12.22.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.21.0...catalyst-dev-v12.22.0)

Jul 02, 2026

<!-- ai-enhanced -->

### SDK Worker Registry & Fleet Resilience

This release introduces a unified in-process SDK worker registry that tracks live workers with heartbeats, sticky abort semantics, and disk projections — closing the liveness blind spots that left the scheduler, delegate queue, and worktree refresh timer unable to see workers running outside the bg executor. Alongside that, a Linear quota storm can no longer freeze fleet admission: when the circuit breaker is open, a provably-real replica-empty is now trusted directly instead of looping into a failing linearis reconfirm. Agent reads also move off the `catalyst-linear` CLI to direct SQLite queries against the local replica, giving agents full join support and a single, well-defined freshness rule; `catalyst-linear` is now a deprecated shim.



### PRs

* **dev:** CTL-1157 — Self-Healing Delegate wave 1 (board-health sees + acts on stuck work; shadow-gated, dark merge) ([#2503](https://github.com/coalesce-labs/catalyst/issues/2503)) ([32d2218](https://github.com/coalesce-labs/catalyst/commit/32d2218b962467ed8e3307e6146f3d657fb030d5))
* **dev:** CTL-1397 — pivot agent Linear reads to direct SQLite; deprecate catalyst-linear CLI ([#2514](https://github.com/coalesce-labs/catalyst/issues/2514)) ([249c9d6](https://github.com/coalesce-labs/catalyst/commit/249c9d67c12d58f79aa07fa44289afa57b29c5db))
* **dev:** CTL-1402 — bump @catalyst-cloud/sdk → ^0.3.1 + telemetry:true (replica apply-failures observable) ([#2517](https://github.com/coalesce-labs/catalyst/issues/2517)) ([0e2883f](https://github.com/coalesce-labs/catalyst/commit/0e2883f675bf8ddc07b9793c24a0b512015e2e97))
* **dev:** CTL-1410 (Phase A) — in-band terminal signal flips for event-only phases + SDK success safety net ([#2524](https://github.com/coalesce-labs/catalyst/issues/2524)) ([ba06b66](https://github.com/coalesce-labs/catalyst/commit/ba06b66b01367091d3badfb107324d29d31c9135))
* **dev:** CTL-1410 (Phase B) — unified in-process SDK worker registry + liveness re-points ([#2529](https://github.com/coalesce-labs/catalyst/issues/2529)) ([89fd452](https://github.com/coalesce-labs/catalyst/commit/89fd45209aed6fcbee213d6a4decf49c950a0fb8))
* **dev:** CTL-1421 — doctor asserts the worker plugin path is a fresh pristine plugin-source ([#2537](https://github.com/coalesce-labs/catalyst/issues/2537)) ([e1c48f3](https://github.com/coalesce-labs/catalyst/commit/e1c48f310b49d638c59955943acd79b31ddf1c51))
* **dev:** catalyst-cloud[#127](https://github.com/coalesce-labs/catalyst/issues/127) — bump @catalyst-cloud/sdk → ^0.4.0 (forward-compat filter + auto-reseed backfill) ([#2525](https://github.com/coalesce-labs/catalyst/issues/2525)) ([3d4bc40](https://github.com/coalesce-labs/catalyst/commit/3d4bc40e174a7e03d4f98bded60c0186e2118e7b))
* **dev:** CTL-1416 — bash-3.2-safe emit-complete session-end + hermetic thoughts fixture for its tests ([#2535](https://github.com/coalesce-labs/catalyst/issues/2535)) ([aaeba1e](https://github.com/coalesce-labs/catalyst/commit/aaeba1e7bc04b9f12cf116294d12e84325818d1b))
* **dev:** CTL-1416 — make `phase-agent-emit-complete` bash-3.2-safe ([aaeba1e](https://github.com/coalesce-labs/catalyst/commit/aaeba1e7bc04b9f12cf116294d12e84325818d1b))
* **dev:** CTL-1418 — quiet catalyst-agent's pino-unavailable shim notice ([#2533](https://github.com/coalesce-labs/catalyst/issues/2533)) ([7aa8af4](https://github.com/coalesce-labs/catalyst/commit/7aa8af48e43252b6d5ee838eac88722b1ad73050))
* **dev:** CTL-1420 — unfreeze fleet admission during a Linear quota storm ([#2538](https://github.com/coalesce-labs/catalyst/issues/2538)) ([b2955e1](https://github.com/coalesce-labs/catalyst/commit/b2955e1c4f92f66f9a8c06ce071911773467144c))

## [12.21.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.20.0...catalyst-dev-v12.21.0)

Jul 01, 2026

<!-- ai-enhanced -->

### Linear Replica Board Discovery

All Linear reads in dispatched agents now route through the local Catalyst Cloud replica via `catalyst-linear`, eliminating the rate-limit burns and board freezes that were stalling the fleet. Discovery now gates on the writer heartbeat lock rather than WAL mtime, so quiet feeds stay replica-served instead of falling through to the API. Two telemetry gaps are also fixed: phase-turns events were wired to the wrong parameter and never reached the event log, and SDK workers were missing their Claude Code OTel metrics because the daemon env lacked the OTLP endpoint.



### PRs

* **dev:** CTL-1397 — replica-backed board-list discovery (board-freeze unstick) ([#2502](https://github.com/coalesce-labs/catalyst/issues/2502)) ([5392229](https://github.com/coalesce-labs/catalyst/commit/53922299a6099800667dbd515714bd56591035b5))
* **dev:** CTL-1397 — route remaining skill-prose Linear reads through catalyst-linear ([#2511](https://github.com/coalesce-labs/catalyst/issues/2511)) ([00ec028](https://github.com/coalesce-labs/catalyst/commit/00ec028c2f1680018073e4c0e3f87324dda37b19))
* **dev:** CTL-1397 (1/n) — mandate Linear reads via catalyst-linear (linearis skill + research agents) ([#2496](https://github.com/coalesce-labs/catalyst/issues/2496)) ([27ab1fe](https://github.com/coalesce-labs/catalyst/commit/27ab1fe5e242f7ac69bc9d7750b1dbd4ee79c1f8))
* **dev:** CTL-1397 (2/n) — route per-dispatch Linear reads through the replica (catalyst-linear) ([#2501](https://github.com/coalesce-labs/catalyst/issues/2501)) ([8a3e336](https://github.com/coalesce-labs/catalyst/commit/8a3e3362649b24ea6a43d0fd78aace3cf66637d0))
* **dev:** CTL-1397 (3/n) — trust the seed-complete replica-empty (durable board-freeze unstick) ([#2509](https://github.com/coalesce-labs/catalyst/issues/2509)) ([36482e7](https://github.com/coalesce-labs/catalyst/commit/36482e79d187f21c6c9ca9805d704819cc7677b4))
* **dev:** CTL-1397 (4/n) — gate replica discovery on the writer heartbeat lock (close the quiet-feed linearis fallback) ([#2512](https://github.com/coalesce-labs/catalyst/issues/2512)) ([edd4b58](https://github.com/coalesce-labs/catalyst/commit/edd4b58901f006eec3ca2ad6088ae3feecf8664f))
* **dev:** CTL-1406 — SDK phase workers emit session.context (dashboard panels 50/51) ([#2508](https://github.com/coalesce-labs/catalyst/issues/2508)) ([2ab5f57](https://github.com/coalesce-labs/catalyst/commit/2ab5f57a8f352116a09649a0870480fadd4ff5db))
* **dev:** CTL-1404 — SDK phase-agent workers emit claude_code_* OTel again (daemon env lacked the OTLP endpoint) ([#2504](https://github.com/coalesce-labs/catalyst/issues/2504)) ([1b726bb](https://github.com/coalesce-labs/catalyst/commit/1b726bb37ed72e5e551c160f9b7f315c2933b087))
* **dev:** CTL-1405 — sdkDispatch passes emitEvent in the wrong param → phase-turns telemetry never reached the event log ([#2500](https://github.com/coalesce-labs/catalyst/issues/2500)) ([6795089](https://github.com/coalesce-labs/catalyst/commit/6795089b9f10e584a63d96c4e6bca39c704c2274))
* **dev:** CTL-1407 — provision the per-account rate-limit usage sampler on every host ([#2507](https://github.com/coalesce-labs/catalyst/issues/2507)) ([58f040e](https://github.com/coalesce-labs/catalyst/commit/58f040eafd2284f8dbe108d4a87e62e7794a43e1))

## [12.20.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.19.0...catalyst-dev-v12.20.0)

Jun 30, 2026

<!-- ai-enhanced -->

### Linear Replica & SDK Executor Hardening

This release wires up the full infrastructure for agents to read Linear from a local Catalyst Cloud replica instead of hitting the rate-limited API directly — including the new `catalyst-linear` CLI that reads the replica first and falls back to `linearis`, and a supervised per-node replica writer that keeps the local DB fresh on every node class. The SDK executor path gets two security and correctness fixes (token scrubbing on rejection, same-tick slot budget), plus a daemon launcher fix that ensures the OAuth token survives non-login restarts so `executor=sdk` no longer silently falls back to `bg`. Run `catalyst install --executor sdk` to provision the executor lever and cloud-sync writer together without regression.



### PRs

* **dev:** CTL-1369 (4/n) — class-aware doctor install verification + phase_duration_ms promotion ([#2469](https://github.com/coalesce-labs/catalyst/issues/2469)) ([99e3231](https://github.com/coalesce-labs/catalyst/commit/99e32314016c8716260c56a6e67406771171df88))
* **dev:** CTL-1383 — uniform -h/--help + bare-usage on user-facing catalyst-* CLIs ([#2459](https://github.com/coalesce-labs/catalyst/issues/2459)) ([0b137a8](https://github.com/coalesce-labs/catalyst/commit/0b137a8bc35a7aea467f7fb79044f62e07f4b727))
* **dev:** CTL-1387 — consolidated catalyst CLI reference page + cannot-drift guard ([#2468](https://github.com/coalesce-labs/catalyst/issues/2468)) ([d989dc0](https://github.com/coalesce-labs/catalyst/commit/d989dc0fb264c460586f84f53532ee5535524db1))
* **dev:** CTL-1391 — catalyst-linear, the replica-first Linear read CLI (linearis fallback) ([#2477](https://github.com/coalesce-labs/catalyst/issues/2477)) ([f1746ad](https://github.com/coalesce-labs/catalyst/commit/f1746ad1dde713a56c0d8ae276e7ff5cca1d34f5))
* **dev:** CTL-1392 — agents read the Catalyst Cloud replica first (evidence-based fallback) ([#2474](https://github.com/coalesce-labs/catalyst/issues/2474)) ([5599fe9](https://github.com/coalesce-labs/catalyst/commit/5599fe954ac859adc2db153a0c93a55eceb8780c))
* **dev:** CTL-1393 — cluster nodes auto-detect + refresh rotated SOPS secrets (loudly) ([#2478](https://github.com/coalesce-labs/catalyst/issues/2478)) ([bc652ee](https://github.com/coalesce-labs/catalyst/commit/bc652ee8f7356e4deceadc7b3e009b16a55e69b7))
* **dev:** CTL-1394 — per-node supervised CatalystReplica writer (unblock mini/mini-2 Linear rate limits) ([#2481](https://github.com/coalesce-labs/catalyst/issues/2481)) ([5cca4c5](https://github.com/coalesce-labs/catalyst/commit/5cca4c5bffa1b3be04edd39b704d7ebaead17ebd))
* **dev:** CTL-1395 (1/n) — catalyst-cloud-sync heartbeat + freshness → Loki (uptime tile + OTL-40 signal) ([#2488](https://github.com/coalesce-labs/catalyst/issues/2488)) ([dbd79d6](https://github.com/coalesce-labs/catalyst/commit/dbd79d6f626b09311a9429e422ae55ceaca88b09))
* **dev:** CTL-1396 — make the SDK-executor rollout verifiable (doctor running-daemon check + phase-turns telemetry) ([#2484](https://github.com/coalesce-labs/catalyst/issues/2484)) ([59ac079](https://github.com/coalesce-labs/catalyst/commit/59ac0794be31bf0098ee762450342e446328af36))
* **dev:** CTL-1401 — catalyst install/reinstall provisions the cloud-sync + executor levers (no reinstall regression) ([#2492](https://github.com/coalesce-labs/catalyst/issues/2492)) ([e964afe](https://github.com/coalesce-labs/catalyst/commit/e964afedda503e0cf1765eb1675bb6b460f608f9))
* **dev:** CTL-1367 — close the 2 final pre-canary SDK-executor gates (token-scrub on rejection path + same-tick SDK slot budget) ([#2475](https://github.com/coalesce-labs/catalyst/issues/2475)) ([160df09](https://github.com/coalesce-labs/catalyst/commit/160df094535a9a30e21c64f17f5292a5eddf3a57))
* **dev:** CTL-1372 — serve orch-monitor as a production React build (root-cause leak fix) ([#2453](https://github.com/coalesce-labs/catalyst/issues/2453)) ([0df476b](https://github.com/coalesce-labs/catalyst/commit/0df476b5e91398b0e63b6dc994e4cf5480fc381e))
* **dev:** CTL-1382 — thin-launcher catalyst CLIs resolve their symlink before locating their driver ([#2465](https://github.com/coalesce-labs/catalyst/issues/2465)) ([3e8d78c](https://github.com/coalesce-labs/catalyst/commit/3e8d78c7e0115e8c92c9e979467430bd6f693cd5))
* **dev:** CTL-1385 — board rows use wrong design tokens (bright dividers + selected-state bg) ([#2462](https://github.com/coalesce-labs/catalyst/issues/2462)) ([0e223b7](https://github.com/coalesce-labs/catalyst/commit/0e223b78ec62dddf9e03784658218c66bd92d44f))
* **dev:** CTL-1398 — daemon launcher sources claude-accounts.env so executor=sdk survives non-login restarts on every host ([#2487](https://github.com/coalesce-labs/catalyst/issues/2487)) ([bf5087e](https://github.com/coalesce-labs/catalyst/commit/bf5087e7d332fb38de50dee92aa7bd78a0319a9e))

## [12.19.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.18.0...catalyst-dev-v12.19.0)

Jun 29, 2026

<!-- ai-enhanced -->

### Per-Class Install Lifecycle

`catalyst install`, `uninstall`, and `reinstall` now work per node class — worker nodes get broker/exec-core/monitor daemons, developer and monitor nodes get the updater agent, and the distinction is enforced. Each run is a fully observable OTEL trace with phase-by-phase telemetry, automatic backup before any overwrite, and rollback to a known-good state if provisioning fails mid-flight. Use `--dry-run` to print the resolved plan for your node class before touching anything.



### PRs

* **dev:** CTL-1369 (3/n) — `catalyst install|uninstall|reinstall` per node class ([#2452](https://github.com/coalesce-labs/catalyst/issues/2452)) ([35339bb](https://github.com/coalesce-labs/catalyst/commit/35339bb8835cec1b4ad0105a4b9489ce74f5423c))
* **dev:** CTL-1374 — PWA self-recovers stale lazy chunks after a redeploy (cache-control + preloadError reload) ([#2447](https://github.com/coalesce-labs/catalyst/issues/2447)) ([416ecb9](https://github.com/coalesce-labs/catalyst/commit/416ecb986acd2a0b57640399c7770f355f581dc9))
* **dev:** CTL-1375 — private-repo favicons re-probe past the cached org avatar + token-scope doctor check ([#2445](https://github.com/coalesce-labs/catalyst/issues/2445)) ([01b5208](https://github.com/coalesce-labs/catalyst/commit/01b5208b825a53b04c83a8922659d639273cde8b))
* **dev:** CTL-1378 — board replica-title edges (parked fallback, queue payload, CATALYST_DIR) ([#2449](https://github.com/coalesce-labs/catalyst/issues/2449)) ([bb772a5](https://github.com/coalesce-labs/catalyst/commit/bb772a52828c501b90acf6ccae1822aeb1a1691a))

## [12.18.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.17.0...catalyst-dev-v12.18.0)

Jun 28, 2026

<!-- ai-enhanced -->

### Catalyst CLI Router & Node Backup

This release adds a top-level `catalyst` command that routes to all existing tools by verb (`start`, `stop`, `doctor`, `update`, and more), with any unrecognized subcommand auto-delegating to the matching `catalyst-<x>` script. Alongside it, `catalyst-backup` lets you snapshot a node's full restorable state — config, credentials, database, and daemon inventory — before any install or uninstall phase touches it, with a manifest-driven restore that refuses to run against a live node. The release also ships a completion-signal-driven Linear reconciler that moves tickets to Done only when work is explicitly declared complete, not inferred from PR events, and fixes two icon-picker recovery bugs where stale cached bundles and poisoned manifest promises left icons blank even after the dist was healthy.



### PRs

* **dev:** CTL-1369 (1/n) — top-level `catalyst` CLI router + catalyst.install.* telemetry contract ([#2429](https://github.com/coalesce-labs/catalyst/issues/2429)) ([3734d01](https://github.com/coalesce-labs/catalyst/commit/3734d01fc3de44e52c17320ae08b9dbe12d841a2))
* **dev:** CTL-1369 (2/n) — catalyst-backup: capture/restore a node's restorable state ([#2446](https://github.com/coalesce-labs/catalyst/issues/2446)) ([76e1266](https://github.com/coalesce-labs/catalyst/commit/76e1266fc0eba9672fe4aa81a1d8df724a0888ac))
* **dev:** CTL-1371 — deterministic PR→Linear state reconciler (no native automation) ([#2431](https://github.com/coalesce-labs/catalyst/issues/2431)) ([70feab0](https://github.com/coalesce-labs/catalyst/commit/70feab0f4fb0cfa4265ebda8ec8557a402f68e68))
* **dev:** CTL-1370 — icon-picker manifest load self-heals after a transient chunk failure ([#2428](https://github.com/coalesce-labs/catalyst/issues/2428)) ([88f26e5](https://github.com/coalesce-labs/catalyst/commit/88f26e52175df326f981f435c360b81f78939024))
* **dev:** CTL-1371 — make the reconcile timer multi-team/fleet-functional ([#2443](https://github.com/coalesce-labs/catalyst/issues/2443)) ([7adecc6](https://github.com/coalesce-labs/catalyst/commit/7adecc65b489f847a2b75e249b74201725fb9ae2))
* **dev:** CTL-1372 — bound orch-monitor renderer memory growth on long sessions ([#2434](https://github.com/coalesce-labs/catalyst/issues/2434)) ([1a8fd3e](https://github.com/coalesce-labs/catalyst/commit/1a8fd3eb6e941fc145ac1880b58ddc4e288beefb))
* **dev:** CTL-1373 — icon-picker Reload hard-recovers the PWA (unregister SW + clear caches) ([#2441](https://github.com/coalesce-labs/catalyst/issues/2441)) ([6bf17cb](https://github.com/coalesce-labs/catalyst/commit/6bf17cb9d6a7d70673d2e7064ebbb013c54ce44b))

## [12.17.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.16.0...catalyst-dev-v12.17.0) (2026-06-27)

<!-- ai-enhanced -->

### Node-Class Awareness & Fleet Observability

This release introduces node classes (`developer`, `worker`, `monitor`) as a first-class concept across the fleet — every telemetry signal now carries `catalyst.node.class`, and `catalyst-doctor` grades nodes against their class-specific rubric instead of treating every machine as a worker activation gate. The standalone `catalyst-updater` daemon ships as the new sole plugin-pull owner for daemonless developer nodes, with `verify-updater` and `verify-node` providing objective pass/fail smoke tests for the GATE-3 cutover. Scheduler reliability gets significant hardening: stale-fenced orphan dirs no longer burn Linear OAuth quota, timed-out `linearis` reads now trip the circuit breaker so a degraded pass short-circuits instead of paying the full cap N times, and the board now sources real ticket titles from the CTC replica instead of falling back to bare IDs.



### Features

* **dev:** board sources ticket titles from the CTC replica (real titles, not bare IDs) ([#2421](https://github.com/coalesce-labs/catalyst/issues/2421)) ([f3f3245](https://github.com/coalesce-labs/catalyst/commit/f3f324540cc74e2f59c23c193c6439af8020eb5f))
* **dev:** CTL-1092 — Cluster Capacity Visibility ([#1942](https://github.com/coalesce-labs/catalyst/issues/1942)) ([aab5b3c](https://github.com/coalesce-labs/catalyst/commit/aab5b3c0d87b04d157303e986689ad3fede4db49))
* **dev:** CTL-1214 — cluster-driven project roster + config-scope schema/doctor (Phases 1,2,5) ([#2419](https://github.com/coalesce-labs/catalyst/issues/2419)) ([d65e3d9](https://github.com/coalesce-labs/catalyst/commit/d65e3d96bdbcf157b466e44fb6ca3e3f160b5721))
* **dev:** CTL-1322 — admission state visible in telemetry + UI (heartbeat block + FleetOps holding) ([#2336](https://github.com/coalesce-labs/catalyst/issues/2336)) ([299ba0c](https://github.com/coalesce-labs/catalyst/commit/299ba0cb204c6b18d2b89370474b971555acb438))
* **dev:** CTL-1328 — Agent Beliefs surface + belief narratives & shape ([#2345](https://github.com/coalesce-labs/catalyst/issues/2345)) ([52312f0](https://github.com/coalesce-labs/catalyst/commit/52312f00fe3cf0b50b0b7b5b8ffc2770d5e5583e))
* **dev:** CTL-1330 — Tier-1 daemon instrumentation (tick timing + event-loop delay + liveness.refresh logs) ([#2349](https://github.com/coalesce-labs/catalyst/issues/2349)) ([e476ce2](https://github.com/coalesce-labs/catalyst/commit/e476ce2c282327e40871bb00c5234aa1c8a2a666))
* **dev:** CTL-1330 Tier 3 — execution-core OTLP spans (scheduler.tick flame graph + liveness.refresh) ([#2354](https://github.com/coalesce-labs/catalyst/issues/2354)) ([e75e5e4](https://github.com/coalesce-labs/catalyst/commit/e75e5e4345536282df13aae822fd3db298612265))
* **dev:** CTL-1331 FU-1 — async the per-item Pass 0r recovery dispatch (recovery-pass p99 crater) ([#2366](https://github.com/coalesce-labs/catalyst/issues/2366)) ([f1fc61a](https://github.com/coalesce-labs/catalyst/commit/f1fc61a28d8a92fadb7a9dd5db990e2fc917a6b4))
* **dev:** CTL-1331 Phase A — async board-health delegate queue (inert land) ([#2365](https://github.com/coalesce-labs/catalyst/issues/2365)) ([77b6305](https://github.com/coalesce-labs/catalyst/commit/77b63055b5471c35ea0e64f13e5672bd903d6523))
* **dev:** CTL-1337 — per-tick trace_id shared by scheduler.tick span + tick-timing log ([#2363](https://github.com/coalesce-labs/catalyst/issues/2363)) ([89dfa20](https://github.com/coalesce-labs/catalyst/commit/89dfa206ba5a4ceae565619c80a01a590076086b))
* **dev:** CTL-1340 — inert read-replica tier for the scheduler's per-signal terminal checks ([#2373](https://github.com/coalesce-labs/catalyst/issues/2373)) ([e6dee9e](https://github.com/coalesce-labs/catalyst/commit/e6dee9ea5dc59d51c6865f52bca5d948cb13204f))
* **dev:** CTL-1344 — node-class seam (getNodeClass) + Layer-2 catalyst.node.class ([#2399](https://github.com/coalesce-labs/catalyst/issues/2399)) ([32c8bd6](https://github.com/coalesce-labs/catalyst/commit/32c8bd6eabaf39f7d97f1a6db543af96cca3a6d4))
* **dev:** CTL-1346 — read-replica resolver is node-class + Layer-2 aware ([#2402](https://github.com/coalesce-labs/catalyst/issues/2402)) ([2f5a451](https://github.com/coalesce-labs/catalyst/commit/2f5a4518e322b7c5839d8dc803be4153717080d9))
* **dev:** CTL-1348 — standalone catalyst-updater daemon (sole plugin-pull owner) + OTel logs/traces/metrics ([#2412](https://github.com/coalesce-labs/catalyst/issues/2412)) ([5b20e9f](https://github.com/coalesce-labs/catalyst/commit/5b20e9fdf8767e226460da5f225b5f3c7011d4c6))
* **dev:** CTL-1349 — verify-updater, an objective adoption smoke test for GATE-3 ([#2423](https://github.com/coalesce-labs/catalyst/issues/2423)) ([f5347b3](https://github.com/coalesce-labs/catalyst/commit/f5347b34fb46c8c8f16212a876c38499ed64584a))
* **dev:** CTL-1355 (1/n) — verify-node, a class-aware local node-profile check (all types) ([#2424](https://github.com/coalesce-labs/catalyst/issues/2424)) ([9503378](https://github.com/coalesce-labs/catalyst/commit/9503378724522495ff6fe93ebdca73eb859690d5))
* **dev:** CTL-1355 (2/n) — catalyst-doctor grades a node against its class-specific rubric ([#2425](https://github.com/coalesce-labs/catalyst/issues/2425)) ([ae33fbb](https://github.com/coalesce-labs/catalyst/commit/ae33fbb89e55e9cfd3fd59839370cf405960abbf))
* **dev:** CTL-1364 — scheduler.op span tier + default rawExec/claude-agents timeout ([#2404](https://github.com/coalesce-labs/catalyst/issues/2404)) ([60c5837](https://github.com/coalesce-labs/catalyst/commit/60c5837aefe35f61ff0fae8660445f3a58e876ad))
* **dev:** CTL-1365a — executor flag + resolution seam + catalyst.dispatch.mode telemetry (inert, default bg) ([#2406](https://github.com/coalesce-labs/catalyst/issues/2406)) ([19754bd](https://github.com/coalesce-labs/catalyst/commit/19754bdf97023abfdf9a81a23fe479a1f36414ac))
* **dev:** CTL-1365b — SDK executor (sdkRunPhaseAgent) + shared pre-launch refactor [HOLD FOR REVIEW] ([#2408](https://github.com/coalesce-labs/catalyst/issues/2408)) ([cf26bbe](https://github.com/coalesce-labs/catalyst/commit/cf26bbe745f444f26c78cebb6036aa0a23f833f2))
* **dev:** CTL-1366 — Linear-data freshness gauge + data_stale alert (Phase 1) [HOLD FOR REVIEW] ([#2410](https://github.com/coalesce-labs/catalyst/issues/2410)) ([28cf4ad](https://github.com/coalesce-labs/catalyst/commit/28cf4adfbf8b37bedcb74760607c186e8fc0edf1))
* **dev:** CTL-1367 — SDK executor pre-canary hardening ([#2417](https://github.com/coalesce-labs/catalyst/issues/2417)) ([679deba](https://github.com/coalesce-labs/catalyst/commit/679deba7d60c7d4b3ebb005d46aac8c2412c26f5))
* **dev:** CTL-1368 — catalyst.node.class as a core fleet-wide resource dimension ([#2422](https://github.com/coalesce-labs/catalyst/issues/2422)) ([e1240be](https://github.com/coalesce-labs/catalyst/commit/e1240be1a801ad8224e79314fe3fc1ba93ed829e))
* **dev:** inbox surfaces parked needs-human tickets from the cache ([#2414](https://github.com/coalesce-labs/catalyst/issues/2414)) ([a941208](https://github.com/coalesce-labs/catalyst/commit/a9412084b1e31a48e3cd2a7cc7fa310430ce507b))
* **dev:** split the conflated recovery-pass scheduler lap into recovery-pass + reclaim ([#2367](https://github.com/coalesce-labs/catalyst/issues/2367)) ([c74738b](https://github.com/coalesce-labs/catalyst/commit/c74738baf717dd4d5b47db0b43275cd75c8242d0))
* **dev:** wire Serena code-understanding MCP into research/analysis agents ([#2369](https://github.com/coalesce-labs/catalyst/issues/2369)) ([c996d95](https://github.com/coalesce-labs/catalyst/commit/c996d9549a4408b5d03e2895834a6c3539ea3816))


### Bug Fixes

* **dev:** CTL-1311 — board crashes (React [#185](https://github.com/coalesce-labs/catalyst/issues/185)) on any ?scope= — kill the URL↔atom self-heal loop ([#2322](https://github.com/coalesce-labs/catalyst/issues/2322)) ([c150fae](https://github.com/coalesce-labs/catalyst/commit/c150faefdeba7b18afe62fa803200609e3de5435))
* **dev:** CTL-1315 — J4 reaper skips terminal triage-done dirs (inFlight gate) ([#2328](https://github.com/coalesce-labs/catalyst/issues/2328)) ([6d2f58d](https://github.com/coalesce-labs/catalyst/commit/6d2f58d4f54ccfb5dca5808d56e06feaa65d92b6))
* **dev:** CTL-1317 — Rulebook crashes on /rules (undefined s.length) — read cfg as { rows } ([#2327](https://github.com/coalesce-labs/catalyst/issues/2327)) ([f658825](https://github.com/coalesce-labs/catalyst/commit/f6588254a257376ec9e766b63d1a9fe302078f29))
* **dev:** CTL-1321 — exec-core boots accepting work by default (clear stale drain flag on boot) ([#2335](https://github.com/coalesce-labs/catalyst/issues/2335)) ([d7a9844](https://github.com/coalesce-labs/catalyst/commit/d7a98449ae81cecf6c0768519c9880433731a7c7))
* **dev:** CTL-1323 — a recovery-pass-only worker dir strands its ticket from the new-work pull ([#2338](https://github.com/coalesce-labs/catalyst/issues/2338)) ([206103e](https://github.com/coalesce-labs/catalyst/commit/206103ea7bde12095eb233f44e59b1dcb44b0bb5))
* **dev:** CTL-1324 — keep the scheduler responsive while cleaning up old worktrees ([#2344](https://github.com/coalesce-labs/catalyst/issues/2344)) ([81e72ce](https://github.com/coalesce-labs/catalyst/commit/81e72cecff9b44f073c2cf386bbc457c045af524))
* **dev:** CTL-1329 — stale-fenced orphan dirs no longer burn Linear OAuth quota ([#2347](https://github.com/coalesce-labs/catalyst/issues/2347)) ([37a0581](https://github.com/coalesce-labs/catalyst/commit/37a05817242663ea4a761c304b49a15b9aab9806))
* **dev:** CTL-1332 — log shipper keeps full pino JSON body so Tier-1 fields reach Loki ([#2352](https://github.com/coalesce-labs/catalyst/issues/2352)) ([14386a3](https://github.com/coalesce-labs/catalyst/commit/14386a3e40050c32044cf12d51366d754d0956f1))
* **dev:** CTL-1334 — log-shipper emits short host.name (first DNS label) so logs join metrics ([#2362](https://github.com/coalesce-labs/catalyst/issues/2362)) ([d948f56](https://github.com/coalesce-labs/catalyst/commit/d948f56a58f6eeb377acc753b59ff16447721e1d))
* **dev:** CTL-1336 — thread warm agents snapshot into Pass 0a phantom sweep (zero-spawn liveness) ([#2361](https://github.com/coalesce-labs/catalyst/issues/2361)) ([d03e000](https://github.com/coalesce-labs/catalyst/commit/d03e00057667a4163690defb90840c772f94aa0d))
* **dev:** CTL-1338 — tracing.mjs degrades to no-op when @opentelemetry/api is absent (unbreak orch-monitor quality) ([#2360](https://github.com/coalesce-labs/catalyst/issues/2360)) ([4a8f6ab](https://github.com/coalesce-labs/catalyst/commit/4a8f6ab51d4588f9adae9669f4f5e9f8b9215014))
* **dev:** CTL-1339 — cap the hot per-signal linearis read so a 429 stall can't wedge the scheduler tick ([#2371](https://github.com/coalesce-labs/catalyst/issues/2371)) ([2d49bfe](https://github.com/coalesce-labs/catalyst/commit/2d49bfebebecdafc2ef61db6e54688d2f23ae323))
* **dev:** CTL-1341 — a timed-out linearis read trips the breaker so a degraded pass short-circuits ([#2375](https://github.com/coalesce-labs/catalyst/issues/2375)) ([8e7a428](https://github.com/coalesce-labs/catalyst/commit/8e7a42837f5ff9cf016f7ad69a875253215d7d35))
* **dev:** CTL-1362 — per-tick trace_id unique across restarts (boot nonce) ([#2397](https://github.com/coalesce-labs/catalyst/issues/2397)) ([bf09451](https://github.com/coalesce-labs/catalyst/commit/bf094513a1e2f13e88860e67c956b353968e3294))
* **dev:** CTL-1363 — cluster-claim resolveIssueId via issue(id:) (unwedge fleet dispatch) ([#2403](https://github.com/coalesce-labs/catalyst/issues/2403)) ([21a7145](https://github.com/coalesce-labs/catalyst/commit/21a7145a376a5b41af53cf17a9fc16bd89cea006))
* **dev:** dedupe nav projects + repo icon auto-detect ([#2418](https://github.com/coalesce-labs/catalyst/issues/2418)) ([8eb398e](https://github.com/coalesce-labs/catalyst/commit/8eb398e0a15b8c1e573c23ad61230eb58c51957f))
* **dev:** orch-monitor project roster reads config cwd-independently ([#2413](https://github.com/coalesce-labs/catalyst/issues/2413)) ([1766666](https://github.com/coalesce-labs/catalyst/commit/17666666a802306ec9f2bd07dd367966a3d3dff3))
* **dev:** reclaim terminal-check trusts the read-replica regardless of age (crater the reclaim lap) ([#2368](https://github.com/coalesce-labs/catalyst/issues/2368)) ([d5c9b1f](https://github.com/coalesce-labs/catalyst/commit/d5c9b1f5d10b023c904a1d1e0b3bc9eccc2a3f9b))
* **dev:** repo-icon empty-favicon → avatar fallback (no blank icons) ([#2420](https://github.com/coalesce-labs/catalyst/issues/2420)) ([b7ca52f](https://github.com/coalesce-labs/catalyst/commit/b7ca52f1832ec3e0adb5f99ed43b48bbf3a3805a))

## [12.16.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.15.0...catalyst-dev-v12.16.0) (2026-06-22)

<!-- ai-enhanced -->

### Board-Health Holistic Dispatch & Cloud Token Provisioning

Board-health now dispatches a single holistic recovery-pass delegate on enforce scans, carrying full board context to the anchored ticket rather than triggering per-move fan-out. A multi-host correctness fix ensures `selectAnchor` only picks tickets this host owns via HRW, so a foreign-owned anchor no longer silently blocks actuation of self-owned work. Separately, `CATALYST_CLOUD_TOKEN` is now provisioned into the machine-level environment from the cluster repo via a new projection script, with an advisory `doctor` check — local-only behavior is unchanged until you opt into the cloud path.



### Features

* **dev:** CTL-1300 — board-health delegate ACTS (holistic recovery-pass dispatch on enforce) ([#2301](https://github.com/coalesce-labs/catalyst/issues/2301)) ([43aaec9](https://github.com/coalesce-labs/catalyst/commit/43aaec90bc129d8e9b0996642f440aba55483762))
* **dev:** CTL-1307 — machine-level CATALYST_CLOUD_TOKEN from catalyst-cluster repo ([#2316](https://github.com/coalesce-labs/catalyst/issues/2316)) ([9ff454d](https://github.com/coalesce-labs/catalyst/commit/9ff454dec3c314a74cbc1424eafa09a4c4e2d1fc))


### Bug Fixes

* **dev:** CTL-1302 — board-health selectAnchor prefers a self-owned ticket (multi-host) ([#2305](https://github.com/coalesce-labs/catalyst/issues/2305)) ([72e4945](https://github.com/coalesce-labs/catalyst/commit/72e49457fadd9ec975fbfaae692e96700f0e4e99))

## [12.15.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.14.0...catalyst-dev-v12.15.0) (2026-06-21)

<!-- ai-enhanced -->

### Stale Worktree Reclamation & Fleet Hardening

The automated stale-worktree sweeper now uses a multi-signal classifier to distinguish safe-to-delete, salvageable, and active worktrees — with battery-aware deferral, a per-run removal cap, and OTel instrumentation per sweep. Alongside that, several fleet-reliability fixes land: the board dispatch gate now routes on delegate instead of assignee (unwedging boards where human assignment blocked every Todo ticket), the recovery-pass bounded-LLM FIX rung is repaired after a missing `evidence.signal` field made it structurally dead in production, and a daemon boot-breaking missing export from `config.mjs` is resolved. PWA push notifications for the orch-monitor and a gitleaks CI secret-scanning gate round out the release.



### Features

* **dev:** CTL-1030 — Automated stale-worktree reclamation (multi-signal classifier) ([#1827](https://github.com/coalesce-labs/catalyst/issues/1827)) ([8a5b127](https://github.com/coalesce-labs/catalyst/commit/8a5b1271703d23ea3179379a7f7333513046005f))
* **dev:** CTL-1093 — node identity survives hostname change without splitting fleet history ([#1927](https://github.com/coalesce-labs/catalyst/issues/1927)) ([780cca3](https://github.com/coalesce-labs/catalyst/commit/780cca318f3eafd16bbc8719a19d7af163c1181d))
* **dev:** CTL-1167 — PWA push notifications for orch-monitor ([#2057](https://github.com/coalesce-labs/catalyst/issues/2057)) ([2b24ebb](https://github.com/coalesce-labs/catalyst/commit/2b24ebb25bbbeacb19246fa447de2a5f20ef0e83))
* **dev:** CTL-1204 — gitleaks secret-scanning CI gate + optional pre-commit hook ([#2297](https://github.com/coalesce-labs/catalyst/issues/2297)) ([0099e67](https://github.com/coalesce-labs/catalyst/commit/0099e67ea631682368d39ca204bed86a44872bc6))
* **dev:** CTL-1290 — board-health delegate (shadow-first) ([#2295](https://github.com/coalesce-labs/catalyst/issues/2295)) ([8a6b46b](https://github.com/coalesce-labs/catalyst/commit/8a6b46b0f955134b2e66529437720a404704e524))
* **dev:** CTL-1292 — catalyst-join provisions a member node to fully-operational state ([#2286](https://github.com/coalesce-labs/catalyst/issues/2286)) ([3fae97e](https://github.com/coalesce-labs/catalyst/commit/3fae97e366514c0b7a5ce370eb8c6daa14a1ebf1))


### Bug Fixes

* **dev:** board deriveAttention cross-checks Linear terminal state (CTL-1239) ([#2205](https://github.com/coalesce-labs/catalyst/issues/2205)) ([5c7decd](https://github.com/coalesce-labs/catalyst/commit/5c7decd1158c57f7b40b78364a08fb5637d452a5))
* **dev:** CTL-1174 — gate dispatch on delegate-ONLY + delegate-on-Todo (unwedge the board) ([#2285](https://github.com/coalesce-labs/catalyst/issues/2285)) ([60c0783](https://github.com/coalesce-labs/catalyst/commit/60c07838d9b9abb6de06d62124276de8a37fbb57))
* **dev:** CTL-1242 — reap stale signals + needs-human fix for terminal/merged tickets ([#2212](https://github.com/coalesce-labs/catalyst/issues/2212)) ([6136362](https://github.com/coalesce-labs/catalyst/commit/6136362959502fd97106eb82e554887d1fc015db))
* **dev:** CTL-1297 — HRW owner preempts stale cross-host claim (TTL-based) ([#2296](https://github.com/coalesce-labs/catalyst/issues/2296)) ([848ca4e](https://github.com/coalesce-labs/catalyst/commit/848ca4e628db200220f42a94eac8037d126bd187))
* **dev:** CTL-1299 — populate evidence.signal so recovery-pass bounded-LLM FIX rung fires ([#2300](https://github.com/coalesce-labs/catalyst/issues/2300)) ([8e7a69d](https://github.com/coalesce-labs/catalyst/commit/8e7a69d21d30f5c8e0860127185707eca56b5e4b))
* **dev:** restore export on getCatalystRepoDir — daemon boot broken fleet-wide ([#2291](https://github.com/coalesce-labs/catalyst/issues/2291)) ([406f28b](https://github.com/coalesce-labs/catalyst/commit/406f28b80b4407cfdf981000d390e39f7d438734))

## [12.14.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.13.0...catalyst-dev-v12.14.0) (2026-06-19)

<!-- ai-enhanced -->

### Recovery Observability & Cache Coverage

The recovery delegate now emits `recovery.tick` and `recovery.decision` events to Loki on every pass, so you can finally distinguish a board where the delegate examined items and handed them to humans from one it silently never processed. Control-loop numerics from those events — plus scheduler parallelism and autotune gauges — are promoted into OTel attributes, making queue depth, action breakdowns, and decision rules chartable in dashboards. The board-cache reconciler also fixes a starvation bug where only the alphabetical prefix of tickets ever reconciled; per-tier rotation cursors now ensure both active-pipeline and Backlog tickets are covered across passes, which should clear the phantom "stuck" tickets that were showing as open PRs despite being done.



### Features

* **dev:** CTL-1287 — recovery delegate emits per-tick recovery.tick/recovery.decision ([#2276](https://github.com/coalesce-labs/catalyst/issues/2276)) ([ae419a6](https://github.com/coalesce-labs/catalyst/commit/ae419a6c8dcced9422c55c7059796b45d6023170))
* **dev:** CTL-1291 — chartable control-loop numerics via OTel attribute promotion ([#2282](https://github.com/coalesce-labs/catalyst/issues/2282)) ([29db3b4](https://github.com/coalesce-labs/catalyst/commit/29db3b40dad0ac6e68f144bda6415ad7082d1df1))


### Bug Fixes

* **dev:** CTL-1285 — Alloy log-shipper survives via dedicated KeepAlive LaunchAgent ([#2273](https://github.com/coalesce-labs/catalyst/issues/2273)) ([849929d](https://github.com/coalesce-labs/catalyst/commit/849929d6ea6ef5a55fd8ed01f77f5d9e098f977b))
* **dev:** CTL-1288 — cache reconcile covers the whole board via per-tier rotation cursors ([#2278](https://github.com/coalesce-labs/catalyst/issues/2278)) ([ca8b808](https://github.com/coalesce-labs/catalyst/commit/ca8b8088411422a32c0ccc93813947c5dd150a98))

## [12.13.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.12.0...catalyst-dev-v12.13.0) (2026-06-19)

<!-- ai-enhanced -->

### Board Health & Log Observability

The broker now periodically reconciles board cache state and labels against live Linear, closing the gap where a missed webhook left tickets lying about their status indefinitely. Dead doc-phase workers that go transcript-silent are detected and reclaimed, unblocking slots that previously sat starved for up to six hours. Grafana Alloy is installed and auto-started per host to ship daemon logs into Loki, queryable by stable node name alongside the existing OTel event streams.



### Features

* **dev:** CTL-1245 — revive dead-but-running-signalled workers ([#2195](https://github.com/coalesce-labs/catalyst/issues/2195)) ([8c420f8](https://github.com/coalesce-labs/catalyst/commit/8c420f8a23238ae356dcc45f76c163ef08ba147f))
* **dev:** CTL-1260 — reframe recovery-pass into the board-health delegate ([#2254](https://github.com/coalesce-labs/catalyst/issues/2254)) ([33101d6](https://github.com/coalesce-labs/catalyst/commit/33101d6f44c3e56a762f88f745c16608a3d47753))
* **dev:** CTL-1262 — tag otel-forward events with stable catalyst.node.name resource attr ([#2242](https://github.com/coalesce-labs/catalyst/issues/2242)) ([c6c0000](https://github.com/coalesce-labs/catalyst/commit/c6c0000e4b4421e60d3f34364c1934c37d915144))
* **dev:** CTL-1263 — install + register + auto-start the Alloy log-shipper per host ([#2248](https://github.com/coalesce-labs/catalyst/issues/2248)) ([8cd288a](https://github.com/coalesce-labs/catalyst/commit/8cd288a3fd2dab01d055237dcfb2a113e787b3ab))
* **dev:** CTL-1277 — periodic broker reconcile of board cache state+labels vs live Linear ([#2264](https://github.com/coalesce-labs/catalyst/issues/2264)) ([bbf9b22](https://github.com/coalesce-labs/catalyst/commit/bbf9b229eaea8700d1a62c6758662a4d84f7bf7f))
* **dev:** CTL-1279 — sensing-substrate cookbook + wire recovery-pass to it ([#2261](https://github.com/coalesce-labs/catalyst/issues/2261)) ([e6479a0](https://github.com/coalesce-labs/catalyst/commit/e6479a05914cca5988b93545d9770e534e3ac27a))
* **dev:** CTL-1282 — cache reconcile async + re-entrancy guard (non-blocking) ([#2270](https://github.com/coalesce-labs/catalyst/issues/2270)) ([9736317](https://github.com/coalesce-labs/catalyst/commit/97363179cd9dba9ab6844b70766e0fd715ec33a7))
* **dev:** off-the-shelf Grafana Alloy daemon-log shipper config (CTL-1261) ([#2243](https://github.com/coalesce-labs/catalyst/issues/2243)) ([425356c](https://github.com/coalesce-labs/catalyst/commit/425356cae411f1d4e3891991147fea38722df6f4))


### Bug Fixes

* **dev:** CTL-1258 — render resolved project icon (glyph|favicon) consistently across all orch-monitor surfaces ([#2225](https://github.com/coalesce-labs/catalyst/issues/2225)) ([983905d](https://github.com/coalesce-labs/catalyst/commit/983905d1e6bd3152d5ccffe18ea071cef8b7f867))
* **dev:** CTL-1277 — broker boot-crash (pino logger binding) ([#2265](https://github.com/coalesce-labs/catalyst/issues/2265)) ([472adfe](https://github.com/coalesce-labs/catalyst/commit/472adfe79bde686bf7baa958007b74291fe9a66c))
* **dev:** log-shipper service.name + catalyst.node.name tagging (semconv) + brew formula ([#2250](https://github.com/coalesce-labs/catalyst/issues/2250)) ([fa9c244](https://github.com/coalesce-labs/catalyst/commit/fa9c24404ae0f6138e91faee4f1b42936c585451))

## [12.12.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.11.0...catalyst-dev-v12.12.0) (2026-06-17)

<!-- ai-enhanced -->

### Cross-Host Control Plane & Monitor Stability

This release lands the cross-host single control plane: multiple machines now publish and merge liveness heartbeats correctly, fixing a Linear GraphQL bug that silently blocked all cross-host heartbeat writes and a merge-ordering issue that caused the self-host to appear degraded. The broker now detects when the monitor goes silent (via an out-of-process ingestion-silence detector) and raises a disk-readable alarm instead of staying falsely green. A batch of monitor stability fixes ships alongside: RSS no longer ratchets to multi-GB from repeated full event-log reads, the icon picker's virtualizer scroll container renders correctly, stale dist chunks no longer accumulate across rebuilds, and the broker now runs `bun install` automatically when dependencies change after a pull.



### Features

* **dev:** cross-host liveness → single control plane (CTL-1251) ([#2197](https://github.com/coalesce-labs/catalyst/issues/2197)) ([4804777](https://github.com/coalesce-labs/catalyst/commit/4804777155340e26c3d067cd25a860b6535a5a7d))
* **dev:** CTL-1122 — out-of-process ingestion-silence detector (PR1) ([#2216](https://github.com/coalesce-labs/catalyst/issues/2216)) ([be4fa5f](https://github.com/coalesce-labs/catalyst/commit/be4fa5fb5ec7b79c9324c4677b1cde9a6943d73b))
* **dev:** CTL-1156 parameterize monitor server project config path ([#2213](https://github.com/coalesce-labs/catalyst/issues/2213)) ([6388415](https://github.com/coalesce-labs/catalyst/commit/638841549a1ade1d4088db2c2e31c17260644f27))
* **dev:** CTL-1223 broker runs bun install after pull when deps changed; surface silent vite-build failures ([#2210](https://github.com/coalesce-labs/catalyst/issues/2210)) ([74650e7](https://github.com/coalesce-labs/catalyst/commit/74650e7669ab54f428dfd92dc827ccd69ad7e941))
* **dev:** CTL-1240 wire gateway tier into scheduler tick (Linear read-hammer fix) ([#2209](https://github.com/coalesce-labs/catalyst/issues/2209)) ([729cfaf](https://github.com/coalesce-labs/catalyst/commit/729cfaf684a9d68e85a7cf682455ac54863d5489))
* **dev:** recovery-pass — agent-coordination comments + verify-the-work-not-the-status check ([#2204](https://github.com/coalesce-labs/catalyst/issues/2204)) ([9d03c0b](https://github.com/coalesce-labs/catalyst/commit/9d03c0b8973fc040b7461b377237d324a23ad1e0))
* **dev:** recovery-pass — context/mode script (signals+log+Linear-cache, HRW-filtered) + sweep SOP ([#2198](https://github.com/coalesce-labs/catalyst/issues/2198)) ([92d49f1](https://github.com/coalesce-labs/catalyst/commit/92d49f1217ebeeb3e85327ae4b7e60878f8bb320))
* **dev:** recovery-pass — forbid --admin/force-merge past failing CI ([#2202](https://github.com/coalesce-labs/catalyst/issues/2202)) ([ad7fe23](https://github.com/coalesce-labs/catalyst/commit/ad7fe2302964767aaca4d34c3975fd713fd1b68f))


### Bug Fixes

* **analytics:** catalyst-agent reads Claude token from credentials file, not just Keychain ([#2219](https://github.com/coalesce-labs/catalyst/issues/2219)) ([30ce8cb](https://github.com/coalesce-labs/catalyst/commit/30ce8cbf17ed83b22167af2ee282cd72a6dd20bc))
* **dev:** cluster-heartbeat publish actually works + newest-wins liveness merge (CTL-1255) ([#2203](https://github.com/coalesce-labs/catalyst/issues/2203)) ([c52e10a](https://github.com/coalesce-labs/catalyst/commit/c52e10a1bbfa0c66d876ab23e3f1ed8304758fb1))
* **dev:** CTL-1243 route source_conflict stall to bounded-LLM; add linearTerminal guard ([#2208](https://github.com/coalesce-labs/catalyst/issues/2208)) ([86fd7d9](https://github.com/coalesce-labs/catalyst/commit/86fd7d93f19df3f8cc7ebb8f37262628aed66de5))
* **dev:** CTL-1252 collapse FQDN host names to first DNS label ([#2218](https://github.com/coalesce-labs/catalyst/issues/2218)) ([4f7ee3d](https://github.com/coalesce-labs/catalyst/commit/4f7ee3d755a0f448bbe1dd04ffe97c4a9add5c17))
* **dev:** CTL-1253 — show detected repo favicons in the project icon picker ([#2222](https://github.com/coalesce-labs/catalyst/issues/2222)) ([f501512](https://github.com/coalesce-labs/catalyst/commit/f501512706af7882575c0dfa1308aca3bcd0c1ca))
* **dev:** CTL-1254 — stage+swap monitor UI build so dist chunks don't accumulate ([#2220](https://github.com/coalesce-labs/catalyst/issues/2220)) ([26b236b](https://github.com/coalesce-labs/catalyst/commit/26b236bc84f746dc2ffcea33a4fd513616862f97))
* **dev:** CTL-1257 — memoize un-ringed event-log readers off the 3s board-recompute (bound monitor RSS) ([#2223](https://github.com/coalesce-labs/catalyst/issues/2223)) ([0d39abb](https://github.com/coalesce-labs/catalyst/commit/0d39abb280344c3c2faea84d1047e4efab0ebd4c))
* **dev:** monitor repoOwners from registry, not stale committed roster (§13 — fixes Adva icon 404) ([#2189](https://github.com/coalesce-labs/catalyst/issues/2189)) ([8a9275c](https://github.com/coalesce-labs/catalyst/commit/8a9275c43f585b1819c079c2acbe7f1535ac40f2))
* **dev:** remove CSS Size Containment from virtualizer scroll container (CTL-1254) ([#2211](https://github.com/coalesce-labs/catalyst/issues/2211)) ([5cbcd93](https://github.com/coalesce-labs/catalyst/commit/5cbcd93184e0d118cfaee1131e9839cdd55fcfa9))
* **dev:** surface recovery-pass/remediate explanation in inbox row + detail card ([#2206](https://github.com/coalesce-labs/catalyst/issues/2206)) ([f41ed2c](https://github.com/coalesce-labs/catalyst/commit/f41ed2c5649c133ab34afe7f47bd9467937ba4bc))

## [12.11.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.10.0...catalyst-dev-v12.11.0) (2026-06-17)

<!-- ai-enhanced -->

### Cluster Control Plane & Autonomous Recovery

This release lands two major systems: a GitOps cluster control plane (`catalyst cluster sync`, `cluster-repo-first roster`, SOPS-encrypted secrets) and a fully wired autonomous recovery pass that now acts on stalled tickets rather than just classifying them — resolving merge conflicts, rebasing, and re-dispatching phases before escalating to a human. The reaper also gains the ability to auto-remove squash-merged worktrees, and N dashboard clients now share a single backend SSE tail instead of spawning separate full-log reads per connection.



### Features

* **dev:** CTL-1135 — additive caused_by on the event envelope ([#2123](https://github.com/coalesce-labs/catalyst/issues/2123)) ([47035f2](https://github.com/coalesce-labs/catalyst/commit/47035f21e9857f587f6f475cd946f0def390617d))
* **dev:** CTL-1186 — catalyst doctor: fail-closed activation gate for new cluster nodes ([#2109](https://github.com/coalesce-labs/catalyst/issues/2109)) ([6c4d910](https://github.com/coalesce-labs/catalyst/commit/6c4d910eb276c5778fc8a2749dec1b8e5ce002e1))
* **dev:** CTL-1188 — catalyst cluster CLI (status/add/remove/rename/set-anchor/drain/tune) ([#2116](https://github.com/coalesce-labs/catalyst/issues/2116)) ([d062a42](https://github.com/coalesce-labs/catalyst/commit/d062a42c110e2d910ded01c730039553f60b8cfd))
* **dev:** CTL-1208 — curated color-tinted project icon set picker (Phosphor glyphs) ([#2115](https://github.com/coalesce-labs/catalyst/issues/2115)) ([5b14eca](https://github.com/coalesce-labs/catalyst/commit/5b14eca87d9dbd4465353d48e558fd6bc394e42c))
* **dev:** CTL-1211 — cluster control-plane (catalyst-cluster repo + SOPS) load-side: cluster-sync, cluster-repo-first roster, schema versioning, observability verbs ([#2181](https://github.com/coalesce-labs/catalyst/issues/2181)) ([8f55595](https://github.com/coalesce-labs/catalyst/commit/8f55595dc52349dbd4051535a3a1542c1e520862))
* **dev:** CTL-1212 — grouped project settings page (Identity/Source/Workflow) + three-tier nav + one-click gear ([#2127](https://github.com/coalesce-labs/catalyst/issues/2127)) ([4de6396](https://github.com/coalesce-labs/catalyst/commit/4de639642f85b10e9cd3ac86ead3d8f1ab572032))
* **dev:** CTL-1214 — durable cluster-node installer (PATH-B [#1](https://github.com/coalesce-labs/catalyst/issues/1)–[#6](https://github.com/coalesce-labs/catalyst/issues/6) + adversarially-verified hardening) ([#2159](https://github.com/coalesce-labs/catalyst/issues/2159)) ([fd85d21](https://github.com/coalesce-labs/catalyst/commit/fd85d211d092e5847e74fe1c8cb72d8ce855c323))
* **dev:** CTL-1215 — consolidate monitor event-log reads behind a shared tail + bound caches ([#2135](https://github.com/coalesce-labs/catalyst/issues/2135)) ([95ec3a2](https://github.com/coalesce-labs/catalyst/commit/95ec3a2e9df09abdf043dd745d82493a8cff191d))
* **dev:** CTL-1218 — reaper auto-removes squash-merged worktrees (provenance + GitHub merge signal + queue drain) ([#2143](https://github.com/coalesce-labs/catalyst/issues/2143)) ([3ae063f](https://github.com/coalesce-labs/catalyst/commit/3ae063ff8bf9fbfb49c655b20d6ea1da03df9973))
* **dev:** CTL-1219 — wire unstuck-sweep deterministic act-seams (ships off/inert) ([#2140](https://github.com/coalesce-labs/catalyst/issues/2140)) ([460e2c3](https://github.com/coalesce-labs/catalyst/commit/460e2c3d3080a494a8732c3f22c5d3789997279e))
* **dev:** CTL-1222 — deep-link notifications to action surfaces ([#2154](https://github.com/coalesce-labs/catalyst/issues/2154)) ([9731ff7](https://github.com/coalesce-labs/catalyst/commit/9731ff762984d30d2881dff7ff12f268924b44c8))
* **dev:** CTL-1224 — route SSE backlog + live tail through the shared event-ring (N clients = one tail) ([#2141](https://github.com/coalesce-labs/catalyst/issues/2141)) ([0ea15c5](https://github.com/coalesce-labs/catalyst/commit/0ea15c566dedc33d498ff21ce5a0b7efcd8b96f4))
* **dev:** CTL-1225 — first-click Save + confirmation + cross-project reset (Project Settings) ([#2144](https://github.com/coalesce-labs/catalyst/issues/2144)) ([755df8c](https://github.com/coalesce-labs/catalyst/commit/755df8c5777630dc92ebb8a5d44a98babbb523d0))
* **dev:** CTL-1226 — searchable icon grid picker backed by full Phosphor set ([#2145](https://github.com/coalesce-labs/catalyst/issues/2145)) ([72057f6](https://github.com/coalesce-labs/catalyst/commit/72057f6a129fcb6c617f0527d1c5b44d04c7fe37))
* **dev:** CTL-1233 — hybrid Phosphor loader + virtualized All-icons picker ([#2168](https://github.com/coalesce-labs/catalyst/issues/2168)) ([9805069](https://github.com/coalesce-labs/catalyst/commit/980506909e999c634f18418c37dce29b901f3211))
* **dev:** CTL-1235 — emit running version + commit + drift-from-main (agent telemetry) ([#2169](https://github.com/coalesce-labs/catalyst/issues/2169)) ([73fe804](https://github.com/coalesce-labs/catalyst/commit/73fe804ea46739ac0056e262cd5042e2022236af))
* **dev:** recovery-pass skill — goal-driven senior-engineer pipeline-unstick agent ([#2184](https://github.com/coalesce-labs/catalyst/issues/2184)) ([047e701](https://github.com/coalesce-labs/catalyst/commit/047e701c8ba2429af5c32a0f2bb6b03242b08680))


### Bug Fixes

* **dev:** CTL-1176 — raise escalation bar: merge conflicts → BOUNDED-LLM, not HUMAN ([#2156](https://github.com/coalesce-labs/catalyst/issues/2156)) ([ad9c426](https://github.com/coalesce-labs/catalyst/commit/ad9c426e2e47ea3dea49df86b4b57a465014e805))
* **dev:** CTL-1176 — real recovery actuators (emit/post/seam/remediate/cooldown) + DIAGNOSE evidence + inbox reader ([#2163](https://github.com/coalesce-labs/catalyst/issues/2163)) ([3863adb](https://github.com/coalesce-labs/catalyst/commit/3863adb5157bdb183702f53da164346c14ca6d4b))
* **dev:** CTL-1176 — wire reasoningRecoveryPass into scheduler as autonomous Pass 0r ([#2157](https://github.com/coalesce-labs/catalyst/issues/2157)) ([ab9e110](https://github.com/coalesce-labs/catalyst/commit/ab9e110574dc698a4027c10cee1a2143037e1011))
* **dev:** CTL-1191 — HRW-gate the 3 recovery passes over the surviving roster + terminal-state filter ([#2173](https://github.com/coalesce-labs/catalyst/issues/2173)) ([38ed942](https://github.com/coalesce-labs/catalyst/commit/38ed942cb2dbdec2bc2fc1680fc2d1cf2638444b))
* **dev:** CTL-1235 — clean metric names (drop _ratio suffix on build_info/commits_behind) ([#2171](https://github.com/coalesce-labs/catalyst/issues/2171)) ([2df7f6c](https://github.com/coalesce-labs/catalyst/commit/2df7f6cb0a5c308f33dbf5ec3229d69927c32806))
* **dev:** CTL-1237 — stamp host.name on bg-worker OTEL attrs (claude_code host_name=null) ([#2167](https://github.com/coalesce-labs/catalyst/issues/2167)) ([768d5ac](https://github.com/coalesce-labs/catalyst/commit/768d5acf5efa1569a6883ad9ad7e5a8332dab5bf))

## [12.10.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.9.0...catalyst-dev-v12.10.0) (2026-06-16)

<!-- ai-enhanced -->

### Multi-Node Cluster Onboarding & Failed-Phase Escalation

Two gaps that let work fall through silently are closed in this release: failed phases now surface identically to stalled ones — inbox row, amber nav dot, `/queue` Needs You bucket, and a Linear `needs-human` label with the worker's structured explanation attached. On the infrastructure side, `catalyst-join.sh` and `catalyst cluster join-token` make adding a second node a one-line operation: mint a short-TTL token on the seed, run the `curl | bash` on the joining node, and the script handles Tailscale preflight, bundle fetch, config merge, and service installation with full resumability on retry. This release also ships worker-dir GC to prevent per-tick I/O blowup as worker directories accumulate, the orch-monitor as an installable PWA, launchd auto-start via `catalyst-stack install-services`, and editable project settings saved server-side from the monitor.



### Features

* **dev:** CTL-1131 — durable needsHumanSince anchor + escalation signal persistence (Phases 1–2) ([#1995](https://github.com/coalesce-labs/catalyst/issues/1995)) ([ada430e](https://github.com/coalesce-labs/catalyst/commit/ada430eb4be524cef56c760e345355ffa5b0b6a4))
* **dev:** CTL-1133 — installable PWA for the orch-monitor ([#2049](https://github.com/coalesce-labs/catalyst/issues/2049)) ([1289b5a](https://github.com/coalesce-labs/catalyst/commit/1289b5a4faa57a7104d0fc741b34d520bbbfce46))
* **dev:** CTL-1152 — config-driven, server-authoritative project roster in the monitor ([#2031](https://github.com/coalesce-labs/catalyst/issues/2031)) ([51f56be](https://github.com/coalesce-labs/catalyst/commit/51f56be36f84a1f7cb25d953c15a8f5b5d4f00dc))
* **dev:** CTL-1153 — editable project settings in the monitor (server-saved) ([#2092](https://github.com/coalesce-labs/catalyst/issues/2092)) ([57c8f12](https://github.com/coalesce-labs/catalyst/commit/57c8f1271a3e6a72788c29ac802561d0cafac53d))
* **dev:** CTL-1166 — catalyst-stack install-services (launchd auto-start on boot) ([#2047](https://github.com/coalesce-labs/catalyst/issues/2047)) ([15925c3](https://github.com/coalesce-labs/catalyst/commit/15925c33c4ed97b2a2e3e2bcdb5d0b0ed6c5e264))
* **dev:** CTL-1168 + CTL-1178 — Linear-match Tickets board (fixed columns, per-column flat scroll, viewport-capped grouped lanes) ([#2044](https://github.com/coalesce-labs/catalyst/issues/2044)) ([f70de89](https://github.com/coalesce-labs/catalyst/commit/f70de89c40408472934a9a7c83331d8d552ded19))
* **dev:** CTL-1170 — async sweeps to unblock heartbeat event loop ([#2058](https://github.com/coalesce-labs/catalyst/issues/2058)) ([d086770](https://github.com/coalesce-labs/catalyst/commit/d08677002520468d61756a0c5da57e77ef6b7157))
* **dev:** CTL-1172 — labeled service-health indicator in the orch-monitor footer ([#2055](https://github.com/coalesce-labs/catalyst/issues/2055)) ([c301d36](https://github.com/coalesce-labs/catalyst/commit/c301d360b3ecde83febabb2e6b026d2addec26fd))
* **dev:** CTL-1173 Phase 2 — fix applyAssignee read-back to verify Issue.delegate.id ([#2064](https://github.com/coalesce-labs/catalyst/issues/2064)) ([68181f1](https://github.com/coalesce-labs/catalyst/commit/68181f1bc140a5fe850baf099d21e47ef446349e))
* **dev:** CTL-1175 — orphan-PR detect+notify sweep raises Needs-You inbox row ([#2065](https://github.com/coalesce-labs/catalyst/issues/2065)) ([6d2ac03](https://github.com/coalesce-labs/catalyst/commit/6d2ac03f4866865b8fe2c4e59c33bd2a01fe6bc8))
* **dev:** CTL-1180 — surface failed phases as needs-human (monitor + daemon) ([#2095](https://github.com/coalesce-labs/catalyst/issues/2095)) ([9a8027b](https://github.com/coalesce-labs/catalyst/commit/9a8027bffc44cb7b3dc68bea8f083e216b019ef0))
* **dev:** CTL-1184 — catalyst-cluster join-token + join-token-store.mjs seam module ([#2097](https://github.com/coalesce-labs/catalyst/issues/2097)) ([df2b838](https://github.com/coalesce-labs/catalyst/commit/df2b838821c8f6a292a219876d3e961516e910f7))
* **dev:** CTL-1185 — catalyst-join.sh one-line node onboarding ([#2110](https://github.com/coalesce-labs/catalyst/issues/2110)) ([5122573](https://github.com/coalesce-labs/catalyst/commit/5122573df656ed784caf26785d006974d2b45603))
* **dev:** CTL-1203 — secrets 600 hygiene: installer enforcement + doctor assertion ([#2104](https://github.com/coalesce-labs/catalyst/issues/2104)) ([d9fd590](https://github.com/coalesce-labs/catalyst/commit/d9fd590d4ccf9cad2e6469b67082ce78b6ad0b68))
* **dev:** CTL-1205 — worker-dir GC to prevent per-tick I/O blowup ([#2112](https://github.com/coalesce-labs/catalyst/issues/2112)) ([9c5d933](https://github.com/coalesce-labs/catalyst/commit/9c5d9336b2e4d74168a955877641a019054dbe22))
* **dev:** CTL-1206 — flat board per-column scroll restoration ([#2113](https://github.com/coalesce-labs/catalyst/issues/2113)) ([9b1db6d](https://github.com/coalesce-labs/catalyst/commit/9b1db6d4041a38bddd4bea163703dc25ae551f81))
* **dev:** CTL-935 shadow comparators + disagreement report + flag-live verification ([#2101](https://github.com/coalesce-labs/catalyst/issues/2101)) ([6922530](https://github.com/coalesce-labs/catalyst/commit/6922530279e767d17949dccaaeaece1047cca58d))


### Bug Fixes

* **dev:** CTL-1169 — daemon-health hysteresis (stop the degraded↔healthy notification flap) ([#2052](https://github.com/coalesce-labs/catalyst/issues/2052)) ([e045155](https://github.com/coalesce-labs/catalyst/commit/e045155f89ed59a3748d49bac5387634b9c38fe4))
* **dev:** CTL-1171 — broker liveness heartbeat (stop the idle-broker false-down) ([#2056](https://github.com/coalesce-labs/catalyst/issues/2056)) ([8f28285](https://github.com/coalesce-labs/catalyst/commit/8f28285eb9a43a521aaa1b14355db212e644c625))
* **dev:** CTL-1181 — loud needs-human escalation + proactive token detour in phase-pr ([#2093](https://github.com/coalesce-labs/catalyst/issues/2093)) ([e1adadd](https://github.com/coalesce-labs/catalyst/commit/e1adadd479d575d6ee2dc0400695bec518d98fbc))

## [12.9.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.8.0...catalyst-dev-v12.9.0)

Jun 15, 2026

<!-- ai-enhanced -->

### Process Pipeline Visualization & Fleet Stability

Click any worker row in the orch-monitor to see its real-time metrics and activity feed, plus a new `/process` route that maps the daemon's 9-phase FSM pipeline with live ticket dots overlaid on each phase. Desktop client launches server-agnostic with setup screen for any Catalyst instance. Critical fleet memory leak fixed — execution-core now runs for months without restart, with bounded background workers and job directory cleanup.



### PRs

* **dev:** CTL-1011 — make applyAssignee self-assign loud (config-missing & scope-failure) ([#2046](https://github.com/coalesce-labs/catalyst/issues/2046)) ([34077e3](https://github.com/coalesce-labs/catalyst/commit/34077e344294f6d9ccf6a0979b1cddeecb1fda99))
* **dev:** CTL-1101 — /process route FSM machine map in orch-monitor ([#1970](https://github.com/coalesce-labs/catalyst/issues/1970)) ([62e3fde](https://github.com/coalesce-labs/catalyst/commit/62e3fde37b73a7e19c43cc6ba9540ae38ed86433))
* **dev:** CTL-1112/1149 — Catalyst desktop client (consolidated, server-agnostic) ([#2019](https://github.com/coalesce-labs/catalyst/issues/2019)) ([0897b44](https://github.com/coalesce-labs/catalyst/commit/0897b44b861a5230e938a4b0798d2ba2ecdcfc2c))
* **dev:** CTL-1132 — tickets board visual polish (column fill, tray lift, band separation, sidebar gap) ([#2005](https://github.com/coalesce-labs/catalyst/issues/2005)) ([7e84e90](https://github.com/coalesce-labs/catalyst/commit/7e84e90212ae25a194d5b5494e440988cc505707))
* **dev:** CTL-1144 — tickets board polish (balanced columns, card elevation, full-height bands, total count) ([#2008](https://github.com/coalesce-labs/catalyst/issues/2008)) ([1be0d13](https://github.com/coalesce-labs/catalyst/commit/1be0d131535e8d86deffc0f7e49c432292fe37a6))
* **dev:** CTL-1146 — card elevation (tray s1→s0) & band hue bump (6→9%) ([#2016](https://github.com/coalesce-labs/catalyst/issues/2016)) ([85240d2](https://github.com/coalesce-labs/catalyst/commit/85240d24d8f44292ce575203ce40f494d599a3ca))
* **dev:** CTL-1148 — fix selected toggle chip fill in light themes ([#2015](https://github.com/coalesce-labs/catalyst/issues/2015)) ([3bcb73a](https://github.com/coalesce-labs/catalyst/commit/3bcb73af564b1a99c0b1b3d31516df0939939fef))
* **dev:** CTL-1158 — surface PR merge-state on BoardTicket for stuck-PR inbox attention ([#2033](https://github.com/coalesce-labs/catalyst/issues/2033)) ([a2ca8e1](https://github.com/coalesce-labs/catalyst/commit/a2ca8e1f9986904dbae62e4151643a68e355e48a))
* **dev:** CTL-1150 — add triage-artifact guard to scheduler Pass 2 new-work dispatch ([#2038](https://github.com/coalesce-labs/catalyst/issues/2038)) ([67434e0](https://github.com/coalesce-labs/catalyst/commit/67434e0b3a36647ef0fb3f75b12cbe40a36d72d1))
* **dev:** CTL-1161 — broker webhook-independent merge refresh ([#2034](https://github.com/coalesce-labs/catalyst/issues/2034)) ([609134f](https://github.com/coalesce-labs/catalyst/commit/609134f3d0b6847e0c248b6711199fd9a8b16e56))
* **dev:** CTL-1165 — bound the execution-core fleet (reap-leak fix, 5 drivers) ([#2045](https://github.com/coalesce-labs/catalyst/issues/2045)) ([4915f7d](https://github.com/coalesce-labs/catalyst/commit/4915f7dd35b9908b624dd07f640df51047fe39c5))
* **dev:** CTL-863 follow-up — fence sweep-2 cycle label write + remove thoughts symlinks from tracking ([#1809](https://github.com/coalesce-labs/catalyst/issues/1809)) ([8f6b49d](https://github.com/coalesce-labs/catalyst/commit/8f6b49d73dfb3e3e5d02c46ace0041f9c3cbb61f))

## [12.8.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.7.0...catalyst-dev-v12.8.0) (2026-06-14)

<!-- ai-enhanced -->

### Execution Tab & Governance Rulebook

Open any ticket in the orch-monitor and click the new Execution tab to see a structured breakdown of what happened — current phase, a narrative summary, phase Gantt with timings and idle gaps, artifacts table, and an exceptions list — without digging through logs. The Governance Rulebook (`/rules`, keyboard shortcut `g r`) surfaces all 17 belief-engine rules across 6 strata in Plain English, Datalog, and the exact SQL the engine runs, with live firing-rate badges when belief recording is active. Escalated tickets that hit the remediate cycle cap now show a CTA-led explanation card in the detail pane with the blocking finding, why the worker gave up, and what you need to decide — no more bare Respond buttons with no context. This release also fixes a silent 12-hour plugin-checkout outage caused by dirty worktrees, adds self-healing refresh with a checkout-lag alarm after consecutive failures, and patches a bash 3.2 crash that left the entire fleet down after a `catalyst-stack restart` with no arguments.



### Features

* **dev:** checkout-lag alarm on persistent refresh failure (CTL-1106 Phase 2) — ([70fe374](https://github.com/coalesce-labs/catalyst/commit/70fe37498fd4d1bdc4b633337136fa2082689e18))
* **dev:** CTL-1099 — Warm/Slate brand theme system (warm default, Settings picker, semantic-invariant) ([#1944](https://github.com/coalesce-labs/catalyst/issues/1944)) ([e93ae79](https://github.com/coalesce-labs/catalyst/commit/e93ae79087db269a61ea21a80eedee3816aebfab))
* **dev:** CTL-1102 — Execution tab (model layer + useJourney hook + full UI) ([#1965](https://github.com/coalesce-labs/catalyst/issues/1965)) ([e336115](https://github.com/coalesce-labs/catalyst/commit/e3361151e94ae392c8d69af44e341c07b3c2bbaf))
* **dev:** CTL-1103 — Governance Rulebook textbook surface ([#1972](https://github.com/coalesce-labs/catalyst/issues/1972)) ([fa27e59](https://github.com/coalesce-labs/catalyst/commit/fa27e59b379b0446d3ce9f1851543ee8a55078b9))
* **dev:** CTL-1106 — self-healing plugin-checkout refresh + checkout-lag alarm ([#1949](https://github.com/coalesce-labs/catalyst/issues/1949)) ([70fe374](https://github.com/coalesce-labs/catalyst/commit/70fe37498fd4d1bdc4b633337136fa2082689e18))
* **dev:** CTL-1108 — populate humanQuestion for remediate-cycle-cap-exhausted escalations ([#1952](https://github.com/coalesce-labs/catalyst/issues/1952)) ([cdb1058](https://github.com/coalesce-labs/catalyst/commit/cdb1058526072f9cc4b7e20d1b3b9a9ab928368e))
* **dev:** CTL-1110 — escalated ticket detail pane CTA-led explanation card ([#1957](https://github.com/coalesce-labs/catalyst/issues/1957)) ([86aeea0](https://github.com/coalesce-labs/catalyst/commit/86aeea084f837af7ffe8f5e2ea4375d5759941c4))
* **dev:** CTL-1120 — prevent orch-monitor build artifacts from dirtying worktree ([#1974](https://github.com/coalesce-labs/catalyst/issues/1974)) ([405f6a2](https://github.com/coalesce-labs/catalyst/commit/405f6a2ef9fdd4aa16fb875bdd6af3d91f3e0d7a))


### Bug Fixes

* **dev:** CTL-1107 — guard empty start_args array in cmd_restart under bash 3.2 ([#1976](https://github.com/coalesce-labs/catalyst/issues/1976)) ([a23bc61](https://github.com/coalesce-labs/catalyst/commit/a23bc61fde5895af631723d996f4cbdc0905b145))
* **dev:** CTL-1111 — _find_layer2_config drift warning + phase skill stderr pass-through ([#1969](https://github.com/coalesce-labs/catalyst/issues/1969)) ([15cb905](https://github.com/coalesce-labs/catalyst/commit/15cb9055e64b8925b93526b741fe6ea2d5e70c92))
* **dev:** CTL-1118 — SHA-aware rebuild guard for catalyst-monitor hot-reload ([#1968](https://github.com/coalesce-labs/catalyst/issues/1968)) ([88afded](https://github.com/coalesce-labs/catalyst/commit/88afdedbee04bc349aa2546f53bc6566d01cea0b))
* **dev:** CTL-1119 — workflow-scope push handling for phase agents ([#1975](https://github.com/coalesce-labs/catalyst/issues/1975)) ([72e4feb](https://github.com/coalesce-labs/catalyst/commit/72e4feb6e5b12161d150ec81822bb5a3dd332671))
* **dev:** self-healing plugin-checkout refresh (CTL-1106 Phase 1) — fetch+reset --hard ([70fe374](https://github.com/coalesce-labs/catalyst/commit/70fe37498fd4d1bdc4b633337136fa2082689e18))

## [12.7.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.6.0...catalyst-dev-v12.7.0) (2026-06-13)

<!-- ai-enhanced -->

### Workers Dispatch/Board Split & Node Drain Mode

The Workers surface now splits into two dedicated screens — Dispatch (ControlTower) and Board (WorkerSwimlaneBoard) — toggled from the app-shell header, eliminating the sticky column header overlap and giving each view its own scroll container. Node drain mode lands alongside it: run `catalyst-execution-core drain` to stop a node from accepting new tickets while in-flight work finishes, with a HUD display and `--off` toggle to resume. This release also fixes phase workers stranding commits on transient `bgIsolation` branches, hardens the artifact gate to resolve paths against the ticket worktree rather than the process cwd, and prevents stale-ref PRs by push-verifying HEAD before announce and merge.



### Features

* **dev:** CTL-1051 — push-verify HEAD before announce/merge to prevent stale-ref PRs ([#1891](https://github.com/coalesce-labs/catalyst/issues/1891)) ([882f032](https://github.com/coalesce-labs/catalyst/commit/882f032c0f5f7ad858db56c00669d006edaaf436))
* **dev:** CTL-1062 — surface governance modes in heartbeat + CLI ([#1908](https://github.com/coalesce-labs/catalyst/issues/1908)) ([b92085f](https://github.com/coalesce-labs/catalyst/commit/b92085fdeb62d28abd0c92175d9fb39ea5432768))
* **dev:** CTL-1063 — dev-time Datalog compiler for belief engine rules ([#1884](https://github.com/coalesce-labs/catalyst/issues/1884)) ([ffa7c16](https://github.com/coalesce-labs/catalyst/commit/ffa7c1640693ac0f1cf2133fad12a0de7b722616))
* **dev:** CTL-1077 — hot-reload full stack on merge to main ([#1893](https://github.com/coalesce-labs/catalyst/issues/1893)) ([c0c5c64](https://github.com/coalesce-labs/catalyst/commit/c0c5c64e0a5369901c5842c284d55f5a20bca368))
* **dev:** CTL-1081 — phase artifacts land where the gate looks for them ([#1904](https://github.com/coalesce-labs/catalyst/issues/1904)) ([ceea9f7](https://github.com/coalesce-labs/catalyst/commit/ceea9f7474a7ad9e44af861f36a3354ddd0c0f35))
* **dev:** CTL-1095 — node drain mode: refuse new-work admission, CLI toggle, HUD display ([#1928](https://github.com/coalesce-labs/catalyst/issues/1928)) ([66cbb44](https://github.com/coalesce-labs/catalyst/commit/66cbb44063c9f25a1d79a23d86cdd60e4643c404))
* **dev:** CTL-1098 — Workers surface: Dispatch/Board split screens ([#1934](https://github.com/coalesce-labs/catalyst/issues/1934)) ([478e224](https://github.com/coalesce-labs/catalyst/commit/478e224e363f5feab5e38eb63d2484c5aa41f0d6))


### Bug Fixes

* **dev:** CTL-1060 — otel-forward reliability: DLQ drain fix, stack lifecycle, lag metric ([#1909](https://github.com/coalesce-labs/catalyst/issues/1909)) ([a308ae2](https://github.com/coalesce-labs/catalyst/commit/a308ae292a99f056cdba39d47f743b62f2635965))
* **dev:** CTL-1078 — classify retraction-sweep auth/scope failures correctly and break per-tick storm ([#1894](https://github.com/coalesce-labs/catalyst/issues/1894)) ([f27f2b7](https://github.com/coalesce-labs/catalyst/commit/f27f2b74bb0cd9d59fa0cf735cc12687f3037454))
* **dev:** CTL-1079 — retraction sweep reads label state from broker cache ([#1898](https://github.com/coalesce-labs/catalyst/issues/1898)) ([74e4cfc](https://github.com/coalesce-labs/catalyst/commit/74e4cfca40cf7f95303f31a52f8f00acfd53ac02))
* **dev:** CTL-1082 — restore vertical scroll to the Workers surface ([#1902](https://github.com/coalesce-labs/catalyst/issues/1902)) ([3ba1e7e](https://github.com/coalesce-labs/catalyst/commit/3ba1e7e72761581f1e0d1386eb74c1299ad6ac4a))
* **dev:** CTL-1083 — The Workers grouping switcher and dep-graph navigation should work ([#1905](https://github.com/coalesce-labs/catalyst/issues/1905)) ([f628bf9](https://github.com/coalesce-labs/catalyst/commit/f628bf927a8dae1a7fe8acf30d2b96bf3c42fb93))
* **dev:** CTL-1085 — removeLabel UUID overwrite fixes cross-team label collision ([#1930](https://github.com/coalesce-labs/catalyst/issues/1930)) ([7c6410b](https://github.com/coalesce-labs/catalyst/commit/7c6410bfe11d4bef9f3c69067f96102d31598c2a))
* **dev:** CTL-1086 — keep synthetic test events out of the live fleet event log ([#1929](https://github.com/coalesce-labs/catalyst/issues/1929)) ([a8e667a](https://github.com/coalesce-labs/catalyst/commit/a8e667a662e69b309eca29daefc67876d443adcb))
* **dev:** CTL-1087 — Service Health reads catalyst.* recency + infers collector from Loki state ([#1912](https://github.com/coalesce-labs/catalyst/issues/1912)) ([2b1eae5](https://github.com/coalesce-labs/catalyst/commit/2b1eae58d0b4ac01ff97666bc627c1834ddd737e))
* **dev:** CTL-1088 — restarting monitor must not dirty the pristine plugin clone ([#1914](https://github.com/coalesce-labs/catalyst/issues/1914)) ([31deaba](https://github.com/coalesce-labs/catalyst/commit/31deaba528bd72a3e1d11b2bb92573deb7103200))
* **dev:** CTL-1097 — resolve artifact gate dir against signal.worktreePath ([#1932](https://github.com/coalesce-labs/catalyst/issues/1932)) ([62cb760](https://github.com/coalesce-labs/catalyst/commit/62cb7607cbacf4f5f2c0b9f13d30ec6fdb8ff406))
* **dev:** CTL-1105 — stop phase workers stranding commits on transient bgIsolation branches ([#1945](https://github.com/coalesce-labs/catalyst/issues/1945)) ([c308f99](https://github.com/coalesce-labs/catalyst/commit/c308f993d8bbb95025e3301e61598347412f6a8b))

## [12.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.5.0...catalyst-dev-v12.6.0) (2026-06-12)

<!-- ai-enhanced -->

### Dispatch Board & Stall-Janitor Overhaul

This release is dense. The Queue surface is renamed Dispatch (with a `/queue` redirect for bookmarks), and the board now distinguishes held, retrying, and gave-up tickets with distinct chips and buckets instead of a blanket "waiting" label. A new stall-janitor (Pass 0j) detects orphaned worktrees and ghost sessions, auto-clears artifact-retry-exhausted stalls once a prior-phase artifact arrives, and ships a classify-then-act unstuck sweep (Pass 0u, opt-in via `CATALYST_UNSTUCK_SWEEP`) for the stalled/needs-human backlog. On the UI side, Cmd+K now covers actions, settings commands, and live ticket search; the sidebar shows per-project worker presence dots and inbox attention badges; and dead ghost sessions are correctly excluded from the admission-gate slot count so work stops getting blocked by terminal sessions that were never cleaned up.



### Features

* **dev:** chrome batch — one header per surface, numbered slots, overlay scrollbars, titles first (CTL-1018/1035/1036/1041) ([1051cae](https://github.com/coalesce-labs/catalyst/commit/1051cae1e8cf37bdd4141b6ee305e039d772999d))
* **dev:** CTL-1004 — stall-janitor: targeted orphan reap-requests + ghost-session kill-intents (shadow-first) ([#1817](https://github.com/coalesce-labs/catalyst/issues/1817)) ([a581efd](https://github.com/coalesce-labs/catalyst/commit/a581efda9c9bf6e9c45d0d4d19074b22d5dde128))
* **dev:** CTL-1005 — J3 artifact-complete auto-clear + CTL-1004 J2-enforce fix ([#1821](https://github.com/coalesce-labs/catalyst/issues/1821)) ([c35ac18](https://github.com/coalesce-labs/catalyst/commit/c35ac18ac00ecbf0f116581c15bb01ec27a7a989))
* **dev:** CTL-1008 — unified event log OTel completeness ([#1793](https://github.com/coalesce-labs/catalyst/issues/1793)) ([3a3fa00](https://github.com/coalesce-labs/catalyst/commit/3a3fa0034f9767d0869305630e75697451d748c5))
* **dev:** CTL-1009 — OTel attribute conformance manifest + drift guard ([#1830](https://github.com/coalesce-labs/catalyst/issues/1830)) ([d46efa7](https://github.com/coalesce-labs/catalyst/commit/d46efa75686fc31498013c7c99cb6a2b00038d7c))
* **dev:** CTL-1013 elevation inversion — dark chrome lowest, content and cards stack lighter ([#1788](https://github.com/coalesce-labs/catalyst/issues/1788)) ([108a957](https://github.com/coalesce-labs/catalyst/commit/108a9578bb63490173b677e9c102100cba3b8957))
* **dev:** CTL-1015 queue becomes a capacity-centric control tower — slots hero, dispatch ranking, motion ([#1790](https://github.com/coalesce-labs/catalyst/issues/1790)) ([c6c8a52](https://github.com/coalesce-labs/catalyst/commit/c6c8a5297484ffdcc8ed4fa3a56cb44fa66089ac))
* **dev:** CTL-1022 card type reads as a colored symbol; description tooltip removed ([#1796](https://github.com/coalesce-labs/catalyst/issues/1796)) ([47d8bdc](https://github.com/coalesce-labs/catalyst/commit/47d8bdc66bc5cf9bbd523141a2568afb0a3604db))
* **dev:** CTL-1023 work-type dimension on phase telemetry (catalyst.ticket.type) ([#1806](https://github.com/coalesce-labs/catalyst/issues/1806)) ([f1de97a](https://github.com/coalesce-labs/catalyst/commit/f1de97a3e460c0b7f1a3fa65d9c45f742da983a9))
* **dev:** CTL-1024 Cmd+K command palette — action registry, settings commands, ticket search ([#1851](https://github.com/coalesce-labs/catalyst/issues/1851)) ([1ca339d](https://github.com/coalesce-labs/catalyst/commit/1ca339d03a1a3ed70ef88cd9953c89d6842dd479))
* **dev:** CTL-1027 per-project color picker + swimlane tint ([#1854](https://github.com/coalesce-labs/catalyst/issues/1854)) ([12fd997](https://github.com/coalesce-labs/catalyst/commit/12fd997152d5b17696d9e4743bcc6524054b1df1))
* **dev:** CTL-1032 status strip counts honestly — active, dead, free, waiting ([#1803](https://github.com/coalesce-labs/catalyst/issues/1803)) ([ee85ff1](https://github.com/coalesce-labs/catalyst/commit/ee85ff14d6aac5a98f25d1bd97fcac34b0a88f47))
* **dev:** CTL-1033 elevation v2 — perceptible surface ladder + one token system across every page ([fa8bedd](https://github.com/coalesce-labs/catalyst/commit/fa8bedd1a1fe083a69985c1694da5df9e2cab9be))
* **dev:** CTL-1034 sidebar — collapsible sections, real project headings, child indentation ([#1808](https://github.com/coalesce-labs/catalyst/issues/1808)) ([be27787](https://github.com/coalesce-labs/catalyst/commit/be27787734ed4adbfa7abc5027da746aa4b7ed29))
* **dev:** CTL-1037 sidebar presence — per-project worker dots, honest counts, inbox attention badges ([#1825](https://github.com/coalesce-labs/catalyst/issues/1825)) ([a27b5b5](https://github.com/coalesce-labs/catalyst/commit/a27b5b531f2ecb00be8f787126853a78d0151a96))
* **dev:** CTL-1049 back-stack entry state — fresh defaults on push, exact restore on back/escape ([1d8eb32](https://github.com/coalesce-labs/catalyst/commit/1d8eb3282e310eb28aa84656ced9427171f49ed7))
* **dev:** CTL-1050+1039 stack service health — Fleet Ops strip, inbox outage events, proportional severity ([#1846](https://github.com/coalesce-labs/catalyst/issues/1846)) ([d74f63c](https://github.com/coalesce-labs/catalyst/commit/d74f63cd0fa42d1e11f5b574050e33b7b521f0a5))
* **dev:** CTL-1052 sidebar full-width/height, adjacent twisties, overlay dots, settings consolidation ([#1844](https://github.com/coalesce-labs/catalyst/issues/1844)) ([81c853d](https://github.com/coalesce-labs/catalyst/commit/81c853d00a11746a73cd24732b9d8efcd31780bf))
* **dev:** CTL-1054 Queue becomes Dispatch + uniform slot-card anatomy ([#1848](https://github.com/coalesce-labs/catalyst/issues/1848)) ([d1168e5](https://github.com/coalesce-labs/catalyst/commit/d1168e54af043052d2392626aaeb688b070a1db3))
* **dev:** CTL-1055 exclude terminal ghost sessions from admission-gate count ([#1860](https://github.com/coalesce-labs/catalyst/issues/1860)) ([489f36e](https://github.com/coalesce-labs/catalyst/commit/489f36e4ca08d0d4fa4bd28f36ec51b0d3b08053))
* **dev:** CTL-1058 — fix advance-shadow input-skew false disagreements via EDB-locked oracle ([#1862](https://github.com/coalesce-labs/catalyst/issues/1862)) ([477556b](https://github.com/coalesce-labs/catalyst/commit/477556bcb31d150d6a1c9a380167c56ae7dbeffc))
* **dev:** CTL-1064 — Auto-Unstuck Deep-Dive Sweep (classify-then-act, Pass 0u) ([#1880](https://github.com/coalesce-labs/catalyst/issues/1880)) ([e5e99f9](https://github.com/coalesce-labs/catalyst/commit/e5e99f9b089156b0d0f56c16ca16ffac49519d52))
* **dev:** CTL-1066 — queue board distinguishes held, retrying, and gave-up tickets ([#1875](https://github.com/coalesce-labs/catalyst/issues/1875)) ([c2e8929](https://github.com/coalesce-labs/catalyst/commit/c2e892975a34daa0fa14922bce2fe8fa4fe972cd))
* **dev:** CTL-1068 — retract orphaned held labels for admitted-then-failed tickets ([#1878](https://github.com/coalesce-labs/catalyst/issues/1878)) ([0cd8281](https://github.com/coalesce-labs/catalyst/commit/0cd82810d827adf4523a6d803655bff9c14f6a51))
* **dev:** CTL-1071 — Catalyst Warm-Textbook Identity Spike ([#1883](https://github.com/coalesce-labs/catalyst/issues/1883)) ([9d34b28](https://github.com/coalesce-labs/catalyst/commit/9d34b28f5b8d416882881b96a6e4447a2dd5733f))
* **dev:** CTL-729 — hung-worker watchdog + needs-attention surfacing (board + Inbox) ([#1814](https://github.com/coalesce-labs/catalyst/issues/1814)) ([095e514](https://github.com/coalesce-labs/catalyst/commit/095e5149b4197ed4523d9b2f66a40410d26f3f3e))
* **dev:** CTL-863 — surviving hosts take over a dead host's tickets and fence the zombie's Linear writes ([#1795](https://github.com/coalesce-labs/catalyst/issues/1795)) ([a7b4d0e](https://github.com/coalesce-labs/catalyst/commit/a7b4d0ec97fb33ecbb5b2d1fca5fe167fa45cc85))


### Bug Fixes

* **dev:** CTL-1020 dependency graph draws its edges — directed blocker arrows ([0f7a9a9](https://github.com/coalesce-labs/catalyst/commit/0f7a9a9dc6cd00e1bab6e573e4a4d498d72e1c1f))
* **dev:** CTL-1028 plumb cluster generation through triage dispatch path ([#1859](https://github.com/coalesce-labs/catalyst/issues/1859)) ([cb8bdad](https://github.com/coalesce-labs/catalyst/commit/cb8bdadb51009df9b5b1692d1a4c7e217b8c1e43))
* **dev:** CTL-1031 — Linear label changes reach the read-model (Inbox lights up) ([#1798](https://github.com/coalesce-labs/catalyst/issues/1798)) ([ad21f42](https://github.com/coalesce-labs/catalyst/commit/ad21f4253d0054794b3acfab0297d41b18d721cc))
* **dev:** CTL-1044 — shadow clock records evidence (operator-event appender + daemon wiring) ([#1819](https://github.com/coalesce-labs/catalyst/issues/1819)) ([10f16d8](https://github.com/coalesce-labs/catalyst/commit/10f16d8f7b9cbeb6c576d21ee7917519d3c2b841))
* **dev:** CTL-1045 — stall-janitor enforce-readiness hardening (J2 kill-storm, J3 cause + prior-signal, once-marker) ([#1826](https://github.com/coalesce-labs/catalyst/issues/1826)) ([4dacdfb](https://github.com/coalesce-labs/catalyst/commit/4dacdfb5e83ac045619d5f75935e872c9f2bc7bb))
* **dev:** CTL-1046 cross-team rows show titles on the control tower ([4fdf722](https://github.com/coalesce-labs/catalyst/commit/4fdf72232e1c335dfa69798e99ad213c573b66a5))
* **dev:** CTL-1048 detail pages scroll from anywhere — dead wheel zones removed ([#1837](https://github.com/coalesce-labs/catalyst/issues/1837)) ([02a1391](https://github.com/coalesce-labs/catalyst/commit/02a1391eaa2bce2a7df2114d2aa290d866f136a0))
* **dev:** CTL-1057 — gate HRW read-side filter on multiHost, add membership warning ([#1863](https://github.com/coalesce-labs/catalyst/issues/1863)) ([9ab5804](https://github.com/coalesce-labs/catalyst/commit/9ab580415a9de37999eb7e486d3e0e665e4e4784))
* **dev:** CTL-1075 — fix plan/implement dispatch gates silently fail open on macOS bash 3.2 ([#1877](https://github.com/coalesce-labs/catalyst/issues/1877)) ([af1387d](https://github.com/coalesce-labs/catalyst/commit/af1387d19076a8abde836774d4355c904e668b0c))
* **dev:** janitor shadow verdicts reach the log + dispatch failures carry stderr ([#1847](https://github.com/coalesce-labs/catalyst/issues/1847)) ([eb84808](https://github.com/coalesce-labs/catalyst/commit/eb84808657fd41618acb7001400aca41022a6b63))

## [12.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.4.0...catalyst-dev-v12.5.0) (2026-06-11)

<!-- ai-enhanced -->

### Observe Suite, Redesigned Shell & Agent Reliability

This release ships the full OBSERVE analytics suite (Telemetry, FinOps, and FleetOps surfaces with live Prometheus/Loki charts, cost breakdowns, and host health), a heavily reworked shell with unified routing, Linear-quality ticket detail pages, and a new swimlane board that shares one scroll axis across all groups. On the reliability side, workers now fence irreversible side-effects against cluster takeover, parked needs-input workers release their concurrency slot and resume when unblocked, and a belief-store rule layer tracks liveness, blocker rank, and escalation decisions each tick. The dirty-worktree rebase storm, boot-resume no-op, and stale eligible-projection bugs are also fixed.



### Features

* **dev:** belief store obs_relation — record blocking edges as facts each tick (CTL-964) ([#1690](https://github.com/coalesce-labs/catalyst/issues/1690)) ([df5bd89](https://github.com/coalesce-labs/catalyst/commit/df5bd89711cf466b3b2497623fad50777804aed3))
* **dev:** belief-store Step 1 — per-tick liveness fact collector (CTL-933) ([#1630](https://github.com/coalesce-labs/catalyst/issues/1630)) ([bc853c5](https://github.com/coalesce-labs/catalyst/commit/bc853c50794b6e72c447b890ee3c04a845ada96e))
* **dev:** beliefs SSE endpoint /api/beliefs/stream + BeliefTail cursor (CTL-967) ([#1700](https://github.com/coalesce-labs/catalyst/issues/1700)) ([baf71e5](https://github.com/coalesce-labs/catalyst/commit/baf71e5cda48aa46225cea18c881885efe5c3101))
* **dev:** BFF10 per-entity host/team/generation (CTL-922) ([#1576](https://github.com/coalesce-labs/catalyst/issues/1576)) ([294bd81](https://github.com/coalesce-labs/catalyst/commit/294bd8124c0ac0f2b5c8531e0393bec686d895ea))
* **dev:** BFF12 fence-aware Answer/Unblock read-model mutation endpoint (CTL-924) ([#1589](https://github.com/coalesce-labs/catalyst/issues/1589)) ([87a4c38](https://github.com/coalesce-labs/catalyst/commit/87a4c38ac043c92e935e8e0bc0d1823a575a0f04))
* **dev:** BFF2 cluster grouping + liveness overlay (CTL-884) ([#1575](https://github.com/coalesce-labs/catalyst/issues/1575)) ([f766acf](https://github.com/coalesce-labs/catalyst/commit/f766acfbe04077788248a4017ccce2a801f0514a))
* **dev:** BFF3 cross-node live-tail SSE fan-in (CTL-885) ([#1590](https://github.com/coalesce-labs/catalyst/issues/1590)) ([8d0e0a4](https://github.com/coalesce-labs/catalyst/commit/8d0e0a4a67b57a4b9c96d19e3f370cbddbb9610d))
* **dev:** BFF5 live EC-worker transcript tail SSE (CTL-887) ([#1573](https://github.com/coalesce-labs/catalyst/issues/1573)) ([83332b3](https://github.com/coalesce-labs/catalyst/commit/83332b35beeddc01de140e45b5ef4d5aec7c96c7))
* **dev:** BFF8 fence-aware stop-worker mutation (CTL-890) ([#1574](https://github.com/coalesce-labs/catalyst/issues/1574)) ([89714a2](https://github.com/coalesce-labs/catalyst/commit/89714a22fbe6e9d08ae689cf5d0e2690c45aa06e))
* **dev:** board shared column headers + single horizontal scroll across swimlanes (CTL-950) ([#1656](https://github.com/coalesce-labs/catalyst/issues/1656)) ([6bc5de4](https://github.com/coalesce-labs/catalyst/commit/6bc5de4541f7d99ddcff04016722f8f1de40f0c8))
* **dev:** board shows one method-correct estimate + dependency chips; estimate read-model projection (CTL-957) ([#1685](https://github.com/coalesce-labs/catalyst/issues/1685)) ([5180b85](https://github.com/coalesce-labs/catalyst/commit/5180b85b67a0fef090e13fd1bfb46622e2d56cec))
* **dev:** BOARD2 display-options popover — density is a knob (CTL-906) ([#1609](https://github.com/coalesce-labs/catalyst/issues/1609)) ([e6e48bb](https://github.com/coalesce-labs/catalyst/commit/e6e48bb90ca727b37e8ac1d605d0b515ca27d8ac))
* **dev:** BOARD3 row swimlanes by team / project / host-node (CTL-907) ([#1611](https://github.com/coalesce-labs/catalyst/issues/1611)) ([d7984ba](https://github.com/coalesce-labs/catalyst/commit/d7984ba306337a656d48335fb8d470be993aa24a))
* **dev:** BOARD4 dense List view as an alternate board layout (CTL-908) ([#1613](https://github.com/coalesce-labs/catalyst/issues/1613)) ([7b4edd5](https://github.com/coalesce-labs/catalyst/commit/7b4edd5fc69c7bb749e349da9d07c7571a190f02))
* **dev:** bounded stall-diagnostician wake wiring + evidence capture (CTL-937) ([#1641](https://github.com/coalesce-labs/catalyst/issues/1641)) ([410a3ac](https://github.com/coalesce-labs/catalyst/commit/410a3acdba527dc763bc6f2f51b71969012d8e47))
* **dev:** closed-loop intent layer — stop-storm, fire-once, pager-fail (CTL-936) ([#1643](https://github.com/coalesce-labs/catalyst/issues/1643)) ([b4fe04b](https://github.com/coalesce-labs/catalyst/commit/b4fe04b0aff23f2a734fb98155fd89bb2825d626))
* **dev:** CTL-1000 — wrappers resolve from healthy pristine checkout (cache fallback + loud warning + --version source) ([#1768](https://github.com/coalesce-labs/catalyst/issues/1768)) ([4665b14](https://github.com/coalesce-labs/catalyst/commit/4665b14195e116fa4531526abfccfaae59259867))
* **dev:** CTL-1003 ticket detail v3 — Linear-parity chrome, prose, tabs, rail cards, relations (+CTL-999 off-board) ([#1758](https://github.com/coalesce-labs/catalyst/issues/1758)) ([ef8a8d9](https://github.com/coalesce-labs/catalyst/commit/ef8a8d96cabdac2c9c24c9aae2b08eee168634b1))
* **dev:** CTL-1012 project branding in lane headers + detail rails ([#1769](https://github.com/coalesce-labs/catalyst/issues/1769)) ([b2f8d1f](https://github.com/coalesce-labs/catalyst/commit/b2f8d1fde1e4e65490638131c3633ad6773df477))
* **dev:** CTL-768 — release parked worker slot (needs-input → hold-stop + revive-with-resume) ([#1736](https://github.com/coalesce-labs/catalyst/issues/1736)) ([c59c9be](https://github.com/coalesce-labs/catalyst/commit/c59c9be7464ce53241036ff860d7971975ca9321))
* **dev:** CTL-864 — workers fence irreversible side-effects against cluster takeover (generation token through dispatch + 5 skill guards) ([#1780](https://github.com/coalesce-labs/catalyst/issues/1780)) ([f6affb5](https://github.com/coalesce-labs/catalyst/commit/f6affb5f008de493851a92051643f59421d70b21))
* **dev:** CTL-966 advance_to phase-prediction shadow comparator ([#1704](https://github.com/coalesce-labs/catalyst/issues/1704)) ([c97dee7](https://github.com/coalesce-labs/catalyst/commit/c97dee753399dbfa552d9cdad27b62f50adcd851))
* **dev:** CTL-981 nav final calibration — weight 500 + contrast /72 for label presence ([#1708](https://github.com/coalesce-labs/catalyst/issues/1708)) ([2cf8971](https://github.com/coalesce-labs/catalyst/commit/2cf8971e6791e790384bba3f2795bf5a229ef34e))
* **dev:** CTL-989 unify app shell — single router, AppShell on every screen, URL=source-of-truth ([#1735](https://github.com/coalesce-labs/catalyst/issues/1735)) ([74e0a2c](https://github.com/coalesce-labs/catalyst/commit/74e0a2c741a73aaae5ddc48dd56638a250bd9cf9))
* **dev:** CTL-996 ticket detail — Linear-calm reading column + right rail + visible tabs ([#1745](https://github.com/coalesce-labs/catalyst/issues/1745)) ([6436f1d](https://github.com/coalesce-labs/catalyst/commit/6436f1d6b68c797150bb0e51fb60585649a1a7dc))
* **dev:** DETAIL1 shared detail chrome + pager + keyboard (CTL-912) ([#1584](https://github.com/coalesce-labs/catalyst/issues/1584)) ([de7911f](https://github.com/coalesce-labs/catalyst/commit/de7911f87ae572c31b3a451aa78fba1e485c1765))
* **dev:** DETAIL2 ticket detail page skeleton (CTL-913) ([#1597](https://github.com/coalesce-labs/catalyst/issues/1597)) ([9c325f0](https://github.com/coalesce-labs/catalyst/commit/9c325f0187813a332b7272648efb641f151d61de))
* **dev:** DETAIL3 worker page skeleton + Loki history tail (CTL-914) ([#1600](https://github.com/coalesce-labs/catalyst/issues/1600)) ([a21da5c](https://github.com/coalesce-labs/catalyst/commit/a21da5c41d8883e0627eaa84998a30b62c153002))
* **dev:** DETAIL4 wire per-phase model/startedAt/pid/sess_id (CTL-915) ([#1602](https://github.com/coalesce-labs/catalyst/issues/1602)) ([84ea09d](https://github.com/coalesce-labs/catalyst/commit/84ea09d67956cbb47e872ea33e0c026411e5616f))
* **dev:** DETAIL5 re-skinned command palette + cheatsheet (CTL-916) ([#1599](https://github.com/coalesce-labs/catalyst/issues/1599)) ([e191d5e](https://github.com/coalesce-labs/catalyst/commit/e191d5e7b19887f9ff594a5c6bb3f964b0a16660))
* **dev:** DETAIL6 telemetry / burn metrics off OTEL (CTL-917) ([#1605](https://github.com/coalesce-labs/catalyst/issues/1605)) ([00f8288](https://github.com/coalesce-labs/catalyst/commit/00f82888e7e1833fe46a2092c60f571df523c145))
* **dev:** DETAIL7 live activity tail (CTL-918) ([#1606](https://github.com/coalesce-labs/catalyst/issues/1606)) ([9a4ed26](https://github.com/coalesce-labs/catalyst/commit/9a4ed26a54c883b2e38041fa7ec42dbac229b4cc))
* **dev:** dispatch workers with --plugin-dir from per-host pluginDirs config ([#1614](https://github.com/coalesce-labs/catalyst/issues/1614)) ([9f21ff3](https://github.com/coalesce-labs/catalyst/commit/9f21ff33f799cec92e38804de3c96c51c9bad92c))
* **dev:** HOME1 calm master-detail Inbox home (CTL-899) ([#1581](https://github.com/coalesce-labs/catalyst/issues/1581)) ([9067471](https://github.com/coalesce-labs/catalyst/commit/90674713758abef13fab00a4e72f4e7512603ee9))
* **dev:** HOME2 status glyph + phase strip (CTL-900) ([#1594](https://github.com/coalesce-labs/catalyst/issues/1594)) ([399d1d7](https://github.com/coalesce-labs/catalyst/commit/399d1d733442b0ee90acef33d7013ae2a00ce23a))
* **dev:** HOME3 reframed groups + per-row durations (CTL-901) ([#1595](https://github.com/coalesce-labs/catalyst/issues/1595)) ([8129d78](https://github.com/coalesce-labs/catalyst/commit/8129d78d1dcbb8306dc8a878f01d0e9e4f97bd32))
* **dev:** HOME4 reading pane — ask/options/About/View-in-Claude (CTL-902) ([#1601](https://github.com/coalesce-labs/catalyst/issues/1601)) ([1d5bef0](https://github.com/coalesce-labs/catalyst/commit/1d5bef023cf594573ae7201bc940b8bb7f0dbaee))
* **dev:** HOME5 one verb clears item + resumes the paused agent (CTL-903) ([#1607](https://github.com/coalesce-labs/catalyst/issues/1607)) ([2a53fec](https://github.com/coalesce-labs/catalyst/commit/2a53fec5573c0cd8315c1d09a3c878f7245fe1c3))
* **dev:** HOME6 calm all-clear empty state (CTL-904) ([#1593](https://github.com/coalesce-labs/catalyst/issues/1593)) ([b56d511](https://github.com/coalesce-labs/catalyst/commit/b56d511466c9fdf3ad80947acf87342b97ca898e))
* **dev:** HUD2 terminal HUD consumes the shared read-model (CTL-920) ([#1583](https://github.com/coalesce-labs/catalyst/issues/1583)) ([fc7e1f9](https://github.com/coalesce-labs/catalyst/commit/fc7e1f947de4732499025580b0b66bf7a925f49d))
* **dev:** left-nav restyle v2 — natural-case headers, right twistie, Linear selected state (CTL-977) ([#1701](https://github.com/coalesce-labs/catalyst/issues/1701)) ([fbdc1ae](https://github.com/coalesce-labs/catalyst/commit/fbdc1aec507fd79d89c6e54d3261f5377ae91ae9))
* **dev:** LIFECYCLE SPINE real per-phase cost/tokens + artifact links + prominent Gantt (CTL-953) ([#1664](https://github.com/coalesce-labs/catalyst/issues/1664)) ([ec1f054](https://github.com/coalesce-labs/catalyst/commit/ec1f0548af5c25ce88ad2eb8f765243145210882))
* **dev:** Linear-style board scroll — dual-sticky group labels + per-cell overscroll chaining (CTL-958) ([#1669](https://github.com/coalesce-labs/catalyst/issues/1669)) ([9463edb](https://github.com/coalesce-labs/catalyst/commit/9463edb2eaaf08d42b1f3d9d6f6276cd8f51e4e4))
* **dev:** list view on TanStack Data Table — default stage/status grouping (CTL-955) ([#1663](https://github.com/coalesce-labs/catalyst/issues/1663)) ([c4dc73b](https://github.com/coalesce-labs/catalyst/commit/c4dc73bae5bbef12942a7a1ccacf4ecba8decef2))
* **dev:** live terminal screen pane for pre-transcript workers (CTL-938) ([#1629](https://github.com/coalesce-labs/catalyst/issues/1629)) ([78f3edb](https://github.com/coalesce-labs/catalyst/commit/78f3edb16d12b95626594a8b81c8711125256816))
* **dev:** motion — animate board/list/queue state & position transitions (CTL-952) ([#1659](https://github.com/coalesce-labs/catalyst/issues/1659)) ([2c57400](https://github.com/coalesce-labs/catalyst/commit/2c5740034882c5e0a75028e985ac2a6366e5333b))
* **dev:** nav proportion v3 — 16px icons, muted labels, twistie beside label, Projects heading (CTL-980) ([#1706](https://github.com/coalesce-labs/catalyst/issues/1706)) ([5ad727a](https://github.com/coalesce-labs/catalyst/commit/5ad727a18a3e8698b07e76e97d5c2ccee2053739))
* **dev:** OBSERVE FinOps surface — cost routes + hero(today-vs-7d + cache-ROI) + breakdowns (OBS-9/10/11) ([#1716](https://github.com/coalesce-labs/catalyst/issues/1716)) ([f0615c6](https://github.com/coalesce-labs/catalyst/commit/f0615c6f4a83ae1846a7b494eed52d3bcd1f5c82))
* **dev:** OBSERVE FleetOps surface — host health + stuck/dead reap hints + reconcile (OBS-18) ([#1719](https://github.com/coalesce-labs/catalyst/issues/1719)) ([1f02983](https://github.com/coalesce-labs/catalyst/commit/1f02983e670da98930152f0655a17e3dacc006da))
* **dev:** OBSERVE foundation — chart grammar + panel honesty kit + shell (OBS-1/2/5) ([#1713](https://github.com/coalesce-labs/catalyst/issues/1713)) ([7603f5f](https://github.com/coalesce-labs/catalyst/commit/7603f5f5860c23cbfb2681e01345473bf945ab25))
* **dev:** OBSERVE Telemetry surface — hero + live tail + errors/tools/latency + events heatmap (OBS-6/7/8) ([#1714](https://github.com/coalesce-labs/catalyst/issues/1714)) ([3cd51ab](https://github.com/coalesce-labs/catalyst/commit/3cd51abf79d90f7ff3c6b0fa9d620973f2567663))
* **dev:** one-checkout node updates — hotpatch pulls the pluginDirs checkout, parity reports drift (CTL-940, CTL-941) ([#1626](https://github.com/coalesce-labs/catalyst/issues/1626)) ([f704bb5](https://github.com/coalesce-labs/catalyst/commit/f704bb539c2ecbd062318844ad10a6dd244d105c))
* **dev:** one-checkout node updates — hotpatch pulls the pluginDirs checkout, parity reports drift (CTL-940, CTL-941) ([#1627](https://github.com/coalesce-labs/catalyst/issues/1627)) ([b61524e](https://github.com/coalesce-labs/catalyst/commit/b61524e44912b03fe9ed8fec561b394ba45f82d6))
* **dev:** one-nav board shell — project-grouped sidebar, quiet display popover, engaged swimlanes, contrast pass (CTL-930, CTL-944) ([#1636](https://github.com/coalesce-labs/catalyst/issues/1636)) ([78ec17b](https://github.com/coalesce-labs/catalyst/commit/78ec17b5ea91a038a455b847ac57527b733b6ba6))
* **dev:** per-project nav icons — auto-detect repo favicon + manual override (CTL-961) ([#1682](https://github.com/coalesce-labs/catalyst/issues/1682)) ([d310722](https://github.com/coalesce-labs/catalyst/commit/d310722a6564ee6001f529631caa0788141a20ec))
* **dev:** pristine main-only plugin-source checkout + merge-to-main auto-refresh (CTL-992, CTL-993) ([#1743](https://github.com/coalesce-labs/catalyst/issues/1743)) ([0280976](https://github.com/coalesce-labs/catalyst/commit/028097621c6c4a6935899f961c271dffff1c0dc6))
* **dev:** queue — group workers by all activity states, blocked pinned bottom with blockers (CTL-947) ([#1654](https://github.com/coalesce-labs/catalyst/issues/1654)) ([5372b61](https://github.com/coalesce-labs/catalyst/commit/5372b61c072759d8ba17bca59933574aa469160f))
* **dev:** React Flow dependency graph — backlog graph + per-ticket dep sub-graph (CTL-948) ([#1655](https://github.com/coalesce-labs/catalyst/issues/1655)) ([8a5d697](https://github.com/coalesce-labs/catalyst/commit/8a5d697471a9c36b58af1157db776b7362232830))
* **dev:** recursive dependency beliefs over obs_relation — blocker_rank/cycle_detected/ready (CTL-965) ([#1699](https://github.com/coalesce-labs/catalyst/issues/1699)) ([e360841](https://github.com/coalesce-labs/catalyst/commit/e36084166074bc45d4c50050d48e84af1e217791))
* **dev:** SHELL2 Dense Board inside the shell (CTL-892) ([#1579](https://github.com/coalesce-labs/catalyst/issues/1579)) ([657b740](https://github.com/coalesce-labs/catalyst/commit/657b740f1790bf8ef516708791bd17f9fb7a1444))
* **dev:** SHELL3 OPERATE/OBSERVE nav IA + brand + footer (CTL-893) ([#1580](https://github.com/coalesce-labs/catalyst/issues/1580)) ([32fb41f](https://github.com/coalesce-labs/catalyst/commit/32fb41f9bc87f099dc83b472457e9d88d15125b1))
* **dev:** SHELL5 top strip — single search palette + '/' open (CTL-895) ([#1588](https://github.com/coalesce-labs/catalyst/issues/1588)) ([ee4607c](https://github.com/coalesce-labs/catalyst/commit/ee4607c1ec8cd29342d3563f2d66ecad5af14b13))
* **dev:** SHELL6 live nav badges/dots from read-model (CTL-896) ([#1591](https://github.com/coalesce-labs/catalyst/issues/1591)) ([05c5b67](https://github.com/coalesce-labs/catalyst/commit/05c5b67188ce45216dfc7ab242491b2df5d43661))
* **dev:** SHELL7 config-driven workspace switcher (CTL-897) ([#1603](https://github.com/coalesce-labs/catalyst/issues/1603)) ([dde9d9f](https://github.com/coalesce-labs/catalyst/commit/dde9d9f8529f90e95885d9aae27b4c99fbd70948))
* **dev:** SHELL8 footer per-node cluster health + node filter (CTL-898) ([#1604](https://github.com/coalesce-labs/catalyst/issues/1604)) ([da688e3](https://github.com/coalesce-labs/catalyst/commit/da688e3196cf06d63b2f9ac0d537d0c417b37e03))
* **dev:** single-click opens detail page, drawer removed, Linear-style pager + Esc-restore (CTL-951) ([#1658](https://github.com/coalesce-labs/catalyst/issues/1658)) ([d22b6f3](https://github.com/coalesce-labs/catalyst/commit/d22b6f31c2eeb61ef3f96fe4e01cc1e1fc28192a))
* **dev:** stratified belief rules + provenance + catalyst why (CTL-934) ([#1635](https://github.com/coalesce-labs/catalyst/issues/1635)) ([b9231bc](https://github.com/coalesce-labs/catalyst/commit/b9231bc75417bcfdbdc02a3985a8ca90dda803af))
* **dev:** supplemental estimate fallback — board shows real Linear estimates for legacy tickets (CTL-974) ([#1692](https://github.com/coalesce-labs/catalyst/issues/1692)) ([bbe55d3](https://github.com/coalesce-labs/catalyst/commit/bbe55d317ffd63918914495126e824e1bd9d3583))
* **dev:** SURF1 Workers grid grouped/filtered by host node (CTL-909) ([#1596](https://github.com/coalesce-labs/catalyst/issues/1596)) ([573bbbc](https://github.com/coalesce-labs/catalyst/commit/573bbbc153b5b9a94664f2adfc561ae73b398256))
* **dev:** SURF2 wide ranked Queue depth surface (CTL-910) ([#1598](https://github.com/coalesce-labs/catalyst/issues/1598)) ([b04c883](https://github.com/coalesce-labs/catalyst/commit/b04c88310a87ca2524d80f67f50cbe2d708a9484))
* **dev:** SURF3 Settings surface (persisted prefs) (CTL-911) ([#1585](https://github.com/coalesce-labs/catalyst/issues/1585)) ([5461865](https://github.com/coalesce-labs/catalyst/commit/546186562c9ed41a4e000765e8e53d29f5d56acd))
* **dev:** ticket detail — real title + Linear-quality markdown description ([#1733](https://github.com/coalesce-labs/catalyst/issues/1733)) ([8973797](https://github.com/coalesce-labs/catalyst/commit/89737975f52b3204abd2ea555fdac3172deb85e7))
* **dev:** ticket detail v2 — PM status hero + consolidated lifecycle + Cost/Activity tabs ([#1730](https://github.com/coalesce-labs/catalyst/issues/1730)) ([9eecfb5](https://github.com/coalesce-labs/catalyst/commit/9eecfb598e07df41085a34ba2d5e63c16ac7de4e))
* **dev:** triage estimates in the project's estimation method, cached with TTL — one estimate not two (CTL-954) ([#1657](https://github.com/coalesce-labs/catalyst/issues/1657)) ([64b4b14](https://github.com/coalesce-labs/catalyst/commit/64b4b1476af8b914d5cd91a4422c56a853c24c8c))
* **dev:** turn-zero gate — stop+replace workers that never start their first turn (CTL-932) ([#1631](https://github.com/coalesce-labs/catalyst/issues/1631)) ([0b34dd7](https://github.com/coalesce-labs/catalyst/commit/0b34dd71b3828f34ec8c9d681039f6d6feab73dc))
* **dev:** worker detail v2 — one rail + ticket link + structured Now view + workflow telemetry ([#1729](https://github.com/coalesce-labs/catalyst/issues/1729)) ([5495905](https://github.com/coalesce-labs/catalyst/commit/549590534819be215180bde990c79104bafc2849))


### Bug Fixes

* **dev:** board surface SkeletonDashboard — free a connection slot for the lazy board chunk (CTL-945) ([#1639](https://github.com/coalesce-labs/catalyst/issues/1639)) ([cf44dde](https://github.com/coalesce-labs/catalyst/commit/cf44ddef016b77903a26a2afb041d1411b5fc51c))
* **dev:** board swipe hijack — contain overscroll + edge bump (CTL-973) ([#1686](https://github.com/coalesce-labs/catalyst/issues/1686)) ([aeaa4ba](https://github.com/coalesce-labs/catalyst/commit/aeaa4ba0423d993b3e4217f064a9d3b7334e4162))
* **dev:** board wheel guard froze horizontal scroll at the resting left edge ([#1710](https://github.com/coalesce-labs/catalyst/issues/1710)) ([5d8ddd1](https://github.com/coalesce-labs/catalyst/commit/5d8ddd1d23c82543f8189d3a0af4305ccedab02f))
* **dev:** CTL-1006 — boot-resume on daemon bounces + phase-regression guard (no more restart-manufactured stalls) ([#1763](https://github.com/coalesce-labs/catalyst/issues/1763)) ([d8c6d5a](https://github.com/coalesce-labs/catalyst/commit/d8c6d5acf37d72e39cbbe73384428c496ab3361b))
* **dev:** CTL-1010 swimlanes fill the board height — flex distribution + lane scroll ([#1765](https://github.com/coalesce-labs/catalyst/issues/1765)) ([a9fb26d](https://github.com/coalesce-labs/catalyst/commit/a9fb26d5c664f66a3788a39d009cfe566edde850))
* **dev:** CTL-1014 — repo-identity resolver honors canonical catalyst.repository key ([#1772](https://github.com/coalesce-labs/catalyst/issues/1772)) ([924d65b](https://github.com/coalesce-labs/catalyst/commit/924d65bbeaeb63b68276f33029747bd127170210))
* **dev:** CTL-926 — eligible projection refreshes when blocked_by relations change out-of-band ([#1771](https://github.com/coalesce-labs/catalyst/issues/1771)) ([5cdd6b1](https://github.com/coalesce-labs/catalyst/commit/5cdd6b16248df2d932b9b08a92dd982e43f06f38))
* **dev:** CTL-928 truthful queue-board liveness — dead bg-workers excluded, idle-between-phases lane ([#1610](https://github.com/coalesce-labs/catalyst/issues/1610)) ([86e09b2](https://github.com/coalesce-labs/catalyst/commit/86e09b203391f2f5431717f7755d21f0cdb22795))
* **dev:** CTL-929 exempt zero-dep tickets from the triage→research read-failure fail-safe hold ([#1592](https://github.com/coalesce-labs/catalyst/issues/1592)) ([6fe3a83](https://github.com/coalesce-labs/catalyst/commit/6fe3a838fbf4e7c32d4f1f05a8bdab04ee83f7c8))
* **dev:** CTL-978 queue must not count dead workers as in-flight ([#1703](https://github.com/coalesce-labs/catalyst/issues/1703)) ([2bb64c7](https://github.com/coalesce-labs/catalyst/commit/2bb64c787f969e180aa676d4caf09216f43264af))
* **dev:** CTL-979 ADVA favicon — case-normalize repo key + add monorepo icon paths ([#1702](https://github.com/coalesce-labs/catalyst/issues/1702)) ([3283ba1](https://github.com/coalesce-labs/catalyst/commit/3283ba17b4b31bbb5ecce09c44b2745adde2ea5b))
* **dev:** CTL-990 — kill the dirty-worktree rebase loop (root fix + typed precheck + recreate guard + dispatch timeout) ([#1734](https://github.com/coalesce-labs/catalyst/issues/1734)) ([cd88a63](https://github.com/coalesce-labs/catalyst/commit/cd88a63ffc4d55bc1f18f7f20e81bd67db536096))
* **dev:** dedupe obs_relation symmetric edges within a tick (CTL-964 follow-up) ([#1711](https://github.com/coalesce-labs/catalyst/issues/1711)) ([33fb204](https://github.com/coalesce-labs/catalyst/commit/33fb204f49cfb75a414ba5e5ffeb73ba55013df8))
* **dev:** dependency graph — draw edges, scope labels, /dep-graph SPA fallback, knip cleanup (CTL-959) ([#1668](https://github.com/coalesce-labs/catalyst/issues/1668)) ([c70c65a](https://github.com/coalesce-labs/catalyst/commit/c70c65ab36b7dee01861ce82f5461448ef35a0ec))
* **dev:** detail page fills full viewport height — no white gap (CTL-949) ([#1651](https://github.com/coalesce-labs/catalyst/issues/1651)) ([7974c7c](https://github.com/coalesce-labs/catalyst/commit/7974c7c1dde749fc38da04ecb937fccab25eba45))
* **dev:** escalate stuck once — single escalate_human executor, exactly-once page (CTL-962) ([#1693](https://github.com/coalesce-labs/catalyst/issues/1693)) ([9e91c41](https://github.com/coalesce-labs/catalyst/commit/9e91c4121e3148f036a7cfad1132d084850e5e8f))
* **dev:** estimate fallback query uses team+number filter — fixes 400 error (CTL-976) ([#1695](https://github.com/coalesce-labs/catalyst/issues/1695)) ([5c17b01](https://github.com/coalesce-labs/catalyst/commit/5c17b01fe2425a4575b1dcf1ff6287f2bb34de35))
* **dev:** FinOps hero + spend cards collapsed to 2px (shrink-0 on scroll-column children) ([#1717](https://github.com/coalesce-labs/catalyst/issues/1717)) ([86a2bc6](https://github.com/coalesce-labs/catalyst/commit/86a2bc68bf244393cb824304ea5c5e424e363bfb))
* **dev:** make Linear-audit mitmproxy strictly opt-in, add NO_PROXY safety guard (CTL-946) ([#1640](https://github.com/coalesce-labs/catalyst/issues/1640)) ([da51c5a](https://github.com/coalesce-labs/catalyst/commit/da51c5a12230eef036b8e2ea60b1b01fa0a55513))
* **dev:** OBSERVE Telemetry Loki queries — model/tool latency + tail field extraction ([#1715](https://github.com/coalesce-labs/catalyst/issues/1715)) ([0275934](https://github.com/coalesce-labs/catalyst/commit/0275934022aebdea66eb1af0b43b9cff297d4ea0))
* **dev:** restore board surface + scope + dual-axis scroll on detail return (CTL-971) ([#1683](https://github.com/coalesce-labs/catalyst/issues/1683)) ([5edc063](https://github.com/coalesce-labs/catalyst/commit/5edc0639f51c015edbc89e0e8b28621277814e05))
* **dev:** turn-zero cap branch is terminal — no post-escalation respawn (CTL-932) ([#1633](https://github.com/coalesce-labs/catalyst/issues/1633)) ([8c7d3a0](https://github.com/coalesce-labs/catalyst/commit/8c7d3a0e50a202cfe77b1d7b47c3f24fc1dbd1c6))
* **dev:** unify board phase with phase-agent-type + remediate column + lens label (CTL-972) ([#1687](https://github.com/coalesce-labs/catalyst/issues/1687)) ([09d6e4e](https://github.com/coalesce-labs/catalyst/commit/09d6e4e68de5a407555b368f77d81c8404a06bb3))
* **dev:** wire applyNeedsHuman in scheduler + clean up dead code in diagnostician (CTL-937) ([#1642](https://github.com/coalesce-labs/catalyst/issues/1642)) ([2982ba6](https://github.com/coalesce-labs/catalyst/commit/2982ba62012f319112e1c00baa6d9c3ab78cd927))
* **dev:** wire board→detail-page navigation + SPA fallback for /ticket /worker (CTL-942) ([#1632](https://github.com/coalesce-labs/catalyst/issues/1632)) ([1532302](https://github.com/coalesce-labs/catalyst/commit/1532302468ac869597d41dad731c3f5883e43cc6))
* **dev:** wire intentDb + appendIntentEvent into runTick; pin bgJobId in kill postcondition (CTL-936) ([#1644](https://github.com/coalesce-labs/catalyst/issues/1644)) ([0a4e898](https://github.com/coalesce-labs/catalyst/commit/0a4e898379cd69d88c91b07b267c32f7646e6931))

## [12.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.3.0...catalyst-dev-v12.4.0) (2026-06-09)

<!-- ai-enhanced -->

### Cache-Backed Read-Model & Board Redesign Foundation

This release lays the architectural foundation for the upcoming board and detail-page redesign. The orchestration monitor's read-model now assembles once from durable caches and fans out to all clients — no more synchronous Linear API calls per request — and every BFF endpoint (ticket detail, artifacts, search, ticket run history) reads exclusively from broker-cached data. Alongside that, the board gains deep-linkable routes via TanStack Router, a single ordering source shared between the board and the detail pager, a typed read-model client contract enforced at compile time across the web UI and terminal HUD, and an edge-to-edge app shell built on the shadcn Sidebar primitive. Two dependency bugs are also fixed: epic-to-child deadlocks and false blockers from prose-scraped ticket mentions.


### Features

- **dev:** BFF1 cache-backed read-model core (CTL-883)
  ([#1559](https://github.com/coalesce-labs/catalyst/issues/1559))
  ([417271b](https://github.com/coalesce-labs/catalyst/commit/417271b5529c614993e24b071a1aaf83400512f7))
- **dev:** BFF11 broker fence projection into cache (CTL-923)
  ([#1563](https://github.com/coalesce-labs/catalyst/issues/1563))
  ([de3d6b3](https://github.com/coalesce-labs/catalyst/commit/de3d6b3151659980ab76b7d539adc64aab47e758))
- **dev:** BFF4 phase runs as run entities + verbatim signal (CTL-886)
  ([#1564](https://github.com/coalesce-labs/catalyst/issues/1564))
  ([55e0bee](https://github.com/coalesce-labs/catalyst/commit/55e0bee3e77a61aeb2e69f0b3d69df14d184985e))
- **dev:** BFF6 board payload model/startedAt/pid/sess_id (CTL-888)
  ([#1562](https://github.com/coalesce-labs/catalyst/issues/1562))
  ([c234c74](https://github.com/coalesce-labs/catalyst/commit/c234c74017685d0ceb3680a61673623258b9bef8))
- **dev:** BFF7 cache-backed ticket detail / artifacts / search endpoints (CTL-889)
  ([#1567](https://github.com/coalesce-labs/catalyst/issues/1567))
  ([1179aa1](https://github.com/coalesce-labs/catalyst/commit/1179aa142af4251abb3ffd01619a0900ef538cb3))
- **dev:** BFF9 retire legacy linearis poller onto durable cache (CTL-921)
  ([#1566](https://github.com/coalesce-labs/catalyst/issues/1566))
  ([d9c050a](https://github.com/coalesce-labs/catalyst/commit/d9c050aeff039a797c41d11a3196abdf0c2585f4))
- **dev:** FND1 deep-linkable routes (TanStack Router) (CTL-881)
  ([#1557](https://github.com/coalesce-labs/catalyst/issues/1557))
  ([36348c2](https://github.com/coalesce-labs/catalyst/commit/36348c21f09fdefef0fa30dd56401d6d9a87626b))
- **dev:** FND2 resolveList() + jotai nav store (CTL-882)
  ([#1565](https://github.com/coalesce-labs/catalyst/issues/1565))
  ([633ad43](https://github.com/coalesce-labs/catalyst/commit/633ad43a36b47526115bf1dca38a9d01af2c5e65))
- **dev:** HUD1 shared read-model client contract (CTL-919)
  ([#1568](https://github.com/coalesce-labs/catalyst/issues/1568))
  ([2eda1de](https://github.com/coalesce-labs/catalyst/commit/2eda1de1d18a6587a9e1c3e60c566a2b44b20cc3))
- **dev:** SHELL1 edge-to-edge app shell + left nav (CTL-891)
  ([#1569](https://github.com/coalesce-labs/catalyst/issues/1569))
  ([41c1000](https://github.com/coalesce-labs/catalyst/commit/41c1000414fbe2b9d1d4a8712f5105bd79189869))

### Bug Fixes

- **dev:** CTL-838 stop inferring dependencies from prose — link them, triage analyzes for missed
  ones ([#1556](https://github.com/coalesce-labs/catalyst/issues/1556))
  ([cf29cf0](https://github.com/coalesce-labs/catalyst/commit/cf29cf038905006c9377dcf5095551bc029ed81e))
- **dev:** CTL-878 stop self-inflicted epic→child dependency deadlock
  ([#1510](https://github.com/coalesce-labs/catalyst/issues/1510))
  ([5f2e388](https://github.com/coalesce-labs/catalyst/commit/5f2e3885a908a58649780a35fe59b0a66e8edc10))
- **dev:** CTL-883 keep bun:sqlite out of the Node-loaded vite.config import graph
  ([#1561](https://github.com/coalesce-labs/catalyst/issues/1561))
  ([03537d0](https://github.com/coalesce-labs/catalyst/commit/03537d0a120791c2584b905a4b41d443b01f1364))
- **dev:** CTL-927 exempt doc-phase workers from the cold-snapshot zombie-floor mtime kill
  ([#1571](https://github.com/coalesce-labs/catalyst/issues/1571))
  ([c3394f8](https://github.com/coalesce-labs/catalyst/commit/c3394f84d7c0285a912063dc27aaf7f28019bfb2))

## [12.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.2.0...catalyst-dev-v12.3.0) (2026-06-08)

<!-- ai-enhanced -->

### Gherkin-Ticket Standard in Ticket Creation

New tickets created via the `linear` and `create-tickets` skills now automatically follow the gherkin-ticket format — outcome-first titles, use-case openers, and tiered Gherkin bodies with technical detail tucked under `## Technical notes`. Both paths enforce this as a hard gate, so the backlog can't drift back to mechanism-first titles. The `phase-triage` skill also assesses conformance and flags non-conformant tickets in triage comments, without touching classification logic or auto-rewriting anything.


### Features

- **dev:** CTL-880 wire gherkin-ticket standard into ticket-creation skills
  ([#1508](https://github.com/coalesce-labs/catalyst/issues/1508))
  ([4b21363](https://github.com/coalesce-labs/catalyst/commit/4b21363b49ea74853f701d2329e07f61cd23334d))

## [12.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.1.0...catalyst-dev-v12.2.0) (2026-06-08)

<!-- ai-enhanced -->

### Gherkin Tickets & Scheduler Hardening

The new `gherkin-ticket` skill rewrites ticket authoring around use cases first: actor-led titles, tiered Gherkin scenarios, and a REWRITE mode that reorganizes without dropping technical detail. Auto-fires on ticket-creation language or invoke it directly as `/catalyst-dev:gherkin-ticket`. This release also closes several scheduler reliability gaps: pre-spawn orphan claims that wedged phases indefinitely are now reaped and retried, persistent per-team reconcile failures surface as visible events instead of silent starvation, and workspace-scoped label preflight no longer fires false alarms on every boot.


### Features

- **dev:** CTL-877 gherkin-ticket skill — use-case-first ticket authoring
  ([#1504](https://github.com/coalesce-labs/catalyst/issues/1504))
  ([e379efb](https://github.com/coalesce-labs/catalyst/commit/e379efbabbc77ebe2e97c50fbc292ed2b7347ef8))

### Bug Fixes

- **dev:** CTL-835 add scope to linear-comment-post OAuth mint (invalid_scope)
  ([#1491](https://github.com/coalesce-labs/catalyst/issues/1491))
  ([42d20ac](https://github.com/coalesce-labs/catalyst/commit/42d20ac140cc53ec08c81a7f2d9602ce73870925))
- **dev:** CTL-837 GC pre-spawn orphan phase claim → unwedge claim-lost loop
  ([#1492](https://github.com/coalesce-labs/catalyst/issues/1492))
  ([f437290](https://github.com/coalesce-labs/catalyst/commit/f43729066b5e73fe7d2be4471a9923fd269a3bfc))
- **dev:** CTL-841 self-heal missing wt/ dir in catalyst-monitor start
  ([#1497](https://github.com/coalesce-labs/catalyst/issues/1497))
  ([a29c5f3](https://github.com/coalesce-labs/catalyst/commit/a29c5f3edd3bb88285286786c9bff91f4f97733c))
- **dev:** CTL-867 escalate persistent per-team reconcile failure to a visible event
  ([#1494](https://github.com/coalesce-labs/catalyst/issues/1494))
  ([8f57f41](https://github.com/coalesce-labs/catalyst/commit/8f57f4193bcc80cef92d20bc93db956022eb385a))
- **dev:** CTL-868 — zombie-staleness hardening + orphan-detected sweep event
  ([#1487](https://github.com/coalesce-labs/catalyst/issues/1487))
  ([b34e506](https://github.com/coalesce-labs/catalyst/commit/b34e5068f4570ddcf197b8f4dbdd7c0354c671db))
- **dev:** CTL-869 detect proxy env leak into interactive shells (CTL-846 regression class)
  ([#1493](https://github.com/coalesce-labs/catalyst/issues/1493))
  ([c604ebe](https://github.com/coalesce-labs/catalyst/commit/c604ebefefc961e76d4d4940a891efe19d98407f))
- **dev:** CTL-874 preflight queries workspace-scoped labels (not --team)
  ([#1499](https://github.com/coalesce-labs/catalyst/issues/1499))
  ([9d8fd84](https://github.com/coalesce-labs/catalyst/commit/9d8fd84fbb84018db59604b4e5c27e75413e214c))

## [12.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v12.0.0...catalyst-dev-v12.1.0) (2026-06-08)

<!-- ai-enhanced -->

### Distributed Orchestration & Daemon Hardening

This release lays the foundation for multi-host orchestration: the scheduler now uses rendezvous hashing to partition ticket ownership across a cluster roster and soft-claims each ticket before dispatch, becoming a safe no-op on single-host setups until you add a second host to `.catalyst/hosts.json`. Alongside that, the daemon gets significant reliability improvements — phase workers now self-stop after emitting complete (eliminating 7-hour idle zombies), cold-start recovery distinguishes cheap phases (auto-resume) from expensive ones (operator greenlight required), and a new standalone `catalyst-agent` samples host metrics and Claude account rate-limit usage across multiple accounts. Fresh-machine setup is also substantially more reliable, with no-sudo install fallbacks, correct humanlayer and `gh` CLI install paths, and a vendored replacement for the crashing `humanlayer thoughts init` command.


### Features

- **dev:** auto-run compound learning per ticket + relocate stores to thoughts/shared/retros/
  (CTL-831) ([#1428](https://github.com/coalesce-labs/catalyst/issues/1428))
  ([c30ca97](https://github.com/coalesce-labs/catalyst/commit/c30ca97bc380f1e3fb65a8f58581f144db9dfa52))
- **dev:** catalyst-agent — standalone host telemetry + multi-account Claude usage agent (CTL-812)
  ([#1413](https://github.com/coalesce-labs/catalyst/issues/1413))
  ([a6d7921](https://github.com/coalesce-labs/catalyst/commit/a6d79210fdba69cabcb97ff0a7a3e3cd379dde34))
- **dev:** CTL-639 clean cold-start recovery — CTL-646 label lifecycle + CTL-644 cheap/gate policy
  ([#1481](https://github.com/coalesce-labs/catalyst/issues/1481))
  ([093f4c8](https://github.com/coalesce-labs/catalyst/commit/093f4c86f430e431d77d5982504fcce2502804f1))
- **dev:** CTL-778 — halt-on-complete, daemon self-heal + reaper backstop
  ([#1486](https://github.com/coalesce-labs/catalyst/issues/1486))
  ([d5f715d](https://github.com/coalesce-labs/catalyst/commit/d5f715d902e6b03a1d1a5d469af9609228bf1f18))
- **dev:** CTL-783 draft-PR-early: implement opens draft on first commit; phase-pr flips ready
  ([#1419](https://github.com/coalesce-labs/catalyst/issues/1419))
  ([f618445](https://github.com/coalesce-labs/catalyst/commit/f618445884727bc5a69272637b0f9aee036ae074))
- **dev:** CTL-845 — vendor worktree-thoughts-init.sh, fix humanlayer crash on fresh install
  ([#1458](https://github.com/coalesce-labs/catalyst/issues/1458))
  ([8ef8739](https://github.com/coalesce-labs/catalyst/commit/8ef873960cf6e579f3232d51642cecaf17e870fa))
- **dev:** CTL-850 wire HRW ownership + Linear-CAS claim into new-work dispatch
  ([#1473](https://github.com/coalesce-labs/catalyst/issues/1473))
  ([ceb7a79](https://github.com/coalesce-labs/catalyst/commit/ceb7a79c50ca8cad58b9140b3fc93a53c31f584a))
- **dev:** CTL-854 — fresh-host registry bootstrap + silent-idle observability
  ([#1465](https://github.com/coalesce-labs/catalyst/issues/1465))
  ([663f563](https://github.com/coalesce-labs/catalyst/commit/663f56337f37119b4755c9b9060c2c98ceb43c31))
- **dev:** CTL-859 host identity + heartbeat foundation
  ([#1470](https://github.com/coalesce-labs/catalyst/issues/1470))
  ([0174016](https://github.com/coalesce-labs/catalyst/commit/0174016ab6539dfc3d600756d224b5b03e6645b2))
- **dev:** Gateway L1(a) — full-descriptor ticket_state schema + UUID→identifier index (CTL-821)
  ([#1414](https://github.com/coalesce-labs/catalyst/issues/1414))
  ([3f17c67](https://github.com/coalesce-labs/catalyst/commit/3f17c67f77f2a167b89419bd795d48f522867952))
- **dev:** Gateway L1(b) — webhook write-through with create/update/remove descriptor fold (CTL-822)
  ([#1415](https://github.com/coalesce-labs/catalyst/issues/1415))
  ([1079c06](https://github.com/coalesce-labs/catalyst/commit/1079c06865649ce74ef815d73eb7d41895d30d26))
- **dev:** Gateway L1(c) — daemon read client over the durable descriptor store (CTL-823)
  ([#1416](https://github.com/coalesce-labs/catalyst/issues/1416))
  ([3dfe01a](https://github.com/coalesce-labs/catalyst/commit/3dfe01a01fdc212b6d7d6369cff81c06a8bfada3))
- **dev:** make setup-catalyst.sh safe for headless environments (CTL-842)
  ([#1456](https://github.com/coalesce-labs/catalyst/issues/1456))
  ([4dd39d5](https://github.com/coalesce-labs/catalyst/commit/4dd39d530367fe37292e892b318093c3f6310b2b))
- **dev:** monitor board — add Todo + Triage columns + surface queued tickets (CTL-767)
  ([#1411](https://github.com/coalesce-labs/catalyst/issues/1411))
  ([83526a3](https://github.com/coalesce-labs/catalyst/commit/83526a30f99ed10e60a704b4ba10e4544e8a7a8d))
- **dev:** ticket-retro — cross-ticket retrospective view + briefing Plan-today callout (CTL-814)
  ([#1410](https://github.com/coalesce-labs/catalyst/issues/1410))
  ([2e65659](https://github.com/coalesce-labs/catalyst/commit/2e6565902a0d2fd7468c12f40a54cc0093e3b512))
- **pm:** close the estimation feedback loop — recurring corpus refresh from real actuals (CTL-813)
  ([#1400](https://github.com/coalesce-labs/catalyst/issues/1400))
  ([f066c82](https://github.com/coalesce-labs/catalyst/commit/f066c82b6535574a4a74e279a62ddac7ab429f1f))

### Bug Fixes

- **catalyst-agent:** add PATH to launchd plist so usage domain works
  ([#1480](https://github.com/coalesce-labs/catalyst/issues/1480))
  ([8e4aec8](https://github.com/coalesce-labs/catalyst/commit/8e4aec809cd8160d9077e314e72d70054abfda53))
- **dev:** add turn-cap-exhausted to TERMINAL set in signal-reader (CTL-830)
  ([#1431](https://github.com/coalesce-labs/catalyst/issues/1431))
  ([381cc27](https://github.com/coalesce-labs/catalyst/commit/381cc277aeaa5793da93c7da0d92162b4c28caf3))
- **dev:** catalyst-agent disk probe reads the APFS Data volume on macOS (CTL-812)
  ([#1427](https://github.com/coalesce-labs/catalyst/issues/1427))
  ([911fd89](https://github.com/coalesce-labs/catalyst/commit/911fd890b6c4dbaffa5764209a0bd3aa92d3ef52))
- **dev:** catalyst-agent skips unlabeled usage samples + normalizes hostname (CTL-812)
  ([#1454](https://github.com/coalesce-labs/catalyst/issues/1454))
  ([4002858](https://github.com/coalesce-labs/catalyst/commit/40028585eca162e6e8e78538dae58873f6424cf3))
- **dev:** CTL-703 — invert no-linear-prose guard: teardown is the Done writer now
  ([#1399](https://github.com/coalesce-labs/catalyst/issues/1399))
  ([dc77a0a](https://github.com/coalesce-labs/catalyst/commit/dc77a0a1569018fc4a70448ba95fde9b48c3daff))
- **dev:** CTL-834 cool-down held-label converger + classify exclusive-group label conflicts
  ([#1483](https://github.com/coalesce-labs/catalyst/issues/1483))
  ([4e117ef](https://github.com/coalesce-labs/catalyst/commit/4e117ef7bc757e89920cac8bdc567354f4d1b49e))
- **dev:** CTL-844 fresh-machine installer gaps — no-sudo, npm humanlayer, real gh CLI, bun required
  ([#1457](https://github.com/coalesce-labs/catalyst/issues/1457))
  ([0c5e94d](https://github.com/coalesce-labs/catalyst/commit/0c5e94d851e4dd34066baecb9401035883852989))
- **dev:** CTL-846 liveness-gate proxy env at daemon launch + harden docs
  ([#1459](https://github.com/coalesce-labs/catalyst/issues/1459))
  ([7bbb585](https://github.com/coalesce-labs/catalyst/commit/7bbb585a03ec46c07f70ecdee39bb092b2b1bbbf))
- **dev:** fold reaper-metrics into O(1) counters, drop the unbounded events[] (CTL-793)
  ([#1383](https://github.com/coalesce-labs/catalyst/issues/1383))
  ([4ac303c](https://github.com/coalesce-labs/catalyst/commit/4ac303c7168bbee0705b63f4db9918217d37c841))
- **dev:** ghost-breaker — reclaim jobLifecycle-alive-but-FRESH-agents-absent workers (CTL-809)
  ([#1385](https://github.com/coalesce-labs/catalyst/issues/1385))
  ([fca33be](https://github.com/coalesce-labs/catalyst/commit/fca33be0b73b39829c2c4eafcd3078814c55f011))
- **dev:** hermetic CATALYST_DIR preload — tests can't pollute the real event log (CTL-810)
  ([#1412](https://github.com/coalesce-labs/catalyst/issues/1412))
  ([eed3ae2](https://github.com/coalesce-labs/catalyst/commit/eed3ae253d08ca884493594c2afacbed74a21190))
- **dev:** merge per-project secrets config to preserve unprompted keys (CTL-843)
  ([#1455](https://github.com/coalesce-labs/catalyst/issues/1455))
  ([3956c9f](https://github.com/coalesce-labs/catalyst/commit/3956c9f5ad150f04262f9c0d15e98622e86218ce))
- **dev:** otel-forward floats as doubleValue + agent OTLP body = event name (CTL-812)
  ([#1421](https://github.com/coalesce-labs/catalyst/issues/1421))
  ([2032436](https://github.com/coalesce-labs/catalyst/commit/2032436dc14c2e8f33588c38245a441f1f5c421d))
- **dev:** relocate CONCEPTS.md to thoughts/shared/ so it syncs (CTL-789)
  ([#1390](https://github.com/coalesce-labs/catalyst/issues/1390))
  ([2deb8e0](https://github.com/coalesce-labs/catalyst/commit/2deb8e0f72a4c754154bc82b1a08eb9beb8bfd64))
- **dev:** strengthen implementProbe with plan-phase completeness gate (CTL-663)
  ([#1434](https://github.com/coalesce-labs/catalyst/issues/1434))
  ([0098e48](https://github.com/coalesce-labs/catalyst/commit/0098e484eb27fe7e78459b528ad56e32bf4618b2))

### Performance Improvements

- **dev:** incremental countTicketEventsInWindow — kill the per-tick full-log rescan (CTL-802)
  ([#1387](https://github.com/coalesce-labs/catalyst/issues/1387))
  ([d2685ab](https://github.com/coalesce-labs/catalyst/commit/d2685ab8bfad0405d7adf515ccc40d7fbdab5af6))

## [12.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v11.0.1...catalyst-dev-v12.0.0) (2026-06-06)

<!-- ai-enhanced -->

### Compound Engineering Loop & Daemon Reliability

This release introduces the Compound Engineering MVP (Slice 1): phase skills now log per-ticket friction as work happens, `phase-research` injects relevant past learnings before starting, and the morning briefing surfaces a friction digest and pending compound decisions for approval. Alongside that, a significant batch of daemon reliability fixes lands — worktree removal now requires positive evidence of merged+clean+no-session+provenance before any deletion (closing a real data-loss vector), liveness snapshot wedges that held new-work dispatch indefinitely are resolved at both the population and in-tick aging layers, and per-tick Linear reads are batched into a single query to collapse what was ~3,000–4,400 individual ticket reads per hour down to one batched request per TTL window. The plugin layout also reorganizes: `catalyst-foundry` is a new plugin for framework setup skills, `catalyst-legacy` topology is corrected, and `compound` is renamed `compound-estimate` — update any slash-command references accordingly.


### ⚠ BREAKING CHANGES

- **dev:** plugin reorg — catalyst-foundry plugin, legacy topology fix, compound-estimate rename
  (CTL-786) ([#1350](https://github.com/coalesce-labs/catalyst/issues/1350))

### Features

- **dev:** account-level rate-limit usage poller (CTL-787)
  ([#1358](https://github.com/coalesce-labs/catalyst/issues/1358))
  ([2e65fc9](https://github.com/coalesce-labs/catalyst/commit/2e65fc98fda822964f83a0b3c972c27814479bd1))
- **dev:** authenticate the daemon as the Catalyst Orchestrator app-actor (isolated bucket)
  ([#1348](https://github.com/coalesce-labs/catalyst/issues/1348))
  ([51accc4](https://github.com/coalesce-labs/catalyst/commit/51accc4f731ffc0b79c2fbf0a1f93a41bc8c5ab9))
- **dev:** compound-engineering Slice 1 — engineering compound loop MVP (CTL-789)
  ([#1361](https://github.com/coalesce-labs/catalyst/issues/1361))
  ([01740eb](https://github.com/coalesce-labs/catalyst/commit/01740ebe9ee67a4196417c735620bbad05301d65))
- **dev:** CTL-784 batch per-tick Linear reads into one filtered query
  ([#1349](https://github.com/coalesce-labs/catalyst/issues/1349))
  ([e19308c](https://github.com/coalesce-labs/catalyst/commit/e19308ca97e68bb04a9bb72843b2f45a26d1994c))
- **dev:** plugin reorg — catalyst-foundry plugin, legacy topology fix, compound-estimate rename
  (CTL-786) ([#1350](https://github.com/coalesce-labs/catalyst/issues/1350))
  ([0995954](https://github.com/coalesce-labs/catalyst/commit/09959540b8ec633ef6cb6f45a7c1778e15e3f4d6))
- **dev:** portable daemon env / proxy-audit template + prerequisite checks
  ([#1343](https://github.com/coalesce-labs/catalyst/issues/1343))
  ([0a59075](https://github.com/coalesce-labs/catalyst/commit/0a590751e9d6c7f531ac9c2aad3afc6d233e0648))
- **dev:** read Linear bot creds + self-echo botUserIds from global
  config.linear.bot.{worker,orchestrator} (back-compat)
  ([#1347](https://github.com/coalesce-labs/catalyst/issues/1347))
  ([150cc94](https://github.com/coalesce-labs/catalyst/commit/150cc9499ec55c1c4aed3ea607abc3ea8c012953))
- **dev:** source machine-local execution-core.env on daemon start
  ([#1341](https://github.com/coalesce-labs/catalyst/issues/1341))
  ([388db14](https://github.com/coalesce-labs/catalyst/commit/388db142bec14e49e6a53ae79bdf82b56629a403))

### Bug Fixes

- **dev:** defer CTL-731 liveness deadline verdict so a completed read survives loop starvation
  (CTL-790) ([#1360](https://github.com/coalesce-labs/catalyst/issues/1360))
  ([5f416a4](https://github.com/coalesce-labs/catalyst/commit/5f416a44cb1a715feebda2b2b43944b19683603a))
- **dev:** evidence-gate worktree removal — never delete without merged+clean+no-session+provenance
  (CTL-791) ([#1363](https://github.com/coalesce-labs/catalyst/issues/1363))
  ([42e1c4e](https://github.com/coalesce-labs/catalyst/commit/42e1c4ea064c34d03034b9fbae79d5c385cf1240))
- **dev:** warm the liveness snapshot + tolerate in-tick aging so dispatch isn't held forever
  (CTL-792) ([#1365](https://github.com/coalesce-labs/catalyst/issues/1365))
  ([e9534cf](https://github.com/coalesce-labs/catalyst/commit/e9534cf241dd58308a33ff05c42b69c0ba140ba3))

## [11.0.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v11.0.0...catalyst-dev-v11.0.1) (2026-06-05)

<!-- ai-enhanced -->

### Pre-Push Hook Suppression Fix

Automated phase-agent pushes no longer trigger locally-installed pre-push hooks (trunk, trufflehog, fmt, tests) that were causing CPU and memory spikes during concurrent worktree dispatches. The fix passes `-c core.hooksPath=/dev/null` per git call — no persistent config changes, no `--no-verify` — so your interactive pushes are completely unaffected.


### Bug Fixes

- **dev:** CTL-693 suppress pre-push hooks on automated phase-agent pushes
  ([#1328](https://github.com/coalesce-labs/catalyst/issues/1328))
  ([c831e58](https://github.com/coalesce-labs/catalyst/commit/c831e58001a79eb127c213f3bb31e998c725305b))

## [11.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.6.0...catalyst-dev-v11.0.0) (2026-06-05)

<!-- ai-enhanced -->

### Ticket Gantt, Smarter Autotuner & Signal Reliability

Clicking a ticket card in the orchestration monitor now opens a three-tab drawer — a wall-clock Gantt of per-phase spans colored by phase type, a cost and token breakdown, and the full comms stream for that ticket. The autotuner gets two significant fixes: macOS hosts no longer false-clamp `maxParallel` to 1 due to `os.freemem()` under-reporting available memory, and scale decisions now attribute CPU and memory to Claude's own process tree so the tuner holds steady when another process is causing host pressure rather than shedding workers unnecessarily. A longstanding wedge where phase workers silently skipped the signal-file flip on `claude --bg` dispatch is also resolved by threading orchestrator context through the surviving `settings.env` channel.


### Features

- **dev:** CTL-734 ticket-detail drill-in — kibo-ui Gantt of per-phase worker spans
  ([#1319](https://github.com/coalesce-labs/catalyst/issues/1319))
  ([5b5d562](https://github.com/coalesce-labs/catalyst/commit/5b5d562b21e5ecbe8ac4bd1033e14ff41f2417a7))
- **dev:** CTL-761 emit revive/attempt count as OTEL dimensions on terminal phase events
  ([#1321](https://github.com/coalesce-labs/catalyst/issues/1321))
  ([087e4b1](https://github.com/coalesce-labs/catalyst/commit/087e4b194818854f66c5aa5e80083c72b1d605a1))
- **dev:** CTL-775 demand-driven autotuner — saturation-gated up, Claude-attributed down
  ([#1316](https://github.com/coalesce-labs/catalyst/issues/1316))
  ([1da9db8](https://github.com/coalesce-labs/catalyst/commit/1da9db899ab535d3017864e51356eaf54df054eb))
- **dev:** document and enforce the Linear app-actor botUserId requirement
  ([#1282](https://github.com/coalesce-labs/catalyst/issues/1282))
  ([a4bb94d](https://github.com/coalesce-labs/catalyst/commit/a4bb94d6ce3173abf78fcc5932ea03fead55b191))

### Bug Fixes

- **dev:** CTL-623 residual — describe-pr sibling-ref prose + ci-describe-pr body_file fix
  ([#1322](https://github.com/coalesce-labs/catalyst/issues/1322))
  ([cab4e9b](https://github.com/coalesce-labs/catalyst/commit/cab4e9b3b7dccd270251d49f62b831e9a8007676))
- **dev:** CTL-731 residual — default eligibleQuery to Todo + Release-As 11.0.0
  ([#1331](https://github.com/coalesce-labs/catalyst/issues/1331))
  ([f9345bd](https://github.com/coalesce-labs/catalyst/commit/f9345bdbe2419038acb00bc8fb67f14f9848875b))
- **dev:** CTL-766 persist real tailer offset in otel-forward checkpoint
  ([#1310](https://github.com/coalesce-labs/catalyst/issues/1310))
  ([1ddf24a](https://github.com/coalesce-labs/catalyst/commit/1ddf24a36749ebf354fc76a4801900c72b41eee6))
- **dev:** CTL-772 platform-aware available memory — stop autotuner false-clamping to 1 on macOS
  ([#1311](https://github.com/coalesce-labs/catalyst/issues/1311))
  ([a06c481](https://github.com/coalesce-labs/catalyst/commit/a06c4815b7f98f8b1cc74af7bb9f7b5f2379c555))
- **dev:** CTL-777 reliable phase-worker signal flip via surviving settings.env channel (step 1)
  ([#1326](https://github.com/coalesce-labs/catalyst/issues/1326))
  ([ccab289](https://github.com/coalesce-labs/catalyst/commit/ccab289343c9c641e9fbfe302d783963af85c83b))
- **dev:** repair removeLabel (linearis rejects --label-mode remove) + hermetic test guard
  ([#1327](https://github.com/coalesce-labs/catalyst/issues/1327))
  ([0e80e26](https://github.com/coalesce-labs/catalyst/commit/0e80e261dc4c9afab889158d320bc2773660dfde))

## [10.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.5.0...catalyst-dev-v10.6.0) (2026-06-04)

<!-- ai-enhanced -->

### Autotuning Execution Core & Per-Worker Observability

The execution core now includes a setpoint-seeking autotuner that converges `maxParallel` toward a host-configurable target — including at idle, where it previously stalled at 1. Per-worker OpenTelemetry is fully wired into the background-worker model, so phase workers now emit correctly tagged metrics in Grafana, Dash0, and Honeycomb instead of untagged or mis-attributed signal. A reaper poll-fallback fix stops predecessor workers from leaking into `liveCount` and starving the parallel queue.


### Features

- **dev:** CTL-760 per-worker OpenTelemetry for the background-worker execution model
  ([#1294](https://github.com/coalesce-labs/catalyst/issues/1294))
  ([5399a29](https://github.com/coalesce-labs/catalyst/commit/5399a29624f40ac19ecd398798b549ad9fb4aefe))
- **dev:** CTL-770 setpoint-seeking autotuner + CTL-771 autotune OTel gauges
  ([#1307](https://github.com/coalesce-labs/catalyst/issues/1307))
  ([6f4cfd9](https://github.com/coalesce-labs/catalyst/commit/6f4cfd9bf1af2dcaf37664ef9bfad57530d19bbd))

### Bug Fixes

- **dev:** CTL-769 give the execution-core reaper a poll-fallback drain
  ([#1304](https://github.com/coalesce-labs/catalyst/issues/1304))
  ([068795d](https://github.com/coalesce-labs/catalyst/commit/068795d5af789effaad22bc041fca4d57d617c93))
- **dev:** CTL-770 reach idle convergence — autotuner no longer bails at bgCount===0
  ([#1308](https://github.com/coalesce-labs/catalyst/issues/1308))
  ([3cc5c99](https://github.com/coalesce-labs/catalyst/commit/3cc5c99211f583d73fd2aade90fb9323f56a722a))

## [10.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.4.0...catalyst-dev-v10.5.0) (2026-06-03)

<!-- ai-enhanced -->

### Point-Driven Effort & Pipeline Reliability

Ticket point estimates now drive `--effort` flags and `/workflows` postamble automatically across the plan, implement, verify, and review phases — 1pt maps to medium, 3/5pt to high, and 8/13pt to xhigh with workflows. Four reliability fixes ship alongside: workers that die before their first turn now self-heal by re-issuing the phase command on revive; the orchestration monitor's Done column no longer surfaces mid-pipeline tickets that haven't reached monitor-deploy; parked workers no longer spuriously re-dispatch when the bot posts its own clarifying question; and `workflow_id` in the sessions table is no longer polluted with stale daemon session ids, making per-run cost attribution queries accurate.


### Features

- **dev:** CTL-747 per-phase effort + dynamic-workflow execution driven by ticket points
  ([#1262](https://github.com/coalesce-labs/catalyst/issues/1262))
  ([0b7bbe0](https://github.com/coalesce-labs/catalyst/commit/0b7bbe0773be9657da1d149628f039bb0420b40c))

### Bug Fixes

- **dev:** CTL-736 revive re-issues the phase command so a pre-first-turn death self-heals
  ([#1263](https://github.com/coalesce-labs/catalyst/issues/1263))
  ([084a522](https://github.com/coalesce-labs/catalyst/commit/084a522209ece59f25a51b71adea499b25e796e2))
- **dev:** CTL-745 gate synthetic done on terminal pipeline state
  ([#1287](https://github.com/coalesce-labs/catalyst/issues/1287))
  ([b65bc27](https://github.com/coalesce-labs/catalyst/commit/b65bc27277a72d88b1b019224ead66421a5365c2))
- **dev:** CTL-752 neutralize frozen-daemon workflow_id leak + doc join queries
  ([#1274](https://github.com/coalesce-labs/catalyst/issues/1274))
  ([d499be9](https://github.com/coalesce-labs/catalyst/commit/d499be98adb60214b4f2537336c14b83d5337df3))
- **dev:** CTL-756 self-echo guard for handleCommentWake
  ([#1283](https://github.com/coalesce-labs/catalyst/issues/1283))
  ([7319d7c](https://github.com/coalesce-labs/catalyst/commit/7319d7cc4432983863cb8ae1717dba0f70447a94))

## [10.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.3.0...catalyst-dev-v10.4.0) (2026-05-31)

<!-- ai-enhanced -->

### Deterministic Worker Lifecycle Engine

The revive-storm guard stack — roughly 14 heuristic dampers that tried to guess whether a worker was dead — is replaced by three deterministic primitives: an atomic single-flight claim with fencing tokens, a `state.json` death trigger that reads local lifecycle state instead of the eventually-consistent `claude agents` snapshot, and a progress probe that stops futile respawns by checking whether a worker actually made commits or produced output before deciding to revive it. Separately, per-step model, effort, and preamble overrides are now live in dispatch via a small rules engine in the workflow descriptor, so large or epic tickets can launch the plan worker with max effort and a different model while every other case stays byte-identical to before. The board real-time client also shifts to a SharedWorker with an IndexedDB cache, cutting upstream SSE connections to one per browser instead of one per tab.


### Features

- **dev:** atomic single-flight worker claim + fencing token (CTL-736 Phase 1)
  ([#1235](https://github.com/coalesce-labs/catalyst/issues/1235))
  ([d09fb2b](https://github.com/coalesce-labs/catalyst/commit/d09fb2b24ddfcb4a4067b2e3d6fbc2dd8266398a))
- **dev:** board SharedWorker + IndexedDB real-time client (CTL-733 PR-2b)
  ([#1242](https://github.com/coalesce-labs/catalyst/issues/1242))
  ([4a76d27](https://github.com/coalesce-labs/catalyst/commit/4a76d2739637c114f73002acaace8d6bb98a7eba))
- **dev:** CTL-736 Phase 2-3 — state.json death trigger + progress probe (retire the revive-storm
  guard stack) ([#1245](https://github.com/coalesce-labs/catalyst/issues/1245))
  ([0a0624a](https://github.com/coalesce-labs/catalyst/commit/0a0624a6b7bc81454d3059c80f4a3a18ce567c03))
- **dev:** per-step conditional levers — model/effort/preamble in dispatch (descriptor v1.1)
  ([#1239](https://github.com/coalesce-labs/catalyst/issues/1239))
  ([673bdc1](https://github.com/coalesce-labs/catalyst/commit/673bdc1841b3dc1c9fffc44d38850f76355723fa))

### Bug Fixes

- **dev:** clear verify/remediate claim tombstones on cycle reset (CTL-736 GATE-0)
  ([#1237](https://github.com/coalesce-labs/catalyst/issues/1237))
  ([5c50ded](https://github.com/coalesce-labs/catalyst/commit/5c50dedaf41c0a051c9c1ab3d359797e5eb4c04c))

## [10.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.2.2...catalyst-dev-v10.3.0) (2026-05-30)

<!-- ai-enhanced -->

### Live Worker/Ticket Board

The monitor now serves a real-time Worker and Ticket board at the default `/` route, replacing the old polling dashboard as the primary view (legacy dashboard still available at `/legacy`). Board data is pushed over SSE from a single shared snapshot — no more per-tab polling hammering the server — with updates triggered reactively on state changes rather than a fixed tick. The Workers view also gains a Status ↔ Pipeline column toggle so you can group live workers by liveness or by phase, and worker cards now show a session short-code to distinguish revived duplicate workers from the same ticket.


### Features

- **dev:** board real-time layer — async assembleBoard + reactive SSE push (CTL-733)
  ([#1230](https://github.com/coalesce-labs/catalyst/issues/1230))
  ([f034a14](https://github.com/coalesce-labs/catalyst/commit/f034a14f9ea2557547918c3d9b4fb938f79721d4))
- **dev:** live Worker/Ticket board UI wired to execution-core (CTL-727)
  ([#1216](https://github.com/coalesce-labs/catalyst/issues/1216))
  ([0d5aac0](https://github.com/coalesce-labs/catalyst/commit/0d5aac09c0b3b128e4c1ee5e1437b7873283b6a0))
- **dev:** real shadcn components + Linear-style board UX (CTL-727)
  ([#1219](https://github.com/coalesce-labs/catalyst/issues/1219))
  ([d8396d2](https://github.com/coalesce-labs/catalyst/commit/d8396d24f42c58a9cbcf01a1b06bc7a2449d35c7))
- **dev:** serve the Worker/Ticket board from the monitor (CTL-730)
  ([#1229](https://github.com/coalesce-labs/catalyst/issues/1229))
  ([50e9b2e](https://github.com/coalesce-labs/catalyst/commit/50e9b2e87aa79a0b441bc7fc6c144e3b23df4501))
- **dev:** Workers board Status↔Pipeline column toggle (CTL-732)
  ([#1228](https://github.com/coalesce-labs/catalyst/issues/1228))
  ([4468bc7](https://github.com/coalesce-labs/catalyst/commit/4468bc75d678001c182f48910002097a41214187))

### Bug Fixes

- **dev:** stabilize main — revive idle/budget gaps + cache-only de-starvation reconciliation
  (CTL-735 / CTL-736 PR-0) ([#1234](https://github.com/coalesce-labs/catalyst/issues/1234))
  ([dbabfbb](https://github.com/coalesce-labs/catalyst/commit/dbabfbbf976d4ce65440d71de2efb57b3fff0d3e))
- **dev:** worker session short-code to distinguish revive-duplicates (CTL-727)
  ([#1223](https://github.com/coalesce-labs/catalyst/issues/1223))
  ([b3d1fdf](https://github.com/coalesce-labs/catalyst/commit/b3d1fdf22c75173bcd3045082d8f850d79b3fdff))

## [10.2.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.2.1...catalyst-dev-v10.2.2) (2026-05-28)

<!-- ai-enhanced -->

### Startup Triage Sweep Fix

Tickets already in an eligible state when the dev daemon boots — or that appear between webhook deliveries — now get triage dispatched automatically. Previously, these fell into a permanent retry loop because the startup reconcile never checked for missing triage artifacts; manual intervention was required after every daemon restart. No migration needed.


### Bug Fixes

- **dev:** auto-dispatch triage for pre-existing eligible tickets at startup (CTL-711)
  ([#1191](https://github.com/coalesce-labs/catalyst/issues/1191))
  ([954b31e](https://github.com/coalesce-labs/catalyst/commit/954b31eafef59ee71f8d5ca45ce6ee140bebfd6d))

## [10.2.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.2.0...catalyst-dev-v10.2.1) (2026-05-28)

<!-- ai-enhanced -->

### Scheduler Test Isolation Fix

Eight scheduler tests were silently failing on any machine with active background workers — CI passed because it runs sandboxed, masking a regression introduced by the CTL-705 preemption sweep. The fix injects `liveBackgroundCount: () => 0` into the affected test fixtures so local dev environments with live pipelines no longer see false failures. No production code changed and no migration is needed.


### Bug Fixes

- **dev:** inject liveBackgroundCount in scheduler tests broken by CTL-705 preemption (CTL-715)
  ([#1188](https://github.com/coalesce-labs/catalyst/issues/1188))
  ([9e1dedf](https://github.com/coalesce-labs/catalyst/commit/9e1dedfa6dc3edf1efe3c47123c5807710f1fd8d))

## [10.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.1.0...catalyst-dev-v10.2.0) (2026-05-28)

<!-- ai-enhanced -->

### Session Continuity & Linear Stability

This release focuses on two things: keeping phase workers alive across reboots and machine restarts, and stopping the Linear API rate-limit storms that were halting the execution-core daemon. Boot-resume now passes `--resume-session` so in-flight workers pick up where they left off instead of starting fresh, with a dual-schema fallback that handles both old and new Claude Code state formats. On the Linear side, a circuit breaker throttles retries on 429s, cross-team label errors are correctly classified as unrecoverable (ending the per-tick retry loops against ADV tickets), and per-event scoping polls are replaced with webhook-captured fields — cutting the baseline Linear call volume significantly. Several correctness fixes also land: the one-worker-per-ticket invariant is now enforced with a liveness gate, yield tombstones no longer crash the scheduler tick, and sub-agent costs are included in phase mirror footers.


### Features

- **dev:** aggregate sub-agent-inclusive cost/token totals for the phase mirror footer (CTL-666)
  ([#1123](https://github.com/coalesce-labs/catalyst/issues/1123))
  ([5bf0e2f](https://github.com/coalesce-labs/catalyst/commit/5bf0e2f77d8b194d2302a7d89ee8b3236bd014ca))
- **dev:** boot-resume passes --resume-session for true session continuation (CTL-690)
  ([#1155](https://github.com/coalesce-labs/catalyst/issues/1155))
  ([b52c4c7](https://github.com/coalesce-labs/catalyst/commit/b52c4c7fcf9cacabeb82b51a1b74751ce7f67416))
- **dev:** capture Linear webhook scoping fields + drop per-event scoping poll (CTL-681)
  ([#1138](https://github.com/coalesce-labs/catalyst/issues/1138))
  ([545e2f6](https://github.com/coalesce-labs/catalyst/commit/545e2f69349fd61c69e32ac03c3ce642271bc33f))
- **dev:** cold-start detection signal for execution-core recovery (CTL-640)
  ([#1071](https://github.com/coalesce-labs/catalyst/issues/1071))
  ([9221ef8](https://github.com/coalesce-labs/catalyst/commit/9221ef8dbefbc30d64b880a7a9e74d987766ac20))
- **dev:** Linear state TTL cache for execution-core daemon (CTL-634)
  ([#1069](https://github.com/coalesce-labs/catalyst/issues/1069))
  ([43917b3](https://github.com/coalesce-labs/catalyst/commit/43917b3fa3d9b68c4a5aa8b51540ea3b5ab6b477))
- **dev:** machine-level config fallback for phase-agent-dispatch (CTL-689)
  ([#1152](https://github.com/coalesce-labs/catalyst/issues/1152))
  ([23eae98](https://github.com/coalesce-labs/catalyst/commit/23eae9892a35f868e2c4cee464d990a93bd34e58))
- **dev:** repoint broker watchdog to claude-agents liveness (CTL-672)
  ([#1163](https://github.com/coalesce-labs/catalyst/issues/1163))
  ([6f1c7bf](https://github.com/coalesce-labs/catalyst/commit/6f1c7bf4b9141b46beb7af780d25e1c3e623ecc3))
- **dev:** route triage/research/implement/pr phase workers to Sonnet (CTL-689)
  ([#1150](https://github.com/coalesce-labs/catalyst/issues/1150))
  ([c5061e6](https://github.com/coalesce-labs/catalyst/commit/c5061e6927dc6d56fbf41fac7c5573f3334bcd7c))

### Bug Fixes

- **dev:** add Linear rate-limit circuit breaker + drop redundant triaged label (CTL-679)
  ([#1136](https://github.com/coalesce-labs/catalyst/issues/1136))
  ([c5e550d](https://github.com/coalesce-labs/catalyst/commit/c5e550d0fefd316dd60f3cbb5eb594a7872d7185))
- **dev:** carry project/linear.key/orchestration in canonical-event resource block (CTL-636)
  ([#1070](https://github.com/coalesce-labs/catalyst/issues/1070))
  ([f011f12](https://github.com/coalesce-labs/catalyst/commit/f011f1299bd0005c9364567f8ff5b195e22ee051))
- **dev:** classify Linear cross-team label-UUID errors as missing-label
  ([#1137](https://github.com/coalesce-labs/catalyst/issues/1137))
  ([e336f36](https://github.com/coalesce-labs/catalyst/commit/e336f36bb2327e3c36e2cb2c774b1383a1147f03))
- **dev:** enforce one-worker-per-ticket — liveness-gate reclaim + reap on remediate cycle (CTL-661)
  ([#1107](https://github.com/coalesce-labs/catalyst/issues/1107))
  ([a4bbfea](https://github.com/coalesce-labs/catalyst/commit/a4bbfea08f068cdbc7524970a764ca199d7a36d9))
- **dev:** make phase-emit-complete.sh sourceable under zsh (CTL-618)
  ([#1067](https://github.com/coalesce-labs/catalyst/issues/1067))
  ([ebde111](https://github.com/coalesce-labs/catalyst/commit/ebde11128f58cf28a64de7214a228096038508ea))
- **dev:** make phase-triage body resilient to slash-arg substitution (CTL-602)
  ([#1031](https://github.com/coalesce-labs/catalyst/issues/1031))
  ([fab4c66](https://github.com/coalesce-labs/catalyst/commit/fab4c66c1795586706b78270ebfbf3a0a5e73e43))
- **dev:** orchestrate-dispatch-next phase-fork bugs — phase-aware RUNNING count + stdin drain guard
  (CTL-605) ([#1068](https://github.com/coalesce-labs/catalyst/issues/1068))
  ([c19dea5](https://github.com/coalesce-labs/catalyst/commit/c19dea511b93e7b8f19eea0df0b823c61087481b))
- **dev:** phase-mode turn-cap continuation — orchestrate-revive fires --resume in phase-agents mode
  (CTL-613) ([#1099](https://github.com/coalesce-labs/catalyst/issues/1099))
  ([b3d5b49](https://github.com/coalesce-labs/catalyst/commit/b3d5b49e66c3d5206497940e50be8f51970866cf))
- **dev:** resolve session UUID from resumeSessionId + formal config schemas (CTL-710)
  ([#1181](https://github.com/coalesce-labs/catalyst/issues/1181))
  ([2fedd98](https://github.com/coalesce-labs/catalyst/commit/2fedd98b7b97b56470d3639643c6a61dfa69939c))
- **dev:** stop execution-core label-retry storm on missing workspace labels (CTL-585)
  ([#1007](https://github.com/coalesce-labs/catalyst/issues/1007))
  ([b9e06e1](https://github.com/coalesce-labs/catalyst/commit/b9e06e1db9bc007bf87e6f87ce1e33a6bcc72903))
- **dev:** stop scheduler tick from crashing on yield-tombstone files (CTL-702)
  ([#1170](https://github.com/coalesce-labs/catalyst/issues/1170))
  ([b732664](https://github.com/coalesce-labs/catalyst/commit/b732664f08e20f344278563b8e199bc20049b7dd))
- **dev:** supersede guard for predecessor reaping (CTL-606)
  ([#1072](https://github.com/coalesce-labs/catalyst/issues/1072))
  ([a6c7f1c](https://github.com/coalesce-labs/catalyst/commit/a6c7f1c6d0a782b8c20ab0c5f6199fe16ac13e37))
- **execution-core:** broaden reclaim trigger to cover stale bg jobs (CTL-588)
  ([#988](https://github.com/coalesce-labs/catalyst/issues/988))
  ([30f1655](https://github.com/coalesce-labs/catalyst/commit/30f165549cebf8a13d0972385fc4dec22623be76))
- **execution-core:** reclaim dead phase-implement workers via commit-state probe (CTL-574)
  ([#985](https://github.com/coalesce-labs/catalyst/issues/985))
  ([747a3f6](https://github.com/coalesce-labs/catalyst/commit/747a3f6e3de5bd5fe47790f2228413ab436b8eb1))

## [10.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v10.0.0...catalyst-dev-v10.1.0) (2026-05-18)

<!-- ai-enhanced -->

### OTEL Cost Attribution for Phase-Agent Workers

Phase-agent workers spawned via `claude --bg` now inherit `OTEL_RESOURCE_ATTRIBUTES` from the orchestrator, so Grafana cost panels correctly attribute their spend to the right Linear ticket, branch, and project. Previously, those labels were empty and the "Cost by Linear Ticket" panel silently dropped phase-agent costs — in one dogfood run, ~75% of spend went unattributed. No migration steps required.


### Features

- **dev:** propagate OTEL_RESOURCE_ATTRIBUTES to phase-agent claude --bg children (CTL-492)
  ([#862](https://github.com/coalesce-labs/catalyst/issues/862))
  ([19166f0](https://github.com/coalesce-labs/catalyst/commit/19166f0bf7e97ac547eb8afe4364282d41f9dca3))

## [10.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v9.3.0...catalyst-dev-v10.0.0) (2026-05-18)

<!-- ai-enhanced -->

### Phase-Agent Pipeline Launch

This release ships the full 9-phase agent pipeline: triage → research → plan → implement → verify → review → PR → merge → deploy monitoring. Orchestrations now dispatch each phase as a `claude --bg` worker, advance automatically via broker `phase_lifecycle` events, and resume when a phase hits its turn cap rather than burning the error-recovery budget. Two blocking dispatch bugs (a skill gate that rejected slash-command invocation and a bg job ID parser that captured `backgrounded` instead of the hex ID) are also fixed, meaning this is the first release where phase workers can actually run end-to-end.


### ⚠ BREAKING CHANGES

- **dev:** turn-cap exhaustion → automated handoff continuation (CTL-484)
  ([#844](https://github.com/coalesce-labs/catalyst/issues/844))

### Features

- **dev:** add phase_lifecycle interest type to broker daemon (CTL-447)
  ([#795](https://github.com/coalesce-labs/catalyst/issues/795))
  ([840f2ef](https://github.com/coalesce-labs/catalyst/commit/840f2ef5362c81e81f06317a0f8bd1e99ea85ae5))
- **dev:** add phase-triage + phase-monitor-deploy skills (CTL-451)
  ([#802](https://github.com/coalesce-labs/catalyst/issues/802))
  ([decabfd](https://github.com/coalesce-labs/catalyst/commit/decabfd975195e2dd91bfded464d20ae1b9e0c73))
- **dev:** add verifying/reviewing transition keys for phase-agent observability (CTL-454)
  ([#797](https://github.com/coalesce-labs/catalyst/issues/797))
  ([303e96a](https://github.com/coalesce-labs/catalyst/commit/303e96a7db1956a4420a142be0078d523d199d47))
- **dev:** ADR-drift detector for morning-briefing Step 3 (CTL-459)
  ([#806](https://github.com/coalesce-labs/catalyst/issues/806))
  ([d442e87](https://github.com/coalesce-labs/catalyst/commit/d442e879b05041392a60d8bfe15c6536e0ec44eb))
- **dev:** briefing-followup action handlers — calendar/ticket/orchestrate/email (CTL-463)
  ([#813](https://github.com/coalesce-labs/catalyst/issues/813))
  ([63383aa](https://github.com/coalesce-labs/catalyst/commit/63383aa943dbc95b1667553790ee9c2af31b158c))
- **dev:** briefing-followup ADR-drift resolution flow (CTL-464)
  ([#815](https://github.com/coalesce-labs/catalyst/issues/815))
  ([8207175](https://github.com/coalesce-labs/catalyst/commit/82071759f6b0d253c2d036733deb0c9006506dfe))
- **dev:** briefing-followup resolution write-back (CTL-465)
  ([#816](https://github.com/coalesce-labs/catalyst/issues/816))
  ([7881962](https://github.com/coalesce-labs/catalyst/commit/788196270101ad13e13ee5c4429f8767ed627c8e))
- **dev:** briefing-followup skill MVP — load + present agenda (CTL-462)
  ([#808](https://github.com/coalesce-labs/catalyst/issues/808))
  ([bd875bf](https://github.com/coalesce-labs/catalyst/commit/bd875bfee49e03bc820e2465e578e1684f0a9147))
- **dev:** catalyst-hud surfaces per-phase signal files (CTL-476)
  ([#835](https://github.com/coalesce-labs/catalyst/issues/835))
  ([2a821fa](https://github.com/coalesce-labs/catalyst/commit/2a821fabf887a9c7ea4024ca6a135a9b2a13da66))
- **dev:** event-source workers/\*.json via broker projection (CTL-483)
  ([#842](https://github.com/coalesce-labs/catalyst/issues/842))
  ([f6c1bdb](https://github.com/coalesce-labs/catalyst/commit/f6c1bdbcf3afee11417516f49e63862cd657bbc3))
- **dev:** HUD WORKER column strips orch prefix (CTL-431)
  ([#755](https://github.com/coalesce-labs/catalyst/issues/755))
  ([4b89cbe](https://github.com/coalesce-labs/catalyst/commit/4b89cbeafc414764cc634311930b223ece105d04))
- **dev:** morning-briefing skill MVP (CTL-457)
  ([#804](https://github.com/coalesce-labs/catalyst/issues/804))
  ([d02bdaf](https://github.com/coalesce-labs/catalyst/commit/d02bdaf19c72ae4bd4c198f69c02b19e4e23959b))
- **dev:** multi-output briefing fan-out (CTL-458)
  ([#807](https://github.com/coalesce-labs/catalyst/issues/807))
  ([3e25223](https://github.com/coalesce-labs/catalyst/commit/3e2522382f99eddc87fc50e88bea5791365a4d20))
- **dev:** orchestrator state-machine rewrite + --bg cutover (CTL-452)
  ([#809](https://github.com/coalesce-labs/catalyst/issues/809))
  ([487cc38](https://github.com/coalesce-labs/catalyst/commit/487cc38f9aaeddd5a7c27d689e03165bf7764a5c))
- **dev:** phase-agent skill scaffold + dispatch helper (CTL-448)
  ([#799](https://github.com/coalesce-labs/catalyst/issues/799))
  ([29e91c7](https://github.com/coalesce-labs/catalyst/commit/29e91c7df17796e87d7f91f7ee3a04ace48ffde1))
- **dev:** phase-implement + phase-pr + phase-monitor-merge skills (CTL-449)
  ([#803](https://github.com/coalesce-labs/catalyst/issues/803))
  ([eb3c008](https://github.com/coalesce-labs/catalyst/commit/eb3c0086c791ac3642aa444b0caf7420a282d677))
- **dev:** phase-research + phase-plan + phase-verify + phase-review skills (CTL-450)
  ([#801](https://github.com/coalesce-labs/catalyst/issues/801))
  ([e3a4294](https://github.com/coalesce-labs/catalyst/commit/e3a4294286a0cbd7c7694aa088389ef3f555a7f6))
- **dev:** research-curate contradiction detection + CONTRADICTIONS.md (CTL-468)
  ([#810](https://github.com/coalesce-labs/catalyst/issues/810))
  ([185814f](https://github.com/coalesce-labs/catalyst/commit/185814fd5c0a8c09c644ea821514f5fa1ff7658d))
- **dev:** research-curate skill — inventory + staleness + INDEX.md (CTL-467)
  ([#805](https://github.com/coalesce-labs/catalyst/issues/805))
  ([dce7f14](https://github.com/coalesce-labs/catalyst/commit/dce7f144c8476507768e28af454f33c375a13555))
- **dev:** turn-cap exhaustion → automated handoff continuation (CTL-484)
  ([#844](https://github.com/coalesce-labs/catalyst/issues/844))
  ([a521ca9](https://github.com/coalesce-labs/catalyst/commit/a521ca98143ed7ec08a8673d1cf4c444371e4a15))

### Bug Fixes

- **dev:** catalyst-events tail/wait-for exit when parent dies (CTL-439)
  ([#762](https://github.com/coalesce-labs/catalyst/issues/762))
  ([bc5b657](https://github.com/coalesce-labs/catalyst/commit/bc5b6570f3066727df2652833e87ad8522e060f5))
- **dev:** consolidate HUD Header chip row onto single line (CTL-434)
  ([#758](https://github.com/coalesce-labs/catalyst/issues/758))
  ([0737ed9](https://github.com/coalesce-labs/catalyst/commit/0737ed9dd68949472af730484901f223694dd7a7))
- **dev:** HUD filter input + status row span full terminal width (CTL-433)
  ([#757](https://github.com/coalesce-labs/catalyst/issues/757))
  ([5532042](https://github.com/coalesce-labs/catalyst/commit/55320429581162277c6d6f2da9abc9315cdd65d2))
- **dev:** HUD interests footer drops 'ago' suffix on null timestamps (CTL-432)
  ([#754](https://github.com/coalesce-labs/catalyst/issues/754))
  ([46887d2](https://github.com/coalesce-labs/catalyst/commit/46887d27e968f8871e6e86f5543d654291118148))
- **dev:** populate session_metrics from worker stream cost data (CTL-455)
  ([#798](https://github.com/coalesce-labs/catalyst/issues/798))
  ([6eeb7ec](https://github.com/coalesce-labs/catalyst/commit/6eeb7ec5f16f14bbff13f9b12405bee368720edd))
- **dev:** unbreak phase-agent dispatch end-to-end (CTL-490)
  ([#848](https://github.com/coalesce-labs/catalyst/issues/848))
  ([ba6fd03](https://github.com/coalesce-labs/catalyst/commit/ba6fd03faa0e07f83c57a2985518e50030c29b0c))
- **dev:** widen HUD Interests TYPE column to 18 + add margin before WATCHES (CTL-438)
  ([#761](https://github.com/coalesce-labs/catalyst/issues/761))
  ([cf97d3c](https://github.com/coalesce-labs/catalyst/commit/cf97d3cf42b3d8b1277be5860ee58c231363c6a5))
- **dev:** wire orchestrate-roll-usage into monitor loop + enable phase-agents dispatch (CTL-487)
  ([#845](https://github.com/coalesce-labs/catalyst/issues/845))
  ([3807a0f](https://github.com/coalesce-labs/catalyst/commit/3807a0f696bdbf4dbd88baceccbf5173e398246a))

## [9.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v9.2.0...catalyst-dev-v9.3.0) (2026-05-15)

<!-- ai-enhanced -->

### HUD Overhaul & Broker Observability

This release is a substantial rework of the orchestration monitor HUD — raw event names in their own column, a unified Claude Code-style prompt input, sortable Workers/Orchestrators tabs, a new Runs tab showing the full orchestrator → worker hierarchy, and progressive Escape to undo one filter layer at a time. On the broker side, workers in wait states are now visible (with countdown timers in the HUD), stale-heartbeat wakes are batched per interest instead of flooding per session, and duplicate wakes are suppressed when CI conclusion hasn't changed. Every `catalyst-*` CLI now accepts `--version` to show the build SHA and source path, and `catalyst-broker probe` gives a fast O(1) daemon health check.


### Features

- **dev:** --version flag on every catalyst-\* CLI + commit hash (CTL-390)
  ([#667](https://github.com/coalesce-labs/catalyst/issues/667))
  ([e6c85a1](https://github.com/coalesce-labs/catalyst/commit/e6c85a130e1a26700842f85933cc786229ff441e))
- **dev:** add reason field to agent.checkout payload (CTL-402)
  ([#725](https://github.com/coalesce-labs/catalyst/issues/725))
  ([dab0fac](https://github.com/coalesce-labs/catalyst/commit/dab0face199316290d80b050ef1dad8707a9bd9e))
- **dev:** add SESSION column to HUD Interests dashboard (CTL-422)
  ([#739](https://github.com/coalesce-labs/catalyst/issues/739))
  ([bd0a61f](https://github.com/coalesce-labs/catalyst/commit/bd0a61fcfd6edce53feb35602a64c4d949dea525))
- **dev:** add wake-extract CLI + document wake payload schema (CTL-408)
  ([#726](https://github.com/coalesce-labs/catalyst/issues/726))
  ([939550e](https://github.com/coalesce-labs/catalyst/commit/939550e139c66b8b2af10f11735f72caecaa0b77))
- **dev:** add WORKER column to HUD interests table (CTL-427)
  ([#743](https://github.com/coalesce-labs/catalyst/issues/743))
  ([cd8b811](https://github.com/coalesce-labs/catalyst/commit/cd8b811727552d1922f6444f21e87f7a18dd2787))
- **dev:** broker wait-loop visibility — worker.waiting/resumed events (CTL-403)
  ([#717](https://github.com/coalesce-labs/catalyst/issues/717))
  ([fa030f5](https://github.com/coalesce-labs/catalyst/commit/fa030f5b17b6d2fbf9f6f3cae250be927ede08e5))
- **dev:** broker_claim_pr as easy path — probe command + fallback telemetry (CTL-409)
  ([#744](https://github.com/coalesce-labs/catalyst/issues/744))
  ([16cc5dc](https://github.com/coalesce-labs/catalyst/commit/16cc5dcdeb0944fffa3fbccba205263f70fab1bf))
- **dev:** emit orchestrator.status events for self-status announcements (CTL-405)
  ([#738](https://github.com/coalesce-labs/catalyst/issues/738))
  ([c1679bb](https://github.com/coalesce-labs/catalyst/commit/c1679bb48f3e2808017de08bb5daa0a9340b1934))
- **dev:** expand REPO column coverage across canonical event emitters (CTL-385)
  ([#665](https://github.com/coalesce-labs/catalyst/issues/665))
  ([baf2d7d](https://github.com/coalesce-labs/catalyst/commit/baf2d7d6bf04a8bb0716918701e9466feff579d8))
- **dev:** HUD — relocate EVENT-ID from row to detail pane (CTL-393)
  ([#684](https://github.com/coalesce-labs/catalyst/issues/684))
  ([13af477](https://github.com/coalesce-labs/catalyst/commit/13af47768b82a229047fc570c40349d0aca943e5))
- **dev:** HUD — show raw event.name in EVENT column; split icon into its own 1-char column
  (CTL-391) ([#668](https://github.com/coalesce-labs/catalyst/issues/668))
  ([eb7e70d](https://github.com/coalesce-labs/catalyst/commit/eb7e70d72075f413d30476f49187056a15a3e70e))
- **dev:** HUD — unified Claude-Code-style prompt input box (CTL-386)
  ([#688](https://github.com/coalesce-labs/catalyst/issues/688))
  ([4d569e3](https://github.com/coalesce-labs/catalyst/commit/4d569e3ac7500cfb82f5c0d6dbdcb5a14b4cb7f2))
- **dev:** HUD :since — first-class filter (overlay, ESC, footer chip) (CTL-387)
  ([#663](https://github.com/coalesce-labs/catalyst/issues/663))
  ([3e71819](https://github.com/coalesce-labs/catalyst/commit/3e7181961982a6d51df1b6f6b96eff55d1233748))
- **dev:** HUD broker/worker dashboard view (CTL-392)
  ([#678](https://github.com/coalesce-labs/catalyst/issues/678))
  ([917ebdb](https://github.com/coalesce-labs/catalyst/commit/917ebdb1b204aa4f1fc1441d8129ce8b0a6285b0))
- **dev:** HUD Claude Code-style full-width input bar with separate status line (CTL-417)
  ([#736](https://github.com/coalesce-labs/catalyst/issues/736))
  ([e641ea4](https://github.com/coalesce-labs/catalyst/commit/e641ea477a28947c3252b12e165d1a672d095206))
- **dev:** HUD Escape progressively undoes state — scope reset + live-tail resume (CTL-423)
  ([#740](https://github.com/coalesce-labs/catalyst/issues/740))
  ([3321ace](https://github.com/coalesce-labs/catalyst/commit/3321acea7f84ff6f98bcd8efff3ad0c7809116c9))
- **dev:** HUD Runs tab showing orchestrator → tickets/workers hierarchy (CTL-426)
  ([#742](https://github.com/coalesce-labs/catalyst/issues/742))
  ([f3c85e6](https://github.com/coalesce-labs/catalyst/commit/f3c85e6ae6be36442770730a49dfa845e688f81f))
- **dev:** HUD unified active-filter indicator in footer (CTL-389)
  ([#685](https://github.com/coalesce-labs/catalyst/issues/685))
  ([bb74832](https://github.com/coalesce-labs/catalyst/commit/bb748328b2b3a06d4c760f6e7e2a1f27544b7ce0))
- **dev:** HUD user-configurable column display and order (CTL-394)
  ([#691](https://github.com/coalesce-labs/catalyst/issues/691))
  ([77ae454](https://github.com/coalesce-labs/catalyst/commit/77ae4544d12d1547e6239aa71634119b04742e97))
- **dev:** HUD Workers/Orchestrators tabs — sortable columns (CTL-425)
  ([#741](https://github.com/coalesce-labs/catalyst/issues/741))
  ([165d7a7](https://github.com/coalesce-labs/catalyst/commit/165d7a787efabf5a93f3f95ee18fc0996d4a8f9b))
- **dev:** HUD wrap-mode toggle — 'w' key to flip truncate/wrap (CTL-384)
  ([#683](https://github.com/coalesce-labs/catalyst/issues/683))
  ([b8584e1](https://github.com/coalesce-labs/catalyst/commit/b8584e1753d419ffc506f41fce5ca8c3e17359a9))
- **dev:** per-event-class DETAILS formatting for GitHub and Linear events (CTL-418)
  ([#732](https://github.com/coalesce-labs/catalyst/issues/732))
  ([db3f111](https://github.com/coalesce-labs/catalyst/commit/db3f1114a243b0542f52ef694a4060548786327f))
- **dev:** populate vcs.pr.number + vcs.ref.name on check_suite/workflow_run (CTL-396)
  ([#687](https://github.com/coalesce-labs/catalyst/issues/687))
  ([efdae78](https://github.com/coalesce-labs/catalyst/commit/efdae7873f32cf10fc8a8f4f4764eebcf01584fd))
- **dev:** surface prose interest disabled status in HUD (CTL-421)
  ([#720](https://github.com/coalesce-labs/catalyst/issues/720))
  ([e38636e](https://github.com/coalesce-labs/catalyst/commit/e38636e69f93bd7a651f44ec6fd52e13385cb446))
- **dev:** wire SubagentStop/Stop hooks as agent.checkout fallback (CTL-404)
  ([#714](https://github.com/coalesce-labs/catalyst/issues/714))
  ([5d313e7](https://github.com/coalesce-labs/catalyst/commit/5d313e7ee080f2fd6ce6166a6361f44fa63b9cbe))

### Bug Fixes

- **dev:** add 1-character left margin to HUD root container (CTL-430)
  ([#734](https://github.com/coalesce-labs/catalyst/issues/734))
  ([37777c9](https://github.com/coalesce-labs/catalyst/commit/37777c96905e6c05f36583b672f5571257fa398a))
- **dev:** add retry loop to broker_claim_pr and broker_register_comms (CTL-429)
  ([#731](https://github.com/coalesce-labs/catalyst/issues/731))
  ([3c87905](https://github.com/coalesce-labs/catalyst/commit/3c879056b4b285f8c30bddb3bb120ff9b8282731))
- **dev:** apply wrap=truncate to all HUD columns to eliminate ghost chars (CTL-416)
  ([#730](https://github.com/coalesce-labs/catalyst/issues/730))
  ([d34c71f](https://github.com/coalesce-labs/catalyst/commit/d34c71f594e983b5854ed34a6b096ca630c1c77f))
- **dev:** batch stale-heartbeat wakes + HUD wake recipient visibility (CTL-419)
  ([#722](https://github.com/coalesce-labs/catalyst/issues/722))
  ([c2ebc63](https://github.com/coalesce-labs/catalyst/commit/c2ebc63266fcf59bf7615eb7eced06f007c832c8))
- **dev:** build-orchestrator-filter drops github.pr.merged when PR not yet in signal files
  (CTL-398) ([#737](https://github.com/coalesce-labs/catalyst/issues/737))
  ([b493715](https://github.com/coalesce-labs/catalyst/commit/b4937156cbe97d4941499d94f3ae0689e42d0f9e))
- **dev:** dedupe filter.wake emissions by (source_event_id, interest_id) (CTL-406)
  ([#712](https://github.com/coalesce-labs/catalyst/issues/712))
  ([985e62e](https://github.com/coalesce-labs/catalyst/commit/985e62e7c55fe20968874418d758e471df707a3d))
- **dev:** drop comms.message.posted from Groq queue when no deterministic match (CTL-397)
  ([#718](https://github.com/coalesce-labs/catalyst/issues/718))
  ([8f3780b](https://github.com/coalesce-labs/catalyst/commit/8f3780b422fe787dea018b44d7a7651c5e574e8f))
- **dev:** enrich filter.wake reasons for check_suite non-success/failure conclusions (CTL-399)
  ([#728](https://github.com/coalesce-labs/catalyst/issues/728))
  ([cfb499a](https://github.com/coalesce-labs/catalyst/commit/cfb499a217f50d25ed990e54600d9360981bf87e))
- **dev:** HUD — eliminate ghost chars in DETAILS via explicit width (CTL-395)
  ([#686](https://github.com/coalesce-labs/catalyst/issues/686))
  ([73c058e](https://github.com/coalesce-labs/catalyst/commit/73c058e3af2df1675b4b718f3289bc14605bfbca))
- **dev:** HUD — truncate long orchestrator IDs in ORCH column (CTL-383)
  ([#662](https://github.com/coalesce-labs/catalyst/issues/662))
  ([4b869fc](https://github.com/coalesce-labs/catalyst/commit/4b869fcc569b65b994cb6f4bfd0cf0b0b72a33fb))
- **dev:** HUD detail pane no longer pins selected event at list top (CTL-420)
  ([#733](https://github.com/coalesce-labs/catalyst/issues/733))
  ([795b2f7](https://github.com/coalesce-labs/catalyst/commit/795b2f7db03aae063675a65cc1489ef2de9a9a70))
- **dev:** HUD pivot keys o/t pause live mode before scoping (CTL-388)
  ([#664](https://github.com/coalesce-labs/catalyst/issues/664))
  ([9604fb7](https://github.com/coalesce-labs/catalyst/commit/9604fb7d7e21f7ee8d17d62c6c4c21bfce63065c))
- **dev:** orchestrate-verify.sh false-positive on post-merge branch lookup (CTL-400)
  ([#735](https://github.com/coalesce-labs/catalyst/issues/735))
  ([ef3f8e1](https://github.com/coalesce-labs/catalyst/commit/ef3f8e1599ef9611f82c80056eea39b100e5cfd0))
- **dev:** populate REPO column for linear.\* and filter.wake events (CTL-412)
  ([#724](https://github.com/coalesce-labs/catalyst/issues/724))
  ([8b928eb](https://github.com/coalesce-labs/catalyst/commit/8b928eb1f4a0aece70844f10953fe2575bb59d39))
- **dev:** reject range operators on wrong-typed fields in NLQ DSL (CTL-415)
  ([#729](https://github.com/coalesce-labs/catalyst/issues/729))
  ([c150a6b](https://github.com/coalesce-labs/catalyst/commit/c150a6bd1aa2575df87fe868f86607f921058eb9))
- **dev:** remove stale filter-input.test.ts after FilterInput.tsx deletion
  ([#689](https://github.com/coalesce-labs/catalyst/issues/689))
  ([6b871d7](https://github.com/coalesce-labs/catalyst/commit/6b871d7a8cc31694263c745939868d8a6327846d))
- **dev:** remove unnecessary type assertions left by CTL-394 worker
  ([#694](https://github.com/coalesce-labs/catalyst/issues/694))
  ([e6dee50](https://github.com/coalesce-labs/catalyst/commit/e6dee50b13425ef960014f8127f02ae1e9d72dba))
- **dev:** remove unused ink-text-input dependency from orch-monitor
  ([#690](https://github.com/coalesce-labs/catalyst/issues/690))
  ([0fa7777](https://github.com/coalesce-labs/catalyst/commit/0fa7777a35fb420c5cf4c936f01e4f670626c59b))
- **dev:** route bare durations to since-filter in HUD query input (CTL-414)
  ([#727](https://github.com/coalesce-labs/catalyst/issues/727))
  ([2f0126c](https://github.com/coalesce-labs/catalyst/commit/2f0126ccdf2e3d8d4cc1c9f0799e180e5303b08b))
- **dev:** route session.heartbeat to broker watchdog liveness map (CTL-401)
  ([#711](https://github.com/coalesce-labs/catalyst/issues/711))
  ([f5d7649](https://github.com/coalesce-labs/catalyst/commit/f5d764946bdeb981faa0a2124d7b3193fcd5c8d1))
- **dev:** suppress redundant broker wakes when downstream state unchanged (CTL-407)
  ([#719](https://github.com/coalesce-labs/catalyst/issues/719))
  ([2a5293e](https://github.com/coalesce-labs/catalyst/commit/2a5293ecf324adb97f08438c7bd3aec40e9925c7))
- **dev:** surface toState, actorName, and scalar fields in Linear webhook canonical payload
  (CTL-424) ([#721](https://github.com/coalesce-labs/catalyst/issues/721))
  ([9e6e494](https://github.com/coalesce-labs/catalyst/commit/9e6e494f2db16e1fa8e853dcd3d9dac94d96f795))
- **dev:** use Date.getTime() for since-filter comparison in HUD (CTL-413)
  ([#723](https://github.com/coalesce-labs/catalyst/issues/723))
  ([81f0e34](https://github.com/coalesce-labs/catalyst/commit/81f0e3430503577527e76e2a3c4f9b77c70a52b0))

## [9.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v9.1.0...catalyst-dev-v9.2.0) (2026-05-14)

<!-- ai-enhanced -->

### Claude Code Session Metadata & HUD Overhaul

Session context is now tracked and surfaced throughout the toolchain: `catalyst-statusline.sh` emits `session.context` events with model, context %, token count, cost, and turn number on every status bar render, and the HUD and web UI display them inline per worker. The monitor HUD also gets a round of focused improvements — the SOURCE and EVENT columns are merged into a single responsive column, the `/` filter now substring-matches across every field in the raw event JSON (with AND semantics for multi-token queries), the footer compacts to two lines with width-responsive hotkey hints, and the scroll anchor bug that hid filter matches above the viewport is fixed. Run `catalyst-db.sh init` after updating to apply the new `claude_session_id` and `last_context_pct` columns.


### Features

- **dev:** broaden HUD `/` filter to substring-match across all event fields (CTL-367)
  ([#644](https://github.com/coalesce-labs/catalyst/issues/644))
  ([f900348](https://github.com/coalesce-labs/catalyst/commit/f9003483d18319bfd2135d7eabb13b4ff1594325))
- **dev:** enrich session events with Claude Code metadata (CTL-374)
  ([#638](https://github.com/coalesce-labs/catalyst/issues/638))
  ([d1f78e2](https://github.com/coalesce-labs/catalyst/commit/d1f78e20e1f67a04246a497060176ebe27106ac8))
- **dev:** HUD — merge SOURCE + EVENT columns into single wider EVENT column (CTL-364)
  ([#645](https://github.com/coalesce-labs/catalyst/issues/645))
  ([2ad9d26](https://github.com/coalesce-labs/catalyst/commit/2ad9d2620f9e079ec172c4bb758e2be63d9cd61a))
- **dev:** HUD footer cleanup — right-align event count, separator, width hints (CTL-363)
  ([#627](https://github.com/coalesce-labs/catalyst/issues/627))
  ([65cb93b](https://github.com/coalesce-labs/catalyst/commit/65cb93bf2b7370956c74077a9b92f0591cb3fe8a))
- **dev:** lift cicd.pipeline.run.status to typed canonical attribute (CTL-366)
  ([#632](https://github.com/coalesce-labs/catalyst/issues/632))
  ([3608818](https://github.com/coalesce-labs/catalyst/commit/3608818204b8ed4f45475d80aeed8f5e755aa495))
- **dev:** orchestrator-id short form `o-<repo>-<tickets>` (CTL-373)
  ([#637](https://github.com/coalesce-labs/catalyst/issues/637))
  ([3353d8c](https://github.com/coalesce-labs/catalyst/commit/3353d8c62f204a59af89256a46f4f0b3b46b4025))
- **dev:** vcs.repository.name enrichment for linear/orchestrator/broker events (CTL-362)
  ([#628](https://github.com/coalesce-labs/catalyst/issues/628))
  ([c6e6138](https://github.com/coalesce-labs/catalyst/commit/c6e61383ac130753c80cb2ba6fbba24e6f841a3b))

### Bug Fixes

- **dev:** canonical worker-event allowlist + schema-drift cleanup (CTL-370)
  ([#635](https://github.com/coalesce-labs/catalyst/issues/635))
  ([94ea15d](https://github.com/coalesce-labs/catalyst/commit/94ea15d9f91e1d1170851f21198c2bc59bbdabe2))
- **dev:** HUD DETAILS column truncates instead of wrapping (CTL-361)
  ([#626](https://github.com/coalesce-labs/catalyst/issues/626))
  ([0e4e267](https://github.com/coalesce-labs/catalyst/commit/0e4e26774742396c9acea7056b1989a4e74a8be2))
- **dev:** HUD filtered viewport — autoFollow UP scroll anchor (CTL-368)
  ([#630](https://github.com/coalesce-labs/catalyst/issues/630))
  ([681f351](https://github.com/coalesce-labs/catalyst/commit/681f3517a8260a3978bc29813d290cb73991ddd2))
- **dev:** NL query — refresh prompt schema, add events catalog, inject current time (CTL-365)
  ([#631](https://github.com/coalesce-labs/catalyst/issues/631))
  ([506eb4f](https://github.com/coalesce-labs/catalyst/commit/506eb4f0a98b0f1f5b59403e8d80a2faa9f3d138))
- **dev:** orchestrate dispatch prompt teaches broker Pattern 3 preference (CTL-371)
  ([#634](https://github.com/coalesce-labs/catalyst/issues/634))
  ([ce2e0f2](https://github.com/coalesce-labs/catalyst/commit/ce2e0f25174c6b4cc457b9585976904e381182f6))
- **dev:** reconcile orchestrate Phase 4 grep pipe with monitor-events prohibition (CTL-372)
  ([#636](https://github.com/coalesce-labs/catalyst/issues/636))
  ([4aeae33](https://github.com/coalesce-labs/catalyst/commit/4aeae33f45a7e50dc169b990dfa5abd4863c418f))
- **dev:** require wake narration line per Monitor wake (CTL-369)
  ([#633](https://github.com/coalesce-labs/catalyst/issues/633))
  ([1bd684d](https://github.com/coalesce-labs/catalyst/commit/1bd684dfdaf75523e65fede45352c935aeb5fa3a))

## [9.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v9.0.0...catalyst-dev-v9.1.0) (2026-05-13)

<!-- ai-enhanced -->

### Broker Reliability & HUD Observability Overhaul

This release fixes a cascade of broker routing failures where canonical OTel event envelopes were being misread at multiple sites — `filter.register` events were silently ignored, deterministic PR routes never fired, and the Groq prose classifier was generating ~95% false positives (now gated off by default via `CATALYST_BROKER_PROSE_ENABLED=0`). The HUD gets substantial polish alongside: wake rows now show the target orchestrator and wake reason in context, SOURCE icons pick up Nerd Font glyphs, column widths adapt to terminal size, and a broker health chip surfaces interest count and API key status at a glance. Run `plugins/dev/scripts/clean-prose-interests.sh && catalyst-monitor restart` after updating to clear any stale test-residue interests from `~/catalyst/broker-interests.json`.


### Features

- **dev:** broker comms_lifecycle + env-gate Groq prose path (CTL-357)
  ([#607](https://github.com/coalesce-labs/catalyst/issues/607))
  ([39adb7a](https://github.com/coalesce-labs/catalyst/commit/39adb7aaa0528ddd5254c715e742ded4dc0ac429))
- **dev:** per-event UUID (event.id) across canonical emitters (CTL-344)
  ([#580](https://github.com/coalesce-labs/catalyst/issues/580))
  ([2b9acc9](https://github.com/coalesce-labs/catalyst/commit/2b9acc9c399d2ebca9701ebdbffefee4316f2227))

### Bug Fixes

- **dev:** API key health — startup warning, probe, status surface, gateway (CTL-343)
  ([#579](https://github.com/coalesce-labs/catalyst/issues/579))
  ([543449f](https://github.com/coalesce-labs/catalyst/commit/543449f7b15550cdd4a9a926c078f16153227be6))
- **dev:** broker interests integrity + empty-state observability (CTL-352)
  ([#602](https://github.com/coalesce-labs/catalyst/issues/602))
  ([fd09601](https://github.com/coalesce-labs/catalyst/commit/fd09601ff5c512037d4ade5f4382eafea610dd47))
- **dev:** broker prose-match suppression gate uses Groq intent (CTL-340)
  ([#585](https://github.com/coalesce-labs/catalyst/issues/585))
  ([6e864be](https://github.com/coalesce-labs/catalyst/commit/6e864becc45763047bbb318cd12909f2eea54f98))
- **dev:** broker reads canonical filter.register events (CTL-336)
  ([#567](https://github.com/coalesce-labs/catalyst/issues/567))
  ([8abc0d5](https://github.com/coalesce-labs/catalyst/commit/8abc0d5ff4d749c09702b3ca947fd95f1cb33f30))
- **dev:** broker skips self-emitted filter.wake/broker.daemon events (CTL-346)
  ([#586](https://github.com/coalesce-labs/catalyst/issues/586))
  ([33859e7](https://github.com/coalesce-labs/catalyst/commit/33859e71f922cb11f7348aa20d7e7770f4a68075))
- **dev:** broker tryDeterministicRoute canonical-envelope read (CTL-359)
  ([#609](https://github.com/coalesce-labs/catalyst/issues/609))
  ([523b6fe](https://github.com/coalesce-labs/catalyst/commit/523b6feef68496136446a51020256e4aed327185))
- **dev:** correct filter.wake predicate in skill docs (CTL-354)
  ([#599](https://github.com/coalesce-labs/catalyst/issues/599))
  ([b7193a4](https://github.com/coalesce-labs/catalyst/commit/b7193a4b79bc6c11dbc26aee5f4cc2f1503fed97))
- **dev:** delete retired filter-daemon directory (CTL-349)
  ([#590](https://github.com/coalesce-labs/catalyst/issues/590))
  ([d553c7e](https://github.com/coalesce-labs/catalyst/commit/d553c7ed827f272ce3ea030bd088c0744fe3fac9))
- **dev:** HUD + broker observability rework (CTL-350)
  ([#592](https://github.com/coalesce-labs/catalyst/issues/592))
  ([3d9a02b](https://github.com/coalesce-labs/catalyst/commit/3d9a02b0e0d054c891516ad22edc2876a69bd52a))
- **dev:** HUD filter row display — DETAILS, REF, and SOURCE (CTL-337)
  ([#569](https://github.com/coalesce-labs/catalyst/issues/569))
  ([944410e](https://github.com/coalesce-labs/catalyst/commit/944410ebb1ad5f62a7e4ea33070b46f2de7c448e))
- **dev:** HUD glyph fixes — NF v3 codepoint move + PR space (CTL-358)
  ([#606](https://github.com/coalesce-labs/catalyst/issues/606))
  ([17d30f4](https://github.com/coalesce-labs/catalyst/commit/17d30f4e8fe4dcb05d0b3b7e17d4baeb04142604))
- **dev:** HUD glyph polish — SOURCE icon prefix, PR symbol, REF/ORCH dedup (CTL-355)
  ([#601](https://github.com/coalesce-labs/catalyst/issues/601))
  ([3dfc153](https://github.com/coalesce-labs/catalyst/commit/3dfc15329cdf184c4a75457f3a09733220270225))
- **dev:** HUD highlight uses inverse video for readable contrast (CTL-342)
  ([#578](https://github.com/coalesce-labs/catalyst/issues/578))
  ([a257e65](https://github.com/coalesce-labs/catalyst/commit/a257e6545cce7f0632bf542b87c991fc9c98cafe))
- **dev:** HUD in-progress glyph uses Nerd Font when available, else ellipsis (CTL-353)
  ([#598](https://github.com/coalesce-labs/catalyst/issues/598))
  ([8baceda](https://github.com/coalesce-labs/catalyst/commit/8baceda8168fd560158adf49cb16bd1fab56211a))
- **dev:** HUD polish + broker.daemon.shutdown event (CTL-351)
  ([#595](https://github.com/coalesce-labs/catalyst/issues/595))
  ([dd99679](https://github.com/coalesce-labs/catalyst/commit/dd99679b42efaca8b0086c93cc70f9bf88c59907))
- **dev:** install-cli.sh owns ~/.catalyst/bin + auto PATH bootstrap (CTL-339)
  ([#571](https://github.com/coalesce-labs/catalyst/issues/571))
  ([3284f5a](https://github.com/coalesce-labs/catalyst/commit/3284f5a7e1e4589f8ffc1f7cc17f8f975bccdf12))
- **dev:** orchestrate-dispatch-next leaks parent stdin into worker (CTL-334)
  ([#577](https://github.com/coalesce-labs/catalyst/issues/577))
  ([8dfb293](https://github.com/coalesce-labs/catalyst/commit/8dfb293d6093494faeba7266fb3cae27e824bf8d))
- **dev:** pr_lifecycle interest refresh + auto-correlate at PR open (CTL-341)
  ([#588](https://github.com/coalesce-labs/catalyst/issues/588))
  ([eadab91](https://github.com/coalesce-labs/catalyst/commit/eadab91efffbc283005b0fa1d03aa4c9732c1327))
- **dev:** surface wake target + reason in HUD rows (CTL-348)
  ([#587](https://github.com/coalesce-labs/catalyst/issues/587))
  ([f1bfbb1](https://github.com/coalesce-labs/catalyst/commit/f1bfbb13e4ab6f7bc87dbfd20a18d27d918507dc))

## [9.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v8.4.0...catalyst-dev-v9.0.0)

May 11, 2026

<!-- ai-enhanced -->

### Catalyst HUD Bottom-Anchored Panels

Detail panes and help overlays now anchor to the bottom of your terminal with the event list
expanding to fill all remaining space above. Event rows are self-explanatory — comms events show
sender/recipient/type, filter events display as "wake"/"filter reg" instead of truncated names, and
all text is cleaned of HTML/Markdown markup. Column headers stay pinned when detail panes are open,
and the core catalyst-pm plugin now focuses on 12 essential strategy/PRD skills with ops features
moved to dedicated sibling plugins.

### PRs

- **pm:** shrink catalyst-pm to 12 strategy/PRD skills (CTL-322)
  ([#543](https://github.com/coalesce-labs/catalyst/issues/543))
- **pm:** shrink catalyst-pm to 12 strategy/PRD skills (CTL-322)
  ([#543](https://github.com/coalesce-labs/catalyst/issues/543))
  ([43b1c89](https://github.com/coalesce-labs/catalyst/commit/43b1c89db5d7536a31a82918df8555b579e53f07))
- **dev:** bottom-anchor catalyst-hud detail pane (CTL-324)
  ([#553](https://github.com/coalesce-labs/catalyst/issues/553))
  ([9de7767](https://github.com/coalesce-labs/catalyst/commit/9de7767c38bc5f09c41465cd793fefe51ef333a7))
- **dev:** bottom-anchor catalyst-hud help panel (CTL-325)
  ([#554](https://github.com/coalesce-labs/catalyst/issues/554))
  ([474702d](https://github.com/coalesce-labs/catalyst/commit/474702db166c6a68ffe277d6767f0674ce63be42))
- **dev:** broker writes canonical filter.wake events + HUD shows filter.\* labels (CTL-331)
  ([#558](https://github.com/coalesce-labs/catalyst/issues/558))
  ([6a28db7](https://github.com/coalesce-labs/catalyst/commit/6a28db74736b857b25328bed253566e7fc289184))
- **dev:** catalyst-hud — make comms rows self-explanatory (CTL-330)
  ([#559](https://github.com/coalesce-labs/catalyst/issues/559))
  ([37cdf68](https://github.com/coalesce-labs/catalyst/commit/37cdf68e0e603fb41569db4ce5b6f7b14c3e3f79))
- **dev:** catalyst-hud detail header — 24h datetime, prevent timestamp wrap (CTL-327)
  ([#552](https://github.com/coalesce-labs/catalyst/issues/552))
  ([8440c9b](https://github.com/coalesce-labs/catalyst/commit/8440c9b94d38958b1b7bf02d12880f36101c744f))
- **dev:** catalyst-hud sticky column header (CTL-332)
  ([#560](https://github.com/coalesce-labs/catalyst/issues/560))
  ([8f4447a](https://github.com/coalesce-labs/catalyst/commit/8f4447a0a0db89528bcf8f69427c35e11bea3c70))
- **dev:** catalyst-hud UI polish — live tail, scrollable panes, redesigned detail
  ([#529](https://github.com/coalesce-labs/catalyst/issues/529))
  ([b6fac3f](https://github.com/coalesce-labs/catalyst/commit/b6fac3fc8316dcc9664349f604f84b1856459c51))
- **dev:** make catalyst-hud and install-cli resilient to plugin upgrades
  ([#538](https://github.com/coalesce-labs/catalyst/issues/538))
  ([3a07708](https://github.com/coalesce-labs/catalyst/commit/3a07708257e88379c77addb13e584c56132e902b))
- **dev:** strip HTML and Markdown markup from catalyst-hud event details (CTL-326)
  ([#551](https://github.com/coalesce-labs/catalyst/issues/551))
  ([80870da](https://github.com/coalesce-labs/catalyst/commit/80870da0d4cd158b37c3e84e6bf893f4c6e8db6b))

## [8.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v8.3.0...catalyst-dev-v8.4.0)

May 09, 2026

<!-- ai-enhanced -->

### Event Log Analysis CLI

Query your event logs using either technical filters or plain English — get phase timing breakdowns,
identify orchestration stalls, and analyze CI funnels from JSONL logs. Natural language queries like
"show errors in the last hour" are translated to structured filters via Claude and work in both the
CLI and live TUI. Legacy event formats are now handled gracefully to prevent the catalyst-hud
loading hang.

### PRs

- **dev:** event log analysis CLI — phase-time, stalls, ci-funnel (CTL-307)
  ([#523](https://github.com/coalesce-labs/catalyst/issues/523))
  ([1f7158a](https://github.com/coalesce-labs/catalyst/commit/1f7158a407a54b49818885314216e7c222c09df0))
- **dev:** natural-language event query for catalyst-events + TUI (CTL-313)
  ([#524](https://github.com/coalesce-labs/catalyst/issues/524))
  ([0a8b235](https://github.com/coalesce-labs/catalyst/commit/0a8b23534c212e6940543b42cc401260df0d9d43))
- **dev:** guard against legacy events crashing catalyst-hud
  ([#528](https://github.com/coalesce-labs/catalyst/issues/528))
  ([f0bcf34](https://github.com/coalesce-labs/catalyst/commit/f0bcf343567c551b6425dfb558f25f7bfd21c4ce))
- **dev:** orchestrate-verify uses `bun run test` not `bun test` (CTL-317)
  ([#531](https://github.com/coalesce-labs/catalyst/issues/531))
  ([76fcbf8](https://github.com/coalesce-labs/catalyst/commit/76fcbf8c6ae93b203f16bd24b36ad5d1aefc70b9))

## [8.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v8.2.0...catalyst-dev-v8.3.0)

May 08, 2026

<!-- ai-enhanced -->

### AI Activity Brief and Broker Evolution

The Catalyst plugin ecosystem now includes an AI-powered Activity Brief panel that generates
executive summaries of the last 30m/1h/6h of development activity, plus a new `/god` skill for
cross-project omniscient status monitoring. The core event filtering system has evolved into
`catalyst-broker` with structured agent identity, automatic PR correlation, and deterministic
routing for Linear ticket events. Run `catalyst-monitor.sh forward-start` to enable the new
OTLP/PostHog/Cloudflare Analytics Engine telemetry forwarder that ships canonical events to external
observability platforms.

### PRs

- **dev:** Activity Brief panel — AI summary of recent event activity (CTL-282)
  ([#470](https://github.com/coalesce-labs/catalyst/issues/470))
  ([e76bed7](https://github.com/coalesce-labs/catalyst/commit/e76bed7e11099c37ad99b2476bb44c7f5bbe1ee9))
- **dev:** add /god skill — cross-project omniscient status view (CTL-193)
  ([#466](https://github.com/coalesce-labs/catalyst/issues/466))
  ([0daed35](https://github.com/coalesce-labs/catalyst/commit/0daed35e90aaa1ef63f64bea1b20e3b5bdf07ffd))
- **dev:** add color-coded source chips to activity feed (CTL-276)
  ([#464](https://github.com/coalesce-labs/catalyst/issues/464))
  ([01565e5](https://github.com/coalesce-labs/catalyst/commit/01565e5ee6b13dad0d61c81e62c5a6f7b5fa1871))
- **dev:** canonical OTel-shaped event envelope (CTL-300)
  ([#501](https://github.com/coalesce-labs/catalyst/issues/501))
  ([f2402c4](https://github.com/coalesce-labs/catalyst/commit/f2402c4ba6f8b05c829284bc21c4be02e20f6b39))
- **dev:** canonical SVC/SEV/TRACE columns in catalyst-hud (CTL-308)
  ([#504](https://github.com/coalesce-labs/catalyst/issues/504))
  ([1a50efb](https://github.com/coalesce-labs/catalyst/commit/1a50efbad9f79617c0f06ab159ed80634d01e1aa))
- **dev:** catalyst-hud TUI — Ink-based terminal with scrollback, filter, detail pane, trace pivot
  (CTL-312) ([#514](https://github.com/coalesce-labs/catalyst/issues/514))
  ([db1e346](https://github.com/coalesce-labs/catalyst/commit/db1e346234d5c0b287cf9cdd4fa2296f5eb6227d))
- **dev:** CTL-306 tail-and-forward daemon (canonical events → OTLP / PostHog / Cloudflare AE)
  ([#516](https://github.com/coalesce-labs/catalyst/issues/516))
  ([ecb71c7](https://github.com/coalesce-labs/catalyst/commit/ecb71c70d85980d2c55db78b5e7b14260a3841fd))
- **dev:** deterministic event routing for PR lifecycle (CTL-284)
  ([#496](https://github.com/coalesce-labs/catalyst/issues/496))
  ([675cd81](https://github.com/coalesce-labs/catalyst/commit/675cd813231c728b720450fda171815c2a3e2c9f))
- **dev:** enrich Linear issue events with human-readable descriptions (CTL-281)
  ([#469](https://github.com/coalesce-labs/catalyst/issues/469))
  ([5d1988c](https://github.com/coalesce-labs/catalyst/commit/5d1988c4ceba2b9314e0beb503edddb8d404a801))
- **dev:** evolve filter daemon into broker — structured agent identity, auto-correlation,
  ticket_lifecycle routing (CTL-303) ([#515](https://github.com/coalesce-labs/catalyst/issues/515))
  ([c0e5417](https://github.com/coalesce-labs/catalyst/commit/c0e5417f78f12ea54d81baf6c679fdb1941adcc9))
- **dev:** generalize filter.register to all agent types (CTL-269)
  ([#441](https://github.com/coalesce-labs/catalyst/issues/441))
  ([ddd493b](https://github.com/coalesce-labs/catalyst/commit/ddd493b3e28b904747f6700873970de0cbb69309))
- **dev:** include message body in comms.message.posted events (CTL-279)
  ([#468](https://github.com/coalesce-labs/catalyst/issues/468))
  ([ad20724](https://github.com/coalesce-labs/catalyst/commit/ad207249a2e73dcc3f984e1a37693dd556371a18))
- **dev:** multi-team webhook support + Layer 2 config alignment (CTL-273)
  ([f6e1eee](https://github.com/coalesce-labs/catalyst/commit/f6e1eeeaf2fb26eee38832d683aa17772ca1675d))
- **dev:** per-repo color config for HUD scope chips (CTL-277)
  ([#471](https://github.com/coalesce-labs/catalyst/issues/471))
  ([f952bfa](https://github.com/coalesce-labs/catalyst/commit/f952bfad7a4590ec1b93b97ce7a0e2152b3a039b))
- **dev:** per-team Linear webhook secrets + fix pre-existing bugs (CTL-285)
  ([#474](https://github.com/coalesce-labs/catalyst/issues/474))
  ([bbdb60f](https://github.com/coalesce-labs/catalyst/commit/bbdb60feb1843499e14dbee125b8fee62ff7db54))
- **dev:** populate traceId on webhook-emitted canonical events (CTL-310)
  ([#509](https://github.com/coalesce-labs/catalyst/issues/509))
  ([74e4150](https://github.com/coalesce-labs/catalyst/commit/74e4150d10e06ded7ec6988082f0c3caf1d1cd8b))
- **dev:** rename catalyst-filter → catalyst-broker as primary CLI (CTL-315)
  ([#521](https://github.com/coalesce-labs/catalyst/issues/521))
  ([6e94290](https://github.com/coalesce-labs/catalyst/commit/6e9429038432a422746b5674ebd709b8b39f2372))
- **dev:** replace console.\* with pino structured logging in broker + forwarder (CTL-314)
  ([#520](https://github.com/coalesce-labs/catalyst/issues/520))
  ([8200ca8](https://github.com/coalesce-labs/catalyst/commit/8200ca8fd53ccbed42bd43f3cbf6e1f86f7cb7fd))
- **dev:** webhook teardown script + auto-startup docs (CTL-219)
  ([#513](https://github.com/coalesce-labs/catalyst/issues/513))
  ([33b7b79](https://github.com/coalesce-labs/catalyst/commit/33b7b7983f95344c324e1660c78d3bdc468312f8))
- **dev:** wire Linear webhook events into HUD activity feed (CTL-275)
  ([#463](https://github.com/coalesce-labs/catalyst/issues/463))
  ([510e6a7](https://github.com/coalesce-labs/catalyst/commit/510e6a7c900155bc2afcf7d690980ea25b064aea))
- **dev:** align Linear webhook URL key with consumers (CTL-274)
  ([#450](https://github.com/coalesce-labs/catalyst/issues/450))
  ([bf6ba0c](https://github.com/coalesce-labs/catalyst/commit/bf6ba0c0b6fd740b5eb2c7715472b81d53fc3f11))
- **dev:** catalyst-hud column alignment + event-name truncation (CTL-311)
  ([#511](https://github.com/coalesce-labs/catalyst/issues/511))
  ([f34af09](https://github.com/coalesce-labs/catalyst/commit/f34af09dcd36c3378961fab040bb7cecd24e1d66))
- **dev:** event filter bugs — Codex reviews silently dropped (CTL-270)
  ([#443](https://github.com/coalesce-labs/catalyst/issues/443))
  ([82b1d3f](https://github.com/coalesce-labs/catalyst/commit/82b1d3f45ff989980a8ca22922ae877d65754b22))
- **dev:** keyed-format fallback for linearSmeeChannel (CTL-301)
  ([#493](https://github.com/coalesce-labs/catalyst/issues/493))
  ([332e8e3](https://github.com/coalesce-labs/catalyst/commit/332e8e3bd87483b99207b85586855f36bebbd800))
- **dev:** read groq.apiKey from config.json when GROQ_API_KEY env var is absent
  ([#445](https://github.com/coalesce-labs/catalyst/issues/445))
  ([ec5c84e](https://github.com/coalesce-labs/catalyst/commit/ec5c84ef2cc1a7a2829ef2cdfb5a0ebe590557b0))
- **dev:** read Linear webhookId from cross-project Layer 2 (CTL-272)
  ([#449](https://github.com/coalesce-labs/catalyst/issues/449))
  ([5ceb79e](https://github.com/coalesce-labs/catalyst/commit/5ceb79e714f47c21e895b59930f8b6f10267edd3))
- **dev:** replace polling with fs.watch reactive tailing in filter daemon (CTL-283)
  ([#461](https://github.com/coalesce-labs/catalyst/issues/461))
  ([c1cca6e](https://github.com/coalesce-labs/catalyst/commit/c1cca6ef78945a7748be214ef468635fb28e0585))
- **dev:** resolve symlink before deriving SCRIPT_DIR in catalyst-hud
  ([#517](https://github.com/coalesce-labs/catalyst/issues/517))
  ([de226e9](https://github.com/coalesce-labs/catalyst/commit/de226e9454d513bfaa18c4373aaf1b3a44d97b8c))
- **dev:** show repo chip on non-PR GitHub events (CTL-278)
  ([#467](https://github.com/coalesce-labs/catalyst/issues/467))
  ([d5b704e](https://github.com/coalesce-labs/catalyst/commit/d5b704eccd4dba56164b9aa1eb27b0df6326b06f))

## [8.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v8.1.0...catalyst-dev-v8.2.0)

May 06, 2026

<!-- ai-enhanced -->

### Groq-Powered Semantic Event Routing

The catalyst-filter daemon now routes GitHub webhook and Linear events through Groq Llama 3.1 8B,
letting orchestrators register natural-language intents instead of writing complex jq filters.
Bidirectional comms enable mid-flight orchestrator messages to workers, and heartbeat watchdog
detection catches stalled workers without LLM calls. Install the new CLIs with
`catalyst-filter start` and `setup-webhooks.sh --register-github-hooks`.

### PRs

- **dev:** add catalyst-filter to plugin install scripts (CTL-259)
  ([#423](https://github.com/coalesce-labs/catalyst/issues/423))
  ([20b7807](https://github.com/coalesce-labs/catalyst/commit/20b780770fe487dfde450eefc5ed1f6b0a8eba59))
- **dev:** bidirectional comms — workers read inbound messages at phase boundaries (CTL-249)
  ([#403](https://github.com/coalesce-labs/catalyst/issues/403))
  ([79aa258](https://github.com/coalesce-labs/catalyst/commit/79aa258c5d2e1fa309bff48b7825417d46e65fde))
- **dev:** catalyst-filter daemon — Groq-powered semantic event routing (CTL-256)
  ([#421](https://github.com/coalesce-labs/catalyst/issues/421))
  ([ceeb0ee](https://github.com/coalesce-labs/catalyst/commit/ceeb0eeb8bad2408e8f7c403df56f1fa0e3af63c))
- **dev:** event-schema reference doc — derive from TypeScript types so agents don't guess field
  names ([#430](https://github.com/coalesce-labs/catalyst/issues/430))
  ([e0b0821](https://github.com/coalesce-labs/catalyst/commit/e0b082144a6a9a20ea6a98694ca1cbe1f78cc67e))
- **dev:** expose webhookTunnel state in catalyst-monitor status --json (CTL-244)
  ([#398](https://github.com/coalesce-labs/catalyst/issues/398))
  ([643055d](https://github.com/coalesce-labs/catalyst/commit/643055d945509200b52d74b351208fc5607445d4))
- **dev:** heartbeat watchdog in filter daemon — detect stalled workers without LLM (CTL-261)
  ([#428](https://github.com/coalesce-labs/catalyst/issues/428))
  ([c8e337b](https://github.com/coalesce-labs/catalyst/commit/c8e337b26c6847f7b03b2b8998aadaa0d318603c))
- **dev:** Linear issue events → filter daemon wake via bot-skip suppression (CTL-263)
  ([#426](https://github.com/coalesce-labs/catalyst/issues/426))
  ([a2bd391](https://github.com/coalesce-labs/catalyst/commit/a2bd3919460efff54379ebdf5f83000a79361d16))
- **dev:** orch-monitor activity feed for global event stream (CTL-225)
  ([#358](https://github.com/coalesce-labs/catalyst/issues/358))
  ([db72cf7](https://github.com/coalesce-labs/catalyst/commit/db72cf7cabb75d2eb63af8f79842df0773b5399b))
- **dev:** orch-monitor daemon liveness check as skill prerequisite (CTL-223)
  ([#356](https://github.com/coalesce-labs/catalyst/issues/356))
  ([7e906ce](https://github.com/coalesce-labs/catalyst/commit/7e906cea0f6e81ac0583b72662263aaa4f827590))
- **dev:** orch-monitor version drift self-check on startup (CTL-237)
  ([#381](https://github.com/coalesce-labs/catalyst/issues/381))
  ([ab2edcf](https://github.com/coalesce-labs/catalyst/commit/ab2edcf24127529a306dd7d9f5196efd538a5bb2))
- **dev:** orchestrate Phase 4 — event-driven Monitor + catalyst-events tail (CTL-243)
  ([#378](https://github.com/coalesce-labs/catalyst/issues/378))
  ([7f3e728](https://github.com/coalesce-labs/catalyst/commit/7f3e728b2c583dbab550c459c28c207582824185))
- **dev:** orchestrator DIRTY merge auto-recovery (CTL-232)
  ([#386](https://github.com/coalesce-labs/catalyst/issues/386))
  ([59222b6](https://github.com/coalesce-labs/catalyst/commit/59222b67706e77ed2164583dba51dc9ebcfb912c))
- **dev:** persist Linear webhook registration to Layer 2 (CTL-238)
  ([#382](https://github.com/coalesce-labs/catalyst/issues/382))
  ([a730499](https://github.com/coalesce-labs/catalyst/commit/a7304997e03823c41028cdc51bd00d4207ec3485))
- **dev:** persistent interests + explicit deregistration in filter daemon (CTL-262)
  ([#425](https://github.com/coalesce-labs/catalyst/issues/425))
  ([d0ac7d9](https://github.com/coalesce-labs/catalyst/commit/d0ac7d9d2c510803f1c594a99ce677cc48dfae18))
- **dev:** reactive multi-event PR lifecycle subscription (CTL-228)
  ([#379](https://github.com/coalesce-labs/catalyst/issues/379))
  ([e407c24](https://github.com/coalesce-labs/catalyst/commit/e407c24a9a102259ef81bb29d658a12d19026908))
- **dev:** SKILL.md for catalyst-filter — protocol docs for orchestrators (CTL-258)
  ([#422](https://github.com/coalesce-labs/catalyst/issues/422))
  ([e42a4ac](https://github.com/coalesce-labs/catalyst/commit/e42a4acb80d4672e1518dfd10ad8609647210cdb))
- **dev:** wait-for-github diagnostic checkpoint — update callers to two-phase pattern (CTL-251)
  ([#404](https://github.com/coalesce-labs/catalyst/issues/404))
  ([e03f455](https://github.com/coalesce-labs/catalyst/commit/e03f455a0293ccd8160f6066a777de6a8163a2f7))
- **dev:** wait-for-github skill — two-phase event wait with diagnostic checkpoint (CTL-247)
  ([7738683](https://github.com/coalesce-labs/catalyst/commit/773868316414494e7565d93174b6e60b3ccce1e0))
- **dev:** wire catalyst-filter into orchestrate Phase 4 (CTL-257)
  ([#424](https://github.com/coalesce-labs/catalyst/issues/424))
  ([43e36ff](https://github.com/coalesce-labs/catalyst/commit/43e36ff4988bf3e3c665c7edee27969f255c69eb))
- **dev:** wire Linear webhook delivery via smee.io end-to-end (CTL-242)
  ([#396](https://github.com/coalesce-labs/catalyst/issues/396))
  ([e58ae5f](https://github.com/coalesce-labs/catalyst/commit/e58ae5f4456760bad64bf88114e327a5f4b19380))
- **dev:** worker-status-change emitter — severity tiers, coalesce, PR enrichment (CTL-229)
  ([#387](https://github.com/coalesce-labs/catalyst/issues/387))
  ([682e817](https://github.com/coalesce-labs/catalyst/commit/682e81788c28391d30e6cda6d2e3279513a3c800))
- **dev:** add monitor.\* to config templates + verify GitHub webhook registration (CTL-254)
  ([#409](https://github.com/coalesce-labs/catalyst/issues/409))
  ([e09d077](https://github.com/coalesce-labs/catalyst/commit/e09d07717aa1028766eb151c7084f3bd88eb4867))
- **dev:** add wait-for-github and catalyst-filter to CLAUDE_SNIPPET.md (CTL-268)
  ([0b1adc4](https://github.com/coalesce-labs/catalyst/commit/0b1adc447db1e8f94f8c011e185e8d635fdf594b))
- **dev:** add worker done comms hook to oneshot Phase 5 (CTL-236)
  ([#388](https://github.com/coalesce-labs/catalyst/issues/388))
  ([a8d4030](https://github.com/coalesce-labs/catalyst/commit/a8d4030023ad572c8462f44ccff680d0e0667c59))
- **dev:** correct webhookTunnel field and add smee-client dependency
  ([#435](https://github.com/coalesce-labs/catalyst/issues/435))
  ([10edb77](https://github.com/coalesce-labs/catalyst/commit/10edb77a623d9f6e782ced7e15c87dc7eb311231))
- **dev:** install-cli.sh adds catalyst-events + defaults to ~/.local/bin (CTL-227)
  ([#357](https://github.com/coalesce-labs/catalyst/issues/357))
  ([5dfa3ac](https://github.com/coalesce-labs/catalyst/commit/5dfa3ac8bcd52ec4a7a5877875b2ee339bf6e37e))
- **dev:** make orchestrate-roll-usage.sh observable (CTL-233)
  ([#380](https://github.com/coalesce-labs/catalyst/issues/380))
  ([b61941d](https://github.com/coalesce-labs/catalyst/commit/b61941dbe809a7b1151bacc20b7a277571c78f1c))
- **dev:** orchestrate-fixup/followup WORKER_DIR fallback (CTL-231)
  ([#377](https://github.com/coalesce-labs/catalyst/issues/377))
  ([9386849](https://github.com/coalesce-labs/catalyst/commit/938684981c89b25cf923d7343a69f4395a8b7d6b))
- **dev:** render DASHBOARD.md every Phase 4 cycle (CTL-230)
  ([#385](https://github.com/coalesce-labs/catalyst/issues/385))
  ([a618055](https://github.com/coalesce-labs/catalyst/commit/a618055fe6e9119d46b7021f53900acfc9729a1e))
- **dev:** replace polling loops in merge-pr and create-pr with wait-for-github (CTL-250)
  ([#402](https://github.com/coalesce-labs/catalyst/issues/402))
  ([96ab764](https://github.com/coalesce-labs/catalyst/commit/96ab7640b3e712db4f8c0a6cd461bc8d6a5779e3))
- **dev:** scope-aware Monitor filter + no-awk-pipe warning (CTL-240)
  ([#390](https://github.com/coalesce-labs/catalyst/issues/390))
  ([7efc119](https://github.com/coalesce-labs/catalyst/commit/7efc119ef2c4cfc6895b38ef48d4e259df1ed18f))
- **dev:** stamp orchestrator on github.\* webhook events (CTL-234)
  ([#391](https://github.com/coalesce-labs/catalyst/issues/391))
  ([56083c9](https://github.com/coalesce-labs/catalyst/commit/56083c92eb91b554e5b4ae01a4572ea8c7178c09))
- **dev:** update fixup/followup templates to CTL-133 exit-at-merging contract (CTL-248)
  ([#401](https://github.com/coalesce-labs/catalyst/issues/401))
  ([2454b19](https://github.com/coalesce-labs/catalyst/commit/2454b19617817f105be3fe997dddc97e5172b753))
- **dev:** upgrade setup prereq checks for event-driven pipeline (CTL-253)
  ([#408](https://github.com/coalesce-labs/catalyst/issues/408))
  ([2d7b8bf](https://github.com/coalesce-labs/catalyst/commit/2d7b8bfe7afb8ddd73ee78734e84dd423122d612))

## [8.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v8.0.0...catalyst-dev-v8.1.0)

May 04, 2026

<!-- ai-enhanced -->

### Webhook Auto-Registration & Verification Fixes

The `setup-webhooks.sh` script now auto-registers Linear webhooks with
`--linear-register --webhook-url <url>`, eliminating the manual GraphQL mutation step that
previously blocked event-driven workflows. Fixed four critical bugs in `orchestrate-verify.sh` that
caused verification failures on merged PRs and produced malformed output with integer comparison
errors. Existing GitHub webhook subscriptions automatically upgrade to include `release` and
`workflow_run` events on daemon restart.

### PRs

- **dev:** Linear webhook auto-registration in setup-webhooks.sh (CTL-224)
  ([#353](https://github.com/coalesce-labs/catalyst/issues/353))
  ([8cf4807](https://github.com/coalesce-labs/catalyst/commit/8cf480738bfc301caed4ee9ddc824fec378ac111))
- **dev:** repair orchestrate-verify.sh — broken on merged PRs + integer-cmp errors (CTL-222)
  ([#352](https://github.com/coalesce-labs/catalyst/issues/352))
  ([e98ffea](https://github.com/coalesce-labs/catalyst/commit/e98ffeaea35f1e78ba4a67026a2c50d68d5a1237))
- **dev:** webhook event mapper — missing release/workflow_run + bogus pr.merged on label changes
  (CTL-226) ([#351](https://github.com/coalesce-labs/catalyst/issues/351))
  ([0668d38](https://github.com/coalesce-labs/catalyst/commit/0668d38bbb748fef6d16554e28d30bc34d0a681b))

## [8.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.14.0...catalyst-dev-v8.0.0)

May 04, 2026

<!-- ai-enhanced -->

### Orchestrator-Driven Deploy Lifecycle

Worker definition-of-done now extends through production deploy success, with orchestrator managing
the merging → merged → deploying → done state machine after workers exit at "merging". Event-driven
GitHub deployment monitoring replaces polling across skills like merge-pr and orchestrate. New
`catalyst-events` CLI provides tail and wait-for primitives over the unified GitHub/Linear/comms
activity log, while Linear webhooks join GitHub webhooks for comprehensive event ingestion.

### PRs

- **dev:** orchestrator-driven deploy lifecycle for workers (CTL-211)
  ([#344](https://github.com/coalesce-labs/catalyst/issues/344))
- **dev:** auto-pull main in primary worktree after PR merge (CTL-198)
  ([#304](https://github.com/coalesce-labs/catalyst/issues/304))
  ([d6ae3ba](https://github.com/coalesce-labs/catalyst/commit/d6ae3baf006d28a0af427fdac8e0eb5512916078))
- **dev:** catalyst-events CLI + Linear webhooks + event-driven skill migration (CTL-210)
  ([#343](https://github.com/coalesce-labs/catalyst/issues/343))
  ([d70f7ee](https://github.com/coalesce-labs/catalyst/commit/d70f7ee87d98bbd7fb0908f8ba88d21c7ff69edf))
- **dev:** config-driven webhook watch list (CTL-216)
  ([#342](https://github.com/coalesce-labs/catalyst/issues/342))
  ([854a85e](https://github.com/coalesce-labs/catalyst/commit/854a85e579e6aafb1624a656ded2da7a41f66083))
- **dev:** orchestrator-driven deploy lifecycle for workers (CTL-211)
  ([#344](https://github.com/coalesce-labs/catalyst/issues/344))
  ([fff5513](https://github.com/coalesce-labs/catalyst/commit/fff5513492ec7b924ff9eb675838984b0445c19a))
- **dev:** canonicalize workerCommand + close orchestrator scope leak (CTL-208)
  ([#325](https://github.com/coalesce-labs/catalyst/issues/325))
  ([8139771](https://github.com/coalesce-labs/catalyst/commit/81397719ca4683ec895fd471b39329ac1f2d6bf6))
- **dev:** move smee channel URL to per-machine Layer 2 config (CTL-217)
  ([#341](https://github.com/coalesce-labs/catalyst/issues/341))
  ([2970e6c](https://github.com/coalesce-labs/catalyst/commit/2970e6c14f4bf02c256eb26f450c970d0528d295))
- **dev:** replace orch-monitor poll-everything with webhook-driven event ingestion (CTL-209)
  ([#330](https://github.com/coalesce-labs/catalyst/issues/330))
  ([39e9d13](https://github.com/coalesce-labs/catalyst/commit/39e9d13a7f5a90f65daf66091d6bb9d7eb16e23f))
- **dev:** unstick Orch Monitor Quality Gates CI workflow (CTL-215)
  ([#335](https://github.com/coalesce-labs/catalyst/issues/335))
  ([2801770](https://github.com/coalesce-labs/catalyst/commit/280177096836fad8dda397d5451b455d5baf79b2))

## [7.14.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.13.0...catalyst-dev-v7.14.0)

May 03, 2026

<!-- ai-enhanced -->

### Linear UUID Caching

New `resolve-linear-ids.sh` script fetches and caches Linear team and workflow state UUIDs to reduce
API rate limiting during issue transitions. The `linear-transition.sh` command now reads cached
UUIDs from `.catalyst/config.json` instead of making repeated API calls, with full backward
compatibility when cache is absent.

### PRs

- **dev:** cache Linear UUIDs to reduce API rate limit pressure (CTL-207)
  ([#323](https://github.com/coalesce-labs/catalyst/issues/323))
  ([ce82a8c](https://github.com/coalesce-labs/catalyst/commit/ce82a8ccc909be5b4605373b53135ebd682f8435))

## [7.13.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.12.2...catalyst-dev-v7.13.0)

Apr 30, 2026

<!-- ai-enhanced -->

### Orchestration Monitor Refresh

Unified Kanban board with view toggles, project filters, and GitHub-style PR status indicators
across home, orchestration, and worker views. Worker detail pages now show hero metrics (elapsed
time, tokens, cost) above the phase timeline, while the orchestration view promotes todos to the top
with an expanded 5-column worker board. Polling loops now include explicit sleep intervals to
prevent GitHub API rate limit exhaustion.

### PRs

- **dev:** refresh orch-monitor mockups — Kanban, PR icons, filters, worker board (CTL-202)
  ([#311](https://github.com/coalesce-labs/catalyst/issues/311))
  ([934404f](https://github.com/coalesce-labs/catalyst/commit/934404f2e9afbe98d95959963f69967fdee2cfb1))
- **dev:** add explicit sleep to polling loops (CTL-203)
  ([#313](https://github.com/coalesce-labs/catalyst/issues/313))
  ([bf90290](https://github.com/coalesce-labs/catalyst/commit/bf90290cc9a6ee7920222dc614aa89deb6a8b3ba))
- **dev:** revert chrome.js to single-system per CTL-178 (CTL-202 follow-up)
  ([#314](https://github.com/coalesce-labs/catalyst/issues/314))
  ([2a4a344](https://github.com/coalesce-labs/catalyst/commit/2a4a344779711ef2bb50cd5da21a4bfb18550cdf))

## [7.12.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.12.1...catalyst-dev-v7.12.2)

Apr 27, 2026

<!-- ai-enhanced -->

### Shell Evaluation CWD Fixes

Fixed Warp terminal integration where `--shell-eval` mode would show incorrect directory paths,
create unwanted shell block splits, and kill the tab's shell on Claude exit. Warp's file explorer
and path indicator now correctly track worktree directories, and Claude sessions return cleanly to
your shell without spawning extra blocks.

### PRs

- **dev:** drop exec from --shell-eval to preserve tab shell (CTL-201)
  ([#307](https://github.com/coalesce-labs/catalyst/issues/307))
  ([3ee4048](https://github.com/coalesce-labs/catalyst/commit/3ee40487ac2473edc90971f67af6288050d6f6cd))
- **dev:** force Warp CWD update before exec in --shell-eval mode (CTL-199)
  ([#302](https://github.com/coalesce-labs/catalyst/issues/302))
  ([d7c9ad8](https://github.com/coalesce-labs/catalyst/commit/d7c9ad8294716459502bd48b6725124aa889eb3b))
- **dev:** replace warp_precmd with OSC 7 to prevent block split (CTL-201)
  ([#308](https://github.com/coalesce-labs/catalyst/issues/308))
  ([1e512b3](https://github.com/coalesce-labs/catalyst/commit/1e512b376fe8dcf34a3356ea16b9626576b74f6f))

## [7.12.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.12.0...catalyst-dev-v7.12.1)

Apr 26, 2026

<!-- ai-enhanced -->

### Warp Tab Directory Tracking

The `launch-worktree-tab.sh` script now supports `--shell-eval` mode to properly set the working
directory in Warp tabs. When you open Catalyst worktree tabs, Warp's path indicator will now show
the actual worktree path instead of defaulting to the main checkout directory.

### PRs

- **dev:** Warp tab shows worktree CWD via --shell-eval mode
  ([#298](https://github.com/coalesce-labs/catalyst/issues/298))
  ([ea30621](https://github.com/coalesce-labs/catalyst/commit/ea30621b65fb744f881ec45ac4affa51a855fe45))

## [7.12.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.11.0...catalyst-dev-v7.12.0)

Apr 25, 2026

<!-- ai-enhanced -->

### Session Outcome & Iteration Tracking

Catalyst now emits session outcome events (`success`, `fail`, `abandoned`) and iteration counters to
your observability stack, enabling cost-per-successful-outcome analysis and complexity measurement.
The `claude_code_iteration_count_total` metric tracks plan-replan and implement-fix cycles
separately, giving you visibility into which tickets require more rework. Run your database
migrations to add the new session tracking columns.

### PRs

- **dev:** emit claude_code.session.outcome at session end (CTL-157)
  ([#278](https://github.com/coalesce-labs/catalyst/issues/278))
  ([6505cb0](https://github.com/coalesce-labs/catalyst/commit/6505cb0a4640db162935f24b86e827b1087f84d9))
- **dev:** iteration_count counter for plan-implement-validate loops (CTL-158)
  ([#280](https://github.com/coalesce-labs/catalyst/issues/280))
  ([18a2b7d](https://github.com/coalesce-labs/catalyst/commit/18a2b7dac7f0e8d225eee6c7b640890be5deb034))

## [7.11.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.10.0...catalyst-dev-v7.11.0)

Apr 25, 2026

<!-- ai-enhanced -->

### Session State Tracking & Restart

Active sessions now show liveness status and crash detection via `catalyst-session.sh status`, with
automated restart commands for crashed Claude sessions that preserves your conversation history.
Orchestrator worktrees get readable names like `orch-deal-to-opportunity-2026-04-25` and write
completion markers for clear done/in-progress distinction. Post-merge verification runs
automatically on merged PRs when `allowSelfReportedCompletion` is disabled, filing remediation
tickets instead of blocking merge.

### PRs

- **dev:** /compound closing ritual writes compound-log entry at PR merge (CTL-159)
  ([#276](https://github.com/coalesce-labs/catalyst/issues/276))
  ([7116395](https://github.com/coalesce-labs/catalyst/commit/71163957a45dd7a9c72f06df0193cda3905f4c23))
- **dev:** auto-file improvement findings at skill run end (CTL-176)
  ([#274](https://github.com/coalesce-labs/catalyst/issues/274))
  ([afc11ea](https://github.com/coalesce-labs/catalyst/commit/afc11ea32be7cf783f3c541e461b1b80112875e7))
- **dev:** integrate todos panel into orch detail (CTL-171)
  ([#279](https://github.com/coalesce-labs/catalyst/issues/279))
  ([62a5c14](https://github.com/coalesce-labs/catalyst/commit/62a5c1445d3686b580c8989ae062a0a77d63aba4))
- **dev:** OSS-safe feedback routing — linear→github fallback + consent (CTL-183)
  ([#272](https://github.com/coalesce-labs/catalyst/issues/272))
  ([77101f5](https://github.com/coalesce-labs/catalyst/commit/77101f572f23dd482fab607e995e588b09189a4b))
- **dev:** post-merge verification for orchestrated workers (CTL-130)
  ([#293](https://github.com/coalesce-labs/catalyst/issues/293))
  ([df04e39](https://github.com/coalesce-labs/catalyst/commit/df04e398cbdb346e1f87a2f1a89c88d228cbdc4c))
- **dev:** session state tracking + crash-resilient restart (CTL-192)
  ([#294](https://github.com/coalesce-labs/catalyst/issues/294))
  ([92c2dd0](https://github.com/coalesce-labs/catalyst/commit/92c2dd076350d29dfea0a8a618f2517457b00a3f))
- **dev:** session-centric Kanban home mockup (CTL-168)
  ([#282](https://github.com/coalesce-labs/catalyst/issues/282))
  ([0c5488f](https://github.com/coalesce-labs/catalyst/commit/0c5488f0981fe1715102c8a23d9315b4df54a783))
- **dev:** tiered attention signals + reason glyphs (CTL-170)
  ([#277](https://github.com/coalesce-labs/catalyst/issues/277))
  ([06d7c60](https://github.com/coalesce-labs/catalyst/commit/06d7c600789fe5546b836e09286dfba853afe3ec))
- **dev:** add thoughts preflight assertions for orchestrated worktrees (CTL-195)
  ([#291](https://github.com/coalesce-labs/catalyst/issues/291))
  ([4444b36](https://github.com/coalesce-labs/catalyst/commit/4444b36cde8db38aaa962741e96e8edd1e3f6e0b))
- **dev:** workers exit at merging, orchestrator is authoritative merge-poller (CTL-133)
  ([#292](https://github.com/coalesce-labs/catalyst/issues/292))
  ([3c99019](https://github.com/coalesce-labs/catalyst/commit/3c990192748e0f73c4cd4cdb95350a632fb7bc75))

## [7.10.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.9.0...catalyst-dev-v7.10.0)

Apr 24, 2026

<!-- ai-enhanced -->

### Canonical Wave Dispatch & Chrome Navigation

The orchestration dispatcher now reads all waveN queues dynamically instead of hardcoded wave
limits, so you can dispatch wave5 or wave10 without manual script edits. Click the Catalyst logo to
return to the mockup gallery, use the new breadcrumb navigation, or press ⌘K for a filterable
command palette with nav shortcuts and appearance controls. Worker usage and costs now aggregate
correctly into state.json during monitoring phases.

### PRs

- **dev:** canonical orchestrate-dispatch-next reading all waveN queues (CTL-116)
  ([#268](https://github.com/coalesce-labs/catalyst/issues/268))
  ([7490be9](https://github.com/coalesce-labs/catalyst/commit/7490be96d7dcd864a27d91af5ee18386fece573c))
- **dev:** mockup chrome — clickable home, breadcrumb, ⌘K palette (CTL-166)
  ([#266](https://github.com/coalesce-labs/catalyst/issues/266))
  ([f503027](https://github.com/coalesce-labs/catalyst/commit/f50302732ef0783e9ecf899218577648a2bdea7b))
- drop precision-instrument + dual theme panels on brand mockup (CTL-178)
  ([#270](https://github.com/coalesce-labs/catalyst/issues/270))
  ([4070e92](https://github.com/coalesce-labs/catalyst/commit/4070e925659b77c8c5ba058a0e761b903f556b80))
- **dev:** aggregate worker usage/cost into orch state.json (CTL-115)
  ([#269](https://github.com/coalesce-labs/catalyst/issues/269))
  ([bcc0189](https://github.com/coalesce-labs/catalyst/commit/bcc0189e4ba7c3b5fa5ef335fa087a88ad3e4f27))

## [7.9.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.8.0...catalyst-dev-v7.9.0)

Apr 23, 2026

<!-- ai-enhanced -->

### Dev UI Mockup Suite

Complete static mockup harness for the orch-monitor redesign with 6 new views (home, worker,
orchestrator, briefing, comms, todos, agent graph), global keybindings, AI summarization endpoint,
and brand V2 assets. Each mockup supports both design systems and includes detailed state variants
for visual review. The harness includes drift detection for local dev marketplace registration and
improved worker communication discipline guidelines.

### PRs

- **dev:** /api/summarize endpoint — configurable provider (CTL-144)
  ([#249](https://github.com/coalesce-labs/catalyst/issues/249))
  ([5029f9e](https://github.com/coalesce-labs/catalyst/commit/5029f9e5a24fc0414589918d6308472e9b167498))
- **dev:** agent-graph.html mockup — React Flow hierarchy (CTL-140)
  ([#259](https://github.com/coalesce-labs/catalyst/issues/259))
  ([73e4947](https://github.com/coalesce-labs/catalyst/commit/73e4947963151f00e9170e05bb8df771e69c4ce6))
- **dev:** briefing.html mockup — rollup + per-wave briefings + AI summarize button (CTL-141)
  ([#256](https://github.com/coalesce-labs/catalyst/issues/256))
  ([2d92853](https://github.com/coalesce-labs/catalyst/commit/2d92853443f80350a343cf97eda354d5a1e6b9ca))
- **dev:** comms.html mockup — channels + agent cards (CTL-139)
  ([#254](https://github.com/coalesce-labs/catalyst/issues/254))
  ([f881cf6](https://github.com/coalesce-labs/catalyst/commit/f881cf64195260617bfb3bf605089e7cec43cafa))
- **dev:** drift detector for registered local dev marketplace (CTL-121)
  ([#255](https://github.com/coalesce-labs/catalyst/issues/255))
  ([6f259ec](https://github.com/coalesce-labs/catalyst/commit/6f259ec36efd6c1b91f7df99a9c3c05d491c0d36))
- **dev:** global keybinding system in mockup chrome.js (CTL-145)
  ([#247](https://github.com/coalesce-labs/catalyst/issues/247))
  ([e24a445](https://github.com/coalesce-labs/catalyst/commit/e24a445e96ef0afcef3a91456322faf642f85f4a))
- **dev:** home.html mockup — orchestrators overview + standalone workers (CTL-136)
  ([#250](https://github.com/coalesce-labs/catalyst/issues/250))
  ([4a77e3b](https://github.com/coalesce-labs/catalyst/commit/4a77e3bdaef6db6a8f108d2e00304f7c6930e5b4))
- **dev:** ingest TodoWrite + build subagent tree in orch-monitor (CTL-143)
  ([#248](https://github.com/coalesce-labs/catalyst/issues/248))
  ([761c5b1](https://github.com/coalesce-labs/catalyst/commit/761c5b167463fc235ea2622c7663d1eea3c8875c))
- **dev:** orch.html mockup — single-orchestrator dashboard (CTL-137)
  ([#253](https://github.com/coalesce-labs/catalyst/issues/253))
  ([ed2f0fe](https://github.com/coalesce-labs/catalyst/commit/ed2f0fe141ee486a1a7077c13cd9fd4ce8a2d001))
- **dev:** todos.html mockup — standalone TodoWrite roll-up across workers (CTL-142)
  ([#260](https://github.com/coalesce-labs/catalyst/issues/260))
  ([c125765](https://github.com/coalesce-labs/catalyst/commit/c12576530a61f963783186872786ad9446be6a0f))
- **dev:** worker comms posting discipline — budgets, escalation, severity (CTL-165)
  ([#265](https://github.com/coalesce-labs/catalyst/issues/265))
  ([160e615](https://github.com/coalesce-labs/catalyst/commit/160e6152051c0ed166e447f8233ceb14a9600f5d))
- **dev:** worker.html mockup — first-class single-worker page (CTL-138)
  ([#244](https://github.com/coalesce-labs/catalyst/issues/244))
  ([439e758](https://github.com/coalesce-labs/catalyst/commit/439e7588a804a0f653339ada574f289843b0c7b2))
- **meta:** 1200×630 OG / social preview card (CTL-152)
  ([#264](https://github.com/coalesce-labs/catalyst/issues/264))
  ([e0312ff](https://github.com/coalesce-labs/catalyst/commit/e0312ff4bb81d676cc6d1497e2bce290c0d31ad3))
- **meta:** drawn wordmark + horizontal/stacked lockups (CTL-148)
  ([#262](https://github.com/coalesce-labs/catalyst/issues/262))
  ([81c6c98](https://github.com/coalesce-labs/catalyst/commit/81c6c98c4640cea3ca6bb21ae765561529711e0b))
- **meta:** monochrome mark variants + README hero image (CTL-154)
  ([#263](https://github.com/coalesce-labs/catalyst/issues/263))
  ([d776fd9](https://github.com/coalesce-labs/catalyst/commit/d776fd98cf43f8db37dcd4a3e459f2a0fbf4a048))
- **meta:** V2 favicon set — multi-res ICO, SVG, apple-touch, PWA icons (CTL-150)
  ([#261](https://github.com/coalesce-labs/catalyst/issues/261))
  ([5dfafaa](https://github.com/coalesce-labs/catalyst/commit/5dfafaa8131dbba45bfc2da7814a9b67957355a4))
- **dev:** refuse worktree marketplace install unless --allow-worktree (CTL-120)
  ([#251](https://github.com/coalesce-labs/catalyst/issues/251))
  ([f264d9b](https://github.com/coalesce-labs/catalyst/commit/f264d9bacf2f0c55955ffd66a69ca59b5df4b243))
- **dev:** resolve catalyst-comms via plugin path (CTL-127)
  ([#252](https://github.com/coalesce-labs/catalyst/issues/252))
  ([1563bec](https://github.com/coalesce-labs/catalyst/commit/1563bec14743d9d396d06149e51172266c606126))

## [7.8.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.7.0...catalyst-dev-v7.8.0)

Apr 22, 2026

<!-- ai-enhanced -->

### Loki-Backed Monitoring Panels

OTel configuration now supports project-scoped files and the monitoring dashboard displays live tool
usage metrics and API error feeds pulled from Loki. The tool usage panel shows your top-8 most
invoked tools over the last hour, while the error feed displays the 5 most recent API failures with
timestamps. Both panels automatically hide when OTel is unconfigured and poll every 30 seconds
alongside your existing health checks.

### PRs

- **dev:** OTel config cleanup + Loki-backed UI panels (CTL-118)
  ([#239](https://github.com/coalesce-labs/catalyst/issues/239))
  ([83647fc](https://github.com/coalesce-labs/catalyst/commit/83647fc1815ecdf61f406bc7684da43d9378370d))
- **dev:** static mockup harness + gallery (CTL-125)
  ([#242](https://github.com/coalesce-labs/catalyst/issues/242))
  ([09b4b3a](https://github.com/coalesce-labs/catalyst/commit/09b4b3a38a9f3c7b7ef485cfe56f829208f88a70))
- **meta:** @catalyst/tokens package with operator-console + precision-instrument systems (CTL-123)
  ([#241](https://github.com/coalesce-labs/catalyst/issues/241))
  ([20a0ec5](https://github.com/coalesce-labs/catalyst/commit/20a0ec53bfd9d2539320838ca21113334cd30299))

## [7.7.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.6.1...catalyst-dev-v7.7.0)

Apr 21, 2026

<!-- ai-enhanced -->

### Orchestrator Intelligence & Communications

Three productivity-focused areas land in the monitor: a restructured dashboard puts "what needs me?"
first without scrolling, a new Comms view surfaces real-time catalyst-comms channels with live
message feeds and cross-links from worker activity, and orchestrator briefings now include an
auto-generated rollup that aggregates what shipped across all waves. Worker cost tooltips explain
when metrics are unavailable, and PR status badges show merge conflicts or blocks at a glance across
tables and cards.

### PRs

- **dev:** briefing Sheet + orchestrator Briefing tab (CTL-105)
  ([#234](https://github.com/coalesce-labs/catalyst/issues/234))
  ([8324f1c](https://github.com/coalesce-labs/catalyst/commit/8324f1c8b86f2d2a2c492859738d09fa1f929e35))
- **dev:** catalyst-comms setup + website docs (CTL-113)
  ([#231](https://github.com/coalesce-labs/catalyst/issues/231))
  ([7ce31a4](https://github.com/coalesce-labs/catalyst/commit/7ce31a43a9db0d35d37b2a7dbb69997d2c204c6d))
- **dev:** Comms view in orch-monitor (CTL-112)
  ([#235](https://github.com/coalesce-labs/catalyst/issues/235))
  ([ed8ba1a](https://github.com/coalesce-labs/catalyst/commit/ed8ba1a9a749dbf70a8b57cb2f28bba7cf41c1a3))
- **dev:** Comms view in orch-monitor (CTL-112)
  ([#236](https://github.com/coalesce-labs/catalyst/issues/236))
  ([81ef0e4](https://github.com/coalesce-labs/catalyst/commit/81ef0e4b2f3061f62fc42583c768b8886bda8bfe))
- **dev:** dashboard IA three-zone layout (CTL-107)
  ([#238](https://github.com/coalesce-labs/catalyst/issues/238))
  ([9ce601f](https://github.com/coalesce-labs/catalyst/commit/9ce601f8743e923f16458901bc606379ae636c95))
- **dev:** orchestrator rollup briefing (CTL-108)
  ([#237](https://github.com/coalesce-labs/catalyst/issues/237))
  ([007c8f3](https://github.com/coalesce-labs/catalyst/commit/007c8f3849ebdcef11d654f8f086db6ebcee1b16))
- **dev:** OTel health banner + worker cost tooltips (CTL-104)
  ([#230](https://github.com/coalesce-labs/catalyst/issues/230))
  ([0f63dbd](https://github.com/coalesce-labs/catalyst/commit/0f63dbd9bb91fba7d9ec75ff0121f9ce3935832c))
- **dev:** persist orchestrator artifacts with hybrid archive (CTL-110)
  ([#232](https://github.com/coalesce-labs/catalyst/issues/232))
  ([003bce3](https://github.com/coalesce-labs/catalyst/commit/003bce33f30d0b04a9ac5b92c2e1b781e76eb09d))
- **dev:** PR status badges across orch-monitor (CTL-109)
  ([#229](https://github.com/coalesce-labs/catalyst/issues/229))
  ([b3510f8](https://github.com/coalesce-labs/catalyst/commit/b3510f8f8c0c50b9be2fa3fc1b86642f1eddf1ce))
- **dev:** rename Process column to Worker, suppress dead PID on done workers (CTL-101)
  ([#226](https://github.com/coalesce-labs/catalyst/issues/226))
  ([6db8a76](https://github.com/coalesce-labs/catalyst/commit/6db8a762ae336efb0a81683046acdf6f4b7ca43a))
- **dev:** scaffold shadcn/ui interaction primitives in orch-monitor (CTL-97)
  ([#223](https://github.com/coalesce-labs/catalyst/issues/223))
  ([fbaba97](https://github.com/coalesce-labs/catalyst/commit/fbaba97fe4f5137c6f6043427e85574996ec5077))
- **dev:** setup-warp color-by-org convention, reserve blue for PM
  ([#219](https://github.com/coalesce-labs/catalyst/issues/219))
  ([4266d33](https://github.com/coalesce-labs/catalyst/commit/4266d33a7af80271e2086aaebf3f22b51d848fc0))
- **dev:** wire catalyst-comms into orchestrate (CTL-111)
  ([#222](https://github.com/coalesce-labs/catalyst/issues/222))
  ([f1e0ecf](https://github.com/coalesce-labs/catalyst/commit/f1e0ecfaa27341be3c016577b65e0246757afd97))
- **dev:** worker + session drawers → shadcn Sheet (CTL-106)
  ([#233](https://github.com/coalesce-labs/catalyst/issues/233))
  ([6355968](https://github.com/coalesce-labs/catalyst/commit/6355968c142a8a03c44bd6f4005f0ae164d876d5))
- **dev:** Active filter now hides done orchestrators (CTL-99)
  ([#224](https://github.com/coalesce-labs/catalyst/issues/224))
  ([39fbe22](https://github.com/coalesce-labs/catalyst/commit/39fbe2217a7c3e7503068d0e678ab6dadc22ff1e))
- **dev:** exclude abandoned workers from orch-monitor progress denominator (CTL-100)
  ([#225](https://github.com/coalesce-labs/catalyst/issues/225))
  ([0437300](https://github.com/coalesce-labs/catalyst/commit/04373001ad5f4ffe013f65b1a3895fe1cfd889d2))
- **dev:** rename "Process died" → "Worker died" in attention feed (CTL-102)
  ([#227](https://github.com/coalesce-labs/catalyst/issues/227))
  ([5ee6c77](https://github.com/coalesce-labs/catalyst/commit/5ee6c77824b128408ab431adde329ecdbcb60e38))
- **dev:** TaskListSection empty/error states + worker-tasks debug endpoint (CTL-103)
  ([#228](https://github.com/coalesce-labs/catalyst/issues/228))
  ([8524299](https://github.com/coalesce-labs/catalyst/commit/8524299074aa09fb079d6f6429c4d0499b91cc51))

## [7.6.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.6.0...catalyst-dev-v7.6.1)

Apr 20, 2026

<!-- ai-enhanced -->

### PM Parallel Orient Delegates

PM kickoff now dispatches three parallel sub-agents for orientation instead of running raw CLI
fetches in the main context. This reduces a typical PM session start from ~15 tool calls with 30KB
of JSON debris down to 3-4 clean tool calls, keeping the main context focused on PM reasoning rather
than data collection.

### PRs

- **dev:** PM kickoff delegates orient to parallel sub-agents (CTL-95)
  ([#217](https://github.com/coalesce-labs/catalyst/issues/217))
  ([5ed8496](https://github.com/coalesce-labs/catalyst/commit/5ed84964dcb2724392b402f15827dbd4c7c5b639))

## [7.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.4...catalyst-dev-v7.6.0)

Apr 20, 2026

<!-- ai-enhanced -->

### Worktree One-Shot Development Pipeline

Create a ticket worktree and launch Claude with the full research-to-ship pipeline pre-queued in one
command. The new Warp tab variant runs `/catalyst-dev:oneshot {{ticket}}` automatically after
worktree creation, enabling walk-away autonomous development workflows. Also adds PM kickoff prompts
and fixes symlink preservation when copying plugin directories into new worktrees.

### PRs

- **dev:** New Worktree One-Shot Warp variant
  ([#215](https://github.com/coalesce-labs/catalyst/issues/215))
  ([0614a96](https://github.com/coalesce-labs/catalyst/commit/0614a9633ddf8f98ea21afe24ad260504c1d3f18))
- **dev:** PM kickoff prompt + worktree symlink fix
  ([#213](https://github.com/coalesce-labs/catalyst/issues/213))
  ([b03fc87](https://github.com/coalesce-labs/catalyst/commit/b03fc87fc9cd7d4da41331cef6bda9e512c026a8))

## [7.5.4](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.3...catalyst-dev-v7.5.4)

Apr 19, 2026

<!-- ai-enhanced -->

### Thoughts Profile Drift Repair

The `catalyst-thoughts.sh init-or-repair` command now automatically detects and fixes profile drift
between your `.catalyst/config.json` and humanlayer's repo mapping. When drift is detected, it runs
`humanlayer thoughts uninit --force` followed by re-init with the correct profile and directory from
your config. Previously, drift would cause silent failures that required manual intervention.

### PRs

- **dev:** init-or-repair auto-fixes thoughts profile drift (CTL-91)
  ([#211](https://github.com/coalesce-labs/catalyst/issues/211))
  ([d79a14d](https://github.com/coalesce-labs/catalyst/commit/d79a14da98773e9eccf7596deb6e6cf88b7df20f))

## [7.5.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.2...catalyst-dev-v7.5.3)

Apr 19, 2026

<!-- ai-enhanced -->

### Thoughts Symlink Protection

`setup-catalyst` no longer silently clobbers thoughts symlinks when repairing directory structure.
The new `catalyst-thoughts.sh` helper detects when a regular directory has replaced an expected
symlink and refuses to auto-fix, instead showing a recovery command to preserve any files written to
the wrong location. Health checks now treat clobbered symlinks as fatal errors when humanlayer is
configured.

### PRs

- **dev:** setup-catalyst no longer clobbers thoughts symlinks (CTL-90)
  ([#209](https://github.com/coalesce-labs/catalyst/issues/209))
  ([fb68453](https://github.com/coalesce-labs/catalyst/commit/fb6845367465c85d1421b09c4263d7abf22ee198))

## [7.5.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.1...catalyst-dev-v7.5.2)

Apr 18, 2026

<!-- ai-enhanced -->

### Warp Color Variant Fix

The `setup-warp` skill now only offers Warp's 8 valid color variants (`black`, `red`, `green`,
`yellow`, `blue`, `magenta`, `cyan`, `white`) instead of invalid options like `purple` and `pink`
that caused Warp to reject generated tab configs on load.

### PRs

- **dev:** restrict setup-warp colors to Warp's 8 valid variants
  ([#207](https://github.com/coalesce-labs/catalyst/issues/207))
  ([05800f3](https://github.com/coalesce-labs/catalyst/commit/05800f3a2fe1854568355d6a77fa526c374858b4))

## [7.5.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.0...catalyst-dev-v7.5.1)

Apr 18, 2026

<!-- ai-enhanced -->

### Warp Helper Script Bundling

The `setup-warp` skill now bundles its helper scripts directly in the plugin instead of referencing
dotfiles that don't exist for other users. Generated Warp tab configurations will point to the
bundled `open-project-tab.sh` and `trust-workspace.sh` scripts, making the plugin work out of the
box for everyone.

### PRs

- **dev:** bundle warp helper scripts in plugin
  ([#205](https://github.com/coalesce-labs/catalyst/issues/205))
  ([687c98b](https://github.com/coalesce-labs/catalyst/commit/687c98bcdfa9d8d5313f18e618b0fb2cf94a60dc))

## [7.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.4.0...catalyst-dev-v7.5.0)

Apr 18, 2026

<!-- ai-enhanced -->

### Auto Orchestration & Warp Integration

Run `catalyst orchestrate --auto N` to automatically pick your top priority tickets from Linear, or
use the new `/catalyst-dev:setup-warp` skill to generate terminal tab configs that launch
orchestration sessions with proper naming and remote control. The `--reuse-existing` flag on
worktree creation means your tab configs can safely reopen long-lived development environments
without conflicts.

### PRs

- **dev:** add --auto orchestration, tab launchers, and setup-warp skill
  ([#203](https://github.com/coalesce-labs/catalyst/issues/203))
  ([326ff20](https://github.com/coalesce-labs/catalyst/commit/326ff209f91e8ea8fbcb1b9c49176d4e50e55840))

## [7.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.3.0...catalyst-dev-v7.4.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Auto-Dispatch Fixup Workers

Blocked PRs with unresolved review threads or failed checks now automatically trigger fixup workers
after a 10-minute stabilization window, capping at 2 attempts before escalating to human attention.
The orchestrator polls BLOCKED states alongside existing DIRTY/BEHIND handling, eliminating the need
for manual intervention on stuck PRs. New signal tracking includes `blockedSince`, `fixupAttempts`,
and `lastFixupDispatchedAt` for dashboard visibility.

### PRs

- **dev:** auto-dispatch fixup workers on BLOCKED PRs (CTL-64)
  ([#199](https://github.com/coalesce-labs/catalyst/issues/199))
  ([77ef1b5](https://github.com/coalesce-labs/catalyst/commit/77ef1b5a80df8bcfb0dc5c07212a25b4554267c8))

## [7.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.2.0...catalyst-dev-v7.3.0)

Apr 16, 2026

<!-- ai-enhanced -->

### API Stream Idle Detection

Workers now recover immediately when hitting Claude API stream idle timeouts, instead of waiting up
to 15 minutes for heartbeat staleness detection. Linear ticket states automatically transition when
PRs are merged, with retroactive reconciliation available via `orchestrate-bulk-close` for tickets
that stayed in "In Review" after successful merges.

### PRs

- **dev:** detect API stream idle timeout in orchestrate-revive (CTL-62)
  ([#196](https://github.com/coalesce-labs/catalyst/issues/196))
  ([b89e342](https://github.com/coalesce-labs/catalyst/commit/b89e342c9103d2324cb47f1478a54005da4e14bb))
- **dev:** drive Linear ticket state transitions on PR merge (CTL-69)
  ([#197](https://github.com/coalesce-labs/catalyst/issues/197))
  ([dc58f32](https://github.com/coalesce-labs/catalyst/commit/dc58f3293c8c76d31951a55af92ffc738bbf6be1))

## [7.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.1.1...catalyst-dev-v7.2.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Authoritative Git and PR State

Workers are no longer marked as "stalled" based solely on signal file age — the orchestrator now
uses git commit history and GitHub PR status as ground truth for completion detection. If a worker
merged its PR but died before writing the terminal signal, it's correctly recognized as complete
rather than stalled. Run the orchestration monitor to see the improved accuracy in worker lifecycle
tracking.

### PRs

- **dev:** derive worker completion from git/PR, not signal file (CTL-32)
  ([#193](https://github.com/coalesce-labs/catalyst/issues/193))
  ([5e4e3bd](https://github.com/coalesce-labs/catalyst/commit/5e4e3bdb5e787b9168a445893e57d71e828d4f2d))

## [7.1.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.1.0...catalyst-dev-v7.1.1)

Apr 16, 2026

<!-- ai-enhanced -->

### Worker Cost Display Fix

Dashboard now shows real-time worker costs (USD, input/output tokens, cache reads) instead of
placeholder dashes. The orchestrator writes parsed usage data to each worker's signal file, matching
the existing global state format that powers the cost overview.

### PRs

- **dev:** write worker cost to signal file in orchestrator (CTL-88)
  ([#190](https://github.com/coalesce-labs/catalyst/issues/190))
  ([dbdb050](https://github.com/coalesce-labs/catalyst/commit/dbdb050de29a62fc6e9604579d2345bc32e13912))

## [7.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.0.0...catalyst-dev-v7.1.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Session Resume Orchestration

When workers die mid-merge or stall with heartbeats, the orchestrator now revives them using
`claude --resume <session_id>` instead of starting fresh — preserving full context while cutting
costs ~10×. The system resolves session IDs from worker output streams and enforces per-ticket
revive budgets, transitioning to stalled status when revival isn't possible.

### PRs

- **dev:** port revive-worker session-resume into orchestrator Phase 4 (CTL-63)
  ([#191](https://github.com/coalesce-labs/catalyst/issues/191))
  ([6b5aaf4](https://github.com/coalesce-labs/catalyst/commit/6b5aaf42b0f18eaf685b9661b0dfe3c354e04367))

## [7.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.39.1...catalyst-dev-v7.0.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Orchestration State Isolation

Orchestrator runtime state now lives in `~/catalyst/runs/<orch-id>/` instead of git worktrees,
keeping your worktree clean during runs. Output files move to `workers/output/` to reduce noise,
while worker signal files stay in their expected locations. The monitor automatically handles both
new runs-based and legacy worktree-based orchestrators.

### PRs

- **dev:** decouple orch state from worktrees — runs/ dir (CTL-59)
  ([#188](https://github.com/coalesce-labs/catalyst/issues/188))
- **dev:** decouple orch state from worktrees — runs/ dir (CTL-59)
  ([#188](https://github.com/coalesce-labs/catalyst/issues/188))
  ([a357eaa](https://github.com/coalesce-labs/catalyst/commit/a357eaad59b3684b72515c69e43e37edbbc34778))

## [6.39.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.39.0...catalyst-dev-v6.39.1)

Apr 16, 2026

<!-- ai-enhanced -->

### Merged PR Status Writeback

The orchestration monitor now writes merged PR status back to worker signal files when it detects
PRs have been merged on GitHub. Previously, merged PRs were only tracked in memory, causing the
dashboard to show incorrect completion percentages when the orchestrator agent had already exited.
Signal files now automatically update with `status=done`, `phase=6`, and merge timestamps for
accurate project tracking.

### PRs

- **dev:** orch-monitor writes back merged PR status to signal files (CTL-86)
  ([#185](https://github.com/coalesce-labs/catalyst/issues/185))
  ([b340de9](https://github.com/coalesce-labs/catalyst/commit/b340de9c725f4bfe400f2796e4932ebba58c8dce))

## [6.39.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.38.0...catalyst-dev-v6.39.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Orchestrator Launch Failure Detection

Workers that die immediately after dispatch (bad flags, environment errors) are now detected within
30 seconds instead of waiting 15 minutes for the stalled-worker detector. The orchestrator runs a
batch health check after each dispatch wave, verifying worker PIDs and automatically flagging
dead-on-arrival processes as failed with attention items.

### PRs

- **dev:** detect worker launch failures within 30s of dispatch (CTL-87)
  ([#184](https://github.com/coalesce-labs/catalyst/issues/184))
  ([c74613b](https://github.com/coalesce-labs/catalyst/commit/c74613b11217def5fe06ac66b3808d7018ed1d96))

## [6.38.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.37.2...catalyst-dev-v6.38.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Agent Communication Channels

The new `catalyst-comms` CLI gives Claude Code agents file-based communication across worktrees,
sub-agents, and orchestrators without requiring servers or HTTP dependencies. Agents can join
channels, send messages, poll for updates, and coordinate completion through simple bash commands
that work with any agent workflow. Channel activity is logged locally at `~/catalyst/comms/` with
automatic cleanup and human audit capabilities via `catalyst-comms watch` and `status`.

### PRs

- **dev:** catalyst-comms — file-based agent communication channels (CTL-60)
  ([#182](https://github.com/coalesce-labs/catalyst/issues/182))
  ([51a73de](https://github.com/coalesce-labs/catalyst/commit/51a73de70c2ce5952bd02ed40a1fe9cb344ecb51))
- **dev:** worker polls until PR merges instead of exiting at pr-created
  ([#180](https://github.com/coalesce-labs/catalyst/issues/180))
  ([351cc95](https://github.com/coalesce-labs/catalyst/commit/351cc958baec9ed9d63739b33c53236f5a3ba302))

## [6.37.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.37.1...catalyst-dev-v6.37.2)

Apr 16, 2026

<!-- ai-enhanced -->

### Claude Worker Dispatch Fixes

Fixed broken worker dispatch where the `-w` flag was incorrectly used with paths instead of names,
causing "Invalid worktree name" errors. Workers now launch in a backgrounded subshell with proper
directory switching, include `--dangerously-skip-permissions` to prevent TTY blocking, and capture
stderr to debuggable log files instead of `/dev/null`.

### PRs

- **dev:** claude-only worker dispatch with cd subshell (CTL-58, CTL-35)
  ([#179](https://github.com/coalesce-labs/catalyst/issues/179))
  ([1bf3f62](https://github.com/coalesce-labs/catalyst/commit/1bf3f62e0b2ff3fe8a641dd03fb17f34c0a2da4e))

## [6.37.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.37.0...catalyst-dev-v6.37.1)

Apr 16, 2026

<!-- ai-enhanced -->

### CI Release Notes Enhancement

The release pipeline now generates AI-enhanced changelogs automatically, matching the backfill
format with structured titles and developer-focused summaries. Fixed a broken pipe issue in the
enhancement script that was preventing changelog updates from completing under strict error
handling.

### PRs

- **dev:** fix CI release notes to match backfill format
  ([#177](https://github.com/coalesce-labs/catalyst/issues/177))
  ([a64b71a](https://github.com/coalesce-labs/catalyst/commit/a64b71a359cecbea30dd76ad784e02f75236cb71))

## [6.37.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.36.0...catalyst-dev-v6.37.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Changelog Backfill and CI API Key Fix

Backfills AI-enhanced summaries for the four most recent releases (6.34.1 through 6.36.0) that
shipped after the original backfill PR. Updates both release-note scripts to use
`LOCAL_ANTHROPIC_API_KEY` instead of `ANTHROPIC_API_KEY` to avoid conflicts with Claude Code's own
key when running locally, with automatic fallback for CI.

### PRs

- **dev:** backfill AI-enhanced notes and use LOCAL_ANTHROPIC_API_KEY
  ([#175](https://github.com/coalesce-labs/catalyst/issues/175))
  ([6d60cc7](https://github.com/coalesce-labs/catalyst/commit/6d60cc74999fa1f5d17a3b28686fa0df4ec63683))

## [6.36.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.35.0...catalyst-dev-v6.36.0)

Apr 16, 2026

<!-- ai-enhanced -->

### AI-Enhanced Changelogs and Homepage Badge

All 51 catalyst-dev changelog entries now have Sonnet-generated titles and 2-4 sentence summaries.
The website homepage gains a version badge that reads the latest release from CHANGELOG.md at build
time. Changelog page styling follows a Conductor-inspired layout with small muted version numbers,
bold release titles, and comfortable reading line-height. CI release note generation upgraded from
Haiku to Sonnet, and a new `add-changelog-media` skill supports R2/CDN hosting for screenshots and
GIF screencasts.

### PRs

- **dev:** AI-enhanced changelogs with titles, homepage badge, and Conductor-style styling
  ([#170](https://github.com/coalesce-labs/catalyst/issues/170))
  ([ebdaf99](https://github.com/coalesce-labs/catalyst/commit/ebdaf99061b9c4f4801abe77290e9c41712f096d))

## [6.35.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.34.2...catalyst-dev-v6.35.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Activity Feed and Task List Integration

The orchestration monitor activity feed now shows tool names, text previews, and rate limit info
instead of generic "new turn" labels. A new task list integration reads from
`~/.claude/tasks/{sessionId}/` to display per-worker task progress with badges in the worker table
and a collapsible task section in the detail drawer.

### PRs

- **dev:** fix activity feed labels and add task list integration
  ([#165](https://github.com/coalesce-labs/catalyst/issues/165))
  ([96e098e](https://github.com/coalesce-labs/catalyst/commit/96e098e3138045868ebdb5e45da2e1ff509ddfba))

## [6.34.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.34.1...catalyst-dev-v6.34.2)

Apr 16, 2026

<!-- ai-enhanced -->

### Watcher Subshell Detach

Adds `disown` after the background watcher subshell in `catalyst-claude.sh` to fully detach it from
bash's job table before `exec` replaces the process. This is a defensive fix that prevents any edge
case where bash might send SIGHUP to the watcher on exit.

### PRs

- **dev:** disown watcher subshell before exec
  ([#171](https://github.com/coalesce-labs/catalyst/issues/171))
  ([5a902b3](https://github.com/coalesce-labs/catalyst/commit/5a902b35d4aefe74d1d237cff00119e41683fc2b))

## [6.34.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.34.0...catalyst-dev-v6.34.1)

Apr 16, 2026

<!-- ai-enhanced -->

### Warp Terminal Integration

Replaces child-process `claude "$@"` with `exec claude "$@"` in the session wrapper so the process
image becomes `claude` directly, restoring Warp's rich sidebar metadata (repo, branch, change count)
and notification integration. Heartbeat and cleanup logic moves to a background watcher that polls
the wrapper PID.

### PRs

- **dev:** exec claude in wrapper for Warp terminal integration
  ([#168](https://github.com/coalesce-labs/catalyst/issues/168))
  ([59e7509](https://github.com/coalesce-labs/catalyst/commit/59e750958cd963aa42972f83a7aba1efcaf0de82))

## [6.34.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.33.0...catalyst-dev-v6.34.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Session Time Filter Controls

Filter your Claude sessions in the sidebar by time range with a 5-option toggle
(Active/1h/24h/48h/All) that replaces the previous hardcoded 1-hour cutoff. The filter setting
persists across page reloads and works in both flat and grouped sidebar modes. Your previous "Active
sessions only" behavior is preserved as the default filter option.

### PRs

- **dev:** add session time filter controls in sidebar
  ([#164](https://github.com/coalesce-labs/catalyst/issues/164))
  ([781ca18](https://github.com/coalesce-labs/catalyst/commit/781ca184f2f24f05c3b0fb1fdf7c4a7c6e011b72))

## [6.33.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.32.0...catalyst-dev-v6.33.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Linear Ticket Grouping

The orchestration monitor sidebar now groups sessions and orchestrators by Linear ticket ID when you
select "ticket" grouping mode. Sessions group by their ticket field, while orchestrators appear in
groups for each worker ticket they manage. Items without tickets collect in an "Unlinked" group at
the bottom.

### PRs

- **dev:** add sidebar grouping by Linear ticket
  ([#162](https://github.com/coalesce-labs/catalyst/issues/162))
  ([d69aa05](https://github.com/coalesce-labs/catalyst/commit/d69aa05398fdae0a85d99530fea0b88fd8a16fa9))

## [6.32.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.31.0...catalyst-dev-v6.32.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Dead Code Detection

Knip now runs automatically on every PR to catch unused exports, dead code, and unnecessary
dependencies before they reach main. The CI quality gates will fail if any dead code is detected,
keeping the codebase clean without manual oversight.

### PRs

- **dev:** add knip dead code checking to CI quality gates
  ([#158](https://github.com/coalesce-labs/catalyst/issues/158))
  ([f58d441](https://github.com/coalesce-labs/catalyst/commit/f58d4414e12b84f6096edf23becd6f8780c0a6e9))

## [6.31.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.30.0...catalyst-dev-v6.31.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Sidebar Repo Grouping

Switch between flat list and grouped tree views with the new Flat/Repo toggle in the sidebar header.
In Repo mode, orchestrators group by workspace and sessions by working directory, with collapsible
headers showing item counts. Your grouping preference persists across sessions automatically.

### PRs

- **dev:** add sidebar grouping by repo/cwd
  ([#157](https://github.com/coalesce-labs/catalyst/issues/157))
  ([0101310](https://github.com/coalesce-labs/catalyst/commit/010131057e2c2419dec3a1ae5c337ba7d809a637))

## [6.30.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.29.0...catalyst-dev-v6.30.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Session Detail Drawer

Click any session in the sidebar or dashboard to open a detailed inspector with status, elapsed
time, cost metrics, and PR information. The drawer follows the same pattern as worker inspection,
with mutual exclusion between session and orchestrator views. Sessions now show visual selection
states with accent highlighting in the sidebar and borders on dashboard cards.

### PRs

- **dev:** add session detail drawer ([#156](https://github.com/coalesce-labs/catalyst/issues/156))
  ([8671562](https://github.com/coalesce-labs/catalyst/commit/867156239ec32907bcf61799948dac1cb6e27cb3))

## [6.29.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.28.0...catalyst-dev-v6.29.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Worker Detail Drawer & Session Tracking

Click any worker row in the orchestration monitor to open a live detail panel with metrics, phase
timeline, and activity feed. Standalone Claude sessions are now tracked automatically via
`catalyst-claude.sh`, appearing in the sidebar with real-time status indicators. Run
`catalyst-db.sh migrate` after updating to add the new session columns.

### PRs

- **dev:** add worker detail drawer, session tracking, and sidebar sessions
  ([#153](https://github.com/coalesce-labs/catalyst/issues/153))
  ([f38e0dc](https://github.com/coalesce-labs/catalyst/commit/f38e0dc37a4ad6b95a943304302d8e51b2381700))

## [6.28.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.27.1...catalyst-dev-v6.28.0)

Apr 15, 2026

<!-- ai-enhanced -->

### DeepWiki Codebase Integration

The research-codebase workflow now starts by querying DeepWiki for a compressed map of your
repository, making all subsequent AI research targeted instead of exploratory. All core Catalyst
skills can now ask DeepWiki specific questions during execution, and oneshot workflow eliminates 16
lines of duplicate research logic by referencing the unified research process.

### PRs

- **dev:** add DeepWiki orientation to codebase research workflow
  ([#151](https://github.com/coalesce-labs/catalyst/issues/151))
  ([7e705de](https://github.com/coalesce-labs/catalyst/commit/7e705def583eca5640a91e071a38abac1389a375))

## [6.27.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.27.0...catalyst-dev-v6.27.1)

Apr 15, 2026

<!-- ai-enhanced -->

### Monitor Command Consolidation

The `start-monitor.sh` script has been merged into `catalyst-monitor.sh` as a single entry point for
all monitoring operations. Use `catalyst-monitor.sh start` instead of the separate bootstrap script
— it now handles dependency checks, installation, and frontend building automatically before
starting the monitor.

### PRs

- **dev:** consolidate start-monitor.sh into catalyst-monitor.sh
  ([#149](https://github.com/coalesce-labs/catalyst/issues/149))
  ([bf50058](https://github.com/coalesce-labs/catalyst/commit/bf50058ac21b0bcc9ac505f04ec085b1833450be))

## [6.27.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.26.1...catalyst-dev-v6.27.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Setup Health Check System

Run `/catalyst-dev:setup-catalyst` to diagnose your entire Catalyst installation with 47 automated
checks covering database, monitoring, secrets, and project configuration. The skill auto-fixes safe
issues like missing directories and database initialization, then re-verifies everything in one
command. The orchestration monitor now shows version info in the header and includes a smarter
launcher that validates prerequisites and handles dependency installation automatically.

### PRs

- **dev:** add setup-catalyst health check, monitor launcher, and version display
  ([#147](https://github.com/coalesce-labs/catalyst/issues/147))
  ([31c8cba](https://github.com/coalesce-labs/catalyst/commit/31c8cba7d413228afffb0c1953aad44926c873df))

## [6.26.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.26.0...catalyst-dev-v6.26.1)

Apr 15, 2026

<!-- ai-enhanced -->

### Setup & Configuration Hardening

Catalyst setup now checks for macOS platform and SQLite prerequisites before installation,
automatically initializes the session database during orchestrator setup, and fixes OpenTelemetry
monitor configuration to read from the correct config path. Run the setup scripts again to ensure
your environment has all required dependencies.

### PRs

- **dev:** harden prerequisites, wire up SQLite init, fix OTel config
  ([#143](https://github.com/coalesce-labs/catalyst/issues/143))
  ([14f7c84](https://github.com/coalesce-labs/catalyst/commit/14f7c849d619b7bfb5f62f411c1e050d226f2103))

## [6.26.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.25.0...catalyst-dev-v6.26.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Standalone Orchestrator Setup

The new `setup-orchestrator.sh` script lets you bootstrap orchestrator worktrees from Warp tabs,
cron jobs, or any external automation without needing a Claude Code session. It supports ticket
pass-through, quiet mode for scripting, and one-shot launch flags while maintaining full
compatibility with the existing `/catalyst-dev:setup-orchestrate` skill. Also fixes the
orchestration monitor dashboard which was showing zero orchestrators due to incorrect SSE event
parsing.

### PRs

- **dev:** standalone setup-orchestrator.sh for external automation
  ([#141](https://github.com/coalesce-labs/catalyst/issues/141))
  ([c1158b4](https://github.com/coalesce-labs/catalyst/commit/c1158b46bd4c62995346e224afa3ede928fad6c0))

### PRs

- **dev:** unwrap SSE event envelope in orch-monitor React UI
  ([#137](https://github.com/coalesce-labs/catalyst/issues/137))
  ([8e2e433](https://github.com/coalesce-labs/catalyst/commit/8e2e43335a354b31c095edbb504cb84357d2efc7))

## [6.25.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.24.0...catalyst-dev-v6.25.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Modern React Orchestration Monitor

The orchestration monitor is now a React SPA with shimmer loading, worker search/filtering, animated
KPIs, and a collapsible sidebar. Code-split lazy loading reduces initial bundle size while 15+
componentized views replace the previous 4000-line vanilla JavaScript implementation. All existing
orchestrator functionality (Overview, Workers, Timeline, Events tabs) works identically with
improved performance and modern SaaS-style UX.

### PRs

- **dev:** migrate orch-monitor to React SPA with modern SaaS UI
  ([#135](https://github.com/coalesce-labs/catalyst/issues/135))
  ([0790005](https://github.com/coalesce-labs/catalyst/commit/0790005962f46e98263fe983d346107aec2b5a7f))

## [6.24.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.23.0...catalyst-dev-v6.24.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Workspace Repository Grouping

The orchestration monitor now organizes sessions by workspace and repository, automatically
extracting workspace names from your project directory structure. Toggle between the new grouped
workspace view and the familiar flat "All" view using the header controls. Each workspace card shows
aggregate stats including total sessions, active count, costs, and last activity across all
repositories in that workspace.

### PRs

- **dev:** add workspace/repo grouping to orch-monitor dashboard
  ([#132](https://github.com/coalesce-labs/catalyst/issues/132))
  ([3c88247](https://github.com/coalesce-labs/catalyst/commit/3c882476cb3530537506ec4bf8f6fcf205287597))

## [6.23.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.22.0...catalyst-dev-v6.23.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Polished Orchestration Monitor UI

Added keyboard navigation (j/k, Enter, Esc), command palette (/ or Cmd+K), sidebar with orchestrator
list, and right-click context menus on worker rows. The interface now uses compact table styling
with smooth transitions and higher information density, inspired by Linear's design patterns.

### PRs

- **dev:** Linear-inspired SaaS UI polish for orch-monitor
  ([#131](https://github.com/coalesce-labs/catalyst/issues/131))
  ([0760882](https://github.com/coalesce-labs/catalyst/commit/07608823b79020d06ba97bae3fb6c578046a289e))

## [6.22.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.21.0...catalyst-dev-v6.22.0)

Apr 14, 2026

<!-- ai-enhanced -->

### OTel Metrics Dashboard

The orchestration monitor now includes a Metrics tab with real-time charts showing cost breakdowns,
token usage, cache hit rates, and tool activity from your OpenTelemetry data. Toggle between
Dashboard and Metrics views to track both workflow execution and performance analytics in one
interface. Charts automatically refresh across configurable time ranges, with graceful fallback when
OTel isn't configured.

### PRs

- **dev:** add OTel-powered metrics panels to monitor UI
  ([#126](https://github.com/coalesce-labs/catalyst/issues/126))
  ([014ede1](https://github.com/coalesce-labs/catalyst/commit/014ede1e5d697b37ed9d6f557739f6167c8d9e11))

## [6.21.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.20.0...catalyst-dev-v6.21.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Preview Deployment Links

The orchestration monitor now detects and displays preview deployment URLs from your pull requests.
Clickable badges show live deployment status with color coding (green for live, yellow for
deploying, red for failed) directly in the web UI, with preview URLs also appearing in terminal
output. Works automatically with Cloudflare Pages, Vercel, Netlify, and Railway by scanning PR
comments and the GitHub Deployments API.

### PRs

- **dev:** add preview deployment links to orch-monitor
  ([#125](https://github.com/coalesce-labs/catalyst/issues/125))
  ([2400616](https://github.com/coalesce-labs/catalyst/commit/2400616a424baa6987c639a6397dd061152b5d86))

## [6.20.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.19.0...catalyst-dev-v6.20.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Terminal UI Monitor

Run `catalyst monitor --terminal` to get a real-time terminal dashboard alongside the web interface,
or use `--terminal-only` for quick status checks without starting the HTTP server. The terminal view
includes aggregate cost tracking with color-coded alerts and compact mode for narrow terminals. All
keyboard shortcuts (q/r/0-9/arrows) work as expected for navigation and control.

### PRs

- **dev:** terminal UI monitor frontend
  ([#124](https://github.com/coalesce-labs/catalyst/issues/124))
  ([cd7240a](https://github.com/coalesce-labs/catalyst/commit/cd7240a2ce6a69e10220527598d5a0fe4d4e90b3))

## [6.19.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.18.0...catalyst-dev-v6.19.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session & Orchestrator Annotations

Add display names, flags, notes, and tags to any session or orchestrator through click-to-edit UI
controls, star/flag toggles, and an expandable notes drawer. Use the new `catalyst-session annotate`
CLI command to script annotations, or call the REST API endpoints directly for programmatic access.

### PRs

- **dev:** add session & orchestrator annotations
  ([#112](https://github.com/coalesce-labs/catalyst/issues/112))
  ([adf331c](https://github.com/coalesce-labs/catalyst/commit/adf331c6be3e2ee1046cf79ffae1b90b7de1d1a1))

## [6.18.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.17.0...catalyst-dev-v6.18.0)

Apr 14, 2026

<!-- ai-enhanced -->

### OTel Query Integration

Query Prometheus metrics and Loki logs directly from the orchestration monitor with built-in cost
tracking, token usage, and tool analytics. The integration pulls data from your always-on OTel
Docker stack through cached HTTP clients, adding enriched session views without impacting
performance when OTel is disabled. Configure endpoints in `~/.catalyst/config.json` or use
`PROMETHEUS_URL` and `LOKI_URL` environment variables.

### PRs

- **dev:** add OTel query integration (Prometheus + Loki)
  ([#106](https://github.com/coalesce-labs/catalyst/issues/106))
  ([111156d](https://github.com/coalesce-labs/catalyst/commit/111156dabf3f86197fa2e8f99ec69c2d9ea6ca57))

## [6.17.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.16.0...catalyst-dev-v6.17.0)

Apr 14, 2026

<!-- ai-enhanced -->

### AI-Powered Status Briefing

The orchestration monitor now includes an optional AI briefing panel that generates natural-language
status summaries and suggests session labels using Claude or OpenAI models. Click the briefing
panel's generate button to get contextual insights about your current development sessions, with
auto-refresh available for ongoing projects. The feature routes through Cloudflare AI Gateway and
includes XSS protection for safe rendering of generated content.

### PRs

- **dev:** add AI-powered status briefing to orch-monitor
  ([#107](https://github.com/coalesce-labs/catalyst/issues/107))
  ([67ed25c](https://github.com/coalesce-labs/catalyst/commit/67ed25c73220c08741a5a666e8c77e39185296b5))

## [6.16.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.15.1...catalyst-dev-v6.16.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session Detail View

Click any worker row in the orch-monitor to open a dedicated session page with phase timeline, live
cost tracking, tool usage bars, and event history. The detail view updates automatically when new
snapshots arrive, giving you real-time visibility into individual Claude sessions without leaving
the dashboard.

### PRs

- **dev:** add single-session detail view to orch-monitor
  ([#110](https://github.com/coalesce-labs/catalyst/issues/110))
  ([562898b](https://github.com/coalesce-labs/catalyst/commit/562898b8e7342ba0a3fe07af31b32165b54b9e9d))

## [6.15.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.15.0...catalyst-dev-v6.15.1)

Apr 14, 2026

<!-- ai-enhanced -->

### Ghost Worker Filter & Cost Tracking

The orchestration monitor now filters out ghost worker rows caused by output files and correctly
discovers all orchestrator directories regardless of naming. The cost card shows total token counts
with input/output/cache breakdown and per-model cost aggregation for better resource tracking.

### PRs

- **dev:** filter ghost worker rows + fix orch-monitor cost tracking
  ([#114](https://github.com/coalesce-labs/catalyst/issues/114))
  ([9eb336c](https://github.com/coalesce-labs/catalyst/commit/9eb336c1ae73eff463b259d93a09907965508764))

## [6.15.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.14.0...catalyst-dev-v6.15.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Historical Analytics & Session Querying

Navigate to `/history` in the monitor dashboard to explore session analytics with cost trends, skill
performance metrics, and a searchable session table with filtering and pagination. The new CLI
commands `catalyst-session.sh history`, `stats`, and `compare` let you query and analyze session
data directly from the terminal. Full API support available at `/api/history/*` endpoints for custom
integrations.

### PRs

- **dev:** historical analytics & session querying (CTL-44)
  ([#113](https://github.com/coalesce-labs/catalyst/issues/113))
  ([edaaf4b](https://github.com/coalesce-labs/catalyst/commit/edaaf4b761c78886672c917add3316116f3d30f4))

## [6.14.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.13.0...catalyst-dev-v6.14.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Zero-Config Monitor Management

Run `catalyst-monitor start` to launch the orchestration monitor in the background, then use `stop`,
`status`, `open`, or `url` commands to manage it without manual server juggling. The monitor now
writes a PID file for clean lifecycle management and automatic stale process cleanup.

### PRs

- **dev:** add catalyst-monitor CLI for zero-config monitoring
  ([#109](https://github.com/coalesce-labs/catalyst/issues/109))
  ([9db0fa5](https://github.com/coalesce-labs/catalyst/commit/9db0fa58ac6f073fc4a065d090013fdf4ed4d7c4))

## [6.13.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.12.0...catalyst-dev-v6.13.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session Labeling System

Add meaningful display names to Claude sessions using the optional `label` field in worker signals,
automatically derived from `<skill> <ticket>` patterns or set with the `--label` flag. Labels appear
in both terminal and web monitor dashboards, making it easier to identify and track specific
development sessions at a glance.

### PRs

- **dev:** add session labeling system to orch-monitor
  ([#105](https://github.com/coalesce-labs/catalyst/issues/105))
  ([bf6c3f6](https://github.com/coalesce-labs/catalyst/commit/bf6c3f691b5971403fbe81ce62f3e82fbbcf3c22))

## [6.12.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.11.0...catalyst-dev-v6.12.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Multi-Frontend SSE Event Architecture

Catalyst now sends all orchestration events through a standardized envelope format with filtering
support. Connect multiple frontends or tools to the same session using SSE query params like
`?filter=session-update,metrics-update` or `?session=abc123` to get only the events you need. The
new typed event system supports session updates, metrics changes, and annotation events with
automatic envelope wrapping for consistent downstream processing.

### PRs

- **dev:** SSE event architecture for multiple frontends
  ([#111](https://github.com/coalesce-labs/catalyst/issues/111))
  ([6433182](https://github.com/coalesce-labs/catalyst/commit/64331824c5a8ee4029becfe1fafdd0a19181a201))

## [6.11.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.10.0...catalyst-dev-v6.11.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session-Aware Skills

All six Catalyst skills now automatically track their execution as observable sessions with
lifecycle events and phase transitions. Each skill run creates a session entry that links parent
workflows to child operations, giving you full visibility into your AI-assisted development
workflows. The skills gracefully degrade when session tracking isn't available, so existing
workflows continue working unchanged.

### PRs

- **dev:** instrument 6 skills with catalyst-session tracking
  ([#104](https://github.com/coalesce-labs/catalyst/issues/104))
  ([5f537a6](https://github.com/coalesce-labs/catalyst/commit/5f537a6a0bb93abbee63a8fe19613d79e5303021))

## [6.10.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.9.0...catalyst-dev-v6.10.0)

Apr 14, 2026

<!-- ai-enhanced -->

### SQLite Session Integration

Solo Claude Code sessions now appear directly in the orchestration monitor alongside workflow
workers, giving you one unified view of all AI development activity. The session store reader
integrates with existing filesystem monitoring, so you can track and filter both orchestrated and
standalone sessions through the same `/api/sessions` endpoint and live SSE streams.

### PRs

- **dev:** SQLite reader and unified data source for orch-monitor (CTL-40)
  ([#101](https://github.com/coalesce-labs/catalyst/issues/101))
  ([6bd8238](https://github.com/coalesce-labs/catalyst/commit/6bd8238f5ba3a7333170a9b9412ce01abbda365e))

## [6.9.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.8.0...catalyst-dev-v6.9.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session Lifecycle CLI

The new `catalyst-session` command gives any skill a universal interface to report lifecycle events,
metrics, and tool usage to the SQLite session store. Replace direct JSON file writes with structured
calls like `catalyst-session start --skill myskill`, `catalyst-session phase $id running`, and
`catalyst-session metric $id --cost 0.05` to get automatic tracking in the orchestration monitor and
session APIs.

### PRs

- **dev:** catalyst-session lifecycle CLI (CTL-37)
  ([#100](https://github.com/coalesce-labs/catalyst/issues/100))
  ([9b7fae2](https://github.com/coalesce-labs/catalyst/commit/9b7fae2b16535c66c97b8a76ba68fb57a9b9d32f))

## [6.8.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.7.0...catalyst-dev-v6.8.0)

Apr 14, 2026

<!-- ai-enhanced -->

### SQLite Session Store

Catalyst now persists all agent activity—both solo and orchestrated sessions—to a durable SQLite
database instead of fragile per-worker JSON files. The new `catalyst-db.sh` CLI provides session
CRUD, event logging, metrics tracking, and PR management with concurrent read/write support. Run
`catalyst-db.sh init` to create the database schema and start building persistent workflow history.

### PRs

- **dev:** SQLite session store for agent activity (CTL-36)
  ([#97](https://github.com/coalesce-labs/catalyst/issues/97))
  ([74bb43d](https://github.com/coalesce-labs/catalyst/commit/74bb43d5a5e4e0be27bab79b2cdfadd4e2e5299b))

## [6.7.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.6.0...catalyst-dev-v6.7.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Pre-assigned Migration Numbers

The orchestrator now reserves sequential Supabase migration numbers for database tickets during wave
briefing, preventing filename collisions when multiple workers generate migrations in parallel.
Migration-likely tickets are detected via labels (`database`, `migration`, `schema`) and keywords,
then assigned unique `NNN_` prefixes that appear in the briefing's new Migration Number Assignments
section.

### PRs

- **dev:** pre-assign Supabase migration numbers per wave (CTL-29)
  ([#95](https://github.com/coalesce-labs/catalyst/issues/95))
  ([84a6f84](https://github.com/coalesce-labs/catalyst/commit/84a6f8471abd49879b0ffb56f4eeda897e96864f))

## [6.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.4...catalyst-dev-v6.6.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Fix-up and Follow-up Recovery Patterns

Two new orchestration patterns handle post-merge issues: fix-up workers push targeted commits to
open PRs when reviewers find blockers, while follow-up workers create new Linear tickets and fresh
worktrees for issues discovered after merge. Use `orchestrate-fixup` and `orchestrate-followup`
scripts to dispatch the appropriate recovery pattern based on your PR state.

### PRs

- **dev:** orchestrate fix-up worker + follow-up ticket recovery patterns (CTL-30)
  ([#93](https://github.com/coalesce-labs/catalyst/issues/93))
  ([bfa9861](https://github.com/coalesce-labs/catalyst/commit/bfa9861b126d2163cae2d643b659237506ba40f7))

## [6.5.4](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.3...catalyst-dev-v6.5.4)

Apr 14, 2026

<!-- ai-enhanced -->

### Orchestrator-Controlled Merge Polling

Workers now exit cleanly after opening PRs with auto-merge armed, while the orchestrator handles the
long poll until actual merge completion. This fixes premature worker termination issues where
subprocess workers would exit before PRs were fully merged, with the orchestrator taking over merge
monitoring duties and updating worker status when PRs complete.

### PRs

- **dev:** orchestrator-owned poll-until-MERGED (CTL-31)
  ([#91](https://github.com/coalesce-labs/catalyst/issues/91))
  ([2da8f69](https://github.com/coalesce-labs/catalyst/commit/2da8f697dafcf9c878bf3fd1760d90ca34ff44c1))

## [6.5.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.2...catalyst-dev-v6.5.3)

Apr 14, 2026

<!-- ai-enhanced -->

### Worker Worktree Context Fix

Fixed ticket extraction in worker worktrees so branches like `orch-data-import-2026-04-13-ADV-220`
correctly identify `ADV-220` as the current ticket instead of false matches from orchestrator
prefixes. Worker worktrees now include an `orchestration` field in their workflow context, enabling
proper telemetry grouping across orchestrator and worker sessions.

### PRs

- **dev:** worker worktrees get correct currentTicket + orchestration field
  ([#89](https://github.com/coalesce-labs/catalyst/issues/89))
  ([4768eac](https://github.com/coalesce-labs/catalyst/commit/4768eac0b4cb87bf074088ca232b29cf72486836))

## [6.5.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.1...catalyst-dev-v6.5.2)

Apr 13, 2026

<!-- ai-enhanced -->

### PR Polling Through Merge

Orchestrated workers now actively poll PR state, CI status, and review comments until merge
completion instead of exiting after creating the PR. The verification script independently confirms
PRs reached MERGED state, catching any workers that ignore polling instructions. Workers wait a
minimum 3 minutes then poll every 30 seconds with concrete step-by-step instructions.

### PRs

- **dev:** add poll-until-merged loop and PR state verification
  ([#86](https://github.com/coalesce-labs/catalyst/issues/86))
  ([666b835](https://github.com/coalesce-labs/catalyst/commit/666b8356ede7c4e1322a0f27bdb9f39c2921caea))

## [6.5.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.0...catalyst-dev-v6.5.1)

Apr 13, 2026

<!-- ai-enhanced -->

### Linearis Command Consolidation

Removed duplicated Linear CLI commands from 8 files, making the linearis skill the single source of
truth for all command syntax and options. Fixed a setup validation false positive that incorrectly
flagged properly configured thoughts directories. Agents now reference `/catalyst-dev:linearis`
instead of maintaining their own stale command examples.

### PRs

- **dev:** DRY linearis CLI commands, fix setup false positive
  ([#84](https://github.com/coalesce-labs/catalyst/issues/84))
  ([68115ac](https://github.com/coalesce-labs/catalyst/commit/68115acd8168e14683a4a079b0cc42b7f2a763b7))

## [6.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.2...catalyst-dev-v6.5.0)

Apr 13, 2026

<!-- ai-enhanced -->

### Orchestration Monitor

Live dashboard tracks your orchestrator runs in real-time with worker status, phase timelines, and
cost analytics. See which workers need attention, browse wave briefings, and analyze parallelism
efficiency across completed runs. Launch with `plugins/dev/scripts/orch-monitor` from any workspace
with orchestrator history.

### PRs

- **dev:** add orch-monitor with live dashboard and analytics
  ([#82](https://github.com/coalesce-labs/catalyst/issues/82))
  ([75f025a](https://github.com/coalesce-labs/catalyst/commit/75f025a88a411882a0f4be45b94033e681c8d27c))

## [6.4.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.1...catalyst-dev-v6.4.2)

Apr 13, 2026

<!-- ai-enhanced -->

### Linearis Integration Cleanup

Remove hardcoded CLI commands across 12 skills in favor of referencing the linearis skill for
syntax, ensuring single source of truth. Fix direnv timing in worktree creation to prevent
re-blocking when setup hooks modify `.envrc`, and remove broken `@me` assignee references that
linearis can't resolve.

### PRs

- **dev:** DRY linearis across all skills, fix direnv timing and [@me](https://github.com/me) bug
  ([#80](https://github.com/coalesce-labs/catalyst/issues/80))
  ([58e0a7b](https://github.com/coalesce-labs/catalyst/commit/58e0a7b14a423429fbb6f2de244f1e2f930dc89d))

## [6.4.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.0...catalyst-dev-v6.4.1)

Apr 13, 2026

<!-- ai-enhanced -->

### Zero-Interaction Orchestration Setup

The `setup-orchestrate` command now runs without any prompts or menus — just pass your ticket IDs
and it creates the worktree, generates a date-based orchestrator name, and prints the next command
to run. It hard-stops if run from a worktree instead of asking whether to continue, keeping setup
predictable and fast.

### PRs

- **dev:** tighten setup-orchestrate to zero-interaction
  ([#78](https://github.com/coalesce-labs/catalyst/issues/78))
  ([2299917](https://github.com/coalesce-labs/catalyst/commit/229991717bb022beee8bcb19679519137c84a003))

## [6.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.3.0...catalyst-dev-v6.4.0)

Apr 13, 2026

<!-- ai-enhanced -->

### Setup Orchestrate Skill

The new `/catalyst-dev:setup-orchestrate` skill creates a bootstrapped orchestrator worktree and
outputs a single copy-paste command to launch your run — no more manual shell scripting. Worktrees
are now automatically trusted in Claude Code during creation, eliminating the trust dialog when you
open them.

### PRs

- **dev:** add setup-orchestrate skill and inline worktree trust
  ([#76](https://github.com/coalesce-labs/catalyst/issues/76))
  ([86b138e](https://github.com/coalesce-labs/catalyst/commit/86b138ecd8af0d8b1b674e2ebcbecc5d705d70a8))

## [6.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.2.0...catalyst-dev-v6.3.0)

Apr 13, 2026

<!-- ai-enhanced -->

### Global Orchestration State Tracking

All active orchestrators are now tracked in a queryable global state registry with event logging and
token usage monitoring. The orchestrator automatically syncs worker progress, captures costs from
Claude CLI output, and maintains an audit trail in monthly-rotated event logs. Workers report status
to the global state and raise attention flags when blocked, giving you full visibility into
multi-agent workflows through `catalyst-state.sh` queries or dashboard integrations.

### PRs

- **dev:** add global orchestrator state, event log, and token tracking
  ([#70](https://github.com/coalesce-labs/catalyst/issues/70))
  ([9f45afa](https://github.com/coalesce-labs/catalyst/commit/9f45afa0f85823f5fbeea6dd27d175ce00b1e1d2))
- **dev:** enforce post-PR monitoring and merge completion
  ([#74](https://github.com/coalesce-labs/catalyst/issues/74))
  ([83b0ee2](https://github.com/coalesce-labs/catalyst/commit/83b0ee2b3fcc75b4149fce5aba5e1715d314557b))
- **dev:** update linearis skill for v2026.4.4
  ([#72](https://github.com/coalesce-labs/catalyst/issues/72))
  ([05237da](https://github.com/coalesce-labs/catalyst/commit/05237dabfb056f4dc9457af47d83dec12aa85c81))

### PRs

- **dev:** add fully-qualified plugin prefixes to skill references
  ([#69](https://github.com/coalesce-labs/catalyst/issues/69))
  ([f9e69f2](https://github.com/coalesce-labs/catalyst/commit/f9e69f29ce7021997f4fba17b1c2bb88e1b62b69))
- **dev:** initialize workflow context and OTEL ticket early
  ([#73](https://github.com/coalesce-labs/catalyst/issues/73))
  ([3406c30](https://github.com/coalesce-labs/catalyst/commit/3406c3099d1e6fcbf9604e9d66649e6e3fbd423e))

## [6.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.1.0...catalyst-dev-v6.2.0)

Apr 11, 2026

<!-- ai-enhanced -->

### Smart Merge Blocker Diagnosis

The merge-pr skill now queries GitHub's full merge state to identify specific blockers (failing CI,
unresolved review threads, missing approvals, outdated branches) and automatically resolves what it
can in a unified loop. When blockers can't be auto-fixed, you get actionable guidance like which
reviewers to request or which files have conflicts — never generic "branch protection is blocking"
errors. The new review-comments skill resolves GitHub review threads after addressing each comment,
and oneshot workflows now wait for automated reviewers before attempting merge.

### PRs

- **dev:** smart merge blocker diagnosis and review thread resolution
  ([#67](https://github.com/coalesce-labs/catalyst/issues/67))
  ([ae74a74](https://github.com/coalesce-labs/catalyst/commit/ae74a749c9f1cd846fb91ba5124fb0db3685c17c))

## [6.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.0.0...catalyst-dev-v6.1.0)

Apr 10, 2026

<!-- ai-enhanced -->

### Parallel Development Orchestration

The new `/orchestrate` skill coordinates multiple development tasks simultaneously by taking Linear
tickets, creating isolated worktrees, and dispatching `/oneshot` workers in parallel with built-in
quality gates. Worktree creation now supports config-driven setup through `catalyst.worktree.setup`,
letting you customize initialization commands instead of relying on auto-detection. Each
orchestrated worker runs with adversarial verification that checks for reward hacking and ensures
delivery quality across all parallel streams.

### PRs

- **dev:** add /orchestrate skill for parallel development
  ([#65](https://github.com/coalesce-labs/catalyst/issues/65))
  ([d3f16d9](https://github.com/coalesce-labs/catalyst/commit/d3f16d93674c7322cba4a2aa076a622e08a9d854))

## [6.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.4.0...catalyst-dev-v6.0.0)

Apr 10, 2026

<!-- ai-enhanced -->

### Workflow State Migration

Catalyst workflow state now lives in `.catalyst/` instead of `.claude/`, keeping your Claude Code
config separate from Catalyst's project files. All scripts automatically fall back to the old
location for backward compatibility, and `check-project-setup.sh` handles the migration on first
run. A new `resolve-ticket.sh` script provides consistent ticket resolution across all workflows
with smart fallback from branch names to workflow context.

### ⚠ BREAKING CHANGES

- **dev:** migrate workflow state from .claude/ to .catalyst/
  ([#63](https://github.com/coalesce-labs/catalyst/issues/63))

### PRs

- **dev:** migrate workflow state from .claude/ to .catalyst/
  ([#63](https://github.com/coalesce-labs/catalyst/issues/63))
  ([114c7c4](https://github.com/coalesce-labs/catalyst/commit/114c7c47734574d552f932fa41902e5adb819283))

## [5.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.3.0...catalyst-dev-v5.4.0)

Apr 9, 2026

<!-- ai-enhanced -->

### Dev Skills v2 Quality Gates

New `/validate-type-safety` and `/review-comments` skills join enhanced versions of
`/scan-reward-hacking`, `/oneshot`, and `/implement-plan` with built-in quality gate pipelines. The
`/oneshot` skill now handles smart PR creation with CI auto-fix loops, while `/implement-plan` runs
a 4-step validation pipeline after implementation phases. All skills include improved descriptions
for better autocomplete discovery and fixed agent references for more reliable execution.

### PRs

- **dev:** dev skills v2 — quality gates, new skills, and shipping enhancements
  ([#60](https://github.com/coalesce-labs/catalyst/issues/60))
  ([70a2d8d](https://github.com/coalesce-labs/catalyst/commit/70a2d8d0dab401841fcc9acf26e4da9932edae57))

## [5.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.2.0...catalyst-dev-v5.3.0)

Apr 4, 2026

<!-- ai-enhanced -->

### TDD Integration & Workflow Context

Claude plugins now enforce Test-Driven Development across all planning and implementation skills,
restructuring workflows to follow the Red → Green → Refactor cycle with tests written before any
implementation code. Workflow context tracking has been improved to properly resolve project roots
and handle symlinked paths, ensuring document history works correctly regardless of your working
directory.

### PRs

- **dev:** integrate Test-Driven Development (TDD) methodology across planning and implementation
  skills ([#50](https://github.com/coalesce-labs/catalyst/issues/50))
  ([1083117](https://github.com/coalesce-labs/catalyst/commit/108311720eb59fed87570233a94abe748fc970b1))

### PRs

- **dev:** ensure workflow context is created and used properly
  ([#52](https://github.com/coalesce-labs/catalyst/issues/52))
  ([b9cf5f5](https://github.com/coalesce-labs/catalyst/commit/b9cf5f5e30233bbabb5ff838a38c6f68328c18af))

## [5.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.1.1...catalyst-dev-v5.2.0)

Apr 1, 2026

<!-- ai-enhanced -->

### Wiki-Links and PM Path Restructuring

The dev plugin now generates Obsidian-style `[[filename]]` wiki-links in skill templates for cleaner
document cross-references, while keeping filesystem paths intact for CLI and code references. PM
skills have been reorganized from scattered `thoughts/shared/*` locations into a unified
`thoughts/shared/pm/` and `thoughts/shared/product/` structure, eliminating the separate
`pm/context-library/` directory for simpler navigation.

### PRs

- **dev,pm:** wiki-links and PM thoughts path restructuring
  ([#47](https://github.com/coalesce-labs/catalyst/issues/47))
  ([fb32e36](https://github.com/coalesce-labs/catalyst/commit/fb32e3622619bfd317c02150565b107158d57746))

## [5.1.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.1.0...catalyst-dev-v5.1.1)

Mar 25, 2026

<!-- ai-enhanced -->

### Linearis CLI Upgrade

Updates the linearis CLI dependency to v2025.12.3 and fixes command syntax across all skills that
interact with Linear. The `--state` flag is now `--status` to match Linear's UI terminology, and
issue creation commands use positional titles instead of the `--title` flag.

### PRs

- **dev:** upgrade linearis CLI and fix skill command syntax
  ([#41](https://github.com/coalesce-labs/catalyst/issues/41))
  ([ffbc14c](https://github.com/coalesce-labs/catalyst/commit/ffbc14c487537bf70805880b39905643e0c56df5))

## [5.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.0.0...catalyst-dev-v5.1.0)

Mar 23, 2026

<!-- ai-enhanced -->

### Loop Workflow Monitoring

The `/create-pr` and `/merge-pr` skills now suggest using `/loop` to monitor GitHub Actions after
creating or merging pull requests, keeping you updated on CI status and deployment progress. Railway
integration has been removed to streamline the setup process.

### PRs

- **dev:** remove Railway integration, add /loop workflow monitoring
  ([#30](https://github.com/coalesce-labs/catalyst/issues/30))
  ([d7df8f2](https://github.com/coalesce-labs/catalyst/commit/d7df8f261ae05abd528d54d695df340b83147d30))

### PRs

- **dev:** fix release-please pipeline + add health monitoring
  ([#32](https://github.com/coalesce-labs/catalyst/issues/32))
  ([cd7054c](https://github.com/coalesce-labs/catalyst/commit/cd7054c591afad61d307a11456855ad397257de3))

## [5.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v4.2.0...catalyst-dev-v5.0.0)

Mar 20, 2026

<!-- ai-enhanced -->

### Smart Workflow Context & Browser Automation

Catalyst now automatically tracks research-to-plan-to-implementation lineage via workflow context
and document frontmatter, eliminating the need to manually chain commands. New browser automation
support lets Claude interact with web UIs directly for testing and data collection. Configuration
must now be nested under the 'catalyst' key in .claude/config.json, and Linear state transitions are
fully configurable through the stateMap setting.

### ⚠ BREAKING CHANGES

- Configuration must now be nested under 'catalyst' key

### PRs

- automatic workflow context tracking + smart setup with token discovery
  ([53b3d38](https://github.com/coalesce-labs/catalyst/commit/53b3d389d7b633721d33d047ff70c31e8c006996))
- **dev:** add agent-browser skill for browser automation
  ([#16](https://github.com/coalesce-labs/catalyst/issues/16))
  ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241bfe9f559fde0f6ae1566d8bed7e6616e94))
- **dev:** add document lineage and reliable workflow context tracking
  ([#13](https://github.com/coalesce-labs/catalyst/issues/13))
  ([b338ae8](https://github.com/coalesce-labs/catalyst/commit/b338ae81679fa620bd7f5e11fe02fe0f90096478))
- **dev:** add Linearis CLI skill for automatic syntax reference
  ([#8](https://github.com/coalesce-labs/catalyst/issues/8))
  ([a9a9de1](https://github.com/coalesce-labs/catalyst/commit/a9a9de13be968a18273a08e583fd498d77ae52c2))
- **dev:** add project setup validation and strengthen command guardrails
  ([#12](https://github.com/coalesce-labs/catalyst/issues/12))
  ([489518e](https://github.com/coalesce-labs/catalyst/commit/489518e726202dea4ede2f5f88c7a0bc5b1371b6))
- **dev:** oneshot Linear states and config normalization
  ([#17](https://github.com/coalesce-labs/catalyst/issues/17))
  ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb50337958a023d731bded913cf0d3f4993))
- implement config security and thoughts system enforcement
  ([b40bda8](https://github.com/coalesce-labs/catalyst/commit/b40bda89dbdd3213d3c5ece2866eec7f52c72f21))
- **linear:** add configurable stateMap for portable state transitions
  ([#15](https://github.com/coalesce-labs/catalyst/issues/15))
  ([371e1d5](https://github.com/coalesce-labs/catalyst/commit/371e1d5dd7c196c2476c28eb873b367d072bb219))
- migrate to HumanLayer profiles and update PM agents to Opus
  ([#7](https://github.com/coalesce-labs/catalyst/issues/7))
  ([1cdbcdd](https://github.com/coalesce-labs/catalyst/commit/1cdbcdd3487422817509b87dbaa9603ad005914b))
- refresh workflow commands with new commands, model tiers, and agent teams
  ([#10](https://github.com/coalesce-labs/catalyst/issues/10))
  ([10a010a](https://github.com/coalesce-labs/catalyst/commit/10a010a51126a8ad9485c37ae6fcb92a4156e8ee))
- restructure to 4-plugin architecture with session-aware MCP management
  ([08f1ec1](https://github.com/coalesce-labs/catalyst/commit/08f1ec1bdd552917c7d29ea8e917be1b8531342f))

### PRs

- add namespace prefixes to all slash command references
  ([099bec9](https://github.com/coalesce-labs/catalyst/commit/099bec9f024594545946dbf8cba78033eb5b0cf6))
- correct linearis CLI syntax across all agents and commands
  ([63ff171](https://github.com/coalesce-labs/catalyst/commit/63ff171dfabdc45c32c94b7e12c8c2aea95bcf06))
- correct plugin marketplace schema and enhance README
  ([89a8fe5](https://github.com/coalesce-labs/catalyst/commit/89a8fe5fd3e4d6e3d436f2b6694364c0776bd434))
- **dev:** add NO CLAUDE ATTRIBUTION sections to PR commands
  ([57ab404](https://github.com/coalesce-labs/catalyst/commit/57ab404e1aa40985ecf6b4785153e4ca9aac71b8))
- **dev:** add YAML frontmatter to /create_plan command template
  ([#9](https://github.com/coalesce-labs/catalyst/issues/9))
  ([ddc75d0](https://github.com/coalesce-labs/catalyst/commit/ddc75d07abec68505bb74017db3ca178453cd9e5))
- **dev:** trim bloated research_codebase and create_plan commands
  ([#11](https://github.com/coalesce-labs/catalyst/issues/11))
  ([4799f4c](https://github.com/coalesce-labs/catalyst/commit/4799f4c0849a471ffcdbe91606792bac83dc0edf))
- **linearis:** correct --team flag docs and add UUID resolution
  ([#18](https://github.com/coalesce-labs/catalyst/issues/18))
  ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205cb0d207096efd3bf5a48bec2acc0c41566))
- namespace all agent references with catalyst-dev prefix
  ([0168b91](https://github.com/coalesce-labs/catalyst/commit/0168b91ccb362134d299d141297204fe545a3f21))
- namespace subagent_type parameters in dev agents README
  ([0f3719e](https://github.com/coalesce-labs/catalyst/commit/0f3719e3994913717116e4df49b8c7758964867c))

### Miscellaneous Chores

- bump versions for breaking config namespace change
  ([9a3f63b](https://github.com/coalesce-labs/catalyst/commit/9a3f63b70c119f7a019116788e6ba0c65b32aa04))

## [4.2.0](https://github.com/coalesce-labs/catalyst/compare/e494235...HEAD)

Mar 17, 2026

<!-- ai-enhanced -->

### Agent Browser & Linear Workflow

Claude can now automate web browsers through the new agent-browser skill, handling authentication
flows and UI testing automatically when you mention browser tasks. Linear workflows get smoother
with automatic ticket state transitions during planning and implementation, plus better team UUID
resolution to prevent silent team-switching bugs. All config files now use the canonical
`catalyst`-wrapped structure for consistency.

### PRs

- add agent-browser skill for browser automation
  ([#16](https://github.com/coalesce-labs/catalyst/pull/16))
  ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241b))
- oneshot Linear states and config normalization
  ([#17](https://github.com/coalesce-labs/catalyst/pull/17))
  ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb))

### PRs

- **linearis:** correct --team flag docs and add UUID resolution
  ([#18](https://github.com/coalesce-labs/catalyst/pull/18))
  ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205c))
