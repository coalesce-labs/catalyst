# Linear workspace migration — cutover plan

> **STATUS 2026-08-10 ~20:30Z — CUTOVER EXECUTED AND VERIFIED.** Everything below the "Outcome"
> section is the pre-execution plan, retained as the record of what was predicted vs. what happened.
> The live coordination log (`~/catalyst/comms/md-channels/ctc-ctl-linear-workspace-cutover.md`, 67+
> turns across MIGRATION / CTL / CTC) is authoritative.

## Outcome

**Destination:** `Coalesce Labs, LLC` (`coalesce-labs`), org `4d9e27a0-de8a-42b9-ae1a-f9fa1151a2d8`.
Team keys and human issue identifiers **survived**; internal UUIDs did **not**.

| gate | proven able to fail | final |
|---|---|---|
| teamId identity (21 assertions) | 21/21 RED | **7/7 on all three hosts** |
| P1 workspace identity by value | 0 of ~248 cached state UUIDs valid | **red=0 on all three hosts** |
| Replica ghost rows | 7,412 rows / 2 UUIDs per key | **3,706 / 1 per key** |
| P2 ingestion round trip | — | **PASS** |
| P3 self-echo (issue events) | — | **PASS**, positive + negative control |
| Cloud C1–C5 (CTC) | — | **PASS** |

**Destination team UUIDs** (derived independently by CTL and by MIGRATION; 8/8 agreement):

```
org 4d9e27a0-de8a-42b9-ae1a-f9fa1151a2d8
CTL f317bf00-653d-48d8-8a8b-1656b3534d7a   ADV 2ffa6e98-e247-4b3e-9c3a-4af9cca8564e
CTC b1cb702f-f1f0-404a-8a72-b5d806a9a647   CRM 26560be8-fbc9-4bb0-94e1-9188d2f39bf2
OTL 57b99f4f-df7b-416e-a05e-a773df5b24a4   EVR 6897a0af-357e-420c-9803-279286bd52f7
SLI 6327016b-bb3d-4030-9db9-352715075a54
```

Retired from the fleet: **POS, MCP, JOB** (registered but never cloud-mirrored, zero replica rows).

### Durability PRs

`catalyst#3201` · `catalyst-otel#134` · `adva-crm#15` · `evergreen#110` · `slides#94` ·
`catalyst-cloud#303` + **#304** (declarative `tenants.jsonc` reversion path) — all MERGED.
**`Adva#1239` — 14 checks green, blocked on human approval only.** That is the last open item.

### Still open / handed back

- **`Adva#1239` needs approval** (CTL is the author).
- **All-clear boot** — P4 (full dispatch loop) and P3's comment/inbox half deliberately deferred to a
  watched boot, because execution-core's first tick dispatches real work against a live board.
- **mini/OTL `.envrc`** — stashed, conflicted on restore, patch at
  `~/catalyst/salvage/cutover-config-patches/mini-OTL-envrc.patch`. Needs someone who knows the change.
- **SLI primary worktree** is on `codex/omnisphere-workshop-readout`, not `main`.
- **`syncProfileFiles` has no size/diff guard** — a 40→3 truncation reads as a healthy sync. Latent
  (minis already at the 3-var worker subset; the 40-var laptop runs no execution-core). Backups at
  `~/catalyst/salvage/direnv-profiles-pre-boot-*`. **Do not "fix" the 3-vs-40 asymmetry by enriching
  SOPS** — that would push 35 developer credentials onto both minis.

### What actually made this hard

Not UUID mapping alone. Effort split roughly identity 30% / credentials 30% / distribution 25% /
design 15% — but **risk** was anti-correlated: credentials fail LOUD (401), identity fails GREEN.
The single most valuable discipline was **asserting workspace identity by value**, and building every
gate so it was seen RED before it was trusted GREEN. Two of the day's misses were failures of the
*checker*, not the code: a sweep that silently truncated itself at `head -8`, and an assertion proven
red but never once run green.

---


## The pre-execution plan (historical — retained as the prediction record)

