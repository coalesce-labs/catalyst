# Runbook — the smee retirement, and how to undo it

**Status: smee is fully retired.** The **Linear** half went first, **2026-08-17 ~16:50–17:02 CT** (CTL-1928). The **GitHub** half followed **2026-08-18 13:58–14:16 CT** (CTL-1929, scope decided as CTL-1965 = B: *all eight* webhooks, not just `coalesce-labs/catalyst`).

⚠️ Read the scope section before touching anything. The two halves rode the *same* smee channel, so "turn smee back on" is not one switch — and the two halves have **separate** flags, **separate** rollback levers, and **different** consequences.

---

## 1. What is true now

Linear ingestion is the **cloud feed** (`execution-core/cloud-feed-timer.mjs`, gate `CATALYST_CLOUD_FEED=enforce`). The three dispatch-class events — `linear.issue.state_changed`, `linear.issue.updated`, `linear.comment.created` — are produced from the local replica and appended to `~/catalyst/events/YYYY-MM.jsonl`, where `monitor.mjs`'s existing tail dispatches them through the same three handlers as before. Nothing about dispatch *semantics* changed at the cutover; only the producer did.

| Surface | State after CTL-1928 |
| --- | --- |
| Linear smee tunnel (orch-monitor, `→ /api/webhook/linear`) | **not started** on either mini |
| 7 Linear webhook subscriptions (SLI/OTL/EVR/CTL/CTC/CRM/ADV) | **`enabled: false`**, not deleted |
| `catalyst.monitor.linear.smeeChannel` + the 7 per-team copies | `""` on both minis |
| Linear HMAC secret files, `webhookId` records, `/api/webhook/linear` route | **untouched** — rollback needs them |
| GitHub smee tunnel (orch-monitor, `→ /api/webhook`) | **not started** on either mini (suppressed at `enforce`) |
| 8 GitHub webhook subscriptions (see the table in §2.3) | **`active: false`**, not deleted |
| `catalyst.githubFeed.mode` (Layer-2) | `"enforce"` on both minis |
| `CATALYST_GITHUB_FEED` in `execution-core.env` | **deliberately unset** on both — see the ⛔ box in §2.3 |
| GitHub HMAC secret, `/api/webhook` route, `catalyst.monitor.github.smeeChannel` | **untouched** — rollback needs them |

### Why the GitHub half stayed until 2026-08-18 — and what changed

Everything below this heading was true when CTL-1928 shipped and is kept because it explains the shape of the GitHub leg. **Three things changed, and each was measured rather than assumed:**

1. **A GitHub producer now exists** — `execution-core/github-feed-timer.mjs`, gated by `catalyst.githubFeed.mode`, reading the same local replica the Linear leg reads.
2. **The last two coverage gaps closed with schema 0.1.18** (CTC-712 `check_suites. pull_request_numbers` + migration 0028; CTC-704 for `pushes`). Both were *statically* excluded in `lib/github-feed-names.mjs` and are resolved **per host at runtime** by `githubUncoveredNames(db)`, because the pin rolls as a canary. With 0.1.18 on both minis the runtime probe reports `pushIsLossy:false, checkSuiteHasPrAssociation:true` and **12 of 12** consumed names suppressible.
3. **Parity was measured on live traffic, not argued.** `execution-core/github-feed-parity-run.mjs` compares the two streams by multiplicity over a window. mini-2: `clean = true · exit 0` over 65 min, 60/60 agreeing. mini: 38/38 post-coverage, and 160/160 over 42 min.

⚠️ **Two instrument traps the ledger will hand you, both self-reported:**

- **A window whose `hi` lands at or after the producer's last tick manufactures its own gap.** The producer ticks every ~30 s; smee is immediate. The runner prints `window-outruns-producer` when this happens — believe it, and re-run with `hi` at least 3 min inside the producer's coverage before reading any `smee-unjoined` count.
- **A host reads dirty for every window that predates its own coverage.** mini emitted its first `check_suite.completed` at 18:16:25Z, ~15 min after its 0.1.18 writer kickstart; every such event before that instant is legitimately smee-only, because the gate correctly declined a name the host could not serve. Start the window after the host's first emission of the name you care about.

