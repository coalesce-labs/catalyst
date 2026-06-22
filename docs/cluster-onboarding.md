# Cluster Node Onboarding (CTL-1214)

This document describes how to onboard a fresh macOS node into a Catalyst cluster. It covers the automated setup process, prerequisites, and how to activate the node in the committed roster.

## Quick Start

As of CTL-1214, `catalyst-join` provisions a node end-to-end on its own — thoughts
clone + clean `humanlayer.json`, GitHub auth, the daemon stack, and the Stage-0
SHADOW gate are all baked in. The canonical flow is two commands:

```bash
# 1. On the seed (mini): mint a single-use token + arm the bundle listener
catalyst cluster join-token

# 2. On the fresh node: run the one-liner. Pass a GitHub token so the node can
#    clone the private thoughts repos without an interactive `gh auth login`.
CATALYST_JOIN_GITHUB_TOKEN=<ghp_…> \
  bash catalyst-join.sh --seed mini:7401 --token <jt_…>
#    (offline / seed-unreachable variant: --bundle ~/catalyst/join-bundle.json)
```

`catalyst-join` walks resumable stages: preflight → acquire-bundle → **github-auth**
→ **provision-thoughts** → setup-catalyst → install-cli → setup-plugin-source →
config-merge → **doctor** (the CTL-1186 `catalyst-doctor` gate) → stack. It is
idempotent — re-run after any failure and it resumes from the failed stage.

**Result:** the node is provisioned and the stack is running under launchd, but the
committed `.catalyst/hosts.json` is untouched, so it owns **zero tickets** (Stage-0
SHADOW). Activation (adding it to the roster) is a deliberate later step — see
[Activation](#activation-m2--future).

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
precondition for [Activation](#activation-m2--future) — verify `humanlayer thoughts
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
- ❌ Committed roster untouched (`hosts.json` still `["mini"]`) — node owns zero tickets

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

## Activation (M2 — Future)

To activate mini-2 and begin accepting work:

1. **Add to committed roster:**
   ```bash
   cd ~/catalyst
   jq '.hosts += ["mini-2"]' .catalyst/hosts.json > /tmp/hosts.json && mv /tmp/hosts.json .catalyst/hosts.json
   git add .catalyst/hosts.json && git commit -m "feat: activate mini-2 to cluster roster (CTL-1217)"
   git push
   ```

2. **Verify all nodes pull the update:**
   ```bash
   catalyst cluster status
   ```

3. **Watch for zero double-dispatch** — the moment mini-2 enters the roster, the sync gate activates (`roster>1`), and phase-research/phase-plan blocks on `humanlayer thoughts sync`. Verify:
   - No duplicate phase-researchers spawned
   - No tickets assigned twice
   - All work completes on one node only

4. **Monitor the reaper** — once activated, mini-2 worktrees are eligible for reaping (CTL-1218). Watch for safe signal+merge patterns before auto-reap.

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
- **HumanLayer global fallback:** `coalesce-labs` (primary org, never groundworkapp)
- **Worktree location:** `~/catalyst/wt/catalyst-workspace/` (not ~/conductor)
- **SHADOW mode:** nodes own zero tickets until added to committed `hosts.json`

## Related Tickets

- **CTL-1214** — This ticket (thoughts provisioning + mini-2 install)
- **CTL-1217** — Cluster liveness anchor (one Linear ticket that must never be closed)
- **CTL-1183–1188** — M1 install-critical path (seed→bundle endpoint, join-token, join installer, doctor gate, contract, cluster CLI)
- **CTL-1228** — Process-by-role metrics (future: resource monitoring for each active role)
- **CTL-1230** — Relocate observability config (project→machine config.json)
- **CTL-1231** — Provision settings.json on every node (OTel env + host identity)

---

**Last updated:** 2026-06-16 | **Status:** Stage-0 SHADOW complete, ready for M2 activation
