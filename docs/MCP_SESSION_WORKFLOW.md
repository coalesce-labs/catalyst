# MCP Session Workflow

**Problem**: Claude Code doesn't support "disabled by default" MCP configuration. All configured
MCPs start enabled, consuming context even when not needed.

**Solution**: Manual runtime toggling via `/mcp` command, made easy with workflow commands.

## Recommended Session Workflow

### 1. Start Every Session Lightweight

```bash
# First command in new session
/start-lightweight-session
```

This instructs you to:

1. Type `/mcp`
2. Disable **posthog** (~40k tokens)
3. Disable **sentry** (~20k tokens)

**Result**: Start with ~3.5k MCP tokens instead of ~65k

**Time cost**: ~15 seconds per session **Context savings**: ~61k tokens (30% of window)

### 2. Enable Tools As Needed

When you need specific capabilities:

```bash
# Need to analyze user behavior?
/enable-analytics
# → Enables PostHog (+40k tokens, 43 tools)

# Need to debug production errors?
/enable-debugging
# → Enables Sentry (+20k tokens, 19 tools)
```

### 3. Disable When Done

Free up context after debugging/analytics work:

```bash
/disable-heavy-mcps
# → Disables both PostHog and Sentry (-60k tokens)
```

## Session Patterns

### Pattern 1: Regular Development (90% of sessions)

```bash
# Start
/start-lightweight-session  # → 3.5k MCP tokens

# Work with lightweight tools
# - Context7 for library docs
# - DeepWiki for research
# - Regular Claude Code tools

# No need to enable heavy MCPs
```

**Context**: 3.5k tokens throughout session

### Pattern 2: Product Analytics Session

```bash
# Start
/start-lightweight-session  # → 3.5k MCP tokens

# Enable when needed
/enable-analytics           # → 44k MCP tokens

# Do analytics work
# Query PostHog for metrics, cohorts, funnels

# Disable when done
/disable-heavy-mcps         # → 3.5k MCP tokens
```

**Context**: 3.5k → 44k → 3.5k (adaptive)

### Pattern 3: Incident Response / Debugging

```bash
# Start
/start-lightweight-session  # → 3.5k MCP tokens

# Enable debugging tools
/enable-debugging           # → 24-65k MCP tokens
# (Sentry only = 24k, Sentry + PostHog = 65k)

# Debug production errors
# Search Sentry issues
# Analyze user impact with PostHog

# Disable after incident resolved
/disable-heavy-mcps         # → 3.5k MCP tokens
```

**Context**: 3.5k → 65k → 3.5k (adaptive)

### Pattern 4: Planning Session (Linear/GitHub)

```bash
# Start
/start-lightweight-session  # → 3.5k MCP tokens

# No need to enable PostHog/Sentry
# Linear and GitHub MCPs (if configured) stay enabled

# Use workflow commands
/research-codebase
/create-plan
```

**Context**: 3.5k tokens throughout

## Understanding Context Costs

### Lightweight MCPs (Always Enabled)

- **context7**: ~1,709 tokens - Library documentation
- **deepwiki**: ~1,885 tokens - GitHub repository research
- **Total**: ~3,594 tokens (~2% of 200k window)

### Heavy MCPs (Enable When Needed)

- **posthog**: ~40,645 tokens - Product analytics (43 tools)
- **sentry**: ~20,670 tokens - Error monitoring (19 tools)
- **Total**: ~61,315 tokens (~30% of 200k window)

### Impact on Conversation

**With all MCPs enabled**:

- System context: ~65k tokens
- Available for conversation: ~135k tokens

**With lightweight MCPs only**:

- System context: ~3.5k tokens
- Available for conversation: ~196k tokens
- **Gain**: +61k tokens for code, docs, discussion

## Why Manual Toggle?

**Current Limitation**: Claude Code doesn't support:

- `"disabled": true` flag in MCP configuration
- Persistent disabled state across sessions
- Programmatic enable/disable from slash commands

**Workarounds Evaluated**:

1. ❌ **Project-scoping** - Doesn't solve session-level problem
2. ❌ **McPick CLI** - Requires restart, not session-aware
3. ✅ **Runtime `/mcp` toggle** - Works perfectly, just manual
4. ✅ **Workflow commands** - Make toggling discoverable

## Future: Automatic Session Detection

If Claude Code adds programmatic MCP control, we could implement:

```bash
# Automatic detection
/start-session --detect
# → Asks: "What are you working on?"
#   1. Regular development (lightweight)
#   2. Analytics/metrics (enable PostHog)
#   3. Debugging (enable Sentry)
#   4. Incident response (enable both)
# → Automatically enables/disables based on choice
```

Until then, the manual `/mcp` approach with workflow commands is the best solution.

## Tips

1. **Make it a habit**: First command = `/start-lightweight-session`
2. **Check context**: Use `/context` to see current MCP usage
3. **Enable selectively**: Only load what you need for current task
4. **Disable after**: Free up context when switching tasks
5. **Profile your usage**: Most sessions don't need heavy MCPs

## Command Reference

| Command                      | Purpose                     | Context Change |
| ---------------------------- | --------------------------- | -------------- |
| `/start-lightweight-session` | Disable heavy MCPs          | 65k → 3.5k     |
| `/enable-analytics`          | Enable PostHog              | +40k           |
| `/enable-debugging`          | Enable Sentry (+ PostHog)   | +20k to +60k   |
| `/disable-heavy-mcps`        | Disable PostHog + Sentry    | -60k           |
| `/check-mcp-status`          | Show current MCP usage      | (info only)    |
| `/context`                   | Show full context breakdown | (info only)    |

## Configuration

Your `~/.claude.json` should have all MCPs configured:

```json
{
  "mcpServers": {
    "context7": {
      /* lightweight */
    },
    "deepwiki": {
      /* lightweight */
    },
    "posthog": {
      /* heavy - manually disable */
    },
    "sentry": {
      /* heavy - manually disable */
    }
  }
}
```

**Don't remove heavy MCPs from config** - they need to be configured to be available for toggling.

## Related Documentation

- `docs/MCP_MANAGEMENT_STRATEGY.md` - Overall strategy
- `plugins/dev/commands/start_lightweight_session.md` - Startup command
- `plugins/dev/commands/enable_analytics.md` - Enable PostHog
- `plugins/dev/commands/enable_debugging.md` - Enable Sentry
- `plugins/dev/commands/disable_heavy_mcps.md` - Disable both

---

**Bottom line**: Start lightweight (`/start-lightweight-session`), enable as needed (`/enable-*`),
disable when done (`/disable-heavy-mcps`). This gives you session-level control over your context
budget.
