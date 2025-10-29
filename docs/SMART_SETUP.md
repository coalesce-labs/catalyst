## Smart Setup Features

The Catalyst setup script includes intelligent token discovery and validation for third-party integrations.

## How It Works

### Token Discovery

The setup script automatically checks standard locations for existing API tokens:

#### Linear
1. **Environment variable**: `LINEAR_API_TOKEN`
2. **File**: `~/.linear_api_token`

#### Sentry
1. **Environment variable**: `SENTRY_AUTH_TOKEN`
2. **File**: `~/.sentryclirc` (looks for `token=` line)

#### Railway
1. **Environment variable**: `RAILWAY_TOKEN`
2. **File**: `~/.railway/config.json`

### Token Validation

When a token is discovered, the setup script:

1. **Validates** the token via API
2. **Fetches** available organizations/teams
3. **Auto-populates** configuration options
4. **Lets you select** from discovered options

### Example: Linear Setup

**Traditional flow (manual)**:
```
Configure Linear? [Y/n] y

Linear API token: lin_api_xxx...
Linear team key: ENG
Linear team name: Engineering
```

**Smart flow (auto-discovered)**:
```
Configure Linear? [Y/n] y

🔍 Checking for existing Linear API token...
✓ Found existing Linear API token in: file

🔍 Validating token and fetching organization info...
✓ Token is valid!
  Organization: Acme Corp (acme)
  Found 3 team(s):
    - ENG: Engineering
    - PROD: Product
    - DESIGN: Design

Use this token? [Y/n] y

Select a team:
  1. ENG: Engineering
  2. PROD: Product
  3. DESIGN: Design

Enter team number [1-3]: 1

✓ Configuration complete!
```

## Benefits

### 1. Fewer Prompts
- Reuses existing tokens
- Auto-populates org/team names
- Validates input immediately

### 2. Better UX
- Shows what was found
- Lets you confirm before using
- Offers to save tokens for next time

### 3. Error Prevention
- Validates tokens before saving
- Shows available options (prevents typos)
- Catches invalid credentials early

### 4. Time Savings
If you already have:
- Linear CLI configured → Zero manual input
- Sentry CLI configured → Zero manual input
- Railway CLI configured → Zero manual input

## Setting Up for Auto-Discovery

### Linear

**Option 1: Environment variable**
```bash
export LINEAR_API_TOKEN="lin_api_..."
# Add to ~/.bashrc or ~/.zshrc
```

**Option 2: File (recommended)**
```bash
echo "lin_api_..." > ~/.linear_api_token
chmod 600 ~/.linear_api_token
```

Then `linearis` CLI and Catalyst both auto-discover it.

### Sentry

**Option 1: Environment variable**
```bash
export SENTRY_AUTH_TOKEN="sntrys_..."
```

**Option 2: File (recommended)**
```bash
cat > ~/.sentryclirc << 'EOF'
[auth]
token=sntrys_...
EOF
chmod 600 ~/.sentryclirc
```

Then `sentry-cli` and Catalyst both auto-discover it.

### Railway

**Railway CLI auto-creates**: `~/.railway/config.json`

Just run `railway login` once, and Catalyst will discover it.

## API Validation Details

### Linear API

**Endpoint**: `https://api.linear.app/graphql`

**Query**:
```graphql
{
  viewer {
    id
    name
    email
    organization {
      id
      name
      urlKey
    }
  }
  teams {
    nodes {
      id
      name
      key
    }
  }
}
```

**Returns**:
- User info
- Organization name and URL
- All teams you have access to

**Auto-populated**:
- Team key (from team list)
- Team name (from team list)
- Organization context

### Sentry API

**Endpoint**: `https://sentry.io/api/0/`

**Requests**:
1. `GET /organizations/` - List orgs
2. `GET /organizations/{org}/projects/` - List projects

**Returns**:
- All organizations you have access to
- All projects in each org

**Auto-populated**:
- Organization slug
- Project slug

## Fallback Behavior

If token discovery/validation fails:
- Falls back to manual entry
- Shows helpful instructions
- Offers to save token for next time

**Example**:
```
🔍 Checking for existing Linear API token...
  (No token found)

Linear API Token Setup:
  📚 Documentation: https://linear.app/docs/api-and-webhooks#api-keys

  Steps:
  1. Go to https://linear.app/settings/api
  2. Click 'Create key' under Personal API Keys
  ...

  TIP: Save to ~/.linear_api_token to auto-discover next time:
       echo 'YOUR_TOKEN' > ~/.linear_api_token

Linear API token: _
```

## Integration Helpers

The smart discovery is powered by `scripts/catalyst-integration-helpers.sh`:

```bash
# Discover existing tokens
./scripts/catalyst-integration-helpers.sh discover-linear
./scripts/catalyst-integration-helpers.sh discover-sentry

# Validate tokens
./scripts/catalyst-integration-helpers.sh validate-linear "lin_api_..."
./scripts/catalyst-integration-helpers.sh validate-sentry "sntrys_..."
```

These can be used standalone or sourced by other scripts.

## Security

**Token storage**:
- Files are created with `chmod 600` (owner read/write only)
- Environment variables stay in memory
- No tokens logged or displayed after entry

**Validation**:
- Only minimal API calls (get user/org info)
- No write operations during validation
- Tokens never sent to third parties

## Future Enhancements

Potential additions:
- PostHog API validation
- Exa API validation
- GitHub token discovery (from `gh` CLI)
- Team/project suggestions based on git remote

## See Also

- [Configuration Guide](./CONFIGURATION.md)
- [Setup Script](../setup-catalyst.sh)
- [Integration Helpers](../scripts/catalyst-integration-helpers.sh)
