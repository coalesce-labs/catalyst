---
name: setup-warp
description:
  "Interactively configure Warp terminal as a Catalyst launcher. Checks Warp install, detects
  projects, interviews the user for display details (name/emoji/color/variants) and generates
  ~/.warp/tab_configs/*.toml files with session-naming and remote-control wiring. Idempotent — re-run
  to add or update projects."
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob, AskUserQuestion
---

# Setup Warp

Configure Warp terminal to work as a Catalyst launcher. Scan the user's machine for projects,
interview them, and generate `~/.warp/tab_configs/*.toml` files following the "catalyst quartet"
pattern (main + PM + new-worktree + worktree + orchestrator), with colors, emoji, and session-name
wiring so Claude's in-UI session name, terminal title, and remote-control name all match the Warp
tab.

## Known limitations (tell the user up front)

- **Warp's `+` menu order is not controllable.** Warp reads `~/.warp/tab_configs/` in raw
  `readdir()` order; on APFS this is filename-hash order (not insertion, not alphabetical, not
  sortable). We still use `NN_` numeric prefixes so `ls` gives coherent shell-side order. The visual
  `+` menu is scrambled — that's a Warp limitation, not ours. We'll offer to file a feature request
  at the end.
- **Tab configs aren't palette-searchable.** `⌘P` searches open tabs, directories, and launch
  configurations — not tab configs. Migrating to launch_configurations was considered and rejected
  because they open in a new window by default and are marked legacy by Warp.
- **Session naming lives in env vars.** Generated TOMLs export `CATALYST_WARP_NAME` +
  `CATALYST_WARP_REMOTE` so `catalyst-claude.sh` forwards them to `claude --name` +
  `--remote-control-session-name-prefix`. If the user doesn't use `catalyst-claude.sh` wrapper, the
  naming won't propagate.

## Phase 0: Preflight

### 0.1 — Check Warp is installed

```bash
if [[ ! -d "/Applications/Warp.app" ]]; then
  echo "MISSING"
fi
```

If missing, use `AskUserQuestion` to ask:

> Warp is not installed. Install via Homebrew (`brew install --cask warp`)?

- Yes → run `brew install --cask warp`, wait for success
- No → tell user: "Install manually from https://www.warp.dev/ then re-run `/catalyst-dev:setup-warp`." Exit cleanly.

### 0.2 — Locate the catalyst clone

Generated TOMLs need absolute paths to `launch-worktree-tab.sh` and `launch-orchestrator-tab.sh`.

```bash
CATALYST_ROOT=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  # When skill runs from the installed plugin, CLAUDE_PLUGIN_ROOT points to plugins/dev/.
  # Walk up to the repo root.
  CANDIDATE="$(cd "${CLAUDE_PLUGIN_ROOT}/../.." 2>/dev/null && pwd || true)"
  [[ -f "${CANDIDATE}/plugins/dev/scripts/launch-worktree-tab.sh" ]] && CATALYST_ROOT="$CANDIDATE"
fi

# Common paths fallback
for p in "$HOME/code-repos/github/coalesce-labs/catalyst" "$HOME/catalyst"; do
  [[ -z "$CATALYST_ROOT" && -f "$p/plugins/dev/scripts/launch-worktree-tab.sh" ]] && CATALYST_ROOT="$p"
done
```

If still empty, ask the user for the path.

### 0.3 — Ensure `~/.warp/tab_configs/`

```bash
mkdir -p ~/.warp/tab_configs
```

### 0.4 — Back up existing configs

If any `*.toml` files are present:

```bash
TS="$(date +%Y-%m-%d_%H%M%S)"
BACKUP="$HOME/.warp/tab_configs_backup_$TS"
mkdir -p "$BACKUP"
cp ~/.warp/tab_configs/*.toml "$BACKUP/" 2>/dev/null || true
echo "Backed up to: $BACKUP"
```

Tell the user the backup path so they can restore if needed.

### 0.5 — Vertical tabs sidebar (informational only)

Do NOT auto-write plist keys (the exact key name varies by Warp version). Instead, run:

```bash
defaults read dev.warp.Warp-Stable 2>/dev/null | grep -iE 'tab|sidebar' | head -10 || true
```

Show output and tell the user:

> To enable vertical tabs (recommended when you have many tab configs):
> Warp → Settings → Appearance → Tab Bar → "Vertical" or "Left".

## Phase 1: Detect projects

### 1.1 — Scan common directories

```bash
for base in "$HOME/code-repos" "$HOME/Developer" "$HOME/Projects" "$HOME/src"; do
  [[ -d "$base" ]] || continue
  find "$base" -mindepth 2 -maxdepth 3 -type d -name ".git" 2>/dev/null
done | xargs -I{} dirname {} 2>/dev/null | sort -u
```

Exclude worktree dirs (anything under `$HOME/catalyst/wt/`, `$HOME/.warp/worktrees/`).

### 1.2 — Present to user

Use `AskUserQuestion` with one question containing the detected project list as multi-select options (plus an "Add a path manually" option).

## Phase 2: Interview each project

For each selected project, collect (in one `AskUserQuestion` call with multiple questions when
possible, or sequential questions):

- **Display name** — shown in Warp menu (e.g., "Catalyst", "Adva")
- **Short identifier (slug)** — alnum/dash only, lowercase (e.g., `catalyst`, `bob-rozich`). Default:
  lowercase display name with spaces → dashes, non-alnum stripped.
- **Emoji** — for main tab (default: `📦`)
- **Color** — Warp only accepts these 8 values: `black`, `red`, `green`, `yellow`, `blue`,
  `magenta`, `cyan`, `white`. **Do not offer any others** — Warp rejects unknown variants with a
  TOML parse error at load. Recommend against `black` (invisible on dark themes). Each project
  gets a distinct color so vertical-sidebar tabs are visually separable.
- **Variants** — multi-select from:
  - Main (always recommended)
  - PM worktree (only for Catalyst-managed projects)
  - New worktree (prompts for branch + optional description)
  - Existing worktree (branch picker)
  - Orchestrator (for projects using `/catalyst-dev:orchestrate`)
- **Setup command** — optional init for the main tab (e.g., `bun install && scripts/setup-env.sh`).
  Leave blank if none.
- **Worktree base dir** — where this project's worktrees live, if worktree variants selected.
  Default: `$HOME/catalyst/wt/<repo-name>/<branch>` following the Catalyst convention.

## Phase 3: Global ordering

The `+` menu is scrambled regardless, but `ls ~/.warp/tab_configs/` follows numeric prefix order —
so pick an order that's meaningful for shell-side discovery.

Default order: the project that owns this skill installation first (typically `catalyst`), then
alphabetical. Ask the user to confirm or reorder.

## Phase 4: Generate

### 4.1 — Clear existing configs

If tab_configs contains existing files (backed up in Phase 0.4), confirm with user:

> Delete current ~/.warp/tab_configs/*.toml and regenerate? (Backup exists at $BACKUP)

On yes:
```bash
rm -f ~/.warp/tab_configs/*.toml
```

### 4.2 — Write each TOML

Compute prefix counter starting at 01. For each project in the Phase 3 order, emit each enabled
variant in this order: Main, PM, New Worktree, Worktree, Orchestrator.

**Naming conventions**:
- Emoji per variant: Main `📦`, PM `📋`, New Worktree `🆕`, Worktree `🔀`, Orchestrator `🚀`
- Color per variant: Main/New/Worktree/Orchestrator → project color. PM → always `blue` (cross-project
  convention for PM/backlog work).
- Session name per variant: `<slug>` (main), `<slug>_pm`, `<slug>_<branch>[_<desc>]`,
  `<slug>_<worktree>`, `<slug>_<tickets>`.

### 4.3 — Templates

Substitute `{DISPLAY}`, `{EMOJI}`, `{COLOR}`, `{SLUG}`, `{PROJECT_PATH}`, `{WORKTREE_BASE}`,
`{CATALYST_ROOT}`, `{SETUP_CMD_SUFFIX}` (either empty or ` 'cmd'`).

#### Main project tab (e.g., `01_catalyst.toml`)

```toml
name = "{DISPLAY} {EMOJI}"
title = "{DISPLAY}"
color = "{COLOR}"

[[panes]]
id = "main"
type = "terminal"
directory = "{PROJECT_PATH}"
commands = [
  "export CATALYST_WARP_NAME={SLUG} CATALYST_WARP_REMOTE={SLUG}",
  "{CATALYST_ROOT}/plugins/dev/scripts/open-project-tab.sh{SETUP_CMD_SUFFIX}",
]
```

#### PM worktree tab

```toml
name = "{DISPLAY} 📋 PM"
title = "{DISPLAY}: PM"
color = "blue"

[[panes]]
id = "main"
type = "terminal"
directory = "{PROJECT_PATH}"
commands = [
  "{CATALYST_ROOT}/plugins/dev/scripts/launch-worktree-tab.sh --project {SLUG} pm main",
]
```

#### New worktree tab (prompts for branch + description)

```toml
name = "{DISPLAY} 🆕 New Worktree"
title = "{DISPLAY}: {{branch}}"
color = "{COLOR}"

[[panes]]
id = "main"
type = "terminal"
directory = "{PROJECT_PATH}"
commands = [
  "{CATALYST_ROOT}/plugins/dev/scripts/launch-worktree-tab.sh --project {SLUG} '{{branch}}' main '{{description}}'",
]

[params.branch]
type = "text"
description = "Branch/worktree name (e.g. {TICKET_EXAMPLE}, fix-auth)"

[params.description]
type = "text"
description = "Optional short description. Leave blank for none."
```

`{TICKET_EXAMPLE}` — use a sensible example like `CTL-72` for catalyst, `ADV-230` for Adva, or
`NEW-1` as fallback.

#### Existing worktree picker tab

```toml
name = "{DISPLAY} 🔀 Worktree"
title = "{DISPLAY}: {{worktree}}"
color = "{COLOR}"

[[panes]]
id = "main"
type = "terminal"
directory = "{WORKTREE_BASE}/{{worktree}}"
commands = [
  "export CATALYST_WARP_NAME={SLUG}_{{worktree}} CATALYST_WARP_REMOTE={SLUG}_{{worktree}}",
  "direnv allow . && eval \"$(direnv export zsh)\"",
  "yes | humanlayer thoughts init --profile $HUMANLAYER_PROFILE --directory $HUMANLAYER_DIRECTORY 2>/dev/null; humanlayer thoughts sync",
  "{CATALYST_ROOT}/plugins/dev/scripts/trust-workspace.sh \"$(pwd)\"",
  "git status",
]

[params.worktree]
type = "branch"
description = "Pick the branch whose worktree you want to open"
```

#### Orchestrator tab

```toml
name = "{DISPLAY} 🚀 Orchestrator"
title = "{DISPLAY}: orchestrate"
color = "{COLOR}"

[[panes]]
id = "main"
type = "terminal"
directory = "{PROJECT_PATH}"
commands = [
  "{CATALYST_ROOT}/plugins/dev/scripts/launch-orchestrator-tab.sh --project {SLUG} '{{tickets}}'",
]

[params.tickets]
type = "text"
description = "Use + for spaces: {TICKET_EXAMPLE}+{TICKET_EXAMPLE_2}, --cycle+current, --project+Project+Name, --auto+5"
```

## Phase 5: Verify & hand off

After all files are written:

1. Run `ls ~/.warp/tab_configs/` to show the final prefix-ordered list.
2. Tell the user to **fully quit and relaunch Warp** (not just close the window) to pick up the
   new configs.
3. Summarize what was generated (count per project, variants, session-name examples).
4. Offer to open a Warp feature-request URL for menu sort support:

   > Want to file a feature request with Warp for tab-config menu sort order?
   > https://github.com/warpdotdev/Warp/issues/new?title=Sort%20tab%20configs%20in%20%2B%20menu

5. Point to the website guide at `https://<docs-host>/guides/warp-terminal` (or the local path if
   offline) for the full reference.

## Important

- **Idempotent**: Re-run to add new projects or update existing ones — always back up first.
- **Never destroy**: The backup in Phase 0.4 is sacred. Never skip it.
- **Don't auto-toggle plist keys**: Sidebar and theme prefs vary by Warp version — direct the user to
  Settings.
- **Respect paths**: Warp's tab configs accept `~` in `directory` but absolute paths are safer.
  Launcher script paths MUST be absolute (Warp's shell doesn't expand `$HOME` reliably before exec).
- **Session naming depends on `catalyst-claude.sh`**: The env-var-to-`--name` forwarding happens in
  that wrapper. If a project doesn't use catalyst-claude.sh (rare), the session naming won't flow
  through.
