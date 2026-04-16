---
name: add-changelog-media
description:
  "Add screenshots, screencasts (GIFs), or other media to changelog entries. Supports both local
  files and externally-hosted assets on R2/CDN. Inserts markdown image references into CHANGELOG.md
  files so they render on the website."
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Glob, Grep
---

# Add Changelog Media

Add screenshots, GIFs, or other visual media to changelog entries for the Catalyst website.

## How It Works

The website renders changelogs from `plugins/*/CHANGELOG.md` using the `starlight-changelogs` Astro
plugin. Images can be either:

1. **Externally hosted on R2** (preferred for large files like GIFs/screencasts)
2. **Local in `website/public/`** (for small PNGs if needed)

## Option A: Externally Hosted on R2 (Preferred)

Large assets (GIFs, screencasts) are hosted on Cloudflare R2 behind image optimization. The user
uploads files to the R2 bucket and provides the URL.

**Base URL:** `https://assets.coalescelabs.ai/changelog/`

**With Cloudflare image transforms** (automatic format conversion + resizing):

```markdown
![Worker detail drawer](https://assets.coalescelabs.ai/cdn-cgi/image/width=800,format=auto/changelog/dev-v6.29.0-worker-drawer.gif)
```

The `cdn-cgi/image/` path triggers Cloudflare's image optimization:
- `format=auto` — serves WebP/AVIF to browsers that support it
- `width=800` — constrains width for page layout (originals can be larger)
- `quality=85` — optional, defaults to 85

**Without transforms** (raw file, for GIFs where you want the animation preserved):

```markdown
![Worker detail drawer](https://assets.coalescelabs.ai/changelog/dev-v6.29.0-worker-drawer.gif)
```

**Naming convention:** `{plugin}-v{version}-{description}.{ext}`

### Workflow

1. User uploads the file to R2 and provides the URL
2. Insert the markdown reference into the CHANGELOG.md (see "Insert the reference" below)
3. Done — no files added to the repo

## Option B: Local Files (Small Assets Only)

For small PNGs/screenshots under ~200KB:

```
website/public/changelog/
```

Reference with an absolute path from site root:

```markdown
![Screenshot](/changelog/dev-v6.29.0-detail.png)
```

**Do NOT use relative paths** — they will not resolve correctly because `starlight-changelogs`
processes the markdown as an in-memory string with no filesystem anchor.

## Insert the Reference

Edit the CHANGELOG.md to add the image reference **after** the AI-generated summary paragraph and
**before** the `### Features` / `### Bug Fixes` sections:

```markdown
## [6.29.0](https://github.com/coalesce-labs/catalyst/compare/...) (2026-04-15)

<!-- ai-enhanced -->

### Worker Detail Drawer & Session Tracking

Click any worker row to open a detail panel with live metrics and activity feed.

![Worker detail drawer](https://assets.coalescelabs.ai/cdn-cgi/image/width=800,format=auto/changelog/dev-v6.29.0-worker-drawer.gif)

### Features
...
```

## Update GitHub Release (Optional)

To also update the GitHub release with the image:

```bash
# Get current release body
gh release view catalyst-dev-v6.29.0 --json body --jq .body > /tmp/release-body.md

# Add image reference (use the same R2 URL)
echo '![Worker detail drawer](https://assets.coalescelabs.ai/changelog/dev-v6.29.0-worker-drawer.gif)' >> /tmp/release-body.md

# Update the release
gh release edit catalyst-dev-v6.29.0 --notes-file /tmp/release-body.md
```

## Supported Formats

- **PNG** — screenshots, UI states (host locally if small, R2 if large)
- **GIF** — short screencasts, interactions (always R2 — these get large)
- **WebP** — optimized images (R2 with format=auto handles this automatically)
- **MP4** — not recommended (won't render inline in markdown)

## Examples

```bash
# User provides an R2 URL for a GIF
/catalyst-dev:add-changelog-media dev v6.29.0 https://assets.coalescelabs.ai/changelog/dev-v6.29.0-worker-drawer.gif

# User provides a local screenshot
/catalyst-dev:add-changelog-media dev v6.34.0 ~/Desktop/session-filters.png
```
