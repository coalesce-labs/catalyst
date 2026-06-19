---
name: sensing-substrate
description: Observability / sensing-substrate cookbook for the recovery-pass delegate (and humans). Copy-paste-runnable LogQL + PromQL against the live OTel stack (Loki/Prometheus/Grafana) to see what the control loop is doing, detect silent freezes, read wedge signals, and turn each into an unstick action + a finding. **ALWAYS consult this skill when** the recovery-pass delegate (or a human) needs to query daemon logs/metrics, suspects the fleet is wedged or silently frozen, wants to count/see a wedge signal, detect a silent daemon (no logs in N minutes), or read cost/token/host-pressure metrics. Use when the user says "is the fleet stuck", "why isn't anything dispatching", "check the daemon logs", "query Loki", "query Prometheus", "is the monitor alive", or "what is the control loop doing".
---

# Sensing-Substrate Cookbook — recovery-pass delegate cheat-sheet

> Every query below is copy-paste-runnable and lifted from (or matches) the working
> dashboards `catalyst-otel/dashboards/catalyst-fleet-daemon-logs.json` (logs) and
> `unified-dashboard.json` (metrics), plus the Alloy shipper
> `plugins/dev/scripts/log-shipper/config.alloy`. This is ground truth, not invention.
> Run them in Grafana Explore (`https://otel.rozich.com`) or directly against the Loki /
> Prometheus HTTP APIs.

## ▶ When you (the delegate) suspect a silent freeze, run THESE first

A silent freeze is the failure mode that matters: the daemon process is **alive** (PID present,
timers armed), but the control loop has stopped doing useful work — no crash, no alert, just an
absence. Your first move is always two questions: *(1) Is each daemon still emitting logs at all?*
(silence detector) and *(2) Is the loop running-but-stuck on a known wedge?* (wedge counts). Run the
**per-daemon silence sweep** (§4 recipe **g**) to find any of the 4 streams that has gone quiet in
the last 10 minutes, then run the **wedge-signal counts** (§3 recipe **b**) to see whether the loop
is throwing or holding. If silence sweep shows all 4 streams live AND all wedge counts are ~0 except
`stale fence`, the loop is healthy and the problem is elsewhere (Linear, GitHub, an empty work
queue). If a stream is silent, that daemon is your suspect. If a wedge count is non-zero, jump to its
row in **§0 (the playbook)** for what it means and what to do about it. Start here, every time.

```logql
# (1) per-daemon silence sweep — any stream missing or == 0 is silent (last 10m)
sum by (service_name) (count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} | log_file_name=~`.+` [10m]))
```
```logql
# (2) wedge-signal sentinel — non-zero rows (other than `stale fence`) are the wedge (last 1h)
sum by () (count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |~ `holding new-work dispatch|reconcile( poll)? failed|liveness warmer.*refresh failed|tick failed|registry has 0 projects|not in the cluster roster` [1h])) or vector(0)
```

