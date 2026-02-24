---
name: agent-browser
description: Browser automation CLI for AI agents. ALWAYS use when the user asks to open a webpage, browse a site, take screenshots, fill forms, test UI, or interact with any website. Also use when browser testing, E2E testing, or web scraping is mentioned.
---

# agent-browser CLI Reference

**ALWAYS use `agent-browser` for browser automation. Do NOT use Playwright MCP tools.**

## Starting a Browser Session

Open a page in headed mode (browser window visible to user):

```bash
agent-browser open https://example.com
agent-browser snapshot -i -c
```

### Authentication Flow

If a site requires login, follow this flow:

1. Open the page:
   ```bash
   agent-browser open https://example.com/login
   ```
2. Tell the user: **"A browser window opened. Please log in, then let me know when you're ready."**
3. **Wait for the user to confirm** they've logged in. Do NOT proceed until they say so.
4. Then continue:
   ```bash
   agent-browser snapshot -i -c
   ```

Sessions persist across commands — once logged in, the session stays active for all subsequent commands.

## Quick Reference

```bash
# Navigation
agent-browser open <url>              # Open URL
agent-browser back / forward / reload # Navigate

# Get page state (use -i -c for efficiency)
agent-browser snapshot -i -c          # Interactive elements only, compact

# Interact using @refs from snapshot
agent-browser click @e2               # Click element
agent-browser fill @e3 "text"         # Fill input
agent-browser type @e3 "text"         # Type (preserves existing)
agent-browser press Enter             # Press key

# Screenshots
agent-browser screenshot              # Viewport
agent-browser screenshot -f           # Full page
agent-browser screenshot file.png     # Save to file

# Get info
agent-browser get text @e1            # Get element text
agent-browser get url                 # Current URL
agent-browser get title               # Page title

# Session management
agent-browser session list            # List sessions
agent-browser close                   # Close browser
```

## Efficiency Tips

1. **Use `-i -c` flags** on snapshot to get only interactive elements in compact form
2. **Chain commands** with `&&` for quick workflows
3. **Use @refs** directly from snapshots — no CSS selectors needed
4. **Sessions persist** — browser state maintained across commands
5. **Headed mode is default** — user can watch what you're doing

## All Commands

### Navigation
```bash
agent-browser open <url>           # Navigate (aliases: goto, navigate)
agent-browser back                 # Browser back
agent-browser forward              # Browser forward
agent-browser reload               # Reload page
agent-browser close                # Close browser session
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
```

### Wait
```bash
agent-browser wait <selector>      # Wait for element visibility
agent-browser wait <ms>            # Wait N milliseconds
agent-browser wait --text "text"   # Wait for text to appear
agent-browser wait --url "pattern" # Wait for URL pattern
```

### Cookies & Storage
```bash
agent-browser cookies              # List cookies
agent-browser cookies set <n> <v>  # Set cookie
agent-browser cookies clear        # Clear cookies
agent-browser storage local        # List localStorage
agent-browser storage local <key>  # Get localStorage value
```

### Tabs
```bash
agent-browser tab                  # List tabs
agent-browser tab new [url]        # Open new tab
agent-browser tab <n>              # Switch to tab n
agent-browser tab close [n]        # Close tab
```

### JavaScript
```bash
agent-browser eval '<expression>'  # Run JavaScript
```

### Settings
```bash
agent-browser set viewport <w> <h> # Set viewport size
agent-browser set device <name>    # Device emulation (e.g., "iPhone 14")
agent-browser set media [dark|light] # Color scheme
```

### Network
```bash
agent-browser network requests             # Show network requests
agent-browser network requests --filter api # Filter requests
agent-browser network route <url> --abort   # Block URL
```

### Semantic Locators
```bash
agent-browser find role <role> <action>       # Find by ARIA role
agent-browser find text <text> <action>       # Find by text
agent-browser find label <label> <action>     # Find by label
agent-browser find placeholder <ph> <action>  # Find by placeholder
agent-browser find testid <id> <action>       # Find by test ID
```

## Important Rules

1. **Headed mode is configured globally** — browser is always visible
2. **For authenticated sites**, open the login page and ask the user to log in manually
3. **Use snapshot -i -c** for AI-efficient page state
4. **Use @refs** from snapshots for interactions, not CSS selectors
5. **agent-browser, NOT Playwright MCP** — always prefer the CLI
6. **Close when done**: `agent-browser close` to clean up