### ⛔ Why the GitHub half stayed (historical — the CTL-1928 reasoning)

The cloud feed replaces **Linear only**. `DISPATCH_CLASS_NAMES` in `cloud-feed-gate.mjs` is three `linear.*` names; there is no GitHub producer, and `catalyst-cloud` has no webhook ingestion route at all (verified by content, with a positive control — the string `webhook` *does* occur in that repo, in `packages/crypto` and `packages/read-model`, so the search works).

Measured on mini-2, 6 h window: **1,616 `github.*` events** — `workflow_run` 924, `check_suite` 375, `push` 120, `pr` 111, `issue_comment` 70, `deployment_status` 16. Those drive `phase-monitor-merge`'s `wait-for`, the broker's PR-lifecycle routing, and CI waits. Deleting the GitHub webhook would blind the fleet to all of it. Retiring the GitHub half is **not** part of this cutover and needs a cloud GitHub-ingestion path to exist first.

### ⚠️ One shared channel, not two

Both tunnels subscribed to the **same** smee channel (`https://smee.io/WDgeZys5ST0uqtL`) and forwarded every payload to *both* local routes. That is why the pre-cutover logs showed mirror-image histograms — e.g. 69× `200` on `/api/webhook` and 69× `401` on `/api/webhook/linear`, then 3× the reverse. **Those 401s were cross-delivery, not auth failure.** Anyone diagnosing a "Linear webhook 401 outage" from a one-sided count will reach the wrong conclusion; always read both routes' histograms together.

---

## 2. Rollback

Two independent levers. **Lever A alone restores Linear dispatch via smee**; Lever B is the belt-and-braces flip if you also want the cloud feed to stop suppressing the webhook copies.

### Lever A — put the smee path back (≈2 min)

1. **Re-enable the subscriptions** (they were disabled, not deleted, precisely so this is one call each — Linear **never re-issues a webhook secret**, so a deleted webhook must be re-registered *and* have its local HMAC secret file rewritten):

   ```bash
   # ids as of the cutover; re-read with `{ webhooks { nodes { id label enabled } } }`
   for id in ea6a4382-a5ba-4e9c-b300-569a342dea1c \
             1b8cef14-908e-42bd-bc6a-05d00ff79688 \
             864790b7-7e8d-4d11-969c-3a463e17a72d \
             0f9c3122-bdb7-411c-b403-77e895b8dfaa \
             747cee41-a078-4d7f-9380-95695bddb2f1 \
             da108fec-69a2-46f6-ae78-04adfee2e03e \
             2f8f316a-a959-4387-a96d-a41981ff4648; do
     curl -s -X POST https://api.linear.app/graphql \
       -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \
       -d "{\"query\":\"mutation{ webhookUpdate(id:\\\"$id\\\", input:{enabled:true}){ success } }\"}"
   done
   ```

2. **Restore the channel in Layer-2 config on each host.** Every host kept a pre-cutover backup at `~/.config/catalyst/config.json.bak-ctl1928-<ts>`; the smallest correct restore is to put the channel back, not to overwrite the whole file (it has moved on since):

   ```bash
   node -e '
     const fs=require("fs"),os=require("os"),p=os.homedir()+"/.config/catalyst/config.json";
     const c=JSON.parse(fs.readFileSync(p,"utf8"));
     c.catalyst.monitor.linear.smeeChannel="https://smee.io/WDgeZys5ST0uqtL";
     const t=p+".tmp"; fs.writeFileSync(t,JSON.stringify(c,null,2)+"\n",{mode:0o600});
     JSON.parse(fs.readFileSync(t,"utf8"));          // fail closed: rejects concatenated docs
     fs.renameSync(t,p);'
   ~/.catalyst/bin/catalyst-monitor restart
   ```

