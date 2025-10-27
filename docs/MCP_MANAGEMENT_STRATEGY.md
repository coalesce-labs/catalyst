# MCP Management Strategy

## Problem Statement

MCP servers consume significant context tokens even when not actively used:

- **PostHog**: ~40,645 tokens (43 tools)
- **Sentry**: ~20,670 tokens (19 tools)
- **DeepWiki**: ~1,885 tokens (3 tools)
- **Context7**: ~1,709 tokens (2 tools)

**Total: ~64,909 tokens** (~32% of Claude Sonnet 4.5's 200k context window)

This context is consumed at session startup before any conversation begins, limiting available space
for code, documentation, and conversation history.

## Current State of Conditional MCP Loading

### ✅ Native Runtime Toggle AVAILABLE (January 2025)

**Status**: **IMPLEMENTED** via `/mcp` command

The `/mcp` built-in command provides runtime enable/disable functionality:

1. Type `/mcp` in any session
2. Select an MCP server from the list
3. Choose **Enable** or **Disable**
4. Context usage updates immediately (no restart required!)

**Verified savings**:

- Disabling PostHog: ~40,645 tokens freed (62% MCP context reduction)
- Disabling Sentry: ~20,670 tokens freed (31% MCP context reduction)
- Total potential: ~61,315 tokens freed by disabling both

**This solves the SESSION-level problem** - you can enable/disable MCPs based on what you're doing
in each session, not just per-project.

### How Runtime Toggle Works

**Primary Method**: `/mcp` command (built-in)

- ✅ Works mid-session without restart
- ✅ Context updates immediately
- ✅ Simple interactive menu
- ✅ Shows all configured servers
- ✅ Preserves configuration when disabled

**Session-Based Workflow**:

1. Start session with default MCPs (lightweight: DeepWiki, Context7)
2. When you need analytics: `/mcp` → enable PostHog
3. When debugging errors: `/mcp` → enable Sentry
4. When done: `/mcp` → disable to free context
5. Next session: starts with defaults again

### Complementary Approaches

1. **Workflow Commands** (NEW - Catalyst-specific)
   - `/enable-analytics` - Instructs Claude to enable PostHog
   - `/enable-debugging` - Instructs Claude to enable Sentry
   - `/disable-heavy-mcps` - Frees ~60k tokens
   - `/check-mcp-status` - Shows current usage

2. **McPick CLI Tool** (Pre-session config)
   - `npx mcpick` before starting Claude Code
   - Useful for setting defaults per project
   - Requires restart to take effect

3. **Project-Specific Configuration**
   - `.mcp.json` for team-shared defaults
   - Define which MCPs should be available
   - Users still toggle on/off per session via `/mcp`

## Recommended Strategy for Catalyst

### 1. Session-Aware MCP Management (PRIMARY STRATEGY)

**Problem Solved**: You don't need 40k PostHog tokens loaded when fixing a typo, even in projects
that USE PostHog.

**Solution**: Runtime toggling via `/mcp` + workflow helper commands

**Default Configuration** (user-level `~/.claude.json`):

```json
{
  "mcpServers": {
    "context7": {
      /* ~1,709 tokens - always useful */
    },
    "deepwiki": {
      /* ~1,885 tokens - always useful */
    },
    "posthog": {
      /* ~40,645 tokens - DISABLED by default */
    },
    "sentry": {
      /* ~20,670 tokens - DISABLED by default */
    }
  }
}
```

**Configure all MCPs but start sessions with heavy ones DISABLED.**

**Workflow**:

```bash
# Start session: ~3.5k MCP tokens (just DeepWiki + Context7)

# Need analytics?
/enable-analytics
# → Claude uses /mcp to enable PostHog (+40k tokens)

# Need to debug errors?
/enable-debugging
# → Claude uses /mcp to enable Sentry (+20k tokens)

# Done debugging, free up context
/disable-heavy-mcps
# → Claude uses /mcp to disable both (-60k tokens)

# Next session: starts with defaults (lightweight again)
```

**Benefits**:

- ✅ Session-specific: Enable only what you need RIGHT NOW
- ✅ Zero restart required
- ✅ Works across all projects
- ✅ Discoverable via slash commands
- ✅ Context-aware (~60k token savings when not needed)

### 2. Optional: Project-Specific Defaults

**When to use**: Projects that never need certain MCPs

**Example**: Documentation-only repo doesn't need PostHog/Sentry at all

**Implementation**: Project `.mcp.json` with only lightweight servers:

```json
{
  "mcpServers": {
    "context7": {
      /* Library docs */
    },
    "deepwiki": {
      /* Research */
    }
  }
}
```

**Benefit**: These projects never even have PostHog/Sentry available to toggle

### 3. Sentry MCP Strategy

**Recommendation**: Project-scope Sentry MCP (don't use CLI alternative)

**Rationale**:

- Sentry MCP: 20,670 tokens for 19 tools with comprehensive functionality
- Sentry CLI: Primarily for releases/debug files, **not for issue/error search**
- Issue operations require Sentry API or MCP server
- MCP provides rich search, filtering, and analysis capabilities

**Findings from Research**:

```bash
# Sentry CLI capabilities (2025):
- ✅ Release management (create, edit, delete)
- ✅ Debug information files (upload, validate)
- ✅ Event transmission
- ✅ Log viewing/streaming
- ✅ Cron monitoring
- ❌ Issue search/list (NOT AVAILABLE)
- ❌ Error analysis (NOT AVAILABLE)
```

**Implementation**: Project-scope only

```json
// .mcp.json - only in projects with Sentry monitoring
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sentry"],
      "env": {
        "SENTRY_AUTH_TOKEN": "${SENTRY_AUTH_TOKEN}",
        "SENTRY_ORG": "${SENTRY_ORG}",
        "SENTRY_PROJECT": "${SENTRY_PROJECT}"
      }
    }
  }
}
```

**When to enable**:

- Projects with active Sentry error monitoring
- During debugging/incident response phases
- When analyzing error trends

**Saves**: ~20,670 tokens in projects without Sentry (vs global config)

### 4. PostHog Conditional Loading

**Recommendation**: Keep PostHog MCP but make it project-scoped

**Rationale**:

- 43 tools provide comprehensive analytics capabilities
- CLI alternative less mature than Sentry
- Many Catalyst users need product analytics
- Project-scoping prevents global context cost

**Implementation**:

1. Remove PostHog from `~/.claude.json` (user scope)
2. Add to project `.mcp.json` only where needed
3. Document in project setup guide

### 5. MCP Management Commands (IMPLEMENTED)

**Purpose**: Make MCP toggling discoverable and easy within Catalyst

**Implemented Commands**:

- ✅ `/enable-analytics` - Instructs Claude to enable PostHog
- ✅ `/enable-debugging` - Instructs Claude to enable Sentry (+ PostHog)
- ✅ `/disable-heavy-mcps` - Frees ~60k tokens by disabling both
- ✅ `/check-mcp-status` - Shows current MCP usage via `/context`

**How they work**: Commands provide Claude with instructions to use the `/mcp` built-in command.
While not fully automated (requires manual interaction with `/mcp` menu), they:

- Make MCP management discoverable
- Provide context about token costs
- Guide users on which MCPs to enable/disable
- Explain what capabilities each MCP provides

**Future enhancement**: If Claude Code adds programmatic MCP API, these commands could be fully
automated.

### 6. Documentation Updates

**Update these docs**:

1. **CONFIGURATION.md** - Add MCP management section
2. **QUICKSTART.md** - Remove PostHog/Sentry from default setup
3. **New: MCP_SETUP.md** - Guide for project-specific MCP config
4. **DEBUGGING.md** - Document Sentry CLI approach

**Template `.mcp.json`**:

```json
{
  "$schema": "https://github.com/anthropics/claude-code/blob/main/schemas/mcp.schema.json",
  "mcpServers": {
    "posthog": {
      "comment": "Product analytics - only enable for products with active users",
      "command": "npx",
      "args": ["-y", "@posthog/mcp-server"],
      "env": {
        "POSTHOG_AUTH_HEADER": "${POSTHOG_AUTH_HEADER}"
      }
    }
  }
}
```

## Migration Plan

### Phase 1: Immediate Fixes (This PR)

- [x] Fix plugin.json validation error
- [ ] Document current MCP context costs
- [ ] Create MCP_MANAGEMENT_STRATEGY.md (this doc)

### Phase 2: Project-Scoping (Next PR)

- [ ] Remove PostHog/Sentry from default user config
- [ ] Create `.mcp.json` template with examples
- [ ] Update QUICKSTART.md to recommend project-scoping
- [ ] Add `/mcp-manage` command (basic version)

### Phase 3: Enhanced Debugging Workflows (Future PR)

- [ ] Document when to enable Sentry MCP
- [ ] Create `/debug-setup` command (checks for Sentry/PostHog availability)
- [ ] Integrate Sentry MCP into `/debug` workflow
- [ ] Add error analysis patterns to debugging docs
- [ ] Create incident response runbook with MCP recommendations

### Phase 4: Enhanced MCP Management (Future)

- [ ] `/mcp-manage recommend` - Context-aware suggestions
- [ ] `/mcp-manage list` - Show context costs
- [ ] Integrate with workflow phases (auto-suggest during planning/debugging)
- [ ] Monitor for native lazy-loading support in Claude Code

## Expected Impact

### Before (Current State)

- User-level MCP config: ~64,909 tokens always loaded
- PostHog + Sentry active globally
- 32% of context consumed before conversation starts

### After Phase 2 (Project-Scoping)

- Default project: ~3,594 tokens (DeepWiki + Context7 only)
- Analytics projects: +40,645 tokens (PostHog when needed)
- **Savings**: ~61,315 tokens (94% reduction) for most projects

### After Phase 3 (Enhanced Workflows)

- Default project: ~3,594 tokens
- Production monitoring projects: ~64,909 tokens (PostHog + Sentry when needed)
- **Context aware**: Load Sentry only during incidents/debugging phases

## Considerations

### Trade-offs

**Project-scoping**:

- ✅ Zero cost when not needed
- ✅ Team-shareable configuration
- ⚠️ Requires per-project setup
- ⚠️ Less discoverable than global config

**Sentry CLI**:

- ✅ Zero context cost
- ✅ Explicit tool invocation
- ⚠️ Less integrated than MCP
- ⚠️ May require more user input

### When to Keep MCP vs CLI

**Use MCP when**:

- Tool provides complex interactive workflows
- Many related operations benefit from context awareness
- CLI alternative is immature or missing features
- Context cost is acceptable for project type

**Use CLI when**:

- Operations are discrete and simple
- Tool has mature CLI with good UX
- Context cost is high (>15k tokens)
- Only needed occasionally

## Future Improvements

### When Native Lazy Loading Arrives

If Claude Code implements native lazy loading
([#7336](https://github.com/anthropics/claude-code/issues/7336)):

1. **Keep project-scoping** - Still valuable for team collaboration
2. **Simplify `/mcp-manage`** - May no longer need McPick wrapper
3. **Re-evaluate Sentry CLI** - May prefer MCP if zero cost
4. **Document migration** - Help users adopt new features

### Enhanced Context Awareness

Potential future features:

```bash
# Auto-detect when PostHog would be useful
> User asks "How many users hit this error?"
> Claude: "This requires PostHog. Enable? [y/n]"

# Phase-based auto-suggestions
> /create-plan starts
> Claude: "Planning phase - enable Linear + GitHub? [y/n]"
```

## References

- [Feature Request: Lazy Loading #7336](https://github.com/anthropics/claude-code/issues/7336)
- [Feature Request: Token Management #7172](https://github.com/anthropics/claude-code/issues/7172)
- [McPick CLI Tool](https://github.com/machjesusmoto/mcpick)
- [Claude Code MCP Docs](https://docs.claude.com/en/docs/claude-code/mcp)
- [Optimising MCP Context - Scott Spence](https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code)

## Next Steps

1. Review this strategy with team
2. Decide on immediate actions (Phase 1 vs Phase 2)
3. Create issues for each phase
4. Begin implementation

---

**Author**: Claude Code **Date**: 2025-10-26 **Status**: Proposed
