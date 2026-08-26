---
name: agent-browser
description: Fast browser automation CLI for AI agents. **ALWAYS use instead of Playwright MCP tools** for web testing, screenshots, form filling, and UI verification. Use when user says "open in browser", "check the site", "take a screenshot", "fill the form", "test the UI", or any browser interaction. Also use as a fallback when a task requires visual browser interaction that CLIs and APIs cannot handle (e.g., OAuth flows, complex dashboards, visual verification).
---

# agent-browser CLI Reference

## When to use this skill

**Prefer programmatic tools first** (CLIs, APIs, MCP servers). Use `agent-browser` when the task
needs a **visual browser** (OAuth login, dashboards, visual verification), no CLI/API alternative
exists, or the user explicitly asks to "open"/"browse"/"check the site"/"take a screenshot".

**Do NOT use Playwright MCP tools.** Always use the `agent-browser` CLI instead.

## The one rule: every session is named and closed

`agent-browser` runs a **persistent per-session daemon** that owns a real "Chrome for Testing"
browser. That daemon **outlives the CLI** — the browser keeps running (and, on an auto-refreshing
page, keeps pegging a CPU core) until something closes it. On shared fleet/worker hosts a leaked
browser starves the box (CTL-1500). So:

- **Every command carries `--headed --session <name>`** — a short, task-specific name (e.g.
  `ctl-1500-verify`, `gh-review`). Never the implicit `default` session: it collides across
  concurrent workers and is the hardest leak to attribute.
- **Close in the same turn you finish**: `agent-browser --session <name> close`. If you took a
  wrong turn, close before starting over — never leave a session open "in case".
- **Never write an open-loop without a guaranteed close** (e.g. `until agent-browser --session s
  open <url>; do sleep …; done`) — each failed `open` can spawn/adopt a browser and a loop that
  exits without closing strands them. If you must poll, `open` once, then `wait`/`reload`, and
  `close` in a trap/`finally`.
- **On a worker/CI host**, close immediately — the host reaper (orphan-sweep vector 5) is a
  backstop, not a substitute.

```bash
agent-browser --headed --session my-task open https://example.com
agent-browser --headed --session my-task snapshot -i -c   # interactive elements, compact
agent-browser --headed --session my-task click @e2
agent-browser --headed --session my-task fill @e3 "text"
agent-browser --headed --session my-task screenshot -f
agent-browser --headed --session my-task close
```

For a login flow: open the login page `--headed`, tell the user "A browser window opened — please
log in, then let me know", wait for their confirmation, then continue with the same
`--headed --session <name>`. Optionally persist it: `agent-browser --headed --session my-task state
save ./auth-state.json`.

## Reference

| topic | file |
| -- | -- |
| every global flag and env var | [`references/flags.md`](references/flags.md) |
| navigation, interaction, snapshot, screenshots, info, wait, semantic locators | [`references/commands.md`](references/commands.md) |
| state/auth, cookies/storage, tabs, frames, JS, console, dialogs, settings, network, debug | [`references/commands-advanced.md`](references/commands-advanced.md) |

## Efficiency tips

1. Use `-i -c` on `snapshot` for interactive elements only, in compact form.
2. Chain commands with `&&`.
3. Use `@refs` from a snapshot directly — no CSS selectors needed.
4. Sessions persist state across commands, so you don't need to re-authenticate per command.
