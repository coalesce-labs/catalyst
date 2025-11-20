# Plugin Architecture - IMPLEMENTED ✅

**Status**: Completed on 2025-10-26 **See**: `PLUGIN_MIGRATION.md` for full implementation details

---

# Original Proposal: Use Case-Based Organization

## Problem (SOLVED)

**Current Architecture** (2 plugins):

- `catalyst-dev` - Everything: workflow commands, agents, AND implicit dependency on PostHog/Sentry
  MCPs
- `catalyst-meta` - Workflow discovery

**Issues**:

1. Heavy MCPs (PostHog ~40k, Sentry ~20k tokens) configured globally
2. All sessions start with heavy MCPs loaded
3. Manual toggling required every session
4. No clear separation between core dev tools and specialized use cases

## Proposed Architecture (4 plugins)

Organize by **use case** rather than **feature type**:

### 1. `catalyst-dev` (Core Development)

**Purpose**: Essential development workflow - no heavy MCPs

**Includes**:

- Core workflow commands: `/research-codebase`, `/create-plan`, `/implement-plan`
- Development commands: `/catalyst-dev:commit`, `/describe-pr`, `/create-worktree`
- Handoff system: `/create-handoff`, `/resume-handoff`
- All research agents (codebase-locator, analyzer, pattern-finder, etc.)
- Lightweight MCPs: DeepWiki (~1.9k), Context7 (~1.7k)

**Context cost**: ~3.5k tokens from MCPs + agent/command definitions

**Install by default**: ✅ Yes - core functionality everyone needs

---

### 2. `catalyst-analytics` (Product Analytics)

**Purpose**: PostHog integration for product metrics and user behavior

**Includes**:

- PostHog MCP (~40,645 tokens, 43 tools)
- `/analyze-user-behavior` - Query cohorts, funnels, retention
- `/product-metrics` - KPIs, conversion rates, feature usage
- `/segment-analysis` - User segmentation and targeting
- `@agent-analytics-insights` - Interpret PostHog data

**Context cost**: ~40k tokens when enabled

**Install by default**: ❌ No - optional, enable when needed

**When to enable**:

- Planning features based on usage data
- Analyzing conversion funnels
- Understanding user behavior
- Measuring feature adoption
- A/B test analysis

---

### 3. `catalyst-debugging` (Error Monitoring)

**Purpose**: Sentry integration for production error analysis

**Includes**:

- Sentry MCP (~20,670 tokens, 19 tools)
- `/debug-production-error` - Search and analyze Sentry issues
- `/error-impact-analysis` - Assess error severity and user impact
- `/trace-analysis` - Distributed tracing investigation
- `@agent-error-root-cause` - Root cause analysis with Seer

**Context cost**: ~20k tokens when enabled

**Install by default**: ❌ No - optional, enable when needed

**When to enable**:

- Investigating production errors
- Incident response
- Error trend analysis
- Release health monitoring
- Stack trace debugging

---

### 4. `catalyst-meta` (Workflow Discovery)

**Purpose**: Learn from community, create custom workflows

**Includes**:

- Workflow discovery commands
- Pattern analysis
- Custom workflow creation
- Best practices research

**Context cost**: Minimal (no heavy MCPs)

**Install by default**: ❌ No - optional for advanced users

---

## User Experience

### Scenario 1: Regular Development (90% of sessions)

```bash
# Only catalyst-dev installed
# Context: ~3.5k MCP tokens

/research-codebase "authentication flow"
/create-plan "Add OAuth support"
/implement-plan
/catalyst-dev:commit
```

**No heavy MCPs loaded** ✅

---

### Scenario 2: Product Analytics Session

```bash
# Enable analytics plugin when needed
/plugin enable catalyst-analytics

# Now PostHog MCP available
/analyze-user-behavior "checkout abandonment"
/product-metrics "conversion rate last 30 days"

# Disable when done
/plugin disable catalyst-analytics
```

**PostHog only loaded when explicitly enabled** ✅

---

### Scenario 3: Debugging Production Issue

```bash
# Enable debugging plugin for incident
/plugin enable catalyst-debugging

# Now Sentry MCP available
/catalyst-dev:debug-production-error "TypeError in checkout"
/error-impact-analysis

# Optional: Also enable analytics for user impact
/plugin enable catalyst-analytics
/segment-analysis "users affected by checkout error"

# Disable both when incident resolved
/plugin disable catalyst-debugging catalyst-analytics
```

**Sentry + PostHog only loaded during incidents** ✅

---

## Technical Implementation

### Plugin Structure

Each plugin needs a `.mcp.json` file to bundle its MCPs:

