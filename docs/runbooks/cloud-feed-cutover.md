# Runbook — the Linear smee retirement, and how to undo it

**Status:** the Linear half of smee ingestion was retired on the live fleet
**2026-08-17 ~16:50–17:02 CT** (CTL-1928). The GitHub half is deliberately still
running. Read the scope section before touching anything — the two halves rode
the *same* smee channel, so "turn smee back on" is not one switch.

---

## 1. What is true now

Linear ingestion is the **cloud feed** (`execution-core/cloud-feed-timer.mjs`,
gate `CATALYST_CLOUD_FEED=enforce`). The three dispatch-class events —
`linear.issue.state_changed`, `linear.issue.updated`, `linear.comment.created` —
are produced from the local replica and appended to `~/catalyst/events/YYYY-MM.jsonl`,
where `monitor.mjs`'s existing tail dispatches them through the same three
handlers as before. Nothing about dispatch *semantics* changed at the cutover;
only the producer did.

| Surface | State after CTL-1928 |
| --- | --- |
| Linear smee tunnel (orch-monitor, `→ /api/webhook/linear`) | **not started** on either mini |
| 7 Linear webhook subscriptions (SLI/OTL/EVR/CTL/CTC/CRM/ADV) | **`enabled: false`**, not deleted |
| `catalyst.monitor.linear.smeeChannel` + the 7 per-team copies | `""` on both minis |
| Linear HMAC secret files, `webhookId` records, `/api/webhook/linear` route | **untouched** — rollback needs them |
| GitHub smee tunnel + repo webhook `616654741` | **RUNNING — deliberately kept** |

### ⛔ Why the GitHub half stayed

The cloud feed replaces **Linear only**. `DISPATCH_CLASS_NAMES` in
`cloud-feed-gate.mjs` is three `linear.*` names; there is no GitHub producer, and
`catalyst-cloud` has no webhook ingestion route at all (verified by content, with
a positive control — the string `webhook` *does* occur in that repo, in
`packages/crypto` and `packages/read-model`, so the search works).

Measured on mini-2, 6 h window: **1,616 `github.*` events** — `workflow_run` 924,
`check_suite` 375, `push` 120, `pr` 111, `issue_comment` 70, `deployment_status` 16.
Those drive `phase-monitor-merge`'s `wait-for`, the broker's PR-lifecycle routing,
and CI waits. Deleting the GitHub webhook would blind the fleet to all of it.
Retiring the GitHub half is **not** part of this cutover and needs a cloud
GitHub-ingestion path to exist first.

### ⚠️ One shared channel, not two

Both tunnels subscribed to the **same** smee channel
(`https://smee.io/WDgeZys5ST0uqtL`) and forwarded every payload to *both* local
routes. That is why the pre-cutover logs showed mirror-image histograms — e.g.
69× `200` on `/api/webhook` and 69× `401` on `/api/webhook/linear`, then 3× the
reverse. **Those 401s were cross-delivery, not auth failure.** Anyone diagnosing
a "Linear webhook 401 outage" from a one-sided count will reach the wrong
conclusion; always read both routes' histograms together.

---

## 2. Rollback

Two independent levers. **Lever A alone restores Linear dispatch via smee**;
Lever B is the belt-and-braces flip if you also want the cloud feed to stop
suppressing the webhook copies.

### Lever A — put the smee path back (≈2 min)

1. **Re-enable the subscriptions** (they were disabled, not deleted, precisely so
   this is one call each — Linear **never re-issues a webhook secret**, so a
   deleted webhook must be re-registered *and* have its local HMAC secret file
   rewritten):

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

2. **Restore the channel in Layer-2 config on each host.** Every host kept a
   pre-cutover backup at `~/.config/catalyst/config.json.bak-ctl1928-<ts>`; the
   smallest correct restore is to put the channel back, not to overwrite the
   whole file (it has moved on since):

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

   ⚠️ **The top-level key is enough to restore, but was NOT enough to retire.**
   `readLinearSmeeChannel` (`orch-monitor/lib/webhook-config.ts`) falls back to
   the **first per-team entry's** `smeeChannel`, so retiring required clearing
   all 8 keys. Verified the hard way: clearing only the documented top-level key
   and restarting still brought the tunnel up.

