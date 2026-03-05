---
name: agent-browser
description: Fast browser automation CLI for AI agents. **ALWAYS use instead of Playwright MCP tools** for web testing, screenshots, form filling, and UI verification. Use when user says "open in browser", "check the site", "take a screenshot", "fill the form", "test the UI", or any browser interaction. Also use as a fallback when a task requires visual browser interaction that CLIs and APIs cannot handle (e.g., OAuth flows, complex dashboards, visual verification).
---

# agent-browser CLI Reference

## When to Use This Skill

**Prefer programmatic tools first** (CLIs, APIs, MCP servers). Use agent-browser when:
- The task requires a **visual browser** (OAuth login, dashboards, visual verification)
- No CLI/API alternative exists for the interaction
- The user explicitly asks to "open", "browse", "check the site", or "take a screenshot"
- You need to fill forms, click through UIs, or test web interfaces

**Do NOT use Playwright MCP tools.** If browser automation is needed, always use `agent-browser` CLI instead.

## Starting a Browser Session

**ALWAYS use `--headed` and a named session.** Headed mode shows a visible browser window so the user can watch. Sessions preserve browser state so they survive accidental closes and can be resumed.

```bash
agent-browser --headed --session my-task open https://example.com
agent-browser --headed --session my-task snapshot -i -c
```

Pick a short descriptive session name for the task (e.g., `v0-chat`, `gh-review`, `test-login`). Use the same `--headed --session <name>` flags on every command.

### Authentication Flow

If a site requires login, **you MUST use `--headed`** so the user can see and interact with the browser window.

1. Open the login page in headed mode with a named session:
   ```bash
   agent-browser --headed --session my-task open https://example.com/login
   ```
2. Tell the user: **"A browser window opened. Please log in, then let me know when you're ready."**
3. **Wait for the user to confirm** they've logged in. Do NOT proceed until they say so.
4. Then continue:
   ```bash
   agent-browser --headed --session my-task snapshot -i -c
   ```
5. Optionally save the authenticated state for reuse:
   ```bash
   agent-browser --headed --session my-task state save ./auth-state.json
   ```

Sessions persist across commands — once logged in, the session stays active for all subsequent commands. If the browser is closed accidentally, re-open with the same `--session` name to resume.

## Global Flags

These flags apply to ALL commands and should appear before the command name:

```bash
--headed                    # Show visible browser window (default: headless) — ALWAYS USE THIS
--session <name>            # Use a named session (preserves state across commands) — ALWAYS USE THIS
--profile <path>            # Persistent browser profile directory (survives restarts)
--state <path>              # Load storage state from JSON file
--headers <json>            # Set HTTP headers scoped to origin
--proxy <url>               # Use a proxy server
--ignore-https-errors       # Ignore SSL certificate errors
--device <name>             # Emulate a device (e.g., "iPhone 14")
--json                      # Output in JSON format
--debug                     # Enable debug output
--config <path>             # Path to config file
```

Environment variables (alternative to flags):

```bash
AGENT_BROWSER_HEADED=1             # Enable headed mode
AGENT_BROWSER_SESSION=<name>       # Set session name
AGENT_BROWSER_PROFILE=<path>       # Set profile directory
```

## Quick Reference

```bash
# Navigation (always include --headed --session <name>)
agent-browser --headed --session s open <url>    # Open URL
agent-browser --headed --session s back          # Navigate back
agent-browser --headed --session s reload        # Reload page

# Get page state (use -i -c for efficiency)
agent-browser --headed --session s snapshot -i -c  # Interactive elements only, compact

# Interact using @refs from snapshot
agent-browser --headed --session s click @e2       # Click element
agent-browser --headed --session s fill @e3 "text" # Fill input
agent-browser --headed --session s type @e3 "text" # Type (preserves existing)
agent-browser --headed --session s press Enter     # Press key

# Screenshots
agent-browser --headed --session s screenshot              # Viewport
agent-browser --headed --session s screenshot -f           # Full page
agent-browser --headed --session s screenshot file.png     # Save to file

# Get info
agent-browser --headed --session s get text @e1   # Get element text
agent-browser --headed --session s get url        # Current URL
agent-browser --headed --session s get title      # Page title

# Session management
agent-browser session list                         # List sessions
agent-browser --headed --session s close           # Close browser
```