⚠️ **The top-level key is enough to restore, but was NOT enough to retire.** `readLinearSmeeChannel` (`orch-monitor/lib/webhook-config.ts`) falls back to the **first per-team entry's** `smeeChannel`, so retiring required clearing all 8 keys. Verified the hard way: clearing only the documented top-level key and restarting still brought the tunnel up.

3. **Verify by content** — `[linear-tunnel] … Forwarding …` must appear in `~/catalyst/monitor.log` under the *new* pid, and `grep -ac "linear-tunnel" ~/catalyst/monitor.log` must be non-zero. Use the GitHub tunnel's own lines as the positive control that the log is live at all.

### Lever B — stop the cloud feed driving dispatch

```bash
# per host: enforce -> shadow (smee copies stop being suppressed)
sed -i "" "s/^export CATALYST_CLOUD_FEED=enforce$/export CATALYST_CLOUD_FEED=shadow/" \
  ~/.config/catalyst/execution-core.env
~/.catalyst/bin/catalyst-execution-core restart
```

⚠️ That env file holds a live `ghp_` PAT — `grep` the one line, never `cat` it.

⛔ **Lever B is only a rollback when Lever A has already been done.** Before the cutover, flipping to `shadow` was safe because smee was still authoritative underneath. It no longer is: `shadow` with the Linear subscriptions disabled means **nothing** drives Linear dispatch. Order matters — A then B, never B alone.

### 2.3 GitHub — Lever C (put the webhooks back) and Lever D (stop the feed)

Same shape as A/B, same ordering rule: **C then D, never D alone.** At `enforce` the broker suppresses the smee copy for 12 names *and* orch-monitor never starts the tunnel, so flipping the mode back without re-enabling the webhooks leaves nothing driving `github.*` dispatch.

**Lever C — re-enable the eight webhooks (≈10 s).** They were disabled, never deleted, so the secret and the 12-event subscription survive and this is one `PATCH` each.

| repo | hook id |
| --- | --- |
| `coalesce-labs/catalyst` | `616654741` |
| `coalesce-labs/catalyst-cloud` | `657402518` |
| `coalesce-labs/catalyst-otel` | `657402515` |
| `coalesce-labs/evergreen` | `657402511` |
| `ryanrozich/personal-os` | `661338344` |
| `ryanrozich/slides` | `616654742` |
| `rightsite-cloud/Adva` | `616654744` |
| `rightsite-cloud/adva-crm` | `657251876` |

```bash
# ⛔ Guard on the channel URL before mutating: `rightsite-cloud/Adva` also carries an
# UNRELATED active hook (`605884530` → api.gitkraken.dev). Never PATCH by id alone.
for h in coalesce-labs/catalyst:616654741 coalesce-labs/catalyst-cloud:657402518 \
         coalesce-labs/catalyst-otel:657402515 coalesce-labs/evergreen:657402511 \
         ryanrozich/personal-os:661338344 ryanrozich/slides:616654742 \
         rightsite-cloud/Adva:616654744 rightsite-cloud/adva-crm:657251876; do
  r="${h%%:*}"; i="${h##*:}"
  gh api "repos/$r/hooks/$i" --jq '.config.url' | grep -q WDgeZys5ST0uqtL || {
    echo "REFUSED $r/$i"; continue; }
  gh api -X PATCH "repos/$r/hooks/$i" -F active=true >/dev/null    # ROLLBACK. Use false to re-retire.
done
```

⚠️ The block above is written **as the rollback** (`active=true`). The retirement ran the identical loop with `active=false`; do not copy it from here and change one word in a hurry.

Re-read every hook back from GitHub afterwards; do not trust the PATCH's own output. The **positive control** for the sweep is that unrelated GitKraken hook: a query for "any still-active hook" that returns *it* and nothing else is a query that still works.

**Lever D — stop the feed driving dispatch.**