3. **Verify by content** — `[linear-tunnel] … Forwarding …` must appear in
   `~/catalyst/monitor.log` under the *new* pid, and
   `grep -ac "linear-tunnel" ~/catalyst/monitor.log` must be non-zero. Use the
   GitHub tunnel's own lines as the positive control that the log is live at all.

### Lever B — stop the cloud feed driving dispatch

```bash
# per host: enforce -> shadow (smee copies stop being suppressed)
sed -i "" "s/^export CATALYST_CLOUD_FEED=enforce$/export CATALYST_CLOUD_FEED=shadow/" \
  ~/.config/catalyst/execution-core.env
~/.catalyst/bin/catalyst-execution-core restart
```

⚠️ That env file holds a live `ghp_` PAT — `grep` the one line, never `cat` it.

⛔ **Lever B is only a rollback when Lever A has already been done.** Before the
cutover, flipping to `shadow` was safe because smee was still authoritative
underneath. It no longer is: `shadow` with the Linear subscriptions disabled
means **nothing** drives Linear dispatch. Order matters — A then B, never B alone.

---

## 3. What this removed that you may still be relying on

- **The `shadow`-flip containment lever.** Cutting the writer over to `shadow`
  around a `cloud-sync` restart used to be safe *because smee stayed
  authoritative*. Post-retirement there is no second stream, so a re-seeding
  writer restart is defended **only** by the CTL-1920 torn-read guard. That guard
  is merged, loaded and mutation-tested, but as of the cutover it had **never
  fired in production**. Treat the first re-seed after this date as the guard's
  real first test and watch `catalyst.linear` event volume across it.
- **The parity harness's comparison stream** (CTL-1916). It compared the feed
  against smee out of one log; with smee's Linear side silent it now has one
  input and can only ever report agreement. Retire or repurpose it deliberately —
  an instrument that cannot disagree is not a check.
- **CTL-1841's route-comparison alarm** (`webhook-route-health.ts`). It cannot
  false-page — `raise` requires a *recent non-2xx* on the Linear route and that
  route now receives nothing — but for the same reason it can never fire again.
  Note its in-code comment ("GitHub and Linear use INDEPENDENT smee channels") was
  already wrong on this fleet, and the shared channel had it **latched raised on
  both minis** at cutover time, because GitHub cross-delivery kept making the
  last Linear-route outcome a 401.

---

## 4. App authorizations — what drops, and what does not

Short answer: **nothing drops from this cutover.**

- The 7 Linear webhook subscriptions were **workspace webhooks created with a
  personal API key** (`creator: Ryan Rozich`), not per-host app grants. Disabling
  them changes no app authorization.
