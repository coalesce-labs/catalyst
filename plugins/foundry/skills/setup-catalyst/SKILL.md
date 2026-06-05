---
name: setup-catalyst
description:
  "Diagnose and fix Catalyst setup issues. Validates tools, database, config, OTel, direnv, and
  thoughts. Automatically fixes what it can — creates directories, initializes the database, sets
  WAL mode, runs migrations. Use for new installs, upgrades, or when something isn't working."
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit
---

# Setup Catalyst

Diagnose the full Catalyst environment, fix everything fixable, and verify the fixes worked.

## Phase 1: Diagnose

Locate and run the health check script:

```bash
# Backing scripts live in catalyst-dev (the shared framework core). Resolve them
# (and fail fast with a clear message if catalyst-dev is not installed).
source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
    "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
SCRIPT="${CATALYST_DEV_SCRIPTS}/check-setup.sh"

bash "$SCRIPT" 2>&1 || true
```

Parse the output. Categorize every warning and failure into:

- **Auto-fixable** — can be fixed right now without user input
- **Needs user input** — requires API tokens, credentials, or decisions
- **Manual only** — requires tool installation or external action

## Phase 2: Fix

For auto-fixable issues, fix them immediately — don't ask, just do it. These are safe, local,
reversible operations.

**Exception: thoughts/ repair is NOT a bare `mkdir`.** The humanlayer thoughts system expects
`thoughts/shared` and `thoughts/global` to be **symlinks** into a central thoughts repo. A bare
`mkdir` over a clobbered symlink silently routes all subsequent agent writes to a non-syncing
local directory. Always route thoughts repair through `catalyst-thoughts.sh`, and treat a
regular-directory-where-a-symlink-should-be as **fatal** — surface the recovery command to the
user rather than overwriting anything.

