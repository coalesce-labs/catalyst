# Cluster Node Onboarding (CTL-1214)

This document describes how to onboard a fresh macOS node into a Catalyst cluster. It covers the automated setup process, prerequisites, and how to activate the node in the committed roster.

## Quick Start

From mini (the seed host), run:

```bash
cd ~/catalyst/hlt-dev
./cluster-node-onboard.sh mini mini-2
```

This automates:
1. Thoughts repo provisioning (3 orgs: coalesce-labs, rightsite-cloud, ryanrozich)
2. HumanLayer configuration
3. Claude Code settings (OTel telemetry + host identity)
4. catalyst-join completion (Stage-0 SHADOW)
5. Catalyst stack auto-start via launchd

**Result:** mini-2 is provisioned and running, but owns zero tickets (SHADOW mode). No further action needed for now.

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

### Phase 1: Prepare GitHub Authentication

The automation script fetches the GitHub PAT (Personal Access Token) from the seed host's environment. This token is used for HTTPS git push auth (thoughts sync).

**Why:** cluster nodes have no SSH keys; HTTPS + token is the auth model.

- [ ] Verify seed's token: `ssh mini env | grep GITHUB_TOKEN`
- [ ] Token must have `repo` + `workflow` scopes

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