**catalyst-analytics/**.claude-plugin/`:

```
catalyst-analytics/
├── .claude-plugin/
│   ├── plugin.json
│   └── .mcp.json          # PostHog MCP config
├── commands/
│   ├── analyze_user_behavior.md
│   ├── product_metrics.md
│   └── segment_analysis.md
└── agents/
    └── analytics-insights.md
```

**catalyst-analytics/.claude-plugin/.mcp.json**:

```json
{
  "mcpServers": {
    "posthog": {
      "command": "npx",
      "args": ["-y", "@posthog/mcp-server"],
      "env": {
        "POSTHOG_AUTH_HEADER": "${POSTHOG_AUTH_HEADER}"
      }
    }
  }
}
```

### Key Question: Does Plugin Disable = MCP Disable?

**Critical assumption**: When a plugin is disabled via `/plugin disable`, its bundled `.mcp.json`
MCPs should also be unloaded.

**Research Status**: ✅ **CONFIRMED** (Validated 2025-11-09)

- ✅ **Confirmed**: Plugins can include `.mcp.json` (released v2.0.12, October 2025)
- ✅ **Confirmed**: Disabling plugin also disables its MCPs (restart required)
- ✅ **Confirmed**: **Restart IS required** - enable/disable does not work dynamically
- ✅ **Confirmed**: Environment variables must be set before launching Claude Code
- ✅ **Confirmed**: Feature is stable and production-ready

**See**: `docs/PLUGIN_MCP_VALIDATION.md` for complete validation results and test data.

**Test plan**:

1. Create test plugin with bundled MCP
2. Install plugin
3. Verify MCP loads in `/context`
4. Disable plugin with `/plugin disable`
5. Check if MCP unloads (context should drop)
6. Re-enable plugin
7. Check if MCP reloads

---

## Migration Plan

### Phase 1: Research & Validation

- [ ] Test if plugin-bundled MCPs load/unload with plugin state
- [ ] Test if plugin enable/disable works without restart
- [ ] Document findings

### Phase 2: Plugin Restructuring (if tests pass)

- [ ] Create `catalyst-analytics` plugin structure
- [ ] Move PostHog MCP config to analytics plugin
- [ ] Create analytics-specific commands
- [ ] Test analytics plugin enable/disable

### Phase 3: Debugging Plugin

- [ ] Create `catalyst-debugging` plugin structure
- [ ] Move Sentry MCP config to debugging plugin
- [ ] Create debugging-specific commands
- [ ] Test debugging plugin enable/disable

### Phase 4: Core Plugin Cleanup

- [ ] Remove MCP management commands from catalyst-dev
- [ ] Update documentation
- [ ] Remove PostHog/Sentry references from core
- [ ] Test all plugins together

### Phase 5: Marketplace Update

- [ ] Update marketplace.json with 4 plugins
- [ ] Write installation guide
- [ ] Document plugin use cases
- [ ] Publish updated plugins

---

## Benefits vs Current Approach

### Current: Manual MCP Toggling

- ❌ Manual `/mcp` interaction every session
- ❌ Easy to forget to disable
- ❌ Context waste if you forget
- ✅ Works immediately

### Proposed: Plugin-Based Organization

- ✅ Single command to enable use case
- ✅ Impossible to forget (plugins persist state)
- ✅ Clear mental model (analytics = analytics plugin)
- ✅ Automatic context management
- ✅ Composable (enable multiple if needed)
- ⚠️ Requires plugin toggle to affect MCPs (needs testing)

---

## Comparison: Session Management

### Current Workflow

```bash
# Every session
/start-lightweight-session  # Disable PostHog, Sentry manually

# Later: need analytics
/enable-analytics           # Manual /mcp interaction

# Done with analytics
/disable-heavy-mcps         # Manual /mcp interaction
```

### Proposed Workflow

```bash
# Session starts lightweight automatically (no analytics/debugging plugins)

# Later: need analytics
/plugin enable catalyst-analytics  # One command, automatic MCP load

# Done with analytics
/plugin disable catalyst-analytics # One command, automatic MCP unload
```

**Simpler, clearer, more reliable** ✅

---

## Risk Assessment

### High Risk: MCP Unloading Doesn't Work

**If** disabling a plugin doesn't unload its MCPs:

- ❌ Architecture doesn't solve the problem
- ❌ Still need manual `/mcp` toggling
- ✅ Can still organize plugins by use case (organizational benefit)
- ✅ Can provide `/plugin enable X` as shorthand for "enable this + manually toggle MCPs"

**Mitigation**: Test thoroughly before restructuring

### Medium Risk: Plugin Toggling Requires Restart

**If** `/plugin enable/disable` requires restart:

- ⚠️ Less convenient than `/mcp` toggle
- ⚠️ Breaks mid-session workflow
- ❌ Not better than current manual toggle

**Mitigation**: Test plugin enable/disable behavior

### Low Risk: User Confusion

**If** users don't understand which plugin to enable:

- ✅ Clear naming: analytics, debugging
- ✅ Documentation explains use cases
- ✅ Can query: `/plugin list` shows descriptions

---

## Decision Points

### 1. Does Plugin Disable Unload MCPs?

**Test**: Create minimal test plugin with MCP, toggle on/off, check context

**If YES**: → Proceed with full restructuring (high value)

**If NO**: → Keep current architecture, improve documentation only

### 2. Does Plugin Toggle Require Restart?

**Test**: `/plugin disable` then check `/plugin list` immediately

**If NO RESTART**: → Plugin toggle is superior to `/mcp` toggle (one command)

**If RESTART REQUIRED**: → `/mcp` toggle is better (no restart), keep current approach

### 3. Is Organizational Benefit Worth It Anyway?

Even if MCPs don't auto-toggle, is use-case-based organization valuable?

**Pros**:

- Clearer mental model
- Install only what you need
- Better discoverability

**Cons**:

- More plugins to manage
- Doesn't solve core context problem

---

## Next Steps

1. **Immediate**: Test plugin-bundled MCP behavior
2. **If successful**: Create POC with analytics plugin
3. **If fails**: Document current approach as final solution

---

## Alternative: Hybrid Approach

**If plugin-bundled MCPs don't unload**, consider:

**Keep current architecture** BUT improve with:

- Better default documentation
- Shell alias for common workflows
- Better `/mcp` command instructions
- Integration with IDE shortcuts

**Example shell aliases**:

```bash
alias cc-light='echo "/start-lightweight-session" | pbcopy && claude'
alias cc-analytics='echo "/start-lightweight-session then /enable-analytics" | pbcopy && claude'
alias cc-debug='echo "/start-lightweight-session then /enable-debugging" | pbcopy && claude'
```

---

**Author**: Claude Code + Ryan **Date**: 2025-10-26 **Status**: Proposal - Pending Testing