- **CATALYST / CATALYST Orchestrator (Linear app-actors) stay.** They are how the
  daemon *writes* — status transitions, labels, mirrored comments — and how
  `catalyst-monitor` authenticates ("authenticated as Catalyst Orchestrator
  app-actor, isolated 5000/hr bucket"). Reads still come from the replica, which
  the cloud writer fills. These drop only when **CTL-1889** moves daemon writes
  behind the cloud write proxy.
- **GitHub app authorizations stay** — the GitHub webhook and `gh` operations are
  untouched by this ticket.

---

## 5. New-host installs

`join-bundle.mjs` no longer emits the Linear webhook block, and
`catalyst-join.sh` strips it from any bundle that still carries one (a bundle is
a file that outlives the code that wrote it). The whole block goes — both the
top-level channel and the per-team `webhookId` map — because the per-team entry
alone is enough to start a tunnel, and a `webhookId` arriving without its HMAC
secret is what `catalyst doctor` grades as half-wired config residue.

A **declared-`cloud`** node already created no smee wiring before this ticket
(`catalyst-join.sh`'s gate settles on `decision=skip` for any recognized
non-cluster mode); CTL-1928 additionally makes a **cluster** join stop re-creating
the retired Linear path.

`catalyst doctor` needs no change and got none for this: measured on both minis
after the cutover it reports
`[PASS] webhook-ingestion: webhook ingestion wired (github=true, linear=false, linear keys=7)`.
Its declared-`cloud` WARN text was corrected, though — it used to say such a node
had "no event ingestion at all", which is now wrong in the direction that sends an
operator hunting a Linear outage that does not exist.

## 6. Proving a host is actually running the code — `verify-loaded.sh` (CTL-1916)

```bash
plugins/dev/scripts/verify-loaded.sh --root ~/catalyst/plugin-source --host mini-2 --mode enforce
plugins/dev/scripts/verify-loaded.sh --root ~/catalyst/plugin-source --host laptop --role monitor
```

⛔ **A git sha on disk is not evidence.** It proves the bytes arrived; it says nothing
about what the running process is executing. Every link below is anchored on the **live
pid**, and the fourth is the one that makes the difference explicit — a daemon that
started *before* the file changed is serving the previous bytes no matter how current the
checkout looks. That is not a hypothetical: it is the whole content of CTL-1919 (a writer
serving a checkout three schema versions stale while every git-level check on the host
read clean), and of CTL-1659 before it.

| link | question | why it is not covered by the others |
| --- | --- | --- |
| `serving-root` | does the live pid's argv name the root it is required to serve? | read from the process table, never a pid **file** — a pid file is a claim written at some past moment, and a recycled pid makes it a confident lie |
| `gate-module` | is the module present **and importable** from that root? | present-but-unimportable is the CTL-1831 shape (a broken transitive resolution) and reads as "installed" to every git-level check |
| `armed-line` | did **this pid** write the mode line? | anchored on the pid, because a log is append-only across restarts — an unanchored grep happily matches the line a *previous* process wrote before the rollback you are checking for |
| `started-after` | did the pid start after the module's mtime? | links 1–3 all pass for a daemon that booted before the pull landed |

Every link **fails closed**: "I could not measure it" exits non-zero and names the link.
`--role monitor` **asserts the absence** of an execution-core daemon rather than skipping —
a skipped link reports the same "no complaint" as a verified one.

⚠️ The declared **mode** and the runtime **`armed`** flag are different facts and the tool
prints both. Measured on the fleet 2026-08-17, mini-2 reports `mode=enforce` with
`armed=false`: enforce is configured, the feed is not currently armed (CTL-1909). That is
a runtime condition, not a load failure, so it is surfaced rather than failed — failing it
would make a correctly-loaded host report FAIL and train operators to ignore the tool.

Tests: `plugins/dev/scripts/__tests__/verify-loaded.test.sh`, gated in CI. Both controls
are present — a correctly-loaded fixture PASSES, and each failure case changes exactly one
fact, so a green result is evidence about that fact rather than about the harness.

### Parity sampling — a one-liner, not a script

The overnight sampler that lived at `~/catalyst/parity-hourly.sh` on mini-2 is **retired**
(CTL-1916). It was hand-placed and untracked, it was never scheduled, and since the Linear
smee retirement (CTL-1928) the parity run has only one stream left to look at, so it can
report agreement but no longer a *comparison*. Run the CLI directly when you want a sample:

```bash
cd ~/catalyst/plugin-source && \
  bun plugins/dev/scripts/execution-core/linear-feed-parity-run.mjs --since-min 60
```

⚠️ If you ever need it on a loop again, put the deadline **inside** the loop and make it
sleep, never spin — `end=$((SECONDS+N)); while [ $SECONDS -lt $end ]; do sleep 60; done`.
Cleanup must never be load-bearing (AGENTS.md); four spinners once leaked out of one test
run here and burned ~4 CPU-cores for 16.5 h while the script reported `cleanup verified`.