| Issue | Fix |
|-------|-----|
| `~/catalyst/` missing | `mkdir -p ~/catalyst/{wt,events,history}` |
| `~/catalyst/wt/` missing | `mkdir -p ~/catalyst/wt` |
| `~/catalyst/events/` missing | `mkdir -p ~/catalyst/events` |
| Database missing or schema incomplete | Run `catalyst-db.sh init` (locating it the same way as the check script) |
| `schema_migrations` table missing | Run `catalyst-db.sh init` — it's idempotent |
| WAL mode not set | `sqlite3 ~/catalyst/catalyst.db 'PRAGMA journal_mode=WAL;'` |
| `thoughts/shared/<dir>` missing | Run `bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair` (re-uses humanlayer when configured; warns loudly when no thoughts repo is set up) |
| `~/.catalyst/bin/` missing OR any catalyst-* symlink absent/broken | Run `bash plugins/dev/scripts/install-cli.sh` — idempotent, safe to re-run. If `$HOME/.catalyst/bin` is not on `$PATH`, the script prints the exact line to add to `~/.zshrc` or `~/.bashrc` — relay that to the user so they can finish the one-time PATH setup. |
| `thoughts/shared` is a regular directory (not a symlink) | **Fatal — do not auto-fix.** Tell the user the humanlayer symlink was clobbered and show recovery: `mv thoughts/shared thoughts/shared.orphaned-$(date +%Y%m%d)` then `bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair` |
| Drift detected: keys present in `plugins/dev/templates/config.template.json` but missing from `.catalyst/config.json` (CTL-489) | Enumerate via `bash plugins/dev/scripts/check-config-drift.sh --json`. Generate a preview merge to a temp file via `--merge-into /tmp/merged.json` and show the user `diff -u .catalyst/config.json /tmp/merged.json`. On user confirmation, `jq` deep-merge into the real file: `bash plugins/dev/scripts/check-config-drift.sh --merge-into .catalyst/config.json.new && mv .catalyst/config.json.new .catalyst/config.json`. Merge preserves every existing user value (project on the right of jq's `*` recursive merge). |
| Profile drift between `.catalyst/config.json` and humanlayer mapping | Run `bash plugins/dev/scripts/catalyst-thoughts.sh init-or-repair` — it now auto-repairs drift by running `humanlayer thoughts uninit --force && humanlayer thoughts init --profile <config profile> --directory <config directory>`. (Plain `humanlayer thoughts init --force` does NOT update an existing repo→profile mapping, so the `uninit` step is required.) |

**Config-template drift (CTL-489).** When the template gains a key that an existing project's
`.catalyst/config.json` lacks (the original CTL-487 silent-fallback bug — catalyst itself ran in
`oneshot-legacy` for two months because `orchestration.dispatchMode` was absent), Phase 2 surfaces
a unified diff and asks for confirmation before merging. Concretely:

1. Run `bash plugins/dev/scripts/check-config-drift.sh --json --config .catalyst/config.json
   --template <template>` to enumerate missing leaves. The template path comes from
   `$CLAUDE_PLUGIN_ROOT/templates/config.template.json` in production, or
   `plugins/dev/templates/config.template.json` when dogfooding from the repo.
2. If the array is non-empty, generate a preview merge file via
   `bash plugins/dev/scripts/check-config-drift.sh --merge-into /tmp/merged.json` and show the user
   the unified diff: `diff -u .catalyst/config.json /tmp/merged.json`.
3. Ask: "Apply these template additions? [y/N]". Default is NO — drift is non-fatal and the
   warning will keep showing on subsequent workflow invocations until the user opts in.
4. On confirmation, write the merged file atomically to `.catalyst/config.json` (`mv` from a
   sibling `.tmp` file). The merge uses jq's `*` operator with the project on the right —
   existing values always win, missing keys are added.
5. The merge **never** overwrites existing user values. If the user has a custom
   `catalyst.filter.groqModel`, the template's default is NOT applied to that key.
6. If the user declines, leave `.catalyst/config.json` untouched. The drift warning continues to
   appear on subsequent workflow invocations, providing passive nagging until resolved.

**Linear bot user ID (CTL-550 / CTL-749 / CTL-549).** `catalyst.monitor.linear.botUserId` is the
Linear user UUID of the Catalyst app-actor — the "Linear for Agents" app identity that posts
comments *as the app* (installed by CTL-550). It is **required for the Linear app-actor comms
channel** — i.e. when the execution-core daemon mirrors phase-agent output to Linear and wakes on
human replies (CTL-550 / CTL-549 / CTL-749). It is the self-echo / loop-prevention guard for the
whole bidirectional channel. CTL-749 / CTL-549 built a channel where a human reply on a ticket
wakes a parked worker; without `botUserId` loaded, the system cannot tell the agent's *own*
comments and description-updates apart from a human's, so (a) the agent's own mirror comments get
written into the worker `inbox.jsonl` as if they were human input (noise / false "human replied"
signals), and (b) bot-authored issue events feed back into the event log as write loops. The
orch-monitor's Linear webhook handler suppresses bot-authored issue events using this value, and
the execution-core daemon uses it to filter the agent's self-echo from each worker's inbox.

This value is **workspace-specific** and is NOT shipped in the committed template
(`config.template.json` keeps it `null`). It is not secret — it appears on every comment the app
posts — but it must be obtained per workspace and written into Layer 1
`.catalyst/config.json → catalyst.monitor.linear.botUserId` (alongside the other `monitor.linear`
keys such as `teams` and `webhookSecretEnv`). To obtain it, query `viewer.id` with the app-actor
token (the app OAuth credentials live in Layer 2
`~/.config/catalyst/config-<projectKey>.json → catalyst.linear.agent.{clientId,clientSecret,accessToken}`):

```bash
TOKEN=$(jq -r '.catalyst.linear.agent.accessToken' ~/.config/catalyst/config-<projectKey>.json)
BOT_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{viewer{id name}}"}' | jq -r .data.viewer.id)
```

(Alternatively, mint a fresh app token via `grant_type=client_credentials` with `actor=app` and
`scope="app:mentionable,app:assignable"` at `POST https://api.linear.app/oauth/token`, then run the
same `viewer{id}` query.) Write `$BOT_ID` into
`.catalyst/config.json → catalyst.monitor.linear.botUserId`. Both the monitor and the daemon read
`botUserId` **only at startup**, so after setting it you must restart them:
`catalyst-monitor stop && catalyst-monitor start`, then `catalyst-execution-core restart`. This is
a needs-user-input step (it requires the app-actor credentials), not an auto-fix — never write the
value for the user without confirming it came from their own app-actor token.

**Execution-core state contract (CTL-564).** When a repo's
`catalyst.orchestration.dispatchMode` is `execution-core`, `setup-catalyst.sh`
runs an extra step — `setup_execution_core_states` — right after the Linear
workflow-state fetch. That step delegates to the standalone
`plugins/dev/scripts/setup-execution-core-states.sh`, which ensures the team's
contract workflow states exist (`Ready` + `Research`, `Plan`, `Implement`,
`Validate`, `PR`; `Triage` already exists), writes the 9-phase → 5-state
collapse `stateMap`, refreshes `stateIds`, and upserts the team's entry in the
central `~/catalyst/execution-core/registry.json`. The step is a silent no-op
for `phase-agents` / `oneshot-legacy` repos, and a Linear-permission failure in
the standalone script never aborts setup. The standalone script is also
idempotent and can be run directly per team (`setup-execution-core-states.sh
--config .catalyst/config.json [--dry-run] [--json]`).

**Linear git automations (CTL-759).** As its last Linear step,
`setup-execution-core-states.sh` reconciles the team's *git automations* —
Linear's built-in "move ticket on git event" rules. It pins exactly two
(`start` → `PR`, `merge` → `Done`) and deletes any `review` automation, so the
execution-core daemon stays the single authority on ticket state. The reconcile
is best-effort and tolerant: a Linear permission/transport failure prints a
WARNING and continues — it never aborts setup and never alters the script's exit
codes. `check-project-setup.sh` (hot path) warns on drift via a TTL-gated cached
read; a missing per-project token is a silent skip. Separately, Linear's
**branch-name "magic words" toggle** (Settings → Team → Workflow → Git) has no
API surface and **cannot** be reconciled — it must be turned OFF by hand, or it
races the daemon and re-introduces the CTL-758 backward state-write.

**Execution-core daemon env / proxy audit (machine-local, opt-in).**
`catalyst-execution-core start` sources a machine-local env file —
`~/.config/catalyst/execution-core.env` (override with `CATALYST_EXECUTION_CORE_ENV`)
— right before it launches the daemon, so every var it exports is inherited by the
daemon and every phase-agent bg job. An **absent file is a complete no-op** and is
the common case; this is **not** auto-fixable because the values (proxy port, MITM
CA path) are machine-specific. The committed template
`plugins/dev/templates/execution-core.env.example` documents every option. The two
uses are (1) routing the daemon's Linear/gh fetch traffic through a local mitmproxy
audit and (2) widening the Linear state-cache TTL (`LINEAR_STATE_CACHE_TTL_MS`).

The risk this guards against: a proxy that is configured but quietly broken silently
kills the daemon's Linear connectivity on a fresh or changed machine, with nothing
obvious to debug. So when the env file sets a proxy, `check-setup.sh` verifies it and
warns **loudly + actionably** on each failure mode — (a) the proxy port is not
listening, (b) `NODE_EXTRA_CA_CERTS` points at a missing file, or (c) `NODE_USE_ENV_PROXY=1`
is missing. The `NODE_USE_ENV_PROXY` flag matters because Node 20+/24+ native fetch
(undici) **ignores** `HTTPS_PROXY`/`HTTP_PROXY` without it — so the daemon's calls
would bypass the audit entirely while looking perfectly healthy. `check-project-setup.sh`
(the hot-path gate) carries only that one silent-bypass warning; full port/CA
diagnostics live in `check-setup.sh`. Treat any of these as **needs-user-input** — relay
the specific warning and fix, never write a machine path on the user's behalf, and
remind them to `catalyst-execution-core restart` after editing (the daemon re-sources
the file only on start/restart).

For issues needing user input, explain what's needed and how to provide it:

| Issue | What to tell the user |
|-------|----------------------|
| Linear API token not set | Show the secrets file path, explain where to get the token from Linear settings |
| No project config | Suggest running `setup-catalyst.sh` or offer to create a minimal `.catalyst/config.json` interactively |
| direnv not installed | Show `brew install direnv` and the shell hook setup |
| Linear "magic words" auto-move ON | Tell the user to turn it OFF in Settings → Team → Workflow → Git — it races the execution-core daemon and causes backward state writes (CTL-758). No API surface; must be toggled by hand. |
| Linear `review` git automation set | Run `setup-execution-core-states.sh` to remove it; the pipeline owns the Validate/review state, not Linear. |
| Personal git automations override team ones | Remind the user that Linear lets each member set *personal* git automations that shadow the team defaults — check Settings → Account → Git if drift persists after the team reconcile. |
| Proxy audit / daemon env wanted | Copy `plugins/dev/templates/execution-core.env.example` to `~/.config/catalyst/execution-core.env`, uncomment the vars you need (proxy + CA + `NODE_USE_ENV_PROXY=1`, and/or `LINEAR_STATE_CACHE_TTL_MS`), then `catalyst-execution-core restart`. **Needs user input, not auto-fix** — the proxy port and CA path are machine-specific. Never write machine paths for the user. |
| Daemon env proxy configured but broken | The check reports the exact failure: port not listening (start `mitmdump … --listen-port <port>` or unset the proxy), `NODE_EXTRA_CA_CERTS` missing (fix the path / re-run mitmproxy to regenerate its CA), or `NODE_USE_ENV_PROXY=1` missing (add it — without it Node fetch silently bypasses the audit). Relay the specific warning + fix; restart the daemon after. |

**Observability (OTel) is optional.** If Docker or OTel containers aren't found, note it as
informational — don't treat it as an issue. Point the user to
https://github.com/ryanrozich/claude-code-otel if they want to set it up.

## Phase 3: Verify

After fixing, run the health check script again (re-resolve, since each bash block
runs in a fresh shell):

```bash
source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
    "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
bash "${CATALYST_DEV_SCRIPTS}/check-setup.sh" 2>&1 || true
```

Re-run the drift check independently to confirm zero remaining drift (CTL-489):

```bash
bash plugins/dev/scripts/check-config-drift.sh \
  --config .catalyst/config.json \
  --template plugins/dev/templates/config.template.json
```

Compare the before/after results. Report:

1. What was fixed (with counts)
2. What still needs attention (with specific next steps)
3. Overall status

## Output Format

```
── Catalyst Setup ──────────────────────────────

[Phase 1 output from check-setup.sh]

── Fixing Issues ───────────────────────────────
  ✅ Created ~/catalyst/events/
  ✅ Initialized session database
  ✅ Set WAL mode
  ✅ Created thoughts/shared/reports/

── Config Drift ────────────────────────────────
Detected 2 missing template keys:
  • catalyst.orchestration.dispatchMode → "phase-agents"
  • catalyst.filter.groqModel → "llama-3.1-8b-instant"

Preview diff:
  --- .catalyst/config.json
  +++ /tmp/merged.json
  +    "orchestration": { "dispatchMode": "phase-agents" },
  +    "filter": { "groqModel": "llama-3.1-8b-instant" },

Apply these template additions? [y/N] y
  ✅ Merged 2 keys into .catalyst/config.json (existing values preserved)

── Verification ────────────────────────────────

[Phase 3 output from check-setup.sh]

── Summary ─────────────────────────────────────
Fixed 4 issues automatically.

Still needs attention:
  • Linear API token — add to ~/.config/catalyst/config-<project>.json
  • OTel stack — run: docker compose up -d
```

## Important

- **Always run the check script first** — don't guess what's wrong
- **Fix silently** — auto-fixable issues are safe operations, don't ask permission for mkdir or
  sqlite3 pragmas
- **Always verify after fixing** — run the check script a second time to confirm
- **Never touch secrets** — don't write API tokens or credentials, just tell the user where to put
  them
- **Idempotent** — safe to run multiple times, won't break anything that's already working
