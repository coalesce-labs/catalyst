# Command catalog — state, auth, tabs, network, debug

Every command below takes the global flags — `--headed --session <name>` on every one, see
SKILL.md's session-hygiene rule. Core navigation/interaction/snapshot commands are a separate
reference, linked from SKILL.md.

### State management (auth persistence)
```bash
agent-browser state save <path>    # Save cookies/localStorage to file
agent-browser state load <path>    # Load state from file
agent-browser state list           # List saved states
agent-browser state show <file>    # Show state contents
agent-browser state clear [name]   # Clear a specific state
agent-browser state clear --all    # Clear all states
```

### Saved auth flows
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

### Cookies & storage
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

### Console & errors
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

### Debug & recording
```bash
agent-browser trace start [path]   # Start Playwright trace
agent-browser trace stop [path]    # Stop trace
agent-browser record start <path>  # Record interactions
agent-browser record stop          # Stop recording
agent-browser highlight <sel>      # Highlight element
agent-browser connect <port|url>   # Connect to existing browser
```