## Efficiency Tips

1. **Use `-i -c` flags** on snapshot to get only interactive elements in compact form
2. **Chain commands** with `&&` for quick workflows
3. **Use @refs** directly from snapshots — no CSS selectors needed
4. **Sessions persist** — browser state maintained across commands
5. **ALWAYS pass `--headed`** — default is headless, user needs to see the browser

## All Commands

### Navigation
```bash
agent-browser open <url>           # Navigate (aliases: goto, navigate)
agent-browser back                 # Browser back
agent-browser forward              # Browser forward
agent-browser reload               # Reload page
agent-browser close                # Close browser session (aliases: quit, exit)
```

### Interaction
```bash
agent-browser click <sel>          # Click element (--new-tab for new tab)
agent-browser dblclick <sel>       # Double-click
agent-browser focus <sel>          # Focus element
agent-browser type <sel> <text>    # Type without clearing
agent-browser fill <sel> <text>    # Clear then fill
agent-browser press <key>          # Press key (Enter, Tab, Control+a)
agent-browser hover <sel>          # Hover element
agent-browser select <sel> <val>   # Select dropdown option
agent-browser check <sel>          # Check checkbox
agent-browser uncheck <sel>        # Uncheck checkbox
agent-browser scroll <dir> [px]    # Scroll (up/down/left/right)
agent-browser scrollintoview <sel> # Scroll element into view
agent-browser drag <src> <tgt>     # Drag and drop
agent-browser upload <sel> <files> # Upload files
```

### Snapshot (AI-Optimized)
```bash
agent-browser snapshot             # Full accessibility tree with refs
agent-browser snapshot -i          # Interactive elements only
agent-browser snapshot -i -c       # Interactive + compact (RECOMMENDED)
agent-browser snapshot -C          # Include cursor-interactive elements
agent-browser snapshot -d <n>      # Limit tree depth
agent-browser snapshot -s "<css>"  # Scope to CSS selector
agent-browser snapshot --json      # JSON output
```

### Screenshots
```bash
agent-browser screenshot [path]    # Viewport screenshot
agent-browser screenshot -f        # Full page screenshot
agent-browser screenshot --annotate # With numbered element labels
agent-browser pdf <path>           # Save as PDF
```

### Information
```bash
agent-browser get text <sel>       # Get text content
agent-browser get html <sel>       # Get innerHTML
agent-browser get value <sel>      # Get input value
agent-browser get attr <sel> <attr># Get attribute
agent-browser get title            # Get page title
agent-browser get url              # Get current URL
agent-browser get count <sel>      # Count matching elements
agent-browser get box <sel>        # Get bounding box
agent-browser get styles <sel>     # Get computed styles
```

### State Checks
```bash
agent-browser is visible <sel>     # Check visibility
agent-browser is enabled <sel>     # Check enabled state
agent-browser is checked <sel>     # Check checked state
```

### Wait
```bash
agent-browser wait <selector>      # Wait for element visibility
agent-browser wait <ms>            # Wait N milliseconds
agent-browser wait --text "text"   # Wait for text to appear
agent-browser wait --url "pattern" # Wait for URL pattern
agent-browser wait --load networkidle # Wait for network idle
agent-browser wait --fn "condition" # Wait for JS condition
agent-browser wait --download [path] # Wait for download
```

### State Management (Auth Persistence)
```bash
agent-browser state save <path>    # Save cookies/localStorage to file
agent-browser state load <path>    # Load state from file
agent-browser state list           # List saved states
agent-browser state show <file>    # Show state contents
agent-browser state clear [name]   # Clear a specific state
agent-browser state clear --all    # Clear all states
```