**Status as written:** import done; fleet paused; three-party consensus reached 2026-08-10T16:36Z.
See **Outcome** above for what actually happened. **Live coordination log:**
`~/catalyst/comms/md-channels/ctc-ctl-linear-workspace-cutover.md`. **Pause/reversal record:**
`thoughts/shared/linear-workspace-migration-PAUSE-STATE.md`.

Participants: **MIGRATION** (Codex agent, Linear-side work), **CTL** (this repo — hosts, orch-monitor,
credentials), **CTC** (catalyst-cloud — mirror, D1, Cloudflare).

> **This doc was rewritten 16:45Z.** The first version planned for `CTL-1740 → NEW-45` identifier
> change and flagged a `CAT-*` collision as the sharpest hazard. **Both are moot** — see §1. The
> earlier version's traps are preserved in §5 only where they still apply.

---

## 1. What actually happened (established facts)

Native Linear-to-Linear import, **already complete**: source `Rozich` → destination
`Coalesce Labs, LLC` (slug `coalesce-labs`). 10 teams, 3,823 issues, 82 projects, 9 initiatives,
comments, relationships, labels, cycles, statuses, archived data.

- ✅ **Team keys and human issue identifiers SURVIVED** (`CTL-1740` is still `CTL-1740`).
- ❌ **Linear internal UUIDs did NOT** — teams, workflow states, labels, projects, users
  (incl. `botUserId`), plus OAuth apps, webhooks, API keys and integrations.
- `Rozich` is **paused and intact** as the rollback source; Linear holds a **14-day rollback record**.
- The destination has no live integrations, OAuth apps, webhooks or personal API keys yet.

**Identifier preservation deleted a large chunk of planned work.** Branch names (`ryan/ctl-1740-slug`),
open PR titles, ~40 worktrees, the `thoughts/` corpus, the event log, the retro/estimation history and
`cluster.json`'s `anchorIssue: CTL-1217` all still resolve. **No old→new translation table is needed.**
CTC retained the old `UUID ↔ identifier ↔ url` triples in `thoughts/shared/migration/` purely so an old
row can be audited after the purge.

The cost of that good news is §2.

---

## 2. 🔴 The two silent failures this cutover is most likely to have

Both were found by reading source, not by inference. Both fail **green**.

**Host side (CTL).** Every Catalyst identity cache is keyed by **team key alone, with no workspace,
org or tenant field** — `linear-state-ids.json` (~100 workflow-state UUIDs; 88 on mini, 60 on mini-2,
100 on laptop), `linear-team-keys.json`, `linear-git-automation-cache.json`, `eligible/<KEY>.json`,
replica `issues.team_key`. And `resolve-linear-ids.sh:80-90` short-circuits:
`"stateIds already cached ($COUNT states). Use --force to re-resolve."` Because the key survived, `CTL`
still resolves, the resolver **skips**, and the daemon writes transitions against **dead Rozich state
UUIDs**. `linear-transition.sh` re-resolves only on an empty *name*, so it won't catch it either.

**Cloud side (CTC).** The Linear delta legs are fenced by `team: { id: { in: teamIds } }` from
`projects.linear_team_id` in D1. Empty `teamIds` ⇒ legs skipped, `writeCursor` never called, freshness
honestly goes **red** (safe). Non-empty-but-stale ⇒ the walk **runs**, matches zero, upserts zero, and
`writeCursor` is called **unconditionally** ⇒ `/freshness` stays **GREEN** while nothing ingests. Worse,
on a 0 cursor `maxUpdatedAt` returns the fallback, so one stale pass **jumps the watermark to `now`** and
buries all pre-cutover history beneath it.

> **Consequence adopted as a hard gate by all three agents:** a verification built on team keys or issue
> identifiers is *structurally incapable* of detecting either failure. Success is asserted on
> **workspace identity by value** (P1 / C1) — never "the key is present" or "`CTL-1740` resolves".

