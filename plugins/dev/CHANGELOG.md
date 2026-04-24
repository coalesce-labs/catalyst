# Changelog

## [7.10.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.9.0...catalyst-dev-v7.10.0)

Apr 24, 2026

<!-- ai-enhanced -->

### Canonical Wave Dispatch & Chrome Navigation

The orchestration dispatcher now reads all waveN queues dynamically instead of hardcoded wave limits, so you can dispatch wave5 or wave10 without manual script edits. Click the Catalyst logo to return to the mockup gallery, use the new breadcrumb navigation, or press ⌘K for a filterable command palette with nav shortcuts and appearance controls. Worker usage and costs now aggregate correctly into state.json during monitoring phases.



### PRs

* **dev:** canonical orchestrate-dispatch-next reading all waveN queues (CTL-116) ([#268](https://github.com/coalesce-labs/catalyst/issues/268)) ([7490be9](https://github.com/coalesce-labs/catalyst/commit/7490be96d7dcd864a27d91af5ee18386fece573c))
* **dev:** mockup chrome — clickable home, breadcrumb, ⌘K palette (CTL-166) ([#266](https://github.com/coalesce-labs/catalyst/issues/266)) ([f503027](https://github.com/coalesce-labs/catalyst/commit/f50302732ef0783e9ecf899218577648a2bdea7b))
* drop precision-instrument + dual theme panels on brand mockup (CTL-178) ([#270](https://github.com/coalesce-labs/catalyst/issues/270)) ([4070e92](https://github.com/coalesce-labs/catalyst/commit/4070e925659b77c8c5ba058a0e761b903f556b80))
* **dev:** aggregate worker usage/cost into orch state.json (CTL-115) ([#269](https://github.com/coalesce-labs/catalyst/issues/269)) ([bcc0189](https://github.com/coalesce-labs/catalyst/commit/bcc0189e4ba7c3b5fa5ef335fa087a88ad3e4f27))

## [7.9.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.8.0...catalyst-dev-v7.9.0)

Apr 23, 2026

<!-- ai-enhanced -->

### Dev UI Mockup Suite

Complete static mockup harness for the orch-monitor redesign with 6 new views (home, worker, orchestrator, briefing, comms, todos, agent graph), global keybindings, AI summarization endpoint, and brand V2 assets. Each mockup supports both design systems and includes detailed state variants for visual review. The harness includes drift detection for local dev marketplace registration and improved worker communication discipline guidelines.



### PRs

* **dev:** /api/summarize endpoint — configurable provider (CTL-144) ([#249](https://github.com/coalesce-labs/catalyst/issues/249)) ([5029f9e](https://github.com/coalesce-labs/catalyst/commit/5029f9e5a24fc0414589918d6308472e9b167498))
* **dev:** agent-graph.html mockup — React Flow hierarchy (CTL-140) ([#259](https://github.com/coalesce-labs/catalyst/issues/259)) ([73e4947](https://github.com/coalesce-labs/catalyst/commit/73e4947963151f00e9170e05bb8df771e69c4ce6))
* **dev:** briefing.html mockup — rollup + per-wave briefings + AI summarize button (CTL-141) ([#256](https://github.com/coalesce-labs/catalyst/issues/256)) ([2d92853](https://github.com/coalesce-labs/catalyst/commit/2d92853443f80350a343cf97eda354d5a1e6b9ca))
* **dev:** comms.html mockup — channels + agent cards (CTL-139) ([#254](https://github.com/coalesce-labs/catalyst/issues/254)) ([f881cf6](https://github.com/coalesce-labs/catalyst/commit/f881cf64195260617bfb3bf605089e7cec43cafa))
* **dev:** drift detector for registered local dev marketplace (CTL-121) ([#255](https://github.com/coalesce-labs/catalyst/issues/255)) ([6f259ec](https://github.com/coalesce-labs/catalyst/commit/6f259ec36efd6c1b91f7df99a9c3c05d491c0d36))
* **dev:** global keybinding system in mockup chrome.js (CTL-145) ([#247](https://github.com/coalesce-labs/catalyst/issues/247)) ([e24a445](https://github.com/coalesce-labs/catalyst/commit/e24a445e96ef0afcef3a91456322faf642f85f4a))
* **dev:** home.html mockup — orchestrators overview + standalone workers (CTL-136) ([#250](https://github.com/coalesce-labs/catalyst/issues/250)) ([4a77e3b](https://github.com/coalesce-labs/catalyst/commit/4a77e3bdaef6db6a8f108d2e00304f7c6930e5b4))
* **dev:** ingest TodoWrite + build subagent tree in orch-monitor (CTL-143) ([#248](https://github.com/coalesce-labs/catalyst/issues/248)) ([761c5b1](https://github.com/coalesce-labs/catalyst/commit/761c5b167463fc235ea2622c7663d1eea3c8875c))
* **dev:** orch.html mockup — single-orchestrator dashboard (CTL-137) ([#253](https://github.com/coalesce-labs/catalyst/issues/253)) ([ed2f0fe](https://github.com/coalesce-labs/catalyst/commit/ed2f0fe141ee486a1a7077c13cd9fd4ce8a2d001))
* **dev:** todos.html mockup — standalone TodoWrite roll-up across workers (CTL-142) ([#260](https://github.com/coalesce-labs/catalyst/issues/260)) ([c125765](https://github.com/coalesce-labs/catalyst/commit/c12576530a61f963783186872786ad9446be6a0f))
* **dev:** worker comms posting discipline — budgets, escalation, severity (CTL-165) ([#265](https://github.com/coalesce-labs/catalyst/issues/265)) ([160e615](https://github.com/coalesce-labs/catalyst/commit/160e6152051c0ed166e447f8233ceb14a9600f5d))
* **dev:** worker.html mockup — first-class single-worker page (CTL-138) ([#244](https://github.com/coalesce-labs/catalyst/issues/244)) ([439e758](https://github.com/coalesce-labs/catalyst/commit/439e7588a804a0f653339ada574f289843b0c7b2))
* **meta:** 1200×630 OG / social preview card (CTL-152) ([#264](https://github.com/coalesce-labs/catalyst/issues/264)) ([e0312ff](https://github.com/coalesce-labs/catalyst/commit/e0312ff4bb81d676cc6d1497e2bce290c0d31ad3))
* **meta:** drawn wordmark + horizontal/stacked lockups (CTL-148) ([#262](https://github.com/coalesce-labs/catalyst/issues/262)) ([81c6c98](https://github.com/coalesce-labs/catalyst/commit/81c6c98c4640cea3ca6bb21ae765561529711e0b))
* **meta:** monochrome mark variants + README hero image (CTL-154) ([#263](https://github.com/coalesce-labs/catalyst/issues/263)) ([d776fd9](https://github.com/coalesce-labs/catalyst/commit/d776fd98cf43f8db37dcd4a3e459f2a0fbf4a048))
* **meta:** V2 favicon set — multi-res ICO, SVG, apple-touch, PWA icons (CTL-150) ([#261](https://github.com/coalesce-labs/catalyst/issues/261)) ([5dfafaa](https://github.com/coalesce-labs/catalyst/commit/5dfafaa8131dbba45bfc2da7814a9b67957355a4))
* **dev:** refuse worktree marketplace install unless --allow-worktree (CTL-120) ([#251](https://github.com/coalesce-labs/catalyst/issues/251)) ([f264d9b](https://github.com/coalesce-labs/catalyst/commit/f264d9bacf2f0c55955ffd66a69ca59b5df4b243))
* **dev:** resolve catalyst-comms via plugin path (CTL-127) ([#252](https://github.com/coalesce-labs/catalyst/issues/252)) ([1563bec](https://github.com/coalesce-labs/catalyst/commit/1563bec14743d9d396d06149e51172266c606126))

## [7.8.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.7.0...catalyst-dev-v7.8.0)

Apr 22, 2026

<!-- ai-enhanced -->

### Loki-Backed Monitoring Panels

OTel configuration now supports project-scoped files and the monitoring dashboard displays live tool usage metrics and API error feeds pulled from Loki. The tool usage panel shows your top-8 most invoked tools over the last hour, while the error feed displays the 5 most recent API failures with timestamps. Both panels automatically hide when OTel is unconfigured and poll every 30 seconds alongside your existing health checks.



### PRs

* **dev:** OTel config cleanup + Loki-backed UI panels (CTL-118) ([#239](https://github.com/coalesce-labs/catalyst/issues/239)) ([83647fc](https://github.com/coalesce-labs/catalyst/commit/83647fc1815ecdf61f406bc7684da43d9378370d))
* **dev:** static mockup harness + gallery (CTL-125) ([#242](https://github.com/coalesce-labs/catalyst/issues/242)) ([09b4b3a](https://github.com/coalesce-labs/catalyst/commit/09b4b3a38a9f3c7b7ef485cfe56f829208f88a70))
* **meta:** @catalyst/tokens package with operator-console + precision-instrument systems (CTL-123) ([#241](https://github.com/coalesce-labs/catalyst/issues/241)) ([20a0ec5](https://github.com/coalesce-labs/catalyst/commit/20a0ec53bfd9d2539320838ca21113334cd30299))

## [7.7.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.6.1...catalyst-dev-v7.7.0)

Apr 21, 2026

<!-- ai-enhanced -->

### Orchestrator Intelligence & Communications

Three productivity-focused areas land in the monitor: a restructured dashboard puts "what needs me?" first without scrolling, a new Comms view surfaces real-time catalyst-comms channels with live message feeds and cross-links from worker activity, and orchestrator briefings now include an auto-generated rollup that aggregates what shipped across all waves. Worker cost tooltips explain when metrics are unavailable, and PR status badges show merge conflicts or blocks at a glance across tables and cards.



### PRs

* **dev:** briefing Sheet + orchestrator Briefing tab (CTL-105) ([#234](https://github.com/coalesce-labs/catalyst/issues/234)) ([8324f1c](https://github.com/coalesce-labs/catalyst/commit/8324f1c8b86f2d2a2c492859738d09fa1f929e35))
* **dev:** catalyst-comms setup + website docs (CTL-113) ([#231](https://github.com/coalesce-labs/catalyst/issues/231)) ([7ce31a4](https://github.com/coalesce-labs/catalyst/commit/7ce31a43a9db0d35d37b2a7dbb69997d2c204c6d))
* **dev:** Comms view in orch-monitor (CTL-112) ([#235](https://github.com/coalesce-labs/catalyst/issues/235)) ([ed8ba1a](https://github.com/coalesce-labs/catalyst/commit/ed8ba1a9a749dbf70a8b57cb2f28bba7cf41c1a3))
* **dev:** Comms view in orch-monitor (CTL-112) ([#236](https://github.com/coalesce-labs/catalyst/issues/236)) ([81ef0e4](https://github.com/coalesce-labs/catalyst/commit/81ef0e4b2f3061f62fc42583c768b8886bda8bfe))
* **dev:** dashboard IA three-zone layout (CTL-107) ([#238](https://github.com/coalesce-labs/catalyst/issues/238)) ([9ce601f](https://github.com/coalesce-labs/catalyst/commit/9ce601f8743e923f16458901bc606379ae636c95))
* **dev:** orchestrator rollup briefing (CTL-108) ([#237](https://github.com/coalesce-labs/catalyst/issues/237)) ([007c8f3](https://github.com/coalesce-labs/catalyst/commit/007c8f3849ebdcef11d654f8f086db6ebcee1b16))
* **dev:** OTel health banner + worker cost tooltips (CTL-104) ([#230](https://github.com/coalesce-labs/catalyst/issues/230)) ([0f63dbd](https://github.com/coalesce-labs/catalyst/commit/0f63dbd9bb91fba7d9ec75ff0121f9ce3935832c))
* **dev:** persist orchestrator artifacts with hybrid archive (CTL-110) ([#232](https://github.com/coalesce-labs/catalyst/issues/232)) ([003bce3](https://github.com/coalesce-labs/catalyst/commit/003bce33f30d0b04a9ac5b92c2e1b781e76eb09d))
* **dev:** PR status badges across orch-monitor (CTL-109) ([#229](https://github.com/coalesce-labs/catalyst/issues/229)) ([b3510f8](https://github.com/coalesce-labs/catalyst/commit/b3510f8f8c0c50b9be2fa3fc1b86642f1eddf1ce))
* **dev:** rename Process column to Worker, suppress dead PID on done workers (CTL-101) ([#226](https://github.com/coalesce-labs/catalyst/issues/226)) ([6db8a76](https://github.com/coalesce-labs/catalyst/commit/6db8a762ae336efb0a81683046acdf6f4b7ca43a))
* **dev:** scaffold shadcn/ui interaction primitives in orch-monitor (CTL-97) ([#223](https://github.com/coalesce-labs/catalyst/issues/223)) ([fbaba97](https://github.com/coalesce-labs/catalyst/commit/fbaba97fe4f5137c6f6043427e85574996ec5077))
* **dev:** setup-warp color-by-org convention, reserve blue for PM ([#219](https://github.com/coalesce-labs/catalyst/issues/219)) ([4266d33](https://github.com/coalesce-labs/catalyst/commit/4266d33a7af80271e2086aaebf3f22b51d848fc0))
* **dev:** wire catalyst-comms into orchestrate (CTL-111) ([#222](https://github.com/coalesce-labs/catalyst/issues/222)) ([f1e0ecf](https://github.com/coalesce-labs/catalyst/commit/f1e0ecfaa27341be3c016577b65e0246757afd97))
* **dev:** worker + session drawers → shadcn Sheet (CTL-106) ([#233](https://github.com/coalesce-labs/catalyst/issues/233)) ([6355968](https://github.com/coalesce-labs/catalyst/commit/6355968c142a8a03c44bd6f4005f0ae164d876d5))
* **dev:** Active filter now hides done orchestrators (CTL-99) ([#224](https://github.com/coalesce-labs/catalyst/issues/224)) ([39fbe22](https://github.com/coalesce-labs/catalyst/commit/39fbe2217a7c3e7503068d0e678ab6dadc22ff1e))
* **dev:** exclude abandoned workers from orch-monitor progress denominator (CTL-100) ([#225](https://github.com/coalesce-labs/catalyst/issues/225)) ([0437300](https://github.com/coalesce-labs/catalyst/commit/04373001ad5f4ffe013f65b1a3895fe1cfd889d2))
* **dev:** rename "Process died" → "Worker died" in attention feed (CTL-102) ([#227](https://github.com/coalesce-labs/catalyst/issues/227)) ([5ee6c77](https://github.com/coalesce-labs/catalyst/commit/5ee6c77824b128408ab431adde329ecdbcb60e38))
* **dev:** TaskListSection empty/error states + worker-tasks debug endpoint (CTL-103) ([#228](https://github.com/coalesce-labs/catalyst/issues/228)) ([8524299](https://github.com/coalesce-labs/catalyst/commit/8524299074aa09fb079d6f6429c4d0499b91cc51))

## [7.6.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.6.0...catalyst-dev-v7.6.1)

Apr 20, 2026

<!-- ai-enhanced -->

### PM Parallel Orient Delegates

PM kickoff now dispatches three parallel sub-agents for orientation instead of running raw CLI fetches in the main context. This reduces a typical PM session start from ~15 tool calls with 30KB of JSON debris down to 3-4 clean tool calls, keeping the main context focused on PM reasoning rather than data collection.



### PRs

* **dev:** PM kickoff delegates orient to parallel sub-agents (CTL-95) ([#217](https://github.com/coalesce-labs/catalyst/issues/217)) ([5ed8496](https://github.com/coalesce-labs/catalyst/commit/5ed84964dcb2724392b402f15827dbd4c7c5b639))

## [7.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.4...catalyst-dev-v7.6.0)

Apr 20, 2026

<!-- ai-enhanced -->

### Worktree One-Shot Development Pipeline

Create a ticket worktree and launch Claude with the full research-to-ship pipeline pre-queued in one command. The new Warp tab variant runs `/catalyst-dev:oneshot {{ticket}}` automatically after worktree creation, enabling walk-away autonomous development workflows. Also adds PM kickoff prompts and fixes symlink preservation when copying plugin directories into new worktrees.



### PRs

* **dev:** New Worktree One-Shot Warp variant ([#215](https://github.com/coalesce-labs/catalyst/issues/215)) ([0614a96](https://github.com/coalesce-labs/catalyst/commit/0614a9633ddf8f98ea21afe24ad260504c1d3f18))
* **dev:** PM kickoff prompt + worktree symlink fix ([#213](https://github.com/coalesce-labs/catalyst/issues/213)) ([b03fc87](https://github.com/coalesce-labs/catalyst/commit/b03fc87fc9cd7d4da41331cef6bda9e512c026a8))

## [7.5.4](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.3...catalyst-dev-v7.5.4)

Apr 19, 2026

<!-- ai-enhanced -->

### Thoughts Profile Drift Repair

The `catalyst-thoughts.sh init-or-repair` command now automatically detects and fixes profile drift between your `.catalyst/config.json` and humanlayer's repo mapping. When drift is detected, it runs `humanlayer thoughts uninit --force` followed by re-init with the correct profile and directory from your config. Previously, drift would cause silent failures that required manual intervention.



### PRs

* **dev:** init-or-repair auto-fixes thoughts profile drift (CTL-91) ([#211](https://github.com/coalesce-labs/catalyst/issues/211)) ([d79a14d](https://github.com/coalesce-labs/catalyst/commit/d79a14da98773e9eccf7596deb6e6cf88b7df20f))

## [7.5.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.2...catalyst-dev-v7.5.3)

Apr 19, 2026

<!-- ai-enhanced -->

### Thoughts Symlink Protection

`setup-catalyst` no longer silently clobbers thoughts symlinks when repairing directory structure. The new `catalyst-thoughts.sh` helper detects when a regular directory has replaced an expected symlink and refuses to auto-fix, instead showing a recovery command to preserve any files written to the wrong location. Health checks now treat clobbered symlinks as fatal errors when humanlayer is configured.



### PRs

* **dev:** setup-catalyst no longer clobbers thoughts symlinks (CTL-90) ([#209](https://github.com/coalesce-labs/catalyst/issues/209)) ([fb68453](https://github.com/coalesce-labs/catalyst/commit/fb6845367465c85d1421b09c4263d7abf22ee198))

## [7.5.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.1...catalyst-dev-v7.5.2)

Apr 18, 2026

<!-- ai-enhanced -->

### Warp Color Variant Fix

The `setup-warp` skill now only offers Warp's 8 valid color variants (`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`) instead of invalid options like `purple` and `pink` that caused Warp to reject generated tab configs on load.



### PRs

* **dev:** restrict setup-warp colors to Warp's 8 valid variants ([#207](https://github.com/coalesce-labs/catalyst/issues/207)) ([05800f3](https://github.com/coalesce-labs/catalyst/commit/05800f3a2fe1854568355d6a77fa526c374858b4))

## [7.5.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.5.0...catalyst-dev-v7.5.1)

Apr 18, 2026

<!-- ai-enhanced -->

### Warp Helper Script Bundling

The `setup-warp` skill now bundles its helper scripts directly in the plugin instead of referencing dotfiles that don't exist for other users. Generated Warp tab configurations will point to the bundled `open-project-tab.sh` and `trust-workspace.sh` scripts, making the plugin work out of the box for everyone.



### PRs

* **dev:** bundle warp helper scripts in plugin ([#205](https://github.com/coalesce-labs/catalyst/issues/205)) ([687c98b](https://github.com/coalesce-labs/catalyst/commit/687c98bcdfa9d8d5313f18e618b0fb2cf94a60dc))

## [7.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.4.0...catalyst-dev-v7.5.0)

Apr 18, 2026

<!-- ai-enhanced -->

### Auto Orchestration & Warp Integration

Run `catalyst orchestrate --auto N` to automatically pick your top priority tickets from Linear, or use the new `/catalyst-dev:setup-warp` skill to generate terminal tab configs that launch orchestration sessions with proper naming and remote control. The `--reuse-existing` flag on worktree creation means your tab configs can safely reopen long-lived development environments without conflicts.



### PRs

* **dev:** add --auto orchestration, tab launchers, and setup-warp skill ([#203](https://github.com/coalesce-labs/catalyst/issues/203)) ([326ff20](https://github.com/coalesce-labs/catalyst/commit/326ff209f91e8ea8fbcb1b9c49176d4e50e55840))

## [7.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.3.0...catalyst-dev-v7.4.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Auto-Dispatch Fixup Workers

Blocked PRs with unresolved review threads or failed checks now automatically trigger fixup workers after a 10-minute stabilization window, capping at 2 attempts before escalating to human attention. The orchestrator polls BLOCKED states alongside existing DIRTY/BEHIND handling, eliminating the need for manual intervention on stuck PRs. New signal tracking includes `blockedSince`, `fixupAttempts`, and `lastFixupDispatchedAt` for dashboard visibility.



### PRs

* **dev:** auto-dispatch fixup workers on BLOCKED PRs (CTL-64) ([#199](https://github.com/coalesce-labs/catalyst/issues/199)) ([77ef1b5](https://github.com/coalesce-labs/catalyst/commit/77ef1b5a80df8bcfb0dc5c07212a25b4554267c8))

## [7.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.2.0...catalyst-dev-v7.3.0)

Apr 16, 2026

<!-- ai-enhanced -->

### API Stream Idle Detection

Workers now recover immediately when hitting Claude API stream idle timeouts, instead of waiting up to 15 minutes for heartbeat staleness detection. Linear ticket states automatically transition when PRs are merged, with retroactive reconciliation available via `orchestrate-bulk-close` for tickets that stayed in "In Review" after successful merges.



### PRs

* **dev:** detect API stream idle timeout in orchestrate-revive (CTL-62) ([#196](https://github.com/coalesce-labs/catalyst/issues/196)) ([b89e342](https://github.com/coalesce-labs/catalyst/commit/b89e342c9103d2324cb47f1478a54005da4e14bb))
* **dev:** drive Linear ticket state transitions on PR merge (CTL-69) ([#197](https://github.com/coalesce-labs/catalyst/issues/197)) ([dc58f32](https://github.com/coalesce-labs/catalyst/commit/dc58f3293c8c76d31951a55af92ffc738bbf6be1))

## [7.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.1.1...catalyst-dev-v7.2.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Authoritative Git and PR State

Workers are no longer marked as "stalled" based solely on signal file age — the orchestrator now uses git commit history and GitHub PR status as ground truth for completion detection. If a worker merged its PR but died before writing the terminal signal, it's correctly recognized as complete rather than stalled. Run the orchestration monitor to see the improved accuracy in worker lifecycle tracking.



### PRs

* **dev:** derive worker completion from git/PR, not signal file (CTL-32) ([#193](https://github.com/coalesce-labs/catalyst/issues/193)) ([5e4e3bd](https://github.com/coalesce-labs/catalyst/commit/5e4e3bdb5e787b9168a445893e57d71e828d4f2d))

## [7.1.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.1.0...catalyst-dev-v7.1.1)

Apr 16, 2026

<!-- ai-enhanced -->

### Worker Cost Display Fix

Dashboard now shows real-time worker costs (USD, input/output tokens, cache reads) instead of placeholder dashes. The orchestrator writes parsed usage data to each worker's signal file, matching the existing global state format that powers the cost overview.



### PRs

* **dev:** write worker cost to signal file in orchestrator (CTL-88) ([#190](https://github.com/coalesce-labs/catalyst/issues/190)) ([dbdb050](https://github.com/coalesce-labs/catalyst/commit/dbdb050de29a62fc6e9604579d2345bc32e13912))

## [7.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v7.0.0...catalyst-dev-v7.1.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Session Resume Orchestration

When workers die mid-merge or stall with heartbeats, the orchestrator now revives them using `claude --resume <session_id>` instead of starting fresh — preserving full context while cutting costs ~10×. The system resolves session IDs from worker output streams and enforces per-ticket revive budgets, transitioning to stalled status when revival isn't possible.



### PRs

* **dev:** port revive-worker session-resume into orchestrator Phase 4 (CTL-63) ([#191](https://github.com/coalesce-labs/catalyst/issues/191)) ([6b5aaf4](https://github.com/coalesce-labs/catalyst/commit/6b5aaf42b0f18eaf685b9661b0dfe3c354e04367))

## [7.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.39.1...catalyst-dev-v7.0.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Orchestration State Isolation

Orchestrator runtime state now lives in `~/catalyst/runs/<orch-id>/` instead of git worktrees, keeping your worktree clean during runs. Output files move to `workers/output/` to reduce noise, while worker signal files stay in their expected locations. The monitor automatically handles both new runs-based and legacy worktree-based orchestrators.



### PRs

* **dev:** decouple orch state from worktrees — runs/ dir (CTL-59) ([#188](https://github.com/coalesce-labs/catalyst/issues/188))
* **dev:** decouple orch state from worktrees — runs/ dir (CTL-59) ([#188](https://github.com/coalesce-labs/catalyst/issues/188)) ([a357eaa](https://github.com/coalesce-labs/catalyst/commit/a357eaad59b3684b72515c69e43e37edbbc34778))

## [6.39.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.39.0...catalyst-dev-v6.39.1)

Apr 16, 2026

<!-- ai-enhanced -->

### Merged PR Status Writeback

The orchestration monitor now writes merged PR status back to worker signal files when it detects PRs have been merged on GitHub. Previously, merged PRs were only tracked in memory, causing the dashboard to show incorrect completion percentages when the orchestrator agent had already exited. Signal files now automatically update with `status=done`, `phase=6`, and merge timestamps for accurate project tracking.



### PRs

* **dev:** orch-monitor writes back merged PR status to signal files (CTL-86) ([#185](https://github.com/coalesce-labs/catalyst/issues/185)) ([b340de9](https://github.com/coalesce-labs/catalyst/commit/b340de9c725f4bfe400f2796e4932ebba58c8dce))

## [6.39.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.38.0...catalyst-dev-v6.39.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Orchestrator Launch Failure Detection

Workers that die immediately after dispatch (bad flags, environment errors) are now detected within 30 seconds instead of waiting 15 minutes for the stalled-worker detector. The orchestrator runs a batch health check after each dispatch wave, verifying worker PIDs and automatically flagging dead-on-arrival processes as failed with attention items.



### PRs

* **dev:** detect worker launch failures within 30s of dispatch (CTL-87) ([#184](https://github.com/coalesce-labs/catalyst/issues/184)) ([c74613b](https://github.com/coalesce-labs/catalyst/commit/c74613b11217def5fe06ac66b3808d7018ed1d96))

## [6.38.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.37.2...catalyst-dev-v6.38.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Agent Communication Channels

The new `catalyst-comms` CLI gives Claude Code agents file-based communication across worktrees, sub-agents, and orchestrators without requiring servers or HTTP dependencies. Agents can join channels, send messages, poll for updates, and coordinate completion through simple bash commands that work with any agent workflow. Channel activity is logged locally at `~/catalyst/comms/` with automatic cleanup and human audit capabilities via `catalyst-comms watch` and `status`.



### PRs

* **dev:** catalyst-comms — file-based agent communication channels (CTL-60) ([#182](https://github.com/coalesce-labs/catalyst/issues/182)) ([51a73de](https://github.com/coalesce-labs/catalyst/commit/51a73de70c2ce5952bd02ed40a1fe9cb344ecb51))
* **dev:** worker polls until PR merges instead of exiting at pr-created ([#180](https://github.com/coalesce-labs/catalyst/issues/180)) ([351cc95](https://github.com/coalesce-labs/catalyst/commit/351cc958baec9ed9d63739b33c53236f5a3ba302))

## [6.37.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.37.1...catalyst-dev-v6.37.2)

Apr 16, 2026

<!-- ai-enhanced -->

### Claude Worker Dispatch Fixes

Fixed broken worker dispatch where the `-w` flag was incorrectly used with paths instead of names, causing "Invalid worktree name" errors. Workers now launch in a backgrounded subshell with proper directory switching, include `--dangerously-skip-permissions` to prevent TTY blocking, and capture stderr to debuggable log files instead of `/dev/null`.



### PRs

* **dev:** claude-only worker dispatch with cd subshell (CTL-58, CTL-35) ([#179](https://github.com/coalesce-labs/catalyst/issues/179)) ([1bf3f62](https://github.com/coalesce-labs/catalyst/commit/1bf3f62e0b2ff3fe8a641dd03fb17f34c0a2da4e))

## [6.37.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.37.0...catalyst-dev-v6.37.1)

Apr 16, 2026

<!-- ai-enhanced -->

### CI Release Notes Enhancement

The release pipeline now generates AI-enhanced changelogs automatically, matching the backfill format with structured titles and developer-focused summaries. Fixed a broken pipe issue in the enhancement script that was preventing changelog updates from completing under strict error handling.



### PRs

* **dev:** fix CI release notes to match backfill format ([#177](https://github.com/coalesce-labs/catalyst/issues/177)) ([a64b71a](https://github.com/coalesce-labs/catalyst/commit/a64b71a359cecbea30dd76ad784e02f75236cb71))

## [6.37.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.36.0...catalyst-dev-v6.37.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Changelog Backfill and CI API Key Fix

Backfills AI-enhanced summaries for the four most recent releases (6.34.1 through 6.36.0) that shipped after the original backfill PR. Updates both release-note scripts to use `LOCAL_ANTHROPIC_API_KEY` instead of `ANTHROPIC_API_KEY` to avoid conflicts with Claude Code's own key when running locally, with automatic fallback for CI.



### PRs

* **dev:** backfill AI-enhanced notes and use LOCAL_ANTHROPIC_API_KEY ([#175](https://github.com/coalesce-labs/catalyst/issues/175)) ([6d60cc7](https://github.com/coalesce-labs/catalyst/commit/6d60cc74999fa1f5d17a3b28686fa0df4ec63683))

## [6.36.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.35.0...catalyst-dev-v6.36.0)

Apr 16, 2026

<!-- ai-enhanced -->

### AI-Enhanced Changelogs and Homepage Badge

All 51 catalyst-dev changelog entries now have Sonnet-generated titles and 2-4 sentence summaries. The website homepage gains a version badge that reads the latest release from CHANGELOG.md at build time. Changelog page styling follows a Conductor-inspired layout with small muted version numbers, bold release titles, and comfortable reading line-height. CI release note generation upgraded from Haiku to Sonnet, and a new `add-changelog-media` skill supports R2/CDN hosting for screenshots and GIF screencasts.



### PRs

* **dev:** AI-enhanced changelogs with titles, homepage badge, and Conductor-style styling ([#170](https://github.com/coalesce-labs/catalyst/issues/170)) ([ebdaf99](https://github.com/coalesce-labs/catalyst/commit/ebdaf99061b9c4f4801abe77290e9c41712f096d))

## [6.35.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.34.2...catalyst-dev-v6.35.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Activity Feed and Task List Integration

The orchestration monitor activity feed now shows tool names, text previews, and rate limit info instead of generic "new turn" labels. A new task list integration reads from `~/.claude/tasks/{sessionId}/` to display per-worker task progress with badges in the worker table and a collapsible task section in the detail drawer.



### PRs

* **dev:** fix activity feed labels and add task list integration ([#165](https://github.com/coalesce-labs/catalyst/issues/165)) ([96e098e](https://github.com/coalesce-labs/catalyst/commit/96e098e3138045868ebdb5e45da2e1ff509ddfba))

## [6.34.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.34.1...catalyst-dev-v6.34.2)

Apr 16, 2026

<!-- ai-enhanced -->

### Watcher Subshell Detach

Adds `disown` after the background watcher subshell in `catalyst-claude.sh` to fully detach it from bash's job table before `exec` replaces the process. This is a defensive fix that prevents any edge case where bash might send SIGHUP to the watcher on exit.



### PRs

* **dev:** disown watcher subshell before exec ([#171](https://github.com/coalesce-labs/catalyst/issues/171)) ([5a902b3](https://github.com/coalesce-labs/catalyst/commit/5a902b35d4aefe74d1d237cff00119e41683fc2b))

## [6.34.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.34.0...catalyst-dev-v6.34.1)

Apr 16, 2026

<!-- ai-enhanced -->

### Warp Terminal Integration

Replaces child-process `claude "$@"` with `exec claude "$@"` in the session wrapper so the process image becomes `claude` directly, restoring Warp's rich sidebar metadata (repo, branch, change count) and notification integration. Heartbeat and cleanup logic moves to a background watcher that polls the wrapper PID.



### PRs

* **dev:** exec claude in wrapper for Warp terminal integration ([#168](https://github.com/coalesce-labs/catalyst/issues/168)) ([59e7509](https://github.com/coalesce-labs/catalyst/commit/59e750958cd963aa42972f83a7aba1efcaf0de82))

## [6.34.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.33.0...catalyst-dev-v6.34.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Session Time Filter Controls

Filter your Claude sessions in the sidebar by time range with a 5-option toggle (Active/1h/24h/48h/All) that replaces the previous hardcoded 1-hour cutoff. The filter setting persists across page reloads and works in both flat and grouped sidebar modes. Your previous "Active sessions only" behavior is preserved as the default filter option.



### PRs

* **dev:** add session time filter controls in sidebar ([#164](https://github.com/coalesce-labs/catalyst/issues/164)) ([781ca18](https://github.com/coalesce-labs/catalyst/commit/781ca184f2f24f05c3b0fb1fdf7c4a7c6e011b72))

## [6.33.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.32.0...catalyst-dev-v6.33.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Linear Ticket Grouping

The orchestration monitor sidebar now groups sessions and orchestrators by Linear ticket ID when you select "ticket" grouping mode. Sessions group by their ticket field, while orchestrators appear in groups for each worker ticket they manage. Items without tickets collect in an "Unlinked" group at the bottom.



### PRs

* **dev:** add sidebar grouping by Linear ticket ([#162](https://github.com/coalesce-labs/catalyst/issues/162)) ([d69aa05](https://github.com/coalesce-labs/catalyst/commit/d69aa05398fdae0a85d99530fea0b88fd8a16fa9))

## [6.32.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.31.0...catalyst-dev-v6.32.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Dead Code Detection

Knip now runs automatically on every PR to catch unused exports, dead code, and unnecessary dependencies before they reach main. The CI quality gates will fail if any dead code is detected, keeping the codebase clean without manual oversight.



### PRs

* **dev:** add knip dead code checking to CI quality gates ([#158](https://github.com/coalesce-labs/catalyst/issues/158)) ([f58d441](https://github.com/coalesce-labs/catalyst/commit/f58d4414e12b84f6096edf23becd6f8780c0a6e9))

## [6.31.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.30.0...catalyst-dev-v6.31.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Sidebar Repo Grouping

Switch between flat list and grouped tree views with the new Flat/Repo toggle in the sidebar header. In Repo mode, orchestrators group by workspace and sessions by working directory, with collapsible headers showing item counts. Your grouping preference persists across sessions automatically.



### PRs

* **dev:** add sidebar grouping by repo/cwd ([#157](https://github.com/coalesce-labs/catalyst/issues/157)) ([0101310](https://github.com/coalesce-labs/catalyst/commit/010131057e2c2419dec3a1ae5c337ba7d809a637))

## [6.30.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.29.0...catalyst-dev-v6.30.0)

Apr 16, 2026

<!-- ai-enhanced -->

### Session Detail Drawer

Click any session in the sidebar or dashboard to open a detailed inspector with status, elapsed time, cost metrics, and PR information. The drawer follows the same pattern as worker inspection, with mutual exclusion between session and orchestrator views. Sessions now show visual selection states with accent highlighting in the sidebar and borders on dashboard cards.



### PRs

* **dev:** add session detail drawer ([#156](https://github.com/coalesce-labs/catalyst/issues/156)) ([8671562](https://github.com/coalesce-labs/catalyst/commit/867156239ec32907bcf61799948dac1cb6e27cb3))

## [6.29.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.28.0...catalyst-dev-v6.29.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Worker Detail Drawer & Session Tracking

Click any worker row in the orchestration monitor to open a live detail panel with metrics, phase timeline, and activity feed. Standalone Claude sessions are now tracked automatically via `catalyst-claude.sh`, appearing in the sidebar with real-time status indicators. Run `catalyst-db.sh migrate` after updating to add the new session columns.



### PRs

* **dev:** add worker detail drawer, session tracking, and sidebar sessions ([#153](https://github.com/coalesce-labs/catalyst/issues/153)) ([f38e0dc](https://github.com/coalesce-labs/catalyst/commit/f38e0dc37a4ad6b95a943304302d8e51b2381700))

## [6.28.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.27.1...catalyst-dev-v6.28.0)

Apr 15, 2026

<!-- ai-enhanced -->

### DeepWiki Codebase Integration

The research-codebase workflow now starts by querying DeepWiki for a compressed map of your repository, making all subsequent AI research targeted instead of exploratory. All core Catalyst skills can now ask DeepWiki specific questions during execution, and oneshot workflow eliminates 16 lines of duplicate research logic by referencing the unified research process.



### PRs

* **dev:** add DeepWiki orientation to codebase research workflow ([#151](https://github.com/coalesce-labs/catalyst/issues/151)) ([7e705de](https://github.com/coalesce-labs/catalyst/commit/7e705def583eca5640a91e071a38abac1389a375))

## [6.27.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.27.0...catalyst-dev-v6.27.1)

Apr 15, 2026

<!-- ai-enhanced -->

### Monitor Command Consolidation

The `start-monitor.sh` script has been merged into `catalyst-monitor.sh` as a single entry point for all monitoring operations. Use `catalyst-monitor.sh start` instead of the separate bootstrap script — it now handles dependency checks, installation, and frontend building automatically before starting the monitor.



### PRs

* **dev:** consolidate start-monitor.sh into catalyst-monitor.sh ([#149](https://github.com/coalesce-labs/catalyst/issues/149)) ([bf50058](https://github.com/coalesce-labs/catalyst/commit/bf50058ac21b0bcc9ac505f04ec085b1833450be))

## [6.27.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.26.1...catalyst-dev-v6.27.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Setup Health Check System

Run `/catalyst-dev:setup-catalyst` to diagnose your entire Catalyst installation with 47 automated checks covering database, monitoring, secrets, and project configuration. The skill auto-fixes safe issues like missing directories and database initialization, then re-verifies everything in one command. The orchestration monitor now shows version info in the header and includes a smarter launcher that validates prerequisites and handles dependency installation automatically.



### PRs

* **dev:** add setup-catalyst health check, monitor launcher, and version display ([#147](https://github.com/coalesce-labs/catalyst/issues/147)) ([31c8cba](https://github.com/coalesce-labs/catalyst/commit/31c8cba7d413228afffb0c1953aad44926c873df))

## [6.26.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.26.0...catalyst-dev-v6.26.1)

Apr 15, 2026

<!-- ai-enhanced -->

### Setup & Configuration Hardening

Catalyst setup now checks for macOS platform and SQLite prerequisites before installation, automatically initializes the session database during orchestrator setup, and fixes OpenTelemetry monitor configuration to read from the correct config path. Run the setup scripts again to ensure your environment has all required dependencies.



### PRs

* **dev:** harden prerequisites, wire up SQLite init, fix OTel config ([#143](https://github.com/coalesce-labs/catalyst/issues/143)) ([14f7c84](https://github.com/coalesce-labs/catalyst/commit/14f7c849d619b7bfb5f62f411c1e050d226f2103))

## [6.26.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.25.0...catalyst-dev-v6.26.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Standalone Orchestrator Setup

The new `setup-orchestrator.sh` script lets you bootstrap orchestrator worktrees from Warp tabs, cron jobs, or any external automation without needing a Claude Code session. It supports ticket pass-through, quiet mode for scripting, and one-shot launch flags while maintaining full compatibility with the existing `/catalyst-dev:setup-orchestrate` skill. Also fixes the orchestration monitor dashboard which was showing zero orchestrators due to incorrect SSE event parsing.



### PRs

* **dev:** standalone setup-orchestrator.sh for external automation ([#141](https://github.com/coalesce-labs/catalyst/issues/141)) ([c1158b4](https://github.com/coalesce-labs/catalyst/commit/c1158b46bd4c62995346e224afa3ede928fad6c0))


### PRs

* **dev:** unwrap SSE event envelope in orch-monitor React UI ([#137](https://github.com/coalesce-labs/catalyst/issues/137)) ([8e2e433](https://github.com/coalesce-labs/catalyst/commit/8e2e43335a354b31c095edbb504cb84357d2efc7))

## [6.25.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.24.0...catalyst-dev-v6.25.0)

Apr 15, 2026

<!-- ai-enhanced -->

### Modern React Orchestration Monitor

The orchestration monitor is now a React SPA with shimmer loading, worker search/filtering, animated KPIs, and a collapsible sidebar. Code-split lazy loading reduces initial bundle size while 15+ componentized views replace the previous 4000-line vanilla JavaScript implementation. All existing orchestrator functionality (Overview, Workers, Timeline, Events tabs) works identically with improved performance and modern SaaS-style UX.



### PRs

* **dev:** migrate orch-monitor to React SPA with modern SaaS UI ([#135](https://github.com/coalesce-labs/catalyst/issues/135)) ([0790005](https://github.com/coalesce-labs/catalyst/commit/0790005962f46e98263fe983d346107aec2b5a7f))

## [6.24.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.23.0...catalyst-dev-v6.24.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Workspace Repository Grouping

The orchestration monitor now organizes sessions by workspace and repository, automatically extracting workspace names from your project directory structure. Toggle between the new grouped workspace view and the familiar flat "All" view using the header controls. Each workspace card shows aggregate stats including total sessions, active count, costs, and last activity across all repositories in that workspace.



### PRs

* **dev:** add workspace/repo grouping to orch-monitor dashboard ([#132](https://github.com/coalesce-labs/catalyst/issues/132)) ([3c88247](https://github.com/coalesce-labs/catalyst/commit/3c882476cb3530537506ec4bf8f6fcf205287597))

## [6.23.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.22.0...catalyst-dev-v6.23.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Polished Orchestration Monitor UI

Added keyboard navigation (j/k, Enter, Esc), command palette (/ or Cmd+K), sidebar with orchestrator list, and right-click context menus on worker rows. The interface now uses compact table styling with smooth transitions and higher information density, inspired by Linear's design patterns.



### PRs

* **dev:** Linear-inspired SaaS UI polish for orch-monitor ([#131](https://github.com/coalesce-labs/catalyst/issues/131)) ([0760882](https://github.com/coalesce-labs/catalyst/commit/07608823b79020d06ba97bae3fb6c578046a289e))

## [6.22.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.21.0...catalyst-dev-v6.22.0)

Apr 14, 2026

<!-- ai-enhanced -->

### OTel Metrics Dashboard

The orchestration monitor now includes a Metrics tab with real-time charts showing cost breakdowns, token usage, cache hit rates, and tool activity from your OpenTelemetry data. Toggle between Dashboard and Metrics views to track both workflow execution and performance analytics in one interface. Charts automatically refresh across configurable time ranges, with graceful fallback when OTel isn't configured.



### PRs

* **dev:** add OTel-powered metrics panels to monitor UI ([#126](https://github.com/coalesce-labs/catalyst/issues/126)) ([014ede1](https://github.com/coalesce-labs/catalyst/commit/014ede1e5d697b37ed9d6f557739f6167c8d9e11))

## [6.21.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.20.0...catalyst-dev-v6.21.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Preview Deployment Links

The orchestration monitor now detects and displays preview deployment URLs from your pull requests. Clickable badges show live deployment status with color coding (green for live, yellow for deploying, red for failed) directly in the web UI, with preview URLs also appearing in terminal output. Works automatically with Cloudflare Pages, Vercel, Netlify, and Railway by scanning PR comments and the GitHub Deployments API.



### PRs

* **dev:** add preview deployment links to orch-monitor ([#125](https://github.com/coalesce-labs/catalyst/issues/125)) ([2400616](https://github.com/coalesce-labs/catalyst/commit/2400616a424baa6987c639a6397dd061152b5d86))

## [6.20.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.19.0...catalyst-dev-v6.20.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Terminal UI Monitor

Run `catalyst monitor --terminal` to get a real-time terminal dashboard alongside the web interface, or use `--terminal-only` for quick status checks without starting the HTTP server. The terminal view includes aggregate cost tracking with color-coded alerts and compact mode for narrow terminals. All keyboard shortcuts (q/r/0-9/arrows) work as expected for navigation and control.



### PRs

* **dev:** terminal UI monitor frontend ([#124](https://github.com/coalesce-labs/catalyst/issues/124)) ([cd7240a](https://github.com/coalesce-labs/catalyst/commit/cd7240a2ce6a69e10220527598d5a0fe4d4e90b3))

## [6.19.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.18.0...catalyst-dev-v6.19.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session & Orchestrator Annotations

Add display names, flags, notes, and tags to any session or orchestrator through click-to-edit UI controls, star/flag toggles, and an expandable notes drawer. Use the new `catalyst-session annotate` CLI command to script annotations, or call the REST API endpoints directly for programmatic access.



### PRs

* **dev:** add session & orchestrator annotations ([#112](https://github.com/coalesce-labs/catalyst/issues/112)) ([adf331c](https://github.com/coalesce-labs/catalyst/commit/adf331c6be3e2ee1046cf79ffae1b90b7de1d1a1))

## [6.18.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.17.0...catalyst-dev-v6.18.0)

Apr 14, 2026

<!-- ai-enhanced -->

### OTel Query Integration

Query Prometheus metrics and Loki logs directly from the orchestration monitor with built-in cost tracking, token usage, and tool analytics. The integration pulls data from your always-on OTel Docker stack through cached HTTP clients, adding enriched session views without impacting performance when OTel is disabled. Configure endpoints in `~/.catalyst/config.json` or use `PROMETHEUS_URL` and `LOKI_URL` environment variables.



### PRs

* **dev:** add OTel query integration (Prometheus + Loki) ([#106](https://github.com/coalesce-labs/catalyst/issues/106)) ([111156d](https://github.com/coalesce-labs/catalyst/commit/111156dabf3f86197fa2e8f99ec69c2d9ea6ca57))

## [6.17.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.16.0...catalyst-dev-v6.17.0)

Apr 14, 2026

<!-- ai-enhanced -->

### AI-Powered Status Briefing

The orchestration monitor now includes an optional AI briefing panel that generates natural-language status summaries and suggests session labels using Claude or OpenAI models. Click the briefing panel's generate button to get contextual insights about your current development sessions, with auto-refresh available for ongoing projects. The feature routes through Cloudflare AI Gateway and includes XSS protection for safe rendering of generated content.



### PRs

* **dev:** add AI-powered status briefing to orch-monitor ([#107](https://github.com/coalesce-labs/catalyst/issues/107)) ([67ed25c](https://github.com/coalesce-labs/catalyst/commit/67ed25c73220c08741a5a666e8c77e39185296b5))

## [6.16.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.15.1...catalyst-dev-v6.16.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session Detail View

Click any worker row in the orch-monitor to open a dedicated session page with phase timeline, live cost tracking, tool usage bars, and event history. The detail view updates automatically when new snapshots arrive, giving you real-time visibility into individual Claude sessions without leaving the dashboard.



### PRs

* **dev:** add single-session detail view to orch-monitor ([#110](https://github.com/coalesce-labs/catalyst/issues/110)) ([562898b](https://github.com/coalesce-labs/catalyst/commit/562898b8e7342ba0a3fe07af31b32165b54b9e9d))

## [6.15.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.15.0...catalyst-dev-v6.15.1)

Apr 14, 2026

<!-- ai-enhanced -->

### Ghost Worker Filter & Cost Tracking

The orchestration monitor now filters out ghost worker rows caused by output files and correctly discovers all orchestrator directories regardless of naming. The cost card shows total token counts with input/output/cache breakdown and per-model cost aggregation for better resource tracking.



### PRs

* **dev:** filter ghost worker rows + fix orch-monitor cost tracking ([#114](https://github.com/coalesce-labs/catalyst/issues/114)) ([9eb336c](https://github.com/coalesce-labs/catalyst/commit/9eb336c1ae73eff463b259d93a09907965508764))

## [6.15.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.14.0...catalyst-dev-v6.15.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Historical Analytics & Session Querying

Navigate to `/history` in the monitor dashboard to explore session analytics with cost trends, skill performance metrics, and a searchable session table with filtering and pagination. The new CLI commands `catalyst-session.sh history`, `stats`, and `compare` let you query and analyze session data directly from the terminal. Full API support available at `/api/history/*` endpoints for custom integrations.



### PRs

* **dev:** historical analytics & session querying (CTL-44) ([#113](https://github.com/coalesce-labs/catalyst/issues/113)) ([edaaf4b](https://github.com/coalesce-labs/catalyst/commit/edaaf4b761c78886672c917add3316116f3d30f4))

## [6.14.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.13.0...catalyst-dev-v6.14.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Zero-Config Monitor Management

Run `catalyst-monitor start` to launch the orchestration monitor in the background, then use `stop`, `status`, `open`, or `url` commands to manage it without manual server juggling. The monitor now writes a PID file for clean lifecycle management and automatic stale process cleanup.



### PRs

* **dev:** add catalyst-monitor CLI for zero-config monitoring ([#109](https://github.com/coalesce-labs/catalyst/issues/109)) ([9db0fa5](https://github.com/coalesce-labs/catalyst/commit/9db0fa58ac6f073fc4a065d090013fdf4ed4d7c4))

## [6.13.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.12.0...catalyst-dev-v6.13.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session Labeling System

Add meaningful display names to Claude sessions using the optional `label` field in worker signals, automatically derived from `<skill> <ticket>` patterns or set with the `--label` flag. Labels appear in both terminal and web monitor dashboards, making it easier to identify and track specific development sessions at a glance.



### PRs

* **dev:** add session labeling system to orch-monitor ([#105](https://github.com/coalesce-labs/catalyst/issues/105)) ([bf6c3f6](https://github.com/coalesce-labs/catalyst/commit/bf6c3f691b5971403fbe81ce62f3e82fbbcf3c22))

## [6.12.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.11.0...catalyst-dev-v6.12.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Multi-Frontend SSE Event Architecture

Catalyst now sends all orchestration events through a standardized envelope format with filtering support. Connect multiple frontends or tools to the same session using SSE query params like `?filter=session-update,metrics-update` or `?session=abc123` to get only the events you need. The new typed event system supports session updates, metrics changes, and annotation events with automatic envelope wrapping for consistent downstream processing.



### PRs

* **dev:** SSE event architecture for multiple frontends ([#111](https://github.com/coalesce-labs/catalyst/issues/111)) ([6433182](https://github.com/coalesce-labs/catalyst/commit/64331824c5a8ee4029becfe1fafdd0a19181a201))

## [6.11.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.10.0...catalyst-dev-v6.11.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session-Aware Skills

All six Catalyst skills now automatically track their execution as observable sessions with lifecycle events and phase transitions. Each skill run creates a session entry that links parent workflows to child operations, giving you full visibility into your AI-assisted development workflows. The skills gracefully degrade when session tracking isn't available, so existing workflows continue working unchanged.



### PRs

* **dev:** instrument 6 skills with catalyst-session tracking ([#104](https://github.com/coalesce-labs/catalyst/issues/104)) ([5f537a6](https://github.com/coalesce-labs/catalyst/commit/5f537a6a0bb93abbee63a8fe19613d79e5303021))

## [6.10.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.9.0...catalyst-dev-v6.10.0)

Apr 14, 2026

<!-- ai-enhanced -->

### SQLite Session Integration

Solo Claude Code sessions now appear directly in the orchestration monitor alongside workflow workers, giving you one unified view of all AI development activity. The session store reader integrates with existing filesystem monitoring, so you can track and filter both orchestrated and standalone sessions through the same `/api/sessions` endpoint and live SSE streams.



### PRs

* **dev:** SQLite reader and unified data source for orch-monitor (CTL-40) ([#101](https://github.com/coalesce-labs/catalyst/issues/101)) ([6bd8238](https://github.com/coalesce-labs/catalyst/commit/6bd8238f5ba3a7333170a9b9412ce01abbda365e))

## [6.9.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.8.0...catalyst-dev-v6.9.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Session Lifecycle CLI

The new `catalyst-session` command gives any skill a universal interface to report lifecycle events, metrics, and tool usage to the SQLite session store. Replace direct JSON file writes with structured calls like `catalyst-session start --skill myskill`, `catalyst-session phase $id running`, and `catalyst-session metric $id --cost 0.05` to get automatic tracking in the orchestration monitor and session APIs.



### PRs

* **dev:** catalyst-session lifecycle CLI (CTL-37) ([#100](https://github.com/coalesce-labs/catalyst/issues/100)) ([9b7fae2](https://github.com/coalesce-labs/catalyst/commit/9b7fae2b16535c66c97b8a76ba68fb57a9b9d32f))

## [6.8.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.7.0...catalyst-dev-v6.8.0)

Apr 14, 2026

<!-- ai-enhanced -->

### SQLite Session Store

Catalyst now persists all agent activity—both solo and orchestrated sessions—to a durable SQLite database instead of fragile per-worker JSON files. The new `catalyst-db.sh` CLI provides session CRUD, event logging, metrics tracking, and PR management with concurrent read/write support. Run `catalyst-db.sh init` to create the database schema and start building persistent workflow history.



### PRs

* **dev:** SQLite session store for agent activity (CTL-36) ([#97](https://github.com/coalesce-labs/catalyst/issues/97)) ([74bb43d](https://github.com/coalesce-labs/catalyst/commit/74bb43d5a5e4e0be27bab79b2cdfadd4e2e5299b))

## [6.7.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.6.0...catalyst-dev-v6.7.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Pre-assigned Migration Numbers

The orchestrator now reserves sequential Supabase migration numbers for database tickets during wave briefing, preventing filename collisions when multiple workers generate migrations in parallel. Migration-likely tickets are detected via labels (`database`, `migration`, `schema`) and keywords, then assigned unique `NNN_` prefixes that appear in the briefing's new Migration Number Assignments section.



### PRs

* **dev:** pre-assign Supabase migration numbers per wave (CTL-29) ([#95](https://github.com/coalesce-labs/catalyst/issues/95)) ([84a6f84](https://github.com/coalesce-labs/catalyst/commit/84a6f8471abd49879b0ffb56f4eeda897e96864f))

## [6.6.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.4...catalyst-dev-v6.6.0)

Apr 14, 2026

<!-- ai-enhanced -->

### Fix-up and Follow-up Recovery Patterns

Two new orchestration patterns handle post-merge issues: fix-up workers push targeted commits to open PRs when reviewers find blockers, while follow-up workers create new Linear tickets and fresh worktrees for issues discovered after merge. Use `orchestrate-fixup` and `orchestrate-followup` scripts to dispatch the appropriate recovery pattern based on your PR state.



### PRs

* **dev:** orchestrate fix-up worker + follow-up ticket recovery patterns (CTL-30) ([#93](https://github.com/coalesce-labs/catalyst/issues/93)) ([bfa9861](https://github.com/coalesce-labs/catalyst/commit/bfa9861b126d2163cae2d643b659237506ba40f7))

## [6.5.4](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.3...catalyst-dev-v6.5.4)

Apr 14, 2026

<!-- ai-enhanced -->

### Orchestrator-Controlled Merge Polling

Workers now exit cleanly after opening PRs with auto-merge armed, while the orchestrator handles the long poll until actual merge completion. This fixes premature worker termination issues where subprocess workers would exit before PRs were fully merged, with the orchestrator taking over merge monitoring duties and updating worker status when PRs complete.



### PRs

* **dev:** orchestrator-owned poll-until-MERGED (CTL-31) ([#91](https://github.com/coalesce-labs/catalyst/issues/91)) ([2da8f69](https://github.com/coalesce-labs/catalyst/commit/2da8f697dafcf9c878bf3fd1760d90ca34ff44c1))

## [6.5.3](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.2...catalyst-dev-v6.5.3)

Apr 14, 2026

<!-- ai-enhanced -->

### Worker Worktree Context Fix

Fixed ticket extraction in worker worktrees so branches like `orch-data-import-2026-04-13-ADV-220` correctly identify `ADV-220` as the current ticket instead of false matches from orchestrator prefixes. Worker worktrees now include an `orchestration` field in their workflow context, enabling proper telemetry grouping across orchestrator and worker sessions.



### PRs

* **dev:** worker worktrees get correct currentTicket + orchestration field ([#89](https://github.com/coalesce-labs/catalyst/issues/89)) ([4768eac](https://github.com/coalesce-labs/catalyst/commit/4768eac0b4cb87bf074088ca232b29cf72486836))

## [6.5.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.1...catalyst-dev-v6.5.2)

Apr 13, 2026

<!-- ai-enhanced -->

### PR Polling Through Merge

Orchestrated workers now actively poll PR state, CI status, and review comments until merge completion instead of exiting after creating the PR. The verification script independently confirms PRs reached MERGED state, catching any workers that ignore polling instructions. Workers wait a minimum 3 minutes then poll every 30 seconds with concrete step-by-step instructions.



### PRs

* **dev:** add poll-until-merged loop and PR state verification ([#86](https://github.com/coalesce-labs/catalyst/issues/86)) ([666b835](https://github.com/coalesce-labs/catalyst/commit/666b8356ede7c4e1322a0f27bdb9f39c2921caea))

## [6.5.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.5.0...catalyst-dev-v6.5.1)

Apr 13, 2026

<!-- ai-enhanced -->

### Linearis Command Consolidation

Removed duplicated Linear CLI commands from 8 files, making the linearis skill the single source of truth for all command syntax and options. Fixed a setup validation false positive that incorrectly flagged properly configured thoughts directories. Agents now reference `/catalyst-dev:linearis` instead of maintaining their own stale command examples.



### PRs

* **dev:** DRY linearis CLI commands, fix setup false positive ([#84](https://github.com/coalesce-labs/catalyst/issues/84)) ([68115ac](https://github.com/coalesce-labs/catalyst/commit/68115acd8168e14683a4a079b0cc42b7f2a763b7))

## [6.5.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.2...catalyst-dev-v6.5.0)

Apr 13, 2026

<!-- ai-enhanced -->

### Orchestration Monitor

Live dashboard tracks your orchestrator runs in real-time with worker status, phase timelines, and cost analytics. See which workers need attention, browse wave briefings, and analyze parallelism efficiency across completed runs. Launch with `plugins/dev/scripts/orch-monitor` from any workspace with orchestrator history.



### PRs

* **dev:** add orch-monitor with live dashboard and analytics ([#82](https://github.com/coalesce-labs/catalyst/issues/82)) ([75f025a](https://github.com/coalesce-labs/catalyst/commit/75f025a88a411882a0f4be45b94033e681c8d27c))

## [6.4.2](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.1...catalyst-dev-v6.4.2)

Apr 13, 2026

<!-- ai-enhanced -->

### Linearis Integration Cleanup

Remove hardcoded CLI commands across 12 skills in favor of referencing the linearis skill for syntax, ensuring single source of truth. Fix direnv timing in worktree creation to prevent re-blocking when setup hooks modify `.envrc`, and remove broken `@me` assignee references that linearis can't resolve.



### PRs

* **dev:** DRY linearis across all skills, fix direnv timing and [@me](https://github.com/me) bug ([#80](https://github.com/coalesce-labs/catalyst/issues/80)) ([58e0a7b](https://github.com/coalesce-labs/catalyst/commit/58e0a7b14a423429fbb6f2de244f1e2f930dc89d))

## [6.4.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.4.0...catalyst-dev-v6.4.1)

Apr 13, 2026

<!-- ai-enhanced -->

### Zero-Interaction Orchestration Setup

The `setup-orchestrate` command now runs without any prompts or menus — just pass your ticket IDs and it creates the worktree, generates a date-based orchestrator name, and prints the next command to run. It hard-stops if run from a worktree instead of asking whether to continue, keeping setup predictable and fast.



### PRs

* **dev:** tighten setup-orchestrate to zero-interaction ([#78](https://github.com/coalesce-labs/catalyst/issues/78)) ([2299917](https://github.com/coalesce-labs/catalyst/commit/229991717bb022beee8bcb19679519137c84a003))

## [6.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.3.0...catalyst-dev-v6.4.0)

Apr 13, 2026

<!-- ai-enhanced -->

### Setup Orchestrate Skill

The new `/catalyst-dev:setup-orchestrate` skill creates a bootstrapped orchestrator worktree and outputs a single copy-paste command to launch your run — no more manual shell scripting. Worktrees are now automatically trusted in Claude Code during creation, eliminating the trust dialog when you open them.



### PRs

* **dev:** add setup-orchestrate skill and inline worktree trust ([#76](https://github.com/coalesce-labs/catalyst/issues/76)) ([86b138e](https://github.com/coalesce-labs/catalyst/commit/86b138ecd8af0d8b1b674e2ebcbecc5d705d70a8))

## [6.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.2.0...catalyst-dev-v6.3.0)

Apr 13, 2026

<!-- ai-enhanced -->

### Global Orchestration State Tracking

All active orchestrators are now tracked in a queryable global state registry with event logging and token usage monitoring. The orchestrator automatically syncs worker progress, captures costs from Claude CLI output, and maintains an audit trail in monthly-rotated event logs. Workers report status to the global state and raise attention flags when blocked, giving you full visibility into multi-agent workflows through `catalyst-state.sh` queries or dashboard integrations.



### PRs

* **dev:** add global orchestrator state, event log, and token tracking ([#70](https://github.com/coalesce-labs/catalyst/issues/70)) ([9f45afa](https://github.com/coalesce-labs/catalyst/commit/9f45afa0f85823f5fbeea6dd27d175ce00b1e1d2))
* **dev:** enforce post-PR monitoring and merge completion ([#74](https://github.com/coalesce-labs/catalyst/issues/74)) ([83b0ee2](https://github.com/coalesce-labs/catalyst/commit/83b0ee2b3fcc75b4149fce5aba5e1715d314557b))
* **dev:** update linearis skill for v2026.4.4 ([#72](https://github.com/coalesce-labs/catalyst/issues/72)) ([05237da](https://github.com/coalesce-labs/catalyst/commit/05237dabfb056f4dc9457af47d83dec12aa85c81))


### PRs

* **dev:** add fully-qualified plugin prefixes to skill references ([#69](https://github.com/coalesce-labs/catalyst/issues/69)) ([f9e69f2](https://github.com/coalesce-labs/catalyst/commit/f9e69f29ce7021997f4fba17b1c2bb88e1b62b69))
* **dev:** initialize workflow context and OTEL ticket early ([#73](https://github.com/coalesce-labs/catalyst/issues/73)) ([3406c30](https://github.com/coalesce-labs/catalyst/commit/3406c3099d1e6fcbf9604e9d66649e6e3fbd423e))

## [6.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.1.0...catalyst-dev-v6.2.0)

Apr 11, 2026

<!-- ai-enhanced -->

### Smart Merge Blocker Diagnosis

The merge-pr skill now queries GitHub's full merge state to identify specific blockers (failing CI, unresolved review threads, missing approvals, outdated branches) and automatically resolves what it can in a unified loop. When blockers can't be auto-fixed, you get actionable guidance like which reviewers to request or which files have conflicts — never generic "branch protection is blocking" errors. The new review-comments skill resolves GitHub review threads after addressing each comment, and oneshot workflows now wait for automated reviewers before attempting merge.



### PRs

* **dev:** smart merge blocker diagnosis and review thread resolution ([#67](https://github.com/coalesce-labs/catalyst/issues/67)) ([ae74a74](https://github.com/coalesce-labs/catalyst/commit/ae74a749c9f1cd846fb91ba5124fb0db3685c17c))

## [6.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v6.0.0...catalyst-dev-v6.1.0)

Apr 10, 2026

<!-- ai-enhanced -->

### Parallel Development Orchestration

The new `/orchestrate` skill coordinates multiple development tasks simultaneously by taking Linear tickets, creating isolated worktrees, and dispatching `/oneshot` workers in parallel with built-in quality gates. Worktree creation now supports config-driven setup through `catalyst.worktree.setup`, letting you customize initialization commands instead of relying on auto-detection. Each orchestrated worker runs with adversarial verification that checks for reward hacking and ensures delivery quality across all parallel streams.



### PRs

* **dev:** add /orchestrate skill for parallel development ([#65](https://github.com/coalesce-labs/catalyst/issues/65)) ([d3f16d9](https://github.com/coalesce-labs/catalyst/commit/d3f16d93674c7322cba4a2aa076a622e08a9d854))

## [6.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.4.0...catalyst-dev-v6.0.0)

Apr 10, 2026

<!-- ai-enhanced -->

### Workflow State Migration

Catalyst workflow state now lives in `.catalyst/` instead of `.claude/`, keeping your Claude Code config separate from Catalyst's project files. All scripts automatically fall back to the old location for backward compatibility, and `check-project-setup.sh` handles the migration on first run. A new `resolve-ticket.sh` script provides consistent ticket resolution across all workflows with smart fallback from branch names to workflow context.



### ⚠ BREAKING CHANGES

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63))

### PRs

* **dev:** migrate workflow state from .claude/ to .catalyst/ ([#63](https://github.com/coalesce-labs/catalyst/issues/63)) ([114c7c4](https://github.com/coalesce-labs/catalyst/commit/114c7c47734574d552f932fa41902e5adb819283))

## [5.4.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.3.0...catalyst-dev-v5.4.0)

Apr 9, 2026

<!-- ai-enhanced -->

### Dev Skills v2 Quality Gates

New `/validate-type-safety` and `/review-comments` skills join enhanced versions of `/scan-reward-hacking`, `/oneshot`, and `/implement-plan` with built-in quality gate pipelines. The `/oneshot` skill now handles smart PR creation with CI auto-fix loops, while `/implement-plan` runs a 4-step validation pipeline after implementation phases. All skills include improved descriptions for better autocomplete discovery and fixed agent references for more reliable execution.



### PRs

* **dev:** dev skills v2 — quality gates, new skills, and shipping enhancements ([#60](https://github.com/coalesce-labs/catalyst/issues/60)) ([70a2d8d](https://github.com/coalesce-labs/catalyst/commit/70a2d8d0dab401841fcc9acf26e4da9932edae57))

## [5.3.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.2.0...catalyst-dev-v5.3.0)

Apr 4, 2026

<!-- ai-enhanced -->

### TDD Integration & Workflow Context

Claude plugins now enforce Test-Driven Development across all planning and implementation skills, restructuring workflows to follow the Red → Green → Refactor cycle with tests written before any implementation code. Workflow context tracking has been improved to properly resolve project roots and handle symlinked paths, ensuring document history works correctly regardless of your working directory.



### PRs

* **dev:** integrate Test-Driven Development (TDD) methodology across planning and implementation skills ([#50](https://github.com/coalesce-labs/catalyst/issues/50)) ([1083117](https://github.com/coalesce-labs/catalyst/commit/108311720eb59fed87570233a94abe748fc970b1))


### PRs

* **dev:** ensure workflow context is created and used properly ([#52](https://github.com/coalesce-labs/catalyst/issues/52)) ([b9cf5f5](https://github.com/coalesce-labs/catalyst/commit/b9cf5f5e30233bbabb5ff838a38c6f68328c18af))

## [5.2.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.1.1...catalyst-dev-v5.2.0)

Apr 1, 2026

<!-- ai-enhanced -->

### Wiki-Links and PM Path Restructuring

The dev plugin now generates Obsidian-style `[[filename]]` wiki-links in skill templates for cleaner document cross-references, while keeping filesystem paths intact for CLI and code references. PM skills have been reorganized from scattered `thoughts/shared/*` locations into a unified `thoughts/shared/pm/` and `thoughts/shared/product/` structure, eliminating the separate `pm/context-library/` directory for simpler navigation.



### PRs

* **dev,pm:** wiki-links and PM thoughts path restructuring ([#47](https://github.com/coalesce-labs/catalyst/issues/47)) ([fb32e36](https://github.com/coalesce-labs/catalyst/commit/fb32e3622619bfd317c02150565b107158d57746))

## [5.1.1](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.1.0...catalyst-dev-v5.1.1)

Mar 25, 2026

<!-- ai-enhanced -->

### Linearis CLI Upgrade

Updates the linearis CLI dependency to v2025.12.3 and fixes command syntax across all skills that interact with Linear. The `--state` flag is now `--status` to match Linear's UI terminology, and issue creation commands use positional titles instead of the `--title` flag.



### PRs

* **dev:** upgrade linearis CLI and fix skill command syntax ([#41](https://github.com/coalesce-labs/catalyst/issues/41)) ([ffbc14c](https://github.com/coalesce-labs/catalyst/commit/ffbc14c487537bf70805880b39905643e0c56df5))

## [5.1.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v5.0.0...catalyst-dev-v5.1.0)

Mar 23, 2026

<!-- ai-enhanced -->

### Loop Workflow Monitoring

The `/create-pr` and `/merge-pr` skills now suggest using `/loop` to monitor GitHub Actions after creating or merging pull requests, keeping you updated on CI status and deployment progress. Railway integration has been removed to streamline the setup process.



### PRs

* **dev:** remove Railway integration, add /loop workflow monitoring ([#30](https://github.com/coalesce-labs/catalyst/issues/30)) ([d7df8f2](https://github.com/coalesce-labs/catalyst/commit/d7df8f261ae05abd528d54d695df340b83147d30))


### PRs

* **dev:** fix release-please pipeline + add health monitoring ([#32](https://github.com/coalesce-labs/catalyst/issues/32)) ([cd7054c](https://github.com/coalesce-labs/catalyst/commit/cd7054c591afad61d307a11456855ad397257de3))

## [5.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-dev-v4.2.0...catalyst-dev-v5.0.0)

Mar 20, 2026

<!-- ai-enhanced -->

### Smart Workflow Context & Browser Automation

Catalyst now automatically tracks research-to-plan-to-implementation lineage via workflow context and document frontmatter, eliminating the need to manually chain commands. New browser automation support lets Claude interact with web UIs directly for testing and data collection. Configuration must now be nested under the 'catalyst' key in .claude/config.json, and Linear state transitions are fully configurable through the stateMap setting.



### ⚠ BREAKING CHANGES

* Configuration must now be nested under 'catalyst' key

### PRs

* automatic workflow context tracking + smart setup with token discovery ([53b3d38](https://github.com/coalesce-labs/catalyst/commit/53b3d389d7b633721d33d047ff70c31e8c006996))
* **dev:** add agent-browser skill for browser automation ([#16](https://github.com/coalesce-labs/catalyst/issues/16)) ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241bfe9f559fde0f6ae1566d8bed7e6616e94))
* **dev:** add document lineage and reliable workflow context tracking ([#13](https://github.com/coalesce-labs/catalyst/issues/13)) ([b338ae8](https://github.com/coalesce-labs/catalyst/commit/b338ae81679fa620bd7f5e11fe02fe0f90096478))
* **dev:** add Linearis CLI skill for automatic syntax reference ([#8](https://github.com/coalesce-labs/catalyst/issues/8)) ([a9a9de1](https://github.com/coalesce-labs/catalyst/commit/a9a9de13be968a18273a08e583fd498d77ae52c2))
* **dev:** add project setup validation and strengthen command guardrails ([#12](https://github.com/coalesce-labs/catalyst/issues/12)) ([489518e](https://github.com/coalesce-labs/catalyst/commit/489518e726202dea4ede2f5f88c7a0bc5b1371b6))
* **dev:** oneshot Linear states and config normalization ([#17](https://github.com/coalesce-labs/catalyst/issues/17)) ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb50337958a023d731bded913cf0d3f4993))
* implement config security and thoughts system enforcement ([b40bda8](https://github.com/coalesce-labs/catalyst/commit/b40bda89dbdd3213d3c5ece2866eec7f52c72f21))
* **linear:** add configurable stateMap for portable state transitions ([#15](https://github.com/coalesce-labs/catalyst/issues/15)) ([371e1d5](https://github.com/coalesce-labs/catalyst/commit/371e1d5dd7c196c2476c28eb873b367d072bb219))
* migrate to HumanLayer profiles and update PM agents to Opus ([#7](https://github.com/coalesce-labs/catalyst/issues/7)) ([1cdbcdd](https://github.com/coalesce-labs/catalyst/commit/1cdbcdd3487422817509b87dbaa9603ad005914b))
* refresh workflow commands with new commands, model tiers, and agent teams ([#10](https://github.com/coalesce-labs/catalyst/issues/10)) ([10a010a](https://github.com/coalesce-labs/catalyst/commit/10a010a51126a8ad9485c37ae6fcb92a4156e8ee))
* restructure to 4-plugin architecture with session-aware MCP management ([08f1ec1](https://github.com/coalesce-labs/catalyst/commit/08f1ec1bdd552917c7d29ea8e917be1b8531342f))


### PRs

* add namespace prefixes to all slash command references ([099bec9](https://github.com/coalesce-labs/catalyst/commit/099bec9f024594545946dbf8cba78033eb5b0cf6))
* correct linearis CLI syntax across all agents and commands ([63ff171](https://github.com/coalesce-labs/catalyst/commit/63ff171dfabdc45c32c94b7e12c8c2aea95bcf06))
* correct plugin marketplace schema and enhance README ([89a8fe5](https://github.com/coalesce-labs/catalyst/commit/89a8fe5fd3e4d6e3d436f2b6694364c0776bd434))
* **dev:** add NO CLAUDE ATTRIBUTION sections to PR commands ([57ab404](https://github.com/coalesce-labs/catalyst/commit/57ab404e1aa40985ecf6b4785153e4ca9aac71b8))
* **dev:** add YAML frontmatter to /create_plan command template ([#9](https://github.com/coalesce-labs/catalyst/issues/9)) ([ddc75d0](https://github.com/coalesce-labs/catalyst/commit/ddc75d07abec68505bb74017db3ca178453cd9e5))
* **dev:** trim bloated research_codebase and create_plan commands ([#11](https://github.com/coalesce-labs/catalyst/issues/11)) ([4799f4c](https://github.com/coalesce-labs/catalyst/commit/4799f4c0849a471ffcdbe91606792bac83dc0edf))
* **linearis:** correct --team flag docs and add UUID resolution ([#18](https://github.com/coalesce-labs/catalyst/issues/18)) ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205cb0d207096efd3bf5a48bec2acc0c41566))
* namespace all agent references with catalyst-dev prefix ([0168b91](https://github.com/coalesce-labs/catalyst/commit/0168b91ccb362134d299d141297204fe545a3f21))
* namespace subagent_type parameters in dev agents README ([0f3719e](https://github.com/coalesce-labs/catalyst/commit/0f3719e3994913717116e4df49b8c7758964867c))


### Miscellaneous Chores

* bump versions for breaking config namespace change ([9a3f63b](https://github.com/coalesce-labs/catalyst/commit/9a3f63b70c119f7a019116788e6ba0c65b32aa04))

## [4.2.0](https://github.com/coalesce-labs/catalyst/compare/e494235...HEAD)

Mar 17, 2026

<!-- ai-enhanced -->

### Agent Browser & Linear Workflow

Claude can now automate web browsers through the new agent-browser skill, handling authentication flows and UI testing automatically when you mention browser tasks. Linear workflows get smoother with automatic ticket state transitions during planning and implementation, plus better team UUID resolution to prevent silent team-switching bugs. All config files now use the canonical `catalyst`-wrapped structure for consistency.


### PRs

* add agent-browser skill for browser automation ([#16](https://github.com/coalesce-labs/catalyst/pull/16)) ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241b))
* oneshot Linear states and config normalization ([#17](https://github.com/coalesce-labs/catalyst/pull/17)) ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb))

### PRs

* **linearis:** correct --team flag docs and add UUID resolution ([#18](https://github.com/coalesce-labs/catalyst/pull/18)) ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205c))