### Saved Auth Flows
```bash
agent-browser auth save <name>     # Save an auth flow definition
agent-browser auth save <name> \
  --url <url> \
  --username <user> \
  --password <pass> \
  --username-selector <sel> \
  --password-selector <sel> \
  --submit-selector <sel>          # Save with full config
agent-browser auth login <name>    # Re-run a saved login
agent-browser auth list            # List saved auth configs
agent-browser auth show <name>     # Show auth config
agent-browser auth delete <name>   # Delete auth config
```

### Cookies & Storage
```bash
agent-browser cookies              # List cookies
agent-browser cookies set <n> <v>  # Set cookie
agent-browser cookies clear        # Clear cookies
agent-browser storage local        # List localStorage
agent-browser storage local <key>  # Get localStorage value
agent-browser storage local set <k> <v> # Set localStorage value
agent-browser storage local clear  # Clear localStorage
agent-browser storage session      # Same for sessionStorage
```

### Tabs
```bash
agent-browser tab                  # List tabs
agent-browser tab new [url]        # Open new tab
agent-browser tab <n>              # Switch to tab n
agent-browser tab close [n]        # Close tab
```

### Frames
```bash
agent-browser frame <sel>          # Switch to iframe
agent-browser frame main           # Return to main frame
```

### JavaScript
```bash
agent-browser eval '<expression>'  # Run JavaScript
agent-browser eval --stdin         # Read JS from stdin
```

### Console & Errors
```bash
agent-browser console              # View console messages
agent-browser console --clear      # Clear console log
agent-browser errors               # View JS errors
```

### Dialogs
```bash
agent-browser dialog accept [text] # Accept dialog
agent-browser dialog dismiss       # Dismiss dialog
```

### Settings
```bash
agent-browser set viewport <w> <h> # Set viewport size
agent-browser set device <name>    # Device emulation (e.g., "iPhone 14")
agent-browser set media [dark|light] # Color scheme
agent-browser set geo <lat> <lng>  # Set geolocation
agent-browser set offline [on|off] # Toggle offline mode
agent-browser set headers <json>   # Set global headers
agent-browser set credentials <u> <p> # Set HTTP basic auth
```

### Network
```bash
agent-browser network requests             # Show network requests
agent-browser network requests --filter api # Filter requests
agent-browser network requests --clear      # Clear request log
agent-browser network route <url> --abort   # Block URL
agent-browser network route <url> --body <json> # Mock response
agent-browser network unroute [url]         # Remove intercept
```

### Semantic Locators
```bash
agent-browser find role <role> <action>       # Find by ARIA role
agent-browser find text <text> <action>       # Find by text
agent-browser find label <label> <action>     # Find by label
agent-browser find placeholder <ph> <action>  # Find by placeholder
agent-browser find alt <text> <action>        # Find by alt text
agent-browser find testid <id> <action>       # Find by test ID
agent-browser find nth <n> <sel> <action>     # Find nth match
```

### Debug & Recording
```bash
agent-browser trace start [path]   # Start Playwright trace
agent-browser trace stop [path]    # Stop trace
agent-browser record start <path>  # Record interactions
agent-browser record stop          # Stop recording
agent-browser highlight <sel>      # Highlight element
agent-browser connect <port|url>   # Connect to existing browser
```

## Important Rules

1. **Always use `--headed`** on every command — default is headless, user needs to see the browser
2. **Always use `--session <name>`** on every command — preserves state, enables recovery
3. **For authenticated sites**, use `--headed` and ask the user to log in manually
4. **Use snapshot -i -c** for AI-efficient page state
5. **Use @refs** from snapshots for interactions, not CSS selectors
6. **agent-browser, NOT Playwright MCP** — always prefer the CLI
7. **Close when done**: `agent-browser --headed --session <name> close` to clean up
