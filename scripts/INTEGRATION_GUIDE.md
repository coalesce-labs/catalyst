## Integration Guide: Smart Setup Functions

This guide explains how to integrate the smart configuration functions into `setup-catalyst.sh`.

---

## Files Created

1. **`scripts/catalyst-integration-helpers.sh`** - API discovery and validation functions
2. **`scripts/smart-linear-config.sh`** - Smart Linear configuration prompt
3. **`scripts/smart-sentry-config.sh`** - Smart Sentry configuration prompt

---

## Integration Steps

### Step 1: Add Helper Functions to setup-catalyst.sh

At the top of `setup-catalyst.sh`, after the utility functions section, add:

```bash
#
# Integration helpers
#

# Source smart config functions if available
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${SCRIPT_DIR}/scripts/smart-linear-config.sh" ]]; then
  source "${SCRIPT_DIR}/scripts/smart-linear-config.sh"
  USE_SMART_LINEAR=true
else
  USE_SMART_LINEAR=false
fi

if [[ -f "${SCRIPT_DIR}/scripts/smart-sentry-config.sh" ]]; then
  source "${SCRIPT_DIR}/scripts/smart-sentry-config.sh"
  USE_SMART_SENTRY=true
else
  USE_SMART_SENTRY=false
fi
```

### Step 2: Update setup_catalyst_secrets Function

Replace the prompt calls in `setup_catalyst_secrets()` (around line 649):

**Before:**
```bash
# Prompt for each integration
prompt_linear_config "$existing_config" > /tmp/catalyst-config-temp.json
existing_config=$(cat /tmp/catalyst-config-temp.json)

prompt_sentry_config "$existing_config" > /tmp/catalyst-config-temp.json
existing_config=$(cat /tmp/catalyst-config-temp.json)
```

**After:**
```bash
# Prompt for each integration (use smart versions if available)
if [[ "$USE_SMART_LINEAR" == "true" ]]; then
  prompt_linear_config_smart "$existing_config" > /tmp/catalyst-config-temp.json
else
  prompt_linear_config "$existing_config" > /tmp/catalyst-config-temp.json
fi
existing_config=$(cat /tmp/catalyst-config-temp.json)

if [[ "$USE_SMART_SENTRY" == "true" ]]; then
  prompt_sentry_config_smart "$existing_config" > /tmp/catalyst-config-temp.json
else
  prompt_sentry_config "$existing_config" > /tmp/catalyst-config-temp.json
fi
existing_config=$(cat /tmp/catalyst-config-temp.json)
```

### Step 3: Make Helper Script Executable

Ensure the helper script is executable:

```bash
chmod +x scripts/catalyst-integration-helpers.sh
```

---

## Testing

### Test Token Discovery

```bash
# Test Linear discovery
./scripts/catalyst-integration-helpers.sh discover-linear

# Test Sentry discovery
./scripts/catalyst-integration-helpers.sh discover-sentry
```

### Test Token Validation

```bash
# Test Linear validation (replace with real token)
./scripts/catalyst-integration-helpers.sh validate-linear "lin_api_..."

# Test Sentry validation (replace with real token)
./scripts/catalyst-integration-helpers.sh validate-sentry "sntrys_..."
```

### Test Full Setup Flow

```bash
# Set up test tokens
echo "lin_api_test..." > ~/.linear_api_token
echo -e "[auth]\ntoken=sntrys_test..." > ~/.sentryclirc

# Run setup
./setup-catalyst.sh

# Should auto-discover both tokens and validate them
```

---

## Backward Compatibility

The integration is **fully backward compatible**:

- If smart config files don't exist, falls back to original functions
- If token discovery fails, falls back to manual entry
- If validation fails, continues with manual entry
- Existing configs are preserved

**This means:**
- Safe to deploy incrementally
- Won't break existing setups
- Users get smart features automatically when available

---

## How It Works

### Discovery Flow

```
1. Check environment variables
   ↓
2. Check standard config files
   ↓
3. Return token + source location
```

### Validation Flow

```
1. Make API call with token
   ↓
2. Parse response for orgs/teams
   ↓
3. Return structured data
```