**Third, host-side:** `cluster-sync.mjs:13-16` deep-merges `cluster-bots.sops.json` over node-local
`config.json` and **"overlays bot creds" — SOPS wins**. Hand-placed destination credentials are
silently reverted to Rozich values on the first daemon boot unless SOPS is updated too. Same for
`config-<projectKey>.sops.json` (carries `.linear.apiToken`) and `node-secret-files.sops.json` (carries
`linear-webhook-secret-{adv,ctl,evr,otl,sli}` — note **crm and ctc are node-local exceptions**).
`~/.zshenv` is *not* SOPS-managed. **Rule: every credential lands in BOTH the node-local destination AND
its SOPS source, before first boot.**

---

## 3. Fleet pause state

Stopped on mini and mini-2: execution-core daemon, orch-monitor, broker, daemon-watchdog, otel-forward.
Verified 0 processes, 0 `claude` workers, held past the resurrection window.

- `catalyst-stack stop` alone is **insufficient** — an `ai.coalesce.catalyst-stack` LaunchAgent
  (`RunAtLoad=true`, `StartInterval=600`) re-runs `catalyst-stack start --yes`. It was `bootout`'d
  **and** `disable`d (bootout alone doesn't survive reboot). **Unpause needs `launchctl enable` BEFORE
  `bootstrap`**, or it silently no-ops.
- **Do not pause with the drain flag** — `applyBootDrainPolicy` (`config.mjs:279`) deletes it on every
  daemon boot by design (CTL-1321).
- CTC disabled the `Linear sync` GitHub workflow (id 301419377) — the merge→Linear "Done" writer.
  Reverse with `gh workflow enable "Linear sync"`, and only as the **last** step.

Left running (verified non-writers to Linear): cloud-sync, health-responder, com.catalyst.agent,
thoughts-sync, log-shipper, orphan-sweep.

---

## 4. Agreed canonical order (turn 08, as amended by turns 09 and 10)

1. CTC lands a scoped `POST /admin/purge` CI-green (**§5.1** — there is no purge path today); CTL
   completes reversible prep; no ID-cache purge, no boot.
2. MIGRATION creates 3 destination OAuth apps (Cloud Sync webhook **disabled**), 4 API keys, 7
   standalone webhooks; stages **18 secrets**; posts only public identifiers + byte counts.
3. CTL dual-places its **16** (node-local + SOPS) and reports `MATCH`; CTC installs its **2** into
   Cloudflare Secrets Store **and** the GitHub Actions copy.
4. CTC: archive all 7 projects (⇒ `teamIds` empty = safe mode) → `C5'` atomic D1 credential-delete +
   `linear_workspace_id` update → install destination team UUIDs → reactivate → purge → resync →
   non-zero reconcile.
5. MIGRATION enables the Cloud Sync webhook **only** on CTC's C6' signal; CTC reports C1–C5.
6. CTL: wipe `ticket_state` (**§5.2**), purge ID caches, `resolve-linear-ids.sh --force` per repoRoot
   per host, run `setup-execution-core-states.sh`, install configs, wipe/reseed replica **only after
   CTC's `VERIFIED`**, run P1–P4 under controlled boot.
7. Reconnect + smoke-test GitHub, Slack/Asks, Notion, Codex, Cursor, Raycast, Neat; re-run the states
   script so `gitAutomationState` wiring is non-null.
8. **8a** all-clear → unpause → remove staging. **8b** soak. **8c** only then consider retiring source
   credentials. **Rozich stays paused-but-intact for the full 14-day rollback window regardless.**

### Probes (all adopted as gates)

| | assertion |
|---|---|
| **P1** | workspace identity by value — a `--force`-resolved state UUID matches the destination and a transition write against it succeeds |
| **P2** | ingestion round trip — mutate a disposable destination issue, event lands on `~/catalyst/events/*.jsonl` with correct team routing |
| **P3** | self-echo guard — post as app-actor on a `needs-human` ticket; must NOT clear the label, must NOT reach a worker inbox |
| **P4** | one full dispatch loop on a scratch ticket, Triage → Todo |
| **C1** | `accounts.linear_workspace_id` equals the destination org UUID, by value |
| **C2** | `POST /admin/reconcile` returns `report.linear.issues > 0` — zero is the failure signature, not quiet |
| **C3** | `/admin/record?entity=issues&key=CTC-393` returns exactly one row, with a destination UUID |
| **C4** | live webhook round trip without a reconcile — proves the 202-drop window is closed |
| **C5** | after reseed, 7 team keys present and `MAX(updated_at)` **moves** |

---

## 5. Open items

### 5.1 CTC is building the only code change
There is **no purge path** in catalyst-cloud today (`/admin/resync` resets cursors, does not truncate).
Because identifiers survived but UUIDs did not, a reseed **inserts a parallel set** — two rows per
ticket, one frozen and unreachable, which is a wrong-state hazard for dispatch. CTC is building a scoped
`POST /admin/purge` + cursor reset. It gates the fleet unpause.

### 5.2 ⛔ Needs Ryan — blocked by the safety classifier
Wiping the stale broker cache was blocked as a destructive DB operation and was **not** routed around:

```bash
sqlite3 ~/catalyst/filter-state.db "DELETE FROM ticket_state;"   # laptop, mini, mini-2
# snapshots exist at ~/catalyst/filter-state.db.pre-linear-cutover on all three hosts
```

Required because `fenceGuard` (`fence-guard.mjs:179-197`) defaults to fail-closed and *"a projection
that positively names a foreign owner is a KNOWN answer, and stays fail-closed regardless"* — a stale
row naming a dead owner host suppresses mutating daemon writes **permanently and silently**. An empty
table is merely "can't tell", which self-heals on the next dispatch and still lets escalations through.
1,093 rows on the laptop, 320 carrying Linear UUIDs.

### 5.3 The config install is 7 repos × 3 hosts, and nothing automates it
Each mini has its **own clone** of all seven repoRoots (`/Users/ryanrozich/code-repos/...`), each with a
git-tracked `catalyst.linear.teamId`. mini's CTL clone still carries the dead `e7e703c4-…` on `main`.
`catalyst-updater` is **laptop-only** and the broker's plugin-refresh advances only `plugin-source` — so
a laptop commit reaches the minis **never**. A miss is silent: `teamIdentityOf` only WARNs and
`registry-team-identity` never FAILs by design. **21 assertions, not one.**

Mitigating mechanic: `resolve-linear-ids.sh` resolves the team **by key** via GraphQL and then *writes*
`teamId` into whatever `--config` path it's given — so one `--force` run per repoRoot per host both
re-resolves stateIds and installs the correct destination `teamId`. Also update
`plugins/dev/scripts/__tests__/config-schema.test.mjs:133`, which pins the live teamId, or CI goes red.

---

## 6. CTL prep completed

| action | mini | mini-2 | laptop |
|---|---|---|---|
| source credentials snapshotted `.pre-linear-cutover` | ✅ | ✅ | ✅ |
| worker dirs → `workers.pre-cutover-20260810/` | 16 | 38 | n/a |
| 9 identifier-keyed marker dirs parked | ✅ | ✅ | — |
| eligible projections parked | 7 (+1 stale bak) | 7 | — |
| execution layer stopped; stack agent bootout **+ disabled** | ✅ | ✅ | n/a |
| `ticket_state` wiped | ⛔ §5.2 | ⛔ | ⛔ |

Worker-dir parking disarms `boot-resume.mjs`, which has **no drain check** and launches workers
synchronously at daemon boot (`daemon.mjs:1190`) — with identifiers preserved, every one of those 54
parked entries would have resolved against the *new* workspace and looked legitimate. Per CTC's ruling:
all 20 `CTC-*` dirs parked, none resumed.

## 7. Retired scope

Not carried across: **POS and MCP** — dispatch-registered but with zero replica rows, and CTC confirmed
they have never been cloud-mirrored (no D1 `projects` row in any status). **JOB** exists only in a stale
cache. Standalone webhook scope is final at **seven**: ADV, CRM, CTC, CTL, EVR, OTL, SLI.