> **Self-constraint (your invariant #2 — do not cause a rate-limit cliff).** Read once, cache the
> result, batch your follow-ups. Do NOT poll Loki/Prometheus/Linear in a tight loop while diagnosing
> — a diagnosis pass that hammers the API is itself a wedge cause. One sweep, reason over it, then
> act.

---

## 0. The playbook — diagnose → unstick → file

This is the spine of the skill: every wedge signal maps to a **query that confirms it**, a **likely
cause**, an **unstick action keyed to your 3-tier rope**, and a **finding to file if it recurs** so
the bug gets fixed from your experience. The rope (from the recovery-pass skill):

- **T1 — fix it silently** (rebase, reap, redispatch, clear stale cache); record via `recovery-emit.mjs fixed`.
- **T2 — fix it AND file an automation-gap finding** (e.g. a daemon restart is a band-aid — the
  finding is the real fix); Gherkin ticket into the **Self-Healing Delegate** Linear project, Backlog.
- **T3 — ask first** (system-wide change: roster, global config, override a hold); executive briefing → operator decides.

| Signal | Confirm (recipe) | Likely cause | Unstick (rope tier) | File if it recurs |
|---|---|---|---|---|
| **holding new-work dispatch** | §3b count + §3a liveness | stale/cold liveness snapshot — `claude agents` count untrustworthy (CTL-731) | **T2** — restart execution-core daemon, re-check dispatch fills | automation-gap: liveness-warmer self-heal / dispatch-resilience fallback (this is CTL-829) |
| **liveness warmer: refresh failed** | §3b count | `claude agents --json` RPC failing/slow → warmer can't refresh | **T2** — restart daemon; verify the warmer recovers | same watchdog gap — a warmer that can't self-recover is the bug |
| **reconcile failed** | §3b count + §3c lines | malformed/partial `registry.json`, or a per-team `linearis` spawn failure | **T1** — repair the registry row / re-trigger reconcile | if config drift keeps recurring → finding (reconcile should be self-healing/atomic) |
| **stale fence** (sustained high rate) | §3b count + §3c lines | an **un-reaped zombie** worker keeps waking and re-hitting a write site (multi-host) | **T1** — reap/redispatch the zombie (this is exactly the phantom-reaper, CTL-1245) | if the reaper misses a whole class of zombie → finding against the reaper layer (NOT the fence) |
| **scheduler: tick failed** | §3b count *(use the `scheduler:` prefix!)* + §3c lines | an uncaught throw in the tick body (cache/DB error, malformed signal, null) | **T2** if a transient that recurs (restart); **T3** if structural | bug finding with the stack/line — a tick must never throw |
| **registry has 0 projects** | §3b count | host booted with an empty registry — never ran `register` | **T3** — brief operator (should this host be registered, or is it meant to be idle?) | config/onboarding finding |
| **not in the cluster roster** | §3b count | this host's name is absent from a ≥2-host roster → HRW routes all work away | **T3** — brief operator (roster edit is a system change) | roster-config finding |
| **daemon silent ≥10m** | §4f `absent_over_time` | a daemon is dead/hung (no logs at all) | **T2** — restart that daemon | supervisor / auto-restart gap — needing a manual restart is the tell |

After any action: print a per-signal resolution line (the rope contract), and for T2/T3 file the
finding via the `gherkin-ticket` skill into the **Self-Healing Delegate** project (Backlog — never
Todo, which auto-dispatches). That is the compounding loop: each intervention either fixes the board
now or becomes the ticket that removes the failure class.

---

## 1. What the sensing substrate is + base URLs

The **sensing substrate** is the read side of Catalyst's control loop. The 4 long-running daemons
each write a `.log` file; a per-host **Grafana Alloy** shipper tails those files and forwards them
(OTLP → collector → **Loki**). Separately, Claude Code and the daemons emit metrics to
**Prometheus**. You query both through **Grafana** (or their HTTP APIs). This is how the
recovery-pass delegate *sees what the control loop is doing* without touching the loop itself.

**Verify these first — every recipe depends on them:**

| Surface | URL | Notes |
|---|---|---|
| **Grafana** (UI / Explore) | `https://otel.rozich.com` | Anonymous, open datasource proxies. Use the Explore tab; pick the Loki or Prometheus datasource. |
| **Loki** HTTP API | `http://100.65.193.30:3100` | Direct query: `GET /loki/api/v1/query_range`. |
| **Prometheus** HTTP API | `http://100.65.193.30:9098` | Host port `9098` → container `9090`. Direct query: `GET /api/v1/query`. |
| **OTLP/HTTP collector** (INGEST only, not query) | `http://100.65.193.30:4318` (gRPC `:4317`) | Where Alloy ships logs. Do not query this. |

The stack lives on the **Tailscale net at `100.65.193.30`**, **NOT localhost**. Inside Grafana the
provisioned datasources use internal docker URLs (`http://otel-loki:3100`,
`http://otel-prometheus:9090`) — those only work *inside* the compose network. When you hit the
Loki/Prometheus HTTP APIs from a host, use the `100.65.193.30` ports above.

Example direct Loki query from a shell (URL-encode the LogQL):

```bash
curl -sG "http://100.65.193.30:3100/loki/api/v1/query_range" \
  --data-urlencode 'query=sum by (service_name) (count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} | log_file_name=~`.+` [10m]))' \
  --data-urlencode "start=$(( $(date +%s) - 600 ))000000000" \
  --data-urlencode "end=$(date +%s)000000000"
```

Example direct Prometheus instant query:

```bash
curl -sG "http://100.65.193.30:9098/api/v1/query" \
  --data-urlencode 'query=sum by (model) (rate(claude_code_cost_usage_USD_total{job="otel-collector"}[5m]))'
```

---

## 2. The shipped log streams + filter / grouping dimensions

### The 4 daemon `.log` files → `service_name` streams

Alloy tails exactly **4 daemon log files** per host, each shipped under a fixed `service_name` Loki
stream label:

| `.log` file (default, `~/catalyst`-relative) | `service_name` stream | Parsing |
|---|---|---|
| `~/catalyst/broker.log` | `catalyst.broker` | pino-JSON |
| `~/catalyst/execution-core/daemon.log` | `catalyst.execution-core` | pino-JSON |
| `~/catalyst/otel-forward.log` | `catalyst.otel-forward` | pino-JSON |
| `~/catalyst/monitor.log` | `catalyst.monitor` | **plain text**, unstructured, never dropped |

The dashboard's `$service` template var enumerates exactly these via `label_values(service_name)`
regex-filtered to `^catalyst\.(broker|execution-core|monitor|otel-forward)$`.

> **`catalyst.monitor` carries no pino `level`** (it is plain console output). Any `| level=~...`
> filter **silently excludes the monitor stream**. When hunting across all daemons including the
> monitor, do not add a `level` filter — or you will go blind on the monitor.

### The filter / grouping dimensions

| Dimension | Loki type | How to filter | Values |
|---|---|---|---|
| `service_name` | **stream label** (`{}` selector) | `{service_name="catalyst.broker"}` or `{service_name=~"catalyst\\.(broker\|execution-core)"}` | the 4 above |
| `catalyst_node_name` | **structured metadata** | `\| catalyst_node_name=~`mini\|mini-2`` (pipe filter, NOT `{}`) | `mini`, `mini-2`, `laptop` |
| `log_file_name` | **structured metadata** | `\| log_file_name=~`.+`` | absolute tailed path |
| `level` | **structured metadata** (pino numeric) | `\| level=~`40\|50\|60`` | `30`=INFO `40`=WARN `50`=ERROR `60`=FATAL |

To scope any recipe to one node, append (for example) `| catalyst_node_name="mini"` **after** the
stream selector.

---

## 3. Wedge-signal reference

Each wedge signal marks a point where the control loop **keeps running but stops doing useful work**
— the process is healthy; the log line is the only externally visible symptom. The phrases below are
**verbatim** from the dashboard's grep panels. On a healthy fleet all counts sit at **0 except
`stale fence`**, which is noisy-normal multi-host zombie-guard suppression. (For what to DO about
each, see **§0 the playbook**.)

### Per-signal meanings

| # | Signal string | Severity | What it means (plain English) | Why it's a silent freeze | Typical trigger |
|---|---|---|---|---|---|
| 1 | `holding new-work dispatch` | **WARN** | The liveness snapshot (live `claude agents --json` worker count) is stale or unpopulated, so the scheduler can't trust the in-flight count; it sets `freeSlots → 0` and admits **zero new tickets** this tick. | Daemon, scheduler timer, and in-flight phase advancement all keep running, so it looks alive — but no *new* work ever enters the pipeline. If the snapshot never recovers, the team starves indefinitely with no crash. | Cold start before the first snapshot populates, or a hung/slow `claude agents` RPC making `livenessIsFresh()` false. *(The same line also fires once per drain via the CTL-1095 `draining` path — that one is INFO, benign.)* |
| 2 | `reconcile failed` / `reconcile poll failed` (`reconcile failed — registry changes are NOT being applied`) | **ERROR** | A registry-watch `reconcile()` threw. The registry is the single source of enrolled projects; a failed reconcile means edits to `registry.json` are silently dropped. | The watch callback swallows the throw and the daemon keeps ticking on the **old** project set — new registrations never picked up, de-registrations never take effect. No restart, no visible error besides this line. | A throw inside `reconcile()` — malformed/partially-written `registry.json`, a per-team `linearis` spawn failure during the fan-out, or stale explicit `status`/`repoRoot`. |
| 3 | `liveness warmer: refresh failed` (also `liveness warmer: threw`) | **WARN** | The dedicated short-interval `refreshAgents()` timer that keeps the liveness snapshot warm between scheduler ticks failed to refresh. | This warmer is what *prevents* signal #1 on an idle daemon. If it keeps failing, the snapshot ages past `staleMs`, `livenessIsFresh()` flips false, and the scheduler silently stops admitting new work — **cascades into signal #1**. The loop runs but goes blind on worker liveness. | The async `claude agents --json` read inside `refreshAgents()` rejecting/erroring (RPC timeout, CLI failure, spawn error). |
| 4 | `stale fence` (`stale fence — suppressing <X> write (zombie guard)`) | **WARN** | On a ≥2-host cluster, `fenceGuard` decided this node is **no longer the current owner** of the ticket's generation and suppressed an outbound Linear/GitHub write. FAIL-CLOSED: missing/unreadable generation → suppress. | A paused/partitioned zombie host that wakes after another node took over keeps walking its old pipeline and *thinks* it's writing state, but every external write is silently dropped — Linear state never updates from this node. Protective by design; a **burst** means a node is doing ghost work that lands nowhere. | Multi-host takeover/preemption: this host's claimed `generation` lost the fence to the new owner, or the signal generation is missing. **Single-host installs never emit this** — at `roster ≤ 1`, `multiHost:false`. |
| 5 | `tick failed` (`scheduler: tick failed`) | **ERROR** | An uncaught exception escaped the entire scheduler tick body; the top-level catch logged it and let the timer schedule the next tick. | The daemon survives ("a tick must never crash the daemon"), but **this entire tick did no work** — no advancement, no dispatch, no terminal sweep. If it recurs every tick, the whole loop is frozen while the process stays up. | Any unhandled throw in the tick's main path (cache/DB error, malformed signal, unexpected null). **Disambiguate** the look-alikes below before concluding the scheduler loop is wedged. |
| 6 | `registry has 0 projects` (`registry has 0 projects — nothing will be dispatched`) | **WARN** | At boot the project registry resolved to **zero** enrolled projects, so there is nothing to ever dispatch. | A fresh/headless host boots a healthy-looking daemon that dispatches **nothing** — PID present, timers armed, every tick a no-op. Without this one-time boot warning it's indistinguishable from a healthy idle daemon. | A host whose `registry.json` was never written (never ran `catalyst-execution-core register`), or a registry read returning empty. **Emitted once at startup, not per tick.** |
| 7 | `not in the cluster roster` | **WARN** | This host's name is absent from a multi-host roster, so under HRW every ticket hashes to some **other** host and this daemon owns zero tickets. | The daemon comes up fully functional but HRW routes all work away — a silent self-eviction. Distinct from #6 (empty registry); here the registry is fine but the *ownership partition* excludes this node. | A roster of ≥2 hosts that doesn't contain `self` — `catalyst.host.name` not matching a roster entry, or a stale/wrong `hosts.json` / cluster-repo `roster`. **Single-host (`roster ≤ 1`) never emits this.** |

> **`tick failed` disambiguation (important — don't cry wolf).** The wedge is **only**
> `scheduler: tick failed` (ERROR). These look-alikes are NOT the scheduler loop wedging:
> `reclaimDeadHostWork tick failed` (WARN, multi-host sub-sweep, non-fatal),
> memory-sampler / ratelimit-poller `tick failed` (WARN, side-car timers),
> beliefs collector `tick failed` (WARN, shadow), and `account tick failed` (a *different*
> account-usage poller, unrelated). Filter to `scheduler: tick failed` to count the real one.

### Stale-fence (#4) — what each suppressed write is

A `stale fence` burst means a zombie host is doing ghost work. Each suppressed write per site:

| Site | Suppressed write |
|---|---|
| `terminalDoneOnce` | Writing the terminal **Done** state to Linear (final close-out). |
| `reconcileTerminalBackstop` | Re-forcing **Done** when a shipped ticket drifted back to non-terminal (CTL-758 backstop). |
| `labelOnce` (dependency-cycle) | Applying the **needs-human** label to a ticket stuck in a dependency **cycle**. |
| `applyBlockedByRelation` (triage-deps) | Writing a durable **blocked-by dependency edge** found during triage. |
| `applyEstimate` | Writing the reference-class **story-point estimate** on triage→research. |
| `applyPhaseStatus` (preemption-resume) | Writing the Linear **phase status** when resuming a preempted ticket. |
| `applyBlockedByRelation` (sequencing) | Writing a **blocked-by sequencing edge** (CTL-925 hard-dep ordering). |
| `labelOnce` (failed-or-stalled) | Applying **needs-human** in the terminal sweep when a phase is **stalled/failed**. |
| held-label retraction (CTL-1068) | **Removing/retracting a held label** (needs-human/cycle) from an in-flight ticket. |
| `postReclaimMirror` | Posting the **"Phase Reclaim" comment** after a work-done-despite-dead-bg reclaim. |
| stale-pr-rescue `labelOnce` | Applying the **needs-human label** from the stale-PR-rescue escalation path. |

### Recipes

These use literal stream names (no Grafana `$service`/`$node` vars) so they run as-is in Explore or
the Loki API. Scope to a node by appending `| catalyst_node_name="mini"`.

**(a) Liveness — is each daemon ticking, per daemon × node, last 10m** (the "0 = silent/down" probe):
```logql
sum by (service_name, catalyst_node_name) (count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} | log_file_name=~`.+` [10m]))
```

**(b) Wedge-signal counts — one query per signal over the window (last 1h):**
```logql
sum(count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |= `holding new-work dispatch` [1h])) or vector(0)
```
```logql
sum(count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |~ `reconcile( poll)? failed` [1h])) or vector(0)
```
```logql
sum(count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |~ `liveness warmer.*refresh failed` [1h])) or vector(0)
```
```logql
sum(count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |~ `scheduler: tick failed` [1h])) or vector(0)
```
```logql
sum(count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |= `registry has 0 projects` [1h])) or vector(0)
```
```logql
sum(count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |= `not in the cluster roster` [1h])) or vector(0)
```
```logql
sum(count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} |= `stale fence` [1h])) or vector(0)
```
`or vector(0)` makes "no matching lines" render as `0` instead of an empty result. **Every count
should be 0 except `stale fence`** (noisy-normal on multi-host; always 0 on single-host).

**(c) Recent wedge LINES — the actual log text, all wedge signals in one feed:**
```logql
{service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`}
  |~ `holding new-work dispatch|reconcile( poll)? failed|liveness warmer.*refresh failed|scheduler: tick failed|registry has 0 projects|not in the cluster roster`
  | label_format sev=`{{ if eq .level "30" }}INFO{{ else if eq .level "40" }}WARN{{ else if eq .level "50" }}ERROR{{ else if eq .level "60" }}FATAL{{ else }}L{{ .level }}{{ end }}`
  | line_format `[{{ .catalyst_node_name }}] {{ .service_name }} {{ .sev }} | {{ __line__ }}`
```

**(d) WARN/ERROR/FATAL feed — everything above INFO** (excludes the level-less monitor stream — that's expected):
```logql
{service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} | level=~`40|50|60`
  | line_format `[{{ .catalyst_node_name }}] {{ .service_name }} | {{ __line__ }}`
```

---

## 4. Silence detector — "no logs from monitor/broker in last N min"

A silent stream is the cleanest signal of a dead/wedged daemon. **For a truly-dead stream, recipe
(f) `absent_over_time` is the reliable alarm — start there.** The `== 0` form (e) is for *rendering*,
not detection (see its caveat).

**(f) `absent_over_time` — fires when the stream produced NOTHING over the range (USE THIS):**
```logql
absent_over_time({service_name=`catalyst.execution-core`} | log_file_name=~`.+` [10m])
```
Returns `1` when the selector matched **no** samples over the range, empty otherwise — the cleanest
"stream is dead" alarm, and the correct primitive for a silence actuator. Swap the `service_name` for
`catalyst.monitor` / `catalyst.broker` / `catalyst.otel-forward` to check each daemon.

**(e) `count_over_time(...) == 0` — matrix-rendering ONLY, NOT a total-silence detector:**
```logql
sum by (catalyst_node_name) (count_over_time({service_name=`catalyst.broker`} | log_file_name=~`.+` [10m])) == 0
```
⚠️ **Caveat (load-bearing):** a `count_over_time` over a stream with **zero** matching lines yields
**no series**, so `sum(...) == 0` returns an **empty result** (not a `0`-row) on *total* silence — it
does **not** detect a fully-dead stream. The live dashboard's liveness panel uses this form only
because a `groupingToMatrix` transform with `emptyValue:"zero"` + a red threshold at 0 *renders* the
absent series as a red zero. For detection in a query/actuator, use **(f)**.

**(g) Per-daemon silence sweep — which of the 4 streams is quiet, all in one query (10m):**
```logql
sum by (service_name) (count_over_time({service_name=~`catalyst\.(broker|execution-core|monitor|otel-forward)`} | log_file_name=~`.+` [10m]))
```
Any `service_name` **missing** from the result, or showing `0`, is silent. This is the
recommended first probe (pair with **(f)** to confirm a missing stream is truly dead, not just
filtered out).

**Choosing N:** the daemons log at least at each scheduler/warmer tick, so a 10m window catches a
truly silent daemon without flapping on quiet-but-alive idle periods. Widen to `[20m]` if you see
false positives on a deliberately-idle node; never go below `[5m]` (normal idle gaps can exceed a
few minutes).

**(h) Currently-raised alerts** (broker `catalyst.alert.*` stream, net raised − cleared over 20m):
```logql
sum by (host_name, event_label, severity_text) (count_over_time({service_name=`catalyst.broker`} | event_entity=`alert` | event_action=`raised` [20m]))
  - (sum by (host_name, event_label, severity_text) (count_over_time({service_name=`catalyst.broker`} | event_entity=`alert` | event_action=`cleared` [20m]))
     or sum by (host_name, event_label, severity_text) (count_over_time({service_name=`catalyst.broker`} | event_entity=`alert` | event_action=`raised` [20m])) * 0)
```
⚠️ This alert stream filters on **`host_name`** (an OTel host attr), **NOT** `catalyst_node_name` —
the alert events don't carry the node tag. Observed live: only `needs_human_pileup`; `system_down`
is built-for but unverified; **no `cleared` event has ever been seen** (the 20m window is the
de-facto resolve). The richer spec payload (`kind/reason/source/count/threshold`) is **not** in
Loki — only `event_label` / `host_name` / `severity_text` / timestamp are queryable.

---

## 5. PromQL recipes

Counters only — durations/latencies live in **Loki**, not Prometheus. All `claude_code_*` series
carry `job="otel-collector"`. Verified label dims include `model`, `linear_key`, `type`,
`task_type`, `catalyst_role`, `model_family`, `hostname`, `host_name`. Use literal ranges like
`[5m]` / `[1h]` (the dashboard's `$__rate_interval` / `$__range`).

> **Per-node dimension on Prometheus is `host_name` / `hostname` — NOT `catalyst_node_name`.**
> `catalyst_node_name` is a **Loki-only structured-metadata label**; it does **not** exist as a
> Prometheus series or label. To split a Catalyst gauge by node, group `by (host_name)` (the unified
> dashboard does exactly this).

**(a) Cost rate by model (USD/s, last 5m):**
```promql
sum by (model) (rate(claude_code_cost_usage_USD_total{job="otel-collector"}[5m]))
```

**(b) Token burn by Linear ticket over the last hour** (the recovery-relevant "which ticket is spending" cut):
```promql
sum by (linear_key) (increase(claude_code_token_usage_tokens_total{job="otel-collector"}[1h]))
```

**(c) Token-usage rate split by type (input / output / cacheRead / cacheCreation):**
```promql
sum by (type) (rate(claude_code_token_usage_tokens_total{job="otel-collector"}[5m]))
```

**(d) Worker token-burn rate by role** (isolates Catalyst orchestration from interactive use):
```promql
sum by (catalyst_role) (rate(claude_code_token_usage_tokens_total{job="otel-collector",catalyst_role="worker"}[5m]))
```

**Host-pressure gauges** (OTel-semconv, ratios 0–1) and Catalyst gauges — split per node with `by (host_name)`:
```promql
system_cpu_utilization_ratio
system_memory_utilization_ratio
system_filesystem_utilization_ratio
catalyst_vcs_commits_behind      # how far a node's checkout lags origin/main
catalyst_worktree_count          # live worktrees per node
```

**Confirmed Prometheus counter families** (`claude_code_*`, dot→underscore, `_total` suffix):
`claude_code_cost_usage_USD_total`, `claude_code_token_usage_tokens_total`,
`claude_code_session_count_total`, `claude_code_commit_count_total`,
`claude_code_pull_request_count_total`, `claude_code_lines_of_code_count_total`.
**Catalyst info/gauge series:** `catalyst_build_info`, `catalyst_dispatch_mode`,
`catalyst_exec_context`, `catalyst_role`, `catalyst_orchestrator`,
`catalyst_vcs_commits_behind`, `catalyst_worktree_count`. *(The per-node dimension on these is the
`host_name` / `hostname` label — `catalyst_node_name` is Loki-only and is NOT a Prometheus series.)*

> `system_*_utilization_ratio` / `catalyst_*` gauges are confirmed present as **series names** in
> the unified dashboard, but were not live-queried to confirm they're populated on **every** node —
> check the result set before alerting on a missing node.

---

## 6. Structured-metadata + level-mapping gotchas

These two traps silently return wrong/empty results. Internalize them.

### Gotcha 1 — structured metadata filters with `|`, NOT `{}`

`service_name` is the **only** `{}`-selectable stream label. `catalyst_node_name`, `log_file_name`,
and `level` are **structured-metadata fields** — they MUST be filtered with `|` pipe expressions
**after** the stream selector.

```logql
# WRONG — returns ZERO results (catalyst_node_name is not a stream label)
{service_name=`catalyst.broker`, catalyst_node_name=`mini`}

# RIGHT — pipe filter after the selector
{service_name=`catalyst.broker`} | catalyst_node_name=`mini`
```

The Alloy shipper emits the resource attr `catalyst.node.name`; the OTLP→Loki dot→underscore
mapping makes it `catalyst_node_name`. (Naming note: the shipper **README** still describes this as
`catalyst.host.name` — that doc is **stale**. The runtime truth is `catalyst_node_name`; the
dashboard filters on it. Always use `catalyst_node_name`.)

You also **cannot enumerate** structured-metadata values via `label_values()` — the label/values
endpoint only lists stream labels. To discover which nodes are present, group a `count_over_time`
by `catalyst_node_name` (recipe **a**) and read the result series.

### Gotcha 2 — `level` is numeric pino, and the monitor has no level

`severity_text` is **empty** on these streams; severity is the **numeric pino `level`** structured
field. Map it to INFO/WARN/ERROR/FATAL with `label_format`:

```logql
| label_format sev=`{{ if eq .level "30" }}INFO{{ else if eq .level "40" }}WARN{{ else if eq .level "50" }}ERROR{{ else if eq .level "60" }}FATAL{{ else }}L{{ .level }}{{ end }}`
```

Values: `30`=INFO, `40`=WARN, `50`=ERROR, `60`=FATAL. To filter to WARN-and-above:
`| level=~`40|50|60``.

**The trap:** `catalyst.monitor` is plain text with **no `level` field**, so **any `| level=...`
filter silently drops the entire monitor stream**. When you need all four daemons (including the
monitor) — e.g. the silence sweep — **do not add a `level` filter**. Add it only when you
deliberately want pino-structured daemons (broker / execution-core / otel-forward).

---

## Things to flag before relying on them

1. **Alert LogQL (h)** filters on `host_name`, not `catalyst_node_name`; only `needs_human_pileup`
   observed live; no `cleared` event ever seen; the rich payload is not in Loki.
2. **`system_*` / `catalyst_*` gauges** confirmed as series names but not live-confirmed populated
   on every node.
3. **External Grafana URL** `otel.rozich.com` is the deployed stack (Tailscale `100.65.193.30`);
   the repo's checked-in datasources only carry internal docker URLs and a dev-stack README uses
   `localhost` — those are not the deployed query surface.