```bash
# per host: enforce -> shadow, then restart ALL THREE readers
node -e '
  const fs=require("fs"),os=require("os"),p=os.homedir()+"/.config/catalyst/config.json";
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  c.catalyst.githubFeed.mode="shadow";
  const out=JSON.stringify(c,null,2); JSON.parse(out);   // fail closed before writing
  fs.writeFileSync(p+".tmp",out); fs.renameSync(p+".tmp",p);'
~/.catalyst/bin/catalyst-stack restart --yes
```

⛔ **`catalyst-stack restart`, not a single-daemon restart.** `CATALYST_GITHUB_FEED` has **four readers in three processes** — the producer (execution-core), the dispatch gate (broker), and the tunnel gate (orch-monitor), plus doctor. All three resolve it at **boot**, so restarting one leaves the host split.

⛔⛔ **AND `execution-core.env` MUST NOT PIN THIS FLAG.** `resolveGithubFeedMode` puts **env above Layer-2**, and `~/.config/catalyst/execution-core.env` is read by **execution-core alone**. A pin there splits the host in the worst direction — measured live on `mini`, 2026-08-18 14:09:47–14:13:21 CT:

| reader | resolved from | mode |
| --- | --- | --- |
| tunnel gate (orch-monitor) | Layer-2 | `enforce` → tunnel closed |
| dispatch gate (broker) | Layer-2 | `enforce` → smee suppressed for 12 names |
| **producer (execution-core)** | **`execution-core.env`** | ⛔ `shadow` → emits `would-dispatch` MARKERS |

Smee closed **and** the producer emitting markers = **nothing dispatches** for any of the 12 covered names, for 3m34s. Every instrument an operator would check read green: `github-feed gate: armed mode:"enforce"`, `suppressing GitHub webhook smee tunnel start`, `catalyst-stack status` all-running, Layer-2 `"enforce"`. Set the mode in Layer-2; leave the env var unset. → CTL-2011 makes `catalyst doctor` FAIL on the disagreement.

### 2.4 Verify a GitHub flip by content — four checks, and only one of them catches the split

Run all four **per host**. Checks 2 and 3 passed throughout the incident above.

```bash
# 1. the PRODUCER's own readiness record — mode AND freshness
cat ~/catalyst/execution-core/shadow/github-feed-ready-tenant-0.json
#    want: {"ready":true,"unready":null,"mode":"enforce", "at":<within ~60s>}
#    ⛔ a FRESH file with the WRONG mode is the split. Freshness alone is not the check.

# 2. the broker's dispatch gate
grep -a "github-feed gate: armed" ~/catalyst/broker.log | tail -1
#    want: "mode":"enforce" AND readyFile under execution-core/shadow/ (CTL-1976)

# 3. the tunnel gate
grep -ac "suppressing GitHub webhook smee tunnel start" ~/catalyst/monitor.log   # >= 1
grep -ac "webhook-tunnel" ~/catalyst/monitor.log                                 # must be 0

# 4. a REAL dispatch-class event on the feed, plus the negative half
grep '"event.channel":"cloud-feed"' <(tail -c 3000000 ~/catalyst/events/$(date -u +%Y-%m).jsonl) | tail -3
#    want >= 1 github.* with "feedAuthority":true, and ZERO "event.channel":"webhook"
#    github.* events after the flip.
```

### 2.5 ⚠️ What a rollback re-adopts

Rolling back is correct if dispatch breaks, but it is not a return to a *better* leg. Two smee weaknesses were measured on the way out, both with positive controls:

- **A dropped delivery.** For `coalesce-labs/catalyst@5d842e7e`, GitHub's API reports 4 completed-`success` check suites. The feed emitted **4**; smee delivered **3** to `mini`. The missing delivery id appears **zero** times in mini's whole 1.57 GB event log, while a control delivery id from the same window appears once — so the event is genuinely absent, not missed by the search.
- **~5% rejected at the door.** In the 13 min after a restart, mini's monitor logged **7 × `401`** against **132 × `200`** on `/api/webhook`. A 401'd delivery never reaches the event log at all. (Cause unattributed; it is *not* a per-repo secret gap.) Note the direction — a 401 hides an event from the **smee** side, which makes the parity ledger report `feed-unjoined`. It biases the instrument **against** a cutover, so it can never manufacture a false CLEAN.

