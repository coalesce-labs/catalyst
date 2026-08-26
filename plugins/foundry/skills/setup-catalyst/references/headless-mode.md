# Non-interactive / headless mode (CTL-842)

`setup-catalyst.sh` can run without a controlling terminal — CI pipelines, SSH exec, cron, and `curl | bash` via `curl … | bash -s -- --non-interactive`. Three flags activate the mode:

- `--non-interactive` or `--defaults` CLI flags (both identical)
- `CATALYST_AUTONOMOUS=1` environment variable (set by non-interactive callers such as `catalyst-join.sh`)

In this mode:

- `ask_yes_no` returns the default answer without reading stdin; a 3rd argument overrides the NI answer (install-offer sites pass `"n"` so they silently decline in CI).
- `prompt_value` echoes the default to stderr and returns it without consuming stdin.
- Install offers (`npm install -g humanlayer`, `brew install jq`, etc.) are declined automatically.
- The Linear config step is skipped when no token is discoverable from the environment or standard config paths (`~/.config/catalyst/`, `~/.config/humanlayer/`). Prints: `Skipping Linear (non-interactive, no token discoverable)`.
- The Sentry, PostHog, and Exa config steps are skipped unconditionally in NI mode.
- When multiple Linear teams or Sentry orgs/projects are found, the first entry is auto-selected with a printed notice — no prompt.
- The cloud-detection check ([cloud-detection.md](cloud-detection.md)) still runs and still prints its loud fallback message when the replica is absent — headless mode silences interactive *prompts*, not the loud diagnostic output the reading contract requires.

The tty redirect (`exec </dev/tty`) runs only in interactive mode and only when `can_open_tty` confirms the device is actually openable (subshell probe: `(: </dev/tty) 2>/dev/null`). This prevents ENXIO crashes on PTY-less CI runners where `/dev/tty` exists as a device node but is not attached to a session.

The source guard (`if ! (return 0 2>/dev/null); then main "$@"; fi`) replaces the old `BASH_SOURCE[0]`-based check and works correctly in `curl | bash` pipelines where `BASH_SOURCE[0]` is unset.
