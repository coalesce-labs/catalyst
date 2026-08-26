# Global flags and environment variables

These flags apply to every command and go before the command name. `--headed` and `--session <name>` are required on every invocation — see SKILL.md's session-hygiene rule.

```bash
--headed                    # Show visible browser window (default: headless) — ALWAYS USE THIS
--session <name>            # Use a named session (preserves state across commands) — ALWAYS USE THIS
--profile <path>            # Persistent browser profile directory (survives restarts)
--state <path>              # Load storage state from JSON file
--headers <json>            # Set HTTP headers scoped to origin
--proxy <url>               # Use a proxy server
--ignore-https-errors       # Ignore SSL certificate errors
--device <name>             # Emulate a device (e.g., "iPhone 14")
--json                       # Output in JSON format
--debug                      # Enable debug output
--config <path>             # Path to config file
```

Equivalent environment variables, if you'd rather not repeat flags across a script:

```bash
AGENT_BROWSER_HEADED=1             # Enable headed mode
AGENT_BROWSER_SESSION=<name>       # Set session name
AGENT_BROWSER_PROFILE=<path>       # Set profile directory
```