### 2.6 ⛔ What the GitHub cutover cost — the PR caches

`pr_status_cache` and `pr_cache` (`~/catalyst/filter-state.db`) are written **only** by orch-monitor's webhook handler (`orch-monitor/lib/pr-cache.ts`). Nothing on the feed path writes them, and `lib/pr-status-backfill.ts` is **one-shot by design** ("skipped entirely when the table already has rows … a migration step, not a poll"). **They froze at the cutover.**

Measured A/B at 14:02 CT, one variable, the same merge (`catalyst-cloud#882`): `mini` (tunnel open) recorded it `merged` at 18:59:42Z; `mini-2` (tunnel closed) still read `open` from 18:42:27Z, with **0** rows written to either table after its flip.

`getAllPrStatuses()` reads `pr_status_cache` as its **primary** source (`filter_state` is empty on every execution-core host) and feeds `scheduler.mjs` and `board-health.mjs`. Both guard on `map.size === 0 → observable:false` — a **frozen non-empty** map defeats that guard: it looks observable and answers wrong, and it rots with time. `checkPhantomMergedPr` goes blind; `checkOrphanedOpenPr` accumulates false positives.

**This is not dispatch loss** — the feed carries `github.pr.merged` with its `mergeCommitSha`. It is detector rot. → **CTL-2008**. Lever C restores the caches.

---

## 3. What this removed that you may still be relying on

- **The `shadow`-flip containment lever.** Cutting the writer over to `shadow` around a `cloud-sync` restart used to be safe *because smee stayed authoritative*. Post-retirement there is no second stream, so a re-seeding writer restart is defended **only** by the CTL-1920 torn-read guard. That guard is merged, loaded and mutation-tested, but as of the cutover it had **never fired in production**. Treat the first re-seed after this date as the guard's real first test and watch `catalyst.linear` event volume across it.
- **The parity harness's comparison stream** (CTL-1916). It compared the feed against smee out of one log; with smee's Linear side silent it now has one input and can only ever report agreement. Retire or repurpose it deliberately — an instrument that cannot disagree is not a check.
- **CTL-1841's route-comparison alarm** (`webhook-route-health.ts`). It cannot false-page — `raise` requires a *recent non-2xx* on the Linear route and that route now receives nothing — but for the same reason it can never fire again. Note its in-code comment ("GitHub and Linear use INDEPENDENT smee channels") was already wrong on this fleet, and the shared channel had it **latched raised on both minis** at cutover time, because GitHub cross-delivery kept making the last Linear-route outcome a 401.

---

## 4. App authorizations — what drops, and what does not

Short answer: **nothing drops from this cutover.**

- The 7 Linear webhook subscriptions were **workspace webhooks created with a personal API key** (`creator: Ryan Rozich`), not per-host app grants. Disabling them changes no app authorization.
- **CATALYST / CATALYST Orchestrator (Linear app-actors) stay.** They are how the daemon *writes* — status transitions, labels, mirrored comments — and how `catalyst-monitor` authenticates ("authenticated as Catalyst Orchestrator app-actor, isolated 5000/hr bucket"). Reads still come from the replica, which the cloud writer fills. These drop only when **CTL-1889** moves daemon writes behind the cloud write proxy.
- **GitHub app authorizations stay** — the GitHub webhook and `gh` operations are untouched by this ticket.

---

## 5. New-host installs

`join-bundle.mjs` no longer emits the Linear webhook block, and `catalyst-join.sh` strips it from any bundle that still carries one (a bundle is a file that outlives the code that wrote it). The whole block goes — both the top-level channel and the per-team `webhookId` map — because the per-team entry alone is enough to start a tunnel, and a `webhookId` arriving without its HMAC secret is what `catalyst doctor` grades as half-wired config residue.

