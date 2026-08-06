# Cluster Node Onboarding (CTL-1214)

This document describes how to onboard a fresh macOS node into a Catalyst cluster. It covers the automated setup process, prerequisites, how to activate the node in the cluster roster, and known gotchas hit during real multi-node onboarding (not theoretical ones).

## Quick Start

As of CTL-1214, `catalyst-join` provisions a node end-to-end on its own — thoughts
clone + clean `humanlayer.json`, GitHub auth, the daemon stack, and the Stage-0
SHADOW gate are all baked in. The canonical flow is two commands:

```bash
# 1. On the seed (mini): mint a single-use token + arm the bundle listener
catalyst cluster join-token

# 2. On the fresh node: clone this repo (catalyst-join.sh needs its sibling
#    scripts — provision-thoughts.sh, install-cli.sh, setup-plugin-source.sh —
#    copying the lone file is not sufficient), cd into it, then run the join
#    from CATALYST_SEED/CATALYST_JOIN_TOKEN env vars (NOT --seed/--token flags
#    — the script takes environment variables, not CLI flags, for these two).
#    Pass a GitHub token so the node can clone private repos without an
#    interactive `gh auth login` (an already-authenticated `gh` also works —
#    see Phase 1 below).
git clone <this-repo-url> ~/catalyst-join-bootstrap
cd ~/catalyst-join-bootstrap
CATALYST_JOIN_GITHUB_TOKEN=<ghp_…> \
CATALYST_SEED=mini:7401 CATALYST_JOIN_TOKEN=<jt_…> \
  bash plugins/dev/scripts/catalyst-join.sh
#    (offline / seed-unreachable variant: --bundle ~/catalyst/join-bundle.json)
```

The join token is single-use with a 15-minute TTL — if a stage fails and you need
to re-mint, `catalyst cluster join-token` again and re-run; the script resumes
from the last completed stage (it does NOT need to re-fetch the bundle if
`acquire-bundle` already succeeded).

`catalyst-join` walks resumable stages: preflight → acquire-bundle → **github-auth**
→ **provision-thoughts** → setup-catalyst → install-cli → setup-plugin-source →
config-merge → **doctor** (the CTL-1186 `catalyst-doctor` gate) → stack. It is
idempotent — re-run after any failure and it resumes from the failed stage.