### Configuration Flow

```
1. Try to discover token
   ↓ (if found)
2. Validate and fetch metadata
   ↓
3. Show user what was found
   ↓
4. Let user confirm or override
   ↓
5. Auto-populate config options
```

---

## API Endpoints Used

### Linear
- **Endpoint**: `https://api.linear.app/graphql`
- **Method**: POST (GraphQL)
- **Auth**: Header `Authorization: TOKEN`
- **Scopes needed**: Read user, organization, teams

### Sentry
- **Endpoints**:
  - `https://sentry.io/api/0/organizations/`
  - `https://sentry.io/api/0/organizations/{org}/projects/`
- **Method**: GET
- **Auth**: Header `Authorization: Bearer TOKEN`
- **Scopes needed**: `org:read`, `project:read`

---

## Error Handling

### Token Not Found
- Silent fallback to manual entry
- Shows helpful setup instructions

### Invalid Token
- Shows error message
- Allows manual re-entry
- Optionally saves valid token for next time

### API Unavailable
- Graceful degradation
- Falls back to manual entry
- Logs warning but continues

### Partial Data
- Uses what's available
- Asks for missing fields
- Doesn't block setup

---

## Security Considerations

### Token Storage
- Files created with `chmod 600`
- No tokens in logs
- No tokens in git

### API Calls
- HTTPS only
- Minimal scopes required
- Read-only operations
- No data written to external services

### Error Messages
- Never display full tokens
- Only show "found in: file/env"
- Validation errors are generic

---

## Future Enhancements

### Phase 2: More Integrations
- PostHog token discovery and validation
- Exa API key validation
- Railway project selection

### Phase 3: Git Integration
- Auto-detect GitHub org from remote
- Suggest team names based on repo
- Extract ticket prefix from existing issues

### Phase 4: Smart Defaults
- Learn from previous setups
- Suggest commonly used configurations
- Import from team templates

---

## Rollback Plan

If issues arise, rollback is simple:

1. Remove sourcing lines from `setup-catalyst.sh`:
```bash
# Comment out or remove these lines
# source "${SCRIPT_DIR}/scripts/smart-linear-config.sh"
# source "${SCRIPT_DIR}/scripts/smart-sentry-config.sh"
```

2. Remove conditional calls:
```bash
# Revert to original
prompt_linear_config "$existing_config" > /tmp/catalyst-config-temp.json
prompt_sentry_config "$existing_config" > /tmp/catalyst-config-temp.json
```

3. Keep files for future use
- Don't delete the smart config files
- Can re-enable later when issues resolved

---

## Documentation Updates

After integration, update:

1. **README.md** - Add note about smart setup
2. **QUICKSTART.md** - Mention auto-discovery
3. **setup-catalyst.sh comments** - Reference helper scripts

Example addition to README:

```markdown
### Smart Setup

The setup script automatically discovers and validates existing API tokens:

- **Linear**: Checks `LINEAR_API_TOKEN` env or `~/.linear_api_token`
- **Sentry**: Checks `SENTRY_AUTH_TOKEN` env or `~/.sentryclirc`
- **Railway**: Checks `RAILWAY_TOKEN` env or `~/.railway/config.json`

If found, it validates the token and auto-populates organization and team information.
No more manual copying of org slugs and team keys!
```

---

## Support

For issues or questions:

1. Check token discovery manually:
   ```bash
   ./scripts/catalyst-integration-helpers.sh discover-linear
   ```

2. Test validation manually:
   ```bash
   ./scripts/catalyst-integration-helpers.sh validate-linear "YOUR_TOKEN"
   ```

3. Check file permissions:
   ```bash
   ls -la ~/.linear_api_token ~/.sentryclirc
   ```

4. Verify environment variables:
   ```bash
   echo $LINEAR_API_TOKEN
   echo $SENTRY_AUTH_TOKEN
   ```

---

## See Also

- [Smart Setup Features](../docs/SMART_SETUP.md)
- [Integration Helpers](./catalyst-integration-helpers.sh)
- [Setup Script](../setup-catalyst.sh)
