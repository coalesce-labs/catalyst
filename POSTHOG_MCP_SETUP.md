# PostHog MCP Setup - Quick Fix

**Issue**: PostHog MCP not loading after enabling catalyst-analytics plugin

**Root Cause**: Missing `POSTHOG_AUTH_HEADER` environment variable

---

## Quick Fix (5 minutes)

### Step 1: Get Your PostHog Token

1. Log into PostHog: https://app.posthog.com
2. Navigate to: **Project Settings → API Keys**
3. Create or copy your **Personal API Key**
4. Format: `phx_YOUR_TOKEN_HERE`

### Step 2: Set Environment Variable

**Add to your shell profile:**

```bash
# Open your shell config
nano ~/.zshrc  # or ~/.bashrc for bash

# Add this line (replace with your actual token)
export POSTHOG_AUTH_HEADER="Bearer phx_YOUR_TOKEN_HERE"

# Save and reload
source ~/.zshrc
```

**Verify it's set:**

```bash
echo $POSTHOG_AUTH_HEADER
# Should output: Bearer phx_...
```

### Step 3: Restart Claude Code

**Critical**: You must fully restart Claude Code (not just reload)

```bash
# Quit Claude Code completely
# Then relaunch it from terminal to inherit env vars
open -a "Claude Code"
```

### Step 4: Verify Plugin Enabled

In Claude Code:

```bash
/plugin list
# catalyst-analytics should show as enabled
```

### Step 5: Test It Works

```bash
/product-metrics "Show MAU for last 30 days"
```

If you see PostHog data, it's working! 🎉

---

## Troubleshooting

### "PostHog MCP not available"

**Check 1: Environment Variable**
```bash
echo $POSTHOG_AUTH_HEADER
```
- ❌ Empty? Go back to Step 2
- ✅ Shows token? Continue to Check 2

**Check 2: Claude Code Launched from Terminal**
- ❌ Launched from Dock/Finder? May not inherit env vars
- ✅ Launch from terminal:
  ```bash
  open -a "Claude Code"
  ```

**Check 3: Full Restart**
- ❌ Just reloaded window? Not enough
- ✅ Completely quit and relaunch Claude Code

**Check 4: Plugin Enabled**
```bash
/plugin list
```
- ❌ catalyst-analytics not in list? Install it first:
  ```bash
  /plugin install catalyst-analytics@catalyst
  ```
- ❌ Shows as disabled? Enable it:
  ```bash
  /plugin enable catalyst-analytics
  ```
- ✅ Shows as enabled? Should work after restart

### "Context too large" warning

**This is expected** - PostHog MCP adds ~40k tokens

**Solution**: Disable when not using analytics

```bash
# Enable only when analyzing metrics
/plugin enable catalyst-analytics

# Disable when done to save context
/plugin disable catalyst-analytics
```

### Token expired or invalid

**Symptom**: Authentication errors

**Solution**:
1. Generate new Personal API Key in PostHog
2. Update environment variable
3. Restart Claude Code

---

## Why This Happens

Claude Code's plugin system:

1. Reads `.mcp.json` from enabled plugins
2. Expands environment variables like `${POSTHOG_AUTH_HEADER}`
3. Launches MCP servers at startup
4. **Requires restart** to pick up changes

If the environment variable isn't set when Claude Code launches:
- ❌ `${POSTHOG_AUTH_HEADER}` expands to empty string
- ❌ PostHog MCP can't authenticate
- ❌ Server fails to start
- ❌ No tools available

---

## Best Practices

### For Daily Use

**Enable when analyzing**:
```bash
/plugin enable catalyst-analytics
# Restart Claude Code
/product-metrics "your query"
```

**Disable when done**:
```bash
/plugin disable catalyst-analytics
# Restart Claude Code
```

### For Team Setups

**Share setup instructions**:

1. Add to team wiki/README:
   ```markdown
   ## PostHog Analytics Access

   To use `/product-metrics` and other analytics commands:

   1. Get PostHog API key from [team lead]
   2. Add to ~/.zshrc: `export POSTHOG_AUTH_HEADER="Bearer phx_..."`
   3. Enable plugin: `/plugin enable catalyst-analytics`
   4. Restart Claude Code
   ```

2. Keep token secure (don't commit to git)

---

## Related Documentation

- **Plugin Validation**: `docs/PLUGIN_MCP_VALIDATION.md` - Full research findings
- **Analytics Plugin**: `plugins/analytics/README.md` - Usage guide
- **MCP Strategy**: `docs/MCP_MANAGEMENT_STRATEGY.md` - Architecture overview

---

## Success Criteria

✅ Environment variable set and verified
✅ Claude Code restarted from terminal
✅ catalyst-analytics plugin enabled
✅ `/product-metrics` command works
✅ PostHog data visible in responses

When all checkboxes are ticked, you're done! 🚀