A **declared-`cloud`** node already created no smee wiring before this ticket (`catalyst-join.sh`'s gate settles on `decision=skip` for any recognized non-cluster mode); CTL-1928 additionally makes a **cluster** join stop re-creating the retired Linear path.

`catalyst doctor` needs no change and got none for this: measured on both minis after the cutover it reports `[PASS] webhook-ingestion: webhook ingestion wired (github=true, linear=false, linear keys=7)`. Its declared-`cloud` WARN text was corrected, though — it used to say such a node had "no event ingestion at all", which is now wrong in the direction that sends an operator hunting a Linear outage that does not exist.

## 6. Proving a host is actually running the code — `verify-loaded.sh` (CTL-1916)

```bash
plugins/dev/scripts/verify-loaded.sh --root ~/catalyst/plugin-source --host mini-2 --mode enforce
plugins/dev/scripts/verify-loaded.sh --root ~/catalyst/plugin-source --host laptop --role monitor
```

⛔ **A git sha on disk is not evidence.** It proves the bytes arrived; it says nothing about what the running process is executing. Every link below is anchored on the **live pid**, and the fourth is the one that makes the difference explicit — a daemon that started *before* the file changed is serving the previous bytes no matter how current the checkout looks. That is not a hypothetical: it is the whole content of CTL-1919 (a writer serving a checkout three schema versions stale while every git-level check on the host read clean), and of CTL-1659 before it.

| link | question | why it is not covered by the others |
| --- | --- | --- |
| `serving-root` | does the live pid's argv name the root it is required to serve? | read from the process table, never a pid **file** — a pid file is a claim written at some past moment, and a recycled pid makes it a confident lie |
| `gate-module` | is the module present **and importable** from that root? | present-but-unimportable is the CTL-1831 shape (a broken transitive resolution) and reads as "installed" to every git-level check |
| `armed-line` | did **this pid** write the mode line? | anchored on the pid, because a log is append-only across restarts — an unanchored grep happily matches the line a *previous* process wrote before the rollback you are checking for |
| `started-after` | did the pid start after the module's mtime? | links 1–3 all pass for a daemon that booted before the pull landed |

Every link **fails closed**: "I could not measure it" exits non-zero and names the link. `--role monitor` **asserts the absence** of an execution-core daemon rather than skipping — a skipped link reports the same "no complaint" as a verified one.

⚠️ The declared **mode** and the runtime **`armed`** flag are different facts and the tool prints both. Measured on the fleet 2026-08-17, mini-2 reports `mode=enforce` with `armed=false`: enforce is configured, the feed is not currently armed (CTL-1909). That is a runtime condition, not a load failure, so it is surfaced rather than failed — failing it would make a correctly-loaded host report FAIL and train operators to ignore the tool.

Tests: `plugins/dev/scripts/__tests__/verify-loaded.test.sh`, gated in CI. Both controls are present — a correctly-loaded fixture PASSES, and each failure case changes exactly one fact, so a green result is evidence about that fact rather than about the harness.

### Parity sampling — a one-liner, not a script

The overnight sampler that lived at `~/catalyst/parity-hourly.sh` on mini-2 is **retired** (CTL-1916). It was hand-placed and untracked, it was never scheduled, and since the Linear smee retirement (CTL-1928) the parity run has only one stream left to look at, so it can report agreement but no longer a *comparison*. Run the CLI directly when you want a sample:

```bash
cd ~/catalyst/plugin-source && \
  bun plugins/dev/scripts/execution-core/linear-feed-parity-run.mjs --since-min 60
```

⚠️ If you ever need it on a loop again, put the deadline **inside** the loop and make it sleep, never spin — `end=$((SECONDS+N)); while [ $SECONDS -lt $end ]; do sleep 60; done`. Cleanup must never be load-bearing (AGENTS.md); four spinners once leaked out of one test run here and burned ~4 CPU-cores for 16.5 h while the script reported `cleanup verified`.
