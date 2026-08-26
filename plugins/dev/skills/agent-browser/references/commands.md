# Command catalog — navigation, interaction, inspection

Every command below takes the global flags — `--headed --session <name>` on every one, see SKILL.md's session-hygiene rule. State/auth, cookies/storage, tabs, frames, JS, console, dialogs, settings, network, and debug/recording commands are a separate reference, linked from SKILL.md.

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

### Snapshot (AI-optimized)
```bash
agent-browser snapshot             # Full accessibility tree with refs
agent-browser snapshot -i          # Interactive elements only
agent-browser snapshot -i -c       # Interactive + compact (RECOMMENDED)
agent-browser snapshot -C          # Include cursor-interactive elements
agent-browser snapshot -d <n>      # Limit tree depth
agent-browser snapshot -s "<css>"  # Scope to CSS selector
agent-browser snapshot --json      # JSON output
```
Use `@refs` returned by a snapshot directly in later commands — no CSS selectors needed.

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

### State checks
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

### Semantic locators
```bash
agent-browser find role <role> <action>       # Find by ARIA role
agent-browser find text <text> <action>       # Find by text
agent-browser find label <label> <action>     # Find by label
agent-browser find placeholder <ph> <action>  # Find by placeholder
agent-browser find alt <text> <action>        # Find by alt text
agent-browser find testid <id> <action>       # Find by test ID
agent-browser find nth <n> <sel> <action>     # Find nth match
```