**Result:** the node is provisioned and the stack is running under launchd, but its
cluster roster (whichever of the two mechanisms below you use) is untouched, so it
owns **zero tickets** (Stage-0 SHADOW). Activation (adding it to the roster) is a
deliberate later step — see [Activation](#activation-m2).

### Convenience wrapper (seed-driven)

`~/catalyst/hlt-dev/cluster-node-onboard.sh mini <target>` is an operator helper
that SSHes the above into a target node and also copies the seed's
`~/.claude/settings.json` (OTel identity). It is laptop ops glue, not part of the
installer — the durable provisioning lives in `catalyst-join` itself.

## Prerequisites

### On the target node (mini-2)
- [ ] **Reachable via SSH** — `ssh mini-2.rozich.com` succeeds
- [ ] **macOS 26.5+** — verified during setup
- [ ] **Tailscale joined** — node on tailnet (100.x.x.x IP)
- [ ] **Sleep disabled** — `sudo pmset -a sleep 0 disablesleep 1`
- [ ] **Claude logged in** — `claude login` done with own Max account (not shared)
- [ ] **Hostname set** — `hostname` returns `mini-2` or similar
- [ ] **SSH key on seed** or **GitHub PAT available** — for HTTPS git auth

### On the seed host (mini)
- [ ] **catalyst-stack running** — `catalyst-stack status` returns running
- [ ] **mini/plugin-source on merged main** — `git -C ~/catalyst/plugin-source log -1 --oneline`
- [ ] **Join bundle prepared** — `ls -la ~/catalyst/join-bundle.json` (size ~500 bytes)
- [ ] **GitHub CLI authenticated** — `gh auth status` (used for token fetch)
- [ ] **Anchor ticket created** — one Linear issue for cluster liveness anchor (CTL-1217 or similar)

## Step-by-Step Setup

### Phase 1: GitHub Authentication (built into the `github-auth` stage)

Cluster nodes have no SSH keys, so thoughts clone+push uses HTTPS + a token. The
`github-auth` stage establishes this two ways, in order:

1. **`CATALYST_JOIN_GITHUB_TOKEN`** (recommended for headless joins) → written to a
   `0600 ~/.netrc`. gh is not required; git uses `.netrc` for both clone and push.
2. Otherwise the stage installs the `gh` CLI binary (if absent) and uses an
   existing `gh auth login` credential helper.

The token needs `repo` scope (and `workflow` if the node will push workflow files).
A Stage-0 SHADOW node owns zero tickets and the thoughts **sync-gate only activates
at roster>1**, so missing push auth is non-fatal at join time but is the explicit
precondition for [Activation](#activation-m2) — verify `humanlayer thoughts
sync` round-trips before adding the node to the committed roster.

### Phase 2: Provision Thoughts Repositories

The `provision-thoughts.sh` script clones three org-specific thoughts repos and writes a clean `~/.config/humanlayer/humanlayer.json`.

**Structure on the node:**
```
~/catalyst/hlt/
  coalesce-labs/thoughts/     # CTL, OTL, EVR projects
  rightsite-cloud/thoughts/   # ADV (Adva) project
  ryanrozich/thoughts/        # SLI (Slides) project
```

**Config created (`~/.config/humanlayer/humanlayer.json`):**
- Global fallback → `coalesce-labs` (primary, no groundworkapp)
- `defaultProfile` → `coalesce-labs` (safe fallback for unmapped cwds)
- `profiles` → deterministic per-org repos
- `repoMappings` → seeded for registry repoRoots + worktrees (bg agents resolve without direnv)

**Why:** Thoughts is critical cluster infra (research + plans + sync gates). Proper provisioning ensures bg agents (phase-triage, phase-research, etc.) resolve to the correct repo without direnv.

### Phase 3: Provision Claude Code Settings

Copies the seed's `~/.claude/settings.json` and updates:
- `OTEL_RESOURCE_ATTRIBUTES=host.name=mini-2` — pinned node identity for telemetry
- `CATALYST_HOST_NAME=mini-2` — used by all catalyst processes

**Why:** Without this, Claude's OTel metrics and catalyst's host metrics label the node with its macOS ComputerName (e.g., `RYANS-MAC_MINI-M4`), breaking correlation in Grafana dashboards.

### Phase 4: Resume catalyst-join

Runs the final join stages:
1. **doctor** — health check (warnings OK for SHADOW, all required checks pass)
2. **stack** — installs launchd plist for auto-start

**End state: Stage-0 SHADOW**
- ✅ Catalyst stack running (auto-restart on reboot)
- ✅ Thoughts synced (all 3 orgs verified)
- ✅ Local roster entry created (mini-2 registered locally)
- ❌ Cluster roster untouched — node owns zero tickets (see [Activation](#activation-m2) for the current roster mechanism)

### Phase 5: Verification

Check the onboard script's verification output:
```
[onboard] Checking stack status...
  ✓ launchd plist installed
[onboard] Checking thoughts repos...
  ✓ 3 thoughts repos cloned
[onboard] Checking humanlayer config...
  ✓ humanlayer.json exists
[onboard] Stage-0 SHADOW Status:
  stack stage complete
```

## Activation (M2)

> **The per-repo committed `.catalyst/hosts.json` roster described in earlier
> drafts of this doc is RETIRED (CTL-1274)** — a CI guard now fails the build if
> one reappears or a reader regrows to expect it. The roster's durable home is
> now `resolveClusterHosts()`'s precedence chain (`execution-core/config.mjs`):
> 1. **cluster-repo** — the `catalyst-cluster` control-plane repo's
>    `cluster.json.roster` (the fully-durable, versioned option — requires that
>    repo to exist, with its own age-key/SOPS setup for secrets).
> 2. **static roster** — an explicit `catalyst.cluster.staticRoster` array (or
>    `CATALYST_STATIC_ROSTER`, comma-separated) in each node's OWN Layer-2
>    config (`~/.config/catalyst/config.json`). Machine-local, NOT committed —
>    per CLAUDE.md, cluster secrets/topology never go in a public repo. This is
>    the lightweight escape hatch if you don't want to stand up the full
>    `catalyst-cluster` repo yet.
> 3. **single-host** — `[own hostname]` when neither resolves.
>
> Whichever you pick, **the SAME roster array must be set identically on every
> node** — if they disagree, HRW partitioning disagrees too, which risks
> double-dispatch or a node silently owning nothing.

Pick ONE roster mechanism (see the precedence chain above) and use it identically on
every node — mixing mechanisms across nodes is exactly the disagreement the chain
warns about.

### Option A — static-roster escape hatch (no `catalyst-cluster` repo needed)

1. **Verify each node's own reported identity first** (see the host-identity
   gotcha below — a node's `catalyst.host.name` is NOT guaranteed to match the
   name you intend to put in the roster unless you've explicitly set it):
   ```bash
   # on each node:
   python3 -c "import json; print(json.load(open('/Users/thagale/.config/catalyst/config.json'))['catalyst']['host']['name'])"
   ```

2. **Set the identical static roster on EVERY node** (seed + all joining nodes):
   ```bash
   jq '.catalyst.cluster.staticRoster = ["mini","mini-2"]' ~/.config/catalyst/config.json \
     > /tmp/cfg.json && mv /tmp/cfg.json ~/.config/catalyst/config.json
   chmod 600 ~/.config/catalyst/config.json
   ```

### Option B — committed `catalyst-cluster` roster (durable, versioned)

**Prerequisite:** **every** activated node — not just the machine performing this edit — needs its
own local clone of the private `catalyst-cluster` repo at the default `CATALYST_CLUSTER_DIR`
location (`~/catalyst/catalyst-cluster`). `cluster-sync` only pulls an *existing* clone (it never
clones fresh), and `resolveClusterHosts()` reads `cluster.json.roster` from that same local clone to
resolve the fleet roster; without it, a node fails open to the `static`/`single-host` roster source
(it silently treats itself as the only host in the fleet), which risks HRW double-ownership against
nodes that do see the shared roster. A read-only clone is sufficient for that; only the machine used
to perform the roster edit below additionally needs *write* access (push rights) to the repo. Like
the age key, `catalyst-join` does **not** clone this repo (see the Scope note in "Provisioning the
shared cloud token" below) — the clone is a pre-existing prerequisite provisioned once, separately,
on each node. See the [config-mirror contract](../website/src/content/docs/reference/cluster-config-mirror.md)
for the full SHARED/PER-NODE classification.

1. **Add to committed roster:** in the private `catalyst-cluster` repo, add the node's name to
   `cluster.json` `roster[]` and push:
   ```bash
   # in the catalyst-cluster repo
   jq '.roster += ["mini-2"]' cluster.json > /tmp/cluster.json && mv /tmp/cluster.json cluster.json
   git add cluster.json && git commit -m "feat: activate mini-2 to cluster roster (CTL-1217)"
   git push
   ```
   `cluster-sync` pulls the update on every node and the next scheduler tick honors it — no restart
   needed. See the [config-mirror contract](../website/src/content/docs/reference/cluster-config-mirror.md)
   for the full SHARED/PER-NODE classification.

2. **Re-run the join on the activated node to wire webhook ingestion** — the
   Stage-0 join deliberately skipped webhook wiring (`stage0-roster-guard` in
   the webhook-wiring gate: wiring a roster≤1 node would double-dispatch, since
   runtime fencing is roster-derived). The join's progress marker records
   `webhookWiringDeferred` for this case. Once the node is in the committed
   roster, re-run the join **with fresh credentials** — the original join
   token was single-use, and a seed-fetched bundle is deleted after the join
   (it carries live bot tokens), so a bare `--no-resume` re-run would exit at
   the token preflight:
   ```bash
   # On the seed host: mint a fresh single-use join token
   catalyst cluster join-token

   # On the activated node: full re-run with the fresh token
   CATALYST_SEED=<seed-host:7400> CATALYST_JOIN_TOKEN=jt_<fresh> \
     bash catalyst-join.sh --no-resume   # re-evaluates the gate at roster>1 and wires
   ```
   (For an offline `--bundle` join, reuse the retained bundle file instead:
   `bash catalyst-join.sh --bundle <path> --no-resume`.)
   Until this runs, `catalyst-doctor` FAILs `webhook-ingestion` on the
   activated node — that FAIL is the loud signal this step was missed, not a
   new problem. (This step is specific to Option B — the static roster has no
   committed repo to re-sync from, so Option A skips it.)

### Then, regardless of which option you used

3. **Restart the stack on every node** (see the "plist env changes need a real
   restart" gotcha below — a `launchctl kickstart` alone is not sufficient).

4. **Verify**: `catalyst cluster status` shows all hosts; `catalyst doctor`'s
   `hrw-partition` check on each node should show a non-trivial ticket count
   (not 100% on one host) — this is the concrete proof the partition is real.

5. **Watch for zero double-dispatch** — the moment mini-2 enters the roster, the sync gate activates (`roster>1`), and phase-research/phase-plan blocks on `humanlayer thoughts sync`. Verify:
   - No duplicate phase-researchers spawned
   - No tickets assigned twice
   - All work completes on one node only

6. **Monitor the reaper** — once activated, mini-2 worktrees are eligible for reaping (CTL-1218). Watch for safe signal+merge patterns before auto-reap.

7. **(Optional but recommended) Set a liveness anchor** — without
   `catalyst.cluster.livenessAnchorIssue` (a Linear ticket key, set identically
   on every node) or `CATALYST_LIVENESS_ANCHOR_ISSUE`, HRW partitioning still
   works (it's a pure hash over the roster), but cross-host DEAD-NODE detection
   is disabled (fail-open, one-time warning) — a crashed peer's in-flight
   tickets won't get reclaimed by a live node. File one ticket, park it in
   Backlog (never Todo — Todo auto-dispatches), and never close it.

## Provisioning the shared cloud token (`CATALYST_CLOUD_TOKEN`, CTL-1307)

`CATALYST_CLOUD_TOKEN` is a single **shared** service credential (the catalyst-cloud `ADMIN_TOKEN`,
interim per CTC-27 / ADR-0006) that must be **identical on every node**. It is an **optional
extension**: setting it changes nothing on its own — nothing in Catalyst reads it, and a node stays
fully local-only until the operator separately opts into cloud services. Only the opt-in,
out-of-repo cloud host-sync daemon (`catalyst-replica` / `catalyst-cloud`) consumes it. It is safe
to roll out cluster-wide without altering default behavior.

It is stored once in the `catalyst-cluster` repo (encrypted, alongside the other secrets) and flows
to every node's **machine-level environment** automatically — no manual per-host step.

### Add or rotate the token (laptop only)

Per the cluster repo's write policy, all `secrets/` writes are operator-initiated from the laptop and
serialized (pull → edit → push); SOPS re-encryption rewrites the whole data-key wrap, so concurrent
commits don't merge.

```bash
cd ~/catalyst/catalyst-cluster        # the clone with your age key + sops installed
git pull --ff-only

# Create/rotate the dedicated cloud-token secret. The existing .sops.yaml rule
# (path_regex 'secrets/.*\.json$') already covers this filename — no .sops.yaml change.
cat > /tmp/cluster-cloud.json <<'JSON'
{ "catalyst": { "cloud": { "token": "<catalyst-cloud ADMIN_TOKEN>" } } }
JSON
sops --encrypt --input-type json --output-type json /tmp/cluster-cloud.json \
  > secrets/cluster-cloud.sops.json
rm -f /tmp/cluster-cloud.json

git add secrets/cluster-cloud.sops.json
git commit -m "feat: add shared CATALYST_CLOUD_TOKEN (CTL-1307)"
git push
```

### How each node picks it up

Each node converges automatically (prerequisite: the node already has the `catalyst-cluster` repo
cloned and its age key at `~/.config/catalyst/age.key` — the same prerequisite as every other cluster
secret):

1. `cluster-sync` (daemon boot, and the periodic pull) decrypts `secrets/cluster-cloud.sops.json` to
   `~/.config/catalyst/cluster-cloud.json` (mode `0600`).
2. `catalyst-stack start` (boot + every keep-alive) runs `cloud-token-env.mjs`, which writes the
   secret to `~/.config/catalyst/cluster.env` (mode `0600`) and adds a non-secret guard line to
   `~/.zshenv` that sources it.
3. Every login/zsh shell — and any cloud daemon **(re)started in a shell context** — inherits
   `CATALYST_CLOUD_TOKEN`.

### Apply immediately (instead of waiting for the keep-alive)

On each node that has opted into cloud services:

```bash
# 1. re-decrypt (or just restart the daemon)
catalyst cluster sync
# 2. project the token into the machine-level env now
catalyst-stack sync-cloud-env
# 3. restart the cloud host-sync daemon in a shell context so it inherits the value
#    (the same pattern used for the per-host Linear keys)
```

`catalyst doctor` reports an advisory `cloud-token` check: `INFO` when no token is provisioned
(local-only, expected), `WARN` when a token is decrypted but not yet projected (or is stale), `PASS`
when it is projected to the machine-level env.

> **Scope note:** `catalyst-join` does not itself clone the `catalyst-cluster` repo or provision the
> age key (a pre-existing prerequisite shared by *all* cluster secrets, tracked separately). Once
> those prerequisites are in place, the cloud token is picked up with no per-host step.

## Known Gotchas (from real multi-node onboarding)

These are real failure modes hit while onboarding actual nodes, not theoretical
— each cost real debugging time, so check them proactively rather than
rediscovering them.

### A fresh macOS node's `bash` is 3.2, not whatever you tested with

macOS ships bash 3.2 (GPL licensing) as `/bin/bash`, and a bare `bash script.sh`
invocation resolves to whichever is first on PATH — which may be a much newer
Homebrew bash on your dev machine, masking bash-3.2-only syntax errors until the
same script runs on a genuinely fresh node. One concrete trap: a heredoc
embedded inside a `$(...)` command substitution, whose body contains an
apostrophe (even in a comment), confuses bash 3.2's quote-tracking across that
nested boundary and produces a syntax error dozens of lines away from the real
cause — bash 4+/5 parses the identical file fine. Before trusting any script
that ships as part of the join path, run `/bin/bash -n script.sh` explicitly
(not just whatever `bash` resolves to), and consider adding that as a permanent
regression test (see `setup-plugin-source.test.sh` for the pattern).

### A node's identity may not be what you expect, and won't self-correct

`catalyst-join.sh` defaults a node's `catalyst.host.name` to `hostname -s` (the
machine's own local/system hostname) unless overridden — which can silently
differ from whatever name you actually refer to the node by (a Tailscale
MagicDNS name, an SSH config alias, etc.). Symptom: you activate the node under
the name you call it, but its daemon silently owns zero tickets under HRW,
because its actual runtime identity doesn't match any roster entry.

Fix with `catalyst cluster rename <name>` — but this ONLY updates the Layer-2
config file. The **running daemon's actual identity comes from the
`CATALYST_HOST_NAME` environment variable baked into the launchd plist at join
time, which wins over the config file** (env-over-config precedence, same
pattern used throughout this stack). A rename requires manually fixing that env
var in the plist(s) too — `ai.coalesce.catalyst-stack.plist` and
`ai.coalesce.catalyst-log-shipper.plist` both carry it, and `~/.claude/settings.json`'s
`OTEL_RESOURCE_ATTRIBUTES=host.name=...` should match for telemetry
consistency. **Verify the actual running process, not just the config file**:
```bash
ps eww $(pgrep -f "execution-core/daemon.mjs") | grep -o "CATALYST_HOST_NAME=[^ ]*"
```
A doctor/config check run from a fresh ad-hoc shell will NOT catch this — it
reads the config file, which may say the right thing while the actual daemon
(with the stale plist env) disagrees. Always cross-check the live process.

### A plist env change needs a full stop, not just `launchctl kickstart`

The daemon plists deliberately set `AbandonProcessGroup` so a keep-alive tick
doesn't SIGTERM the nohup'd children it just started (see the plist comment).
This means an already-running broker/monitor/execution-core survives a
`launchctl kickstart` (or even a `bootout`+`bootstrap` of the wrapper job) — the
wrapper's own "already running" check sees the live PID and skips respawning,
so an edited plist env var is silently NOT picked up. To actually apply a plist
change:
```bash
catalyst-stack stop        # kills the actual children (log-shipper excluded, by design)
launchctl kickstart -k gui/<uid>/ai.coalesce.catalyst-stack
```
A bare `catalyst-stack restart` run over SSH has a related but different
failure mode: SSH session teardown can kill the nohup'd children even with
`disown`, so a manually-triggered restart may not survive your SSH connection
closing. Prefer `launchctl kickstart` (after an explicit `stop`) for anything
you need to actually persist.

### Codex needs its own separate per-node setup — the join process doesn't touch it

If your fleet routes any phase to a Codex executor (`executorByPhase`), each
node needs its OWN Codex auth — `mkdir -p ~/catalyst/codex-home && CODEX_HOME=~/catalyst/codex-home codex login`
(a dedicated auth home is deliberately isolated from any personal `codex` CLI
login). This is NOT part of `catalyst-join.sh` — a freshly joined node has
`codex` on PATH (if some other step installed it) but no credentials, and will
fail immediately on any phase routed to it. If a fleet-wide `executorByPhase`
setting isn't the same for every node (e.g., you're rolling Codex out
node-by-node), pin the not-yet-ready node to non-Codex executors via the
`CATALYST_EXECUTOR_BY_PHASE` env var in ITS OWN plist (env wins over the shared
Layer-1 `executorByPhase` config, and — unlike a Layer-1 edit on a worker node,
which gets reset on the next config pull — an env var in the plist is durable):
```xml
<key>CATALYST_EXECUTOR_BY_PHASE</key>
<string>{"triage":"bg","research":"bg","plan":"bg","implement":"bg","remediate":"bg","verify":"bg","review":"bg","pr":"bg"}</string>
```

### Webhook ingestion doesn't propagate via the join bundle

`catalyst doctor`'s `webhook-ingestion` check fails-closed on any multi-host
member with no wired route (`FAILs so the activation gate fail-closes`, per the
check's own code comment) — but the join bundle does NOT carry the webhook
smee-channel URLs or HMAC secret files, since those come from a one-time
registration done on whichever node originally set up the webhook. To wire a
new node: copy the secret files (`~/.config/catalyst/webhook-secret`,
`~/.config/catalyst/linear-webhook-secret`) and the `catalyst.monitor.github.smeeChannel`
/ `catalyst.monitor.linear.smeeChannel` (+ `.workspace.webhookId`) values from
an already-wired node into the new node's own Layer-2 config. smee.io channels
broadcast to every connected listener, so multiple nodes CAN share the same
channel — each node's own HRW ownership check is what prevents double-acting on
the same event (this is the "double-dispatch guard" the single-host PASS
message refers to).

### Org/thoughts convention must be explicit for a forked install

`provision-thoughts.sh`'s primary org is NOT hardcoded (a prior version hardcoded
one specific org, which is exactly the anti-pattern that broke a downstream
fork) — set it via `--orgs`/`--registry` (which `catalyst-join.sh` derives
automatically from the join bundle's `layer1Identity.projectKey`) or the
`CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG` env var for a from-scratch standalone
run. With none of the three, the script fails loudly rather than guessing.

### Layer-2 config file permissions drift back to 644

Several code paths that rewrite `~/.config/catalyst/config.json` (a `jq ...  >
tmp && mv tmp file` pattern, or an `npm install -g` touching the directory)
don't preserve the original file mode — the temp file inherits the process
umask instead. `catalyst doctor`'s `layer2-perms` check catches this, but check
after any manual edit or package install: `chmod 600 ~/.config/catalyst/config.json`.

## Troubleshooting

### Join script fails with "doctor gate failed"

**Root cause:** Usually PATH issues or missing `.catalyst.thoughts` config.

**Solution:**
```bash
# Ensure PATH includes node bins
export PATH=~/.local/node/bin:~/.bun/bin:$PATH

# Verify humanlayer is discoverable
which humanlayer

# Add thoughts config to .catalyst/config.json if missing
cd ~/catalyst-join-bootstrap
jq '.catalyst.thoughts = {directory: "catalyst", profile: "coalesce-labs"}' .catalyst/config.json > /tmp/config.json && mv /tmp/config.json .catalyst/config.json
```

### Git clone fails with "Device not configured"

**Root cause:** git credential helper not configured.

**Solution:**
```bash
# Use .netrc for HTTPS auth
cat > ~/.netrc <<'EOF'
machine github.com
login ryanrozich
password YOUR_GITHUB_PAT
EOF
chmod 600 ~/.netrc
```

### Thoughts sync fails with "no auth"

**Root cause:** `gh` CLI or git credentials not configured on the node.

**Solution:**
- Verify `gh auth status` on the node
- Verify `.netrc` exists and has correct PAT
- Verify git is configured: `git config --global credential.helper store`

### launchd plist not installing

**Root cause:** catalyst-stack command not in PATH.

**Solution:**
```bash
export PATH=~/.catalyst/bin:$PATH
catalyst-stack install-services
```

## Architecture References

- **Thoughts provisioning model:** `thoughts/shared/plans/2026-06-16-cluster-hlt-thoughts-model.md`
- **Cluster config design:** `thoughts/shared/plans/2026-06-16-cluster-config-architecture.md`
- **Join implementation:** `plugins/dev/scripts/catalyst-join.sh` (CTL-1185)
- **Onboarding log:** `thoughts/shared/ops/mini-2-onboarding-log.md`

## Key Decisions (Locked)

- **Thoughts layout:** `~/catalyst/hlt/<org>/thoughts` (one per org, org = GitHub org name)
- **Auth model:** `gh` + HTTPS (no SSH keys on cluster nodes)
- **Node user:** local system user (ryan on mini, ryan on mini-2, etc.)
- **HumanLayer global fallback:** the operator's own primary org, set via `CATALYST_PROVISION_THOUGHTS_PRIMARY_ORG` or `--orgs`/`--registry` — deliberately NOT a hardcoded org name (see the Known Gotchas section)
- **Worktree location:** `~/catalyst/wt/catalyst-workspace/` (not ~/conductor)
- **SHADOW mode:** nodes own zero tickets until added to the cluster roster (see [Activation](#activation-m2) for the current mechanism — the roster is no longer a per-repo committed `hosts.json`)

## Related Tickets

- **CTL-1214** — This ticket (thoughts provisioning + mini-2 install)
- **CTL-1217** — Cluster liveness anchor (one Linear ticket that must never be closed)
- **CTL-1274** — Cluster roster relocated to the `catalyst-cluster` repo's `cluster.json`; per-repo `hosts.json` retired
- **CTL-1183–1188** — M1 install-critical path (seed→bundle endpoint, join-token, join installer, doctor gate, contract, cluster CLI)
- **CTL-1228** — Process-by-role metrics (future: resource monitoring for each active role)
- **CTL-1230** — Relocate observability config (project→machine config.json)
- **CTL-1231** — Provision settings.json on every node (OTel env + host identity)

---

**Last updated:** 2026-08-01 | **Status:** Stage-0 SHADOW + M2 activation both exercised on a real 3-node cluster; Known Gotchas section reflects real onboarding failures, not theoretical ones
