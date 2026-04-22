# Mockup harness

Static HTML mockups served directly by the orch-monitor Bun server (no Vite, no auth, no build step
per mockup). One `.html` file per screen. Shared harness files live in `_shared/`.

## What lives here

| File         | Role                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| `tokens.css` | Auto-generated from `@catalyst/tokens`. Both system blocks. **Do not edit.**  |
| `fonts.css`  | Google Fonts `@import` for both systems' families + fallbacks.                |
| `base.css`   | Reset + baseline typography + harness utilities (`.mockup-shell`, `.card`, …) |
| `chrome.css` | Floating switcher pill + popover styling.                                     |
| `chrome.js`  | Switcher runtime: reads prefs, writes `html[data-system]`, persists.          |
| `README.md`  | This file.                                                                    |

No `palettes.css`. The harness has one axis — `data-system` — and `tokens.css` already ships both
system blocks via `[data-system="..."]` selectors. An overlay file would be dead weight.

## Adding a new mockup

1. Create `<name>.html` in `plugins/dev/scripts/orch-monitor/public/mockups/`.
2. Use the exact load order below in `<head>`.
3. Copy the inline pre-paint bootstrap IIFE verbatim — it MUST run before first paint or the page
   flashes the default system before switching.
4. Put `<script src="./_shared/chrome.js"></script>` at the bottom of `<body>` (no `defer`).
5. Add a `<a class="card mockup-card">` to the gallery `index.html` linking to the new file.

## Load order inside each `.html`

```html
<link rel="stylesheet" href="./_shared/tokens.css" />
<link rel="stylesheet" href="./_shared/fonts.css" />
<link rel="stylesheet" href="./_shared/base.css" />
<link rel="stylesheet" href="./_shared/chrome.css" />
<script>
  /* pre-paint bootstrap — see below */
</script>
<style>
  /* optional page-specific rules */
</style>
```

Body:

```html
<main class="mockup-shell">
  <div class="mockup-container">…</div>
</main>
<script src="./_shared/chrome.js"></script>
```

## Pre-paint bootstrap (copy verbatim)

The inline script sits after all `<link>` tags, before `</head>`. It runs synchronously during HTML
parsing, so `data-system` is set before the browser paints anything.

```html
<script>
  (function () {
    const LS_KEY = "catalyst.mockup.prefs";
    const DEFAULTS = { system: "operator-console" };
    const SYSTEMS = ["operator-console", "precision-instrument"];
    const url = new URLSearchParams(window.location.search);
    let stored = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(LS_KEY) || "{}");
    } catch (_e) {
      stored = {};
    }
    const candidate = url.get("system") || stored.system || DEFAULTS.system;
    const system = SYSTEMS.includes(candidate) ? candidate : DEFAULTS.system;
    document.documentElement.setAttribute("data-system", system);
    window.__catalystMockupPrefs = { system };
  })();
</script>
```

`chrome.js` picks up `window.__catalystMockupPrefs` to avoid re-parsing the URL and localStorage on
mount.

## The `data-system` axis

| Value                  | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `operator-console`     | Default. Dark canvas, amber accent, grotesk type. |
| `precision-instrument` | Ivory canvas, ink-blue accent, serif display.     |

`operator-console` is the default because `tokens.css` scopes its block to `:root` in addition to
`[data-system="operator-console"]`.

### Persistence + clean URL

Priority when resolving the system value:

1. `window.__catalystMockupPrefs` (set by bootstrap above)
2. `?system=…` URL query param
3. `localStorage["catalyst.mockup.prefs"].system`
4. Default (`operator-console`)

When writing back to the URL, the switcher only emits `?system=…` for **non-default** values. A
default system stays clean (`/mockups/`, not `/mockups/?system=operator-console`). `localStorage` is
always written.

## Regenerating `tokens.css`

The file in this directory is auto-copied by the tokens package build:

```sh
cd packages/tokens && bun run build
```

The build writes `dist/theme.css` and copies it to
`plugins/dev/scripts/orch-monitor/public/mockups/_shared/tokens.css`. Do not hand-edit the output —
edit `packages/tokens/tokens/*.json` and rebuild.

## Voice for mockup copy

Per the UX direction docs
(`thoughts/shared/product/ux-refresh/design-direction-A-operator-console.md` and
`-B-precision-instrument.md`):

- No emoji.
- No exclamation marks.
- Operator voice: declarative, terse, past-tense when possible. Units spelled out. UPPERCASE for
  state tags (`SHIPPED`, `HOLD`); sentence case for prose.

## Why these files live under `public/`

The orch-monitor backend is a Bun server. `public/` is its static asset root. Files under
`public/mockups/` are served via a small `/mockups/*` route that mirrors the existing `/public/*`
block (same `resolveSafeStaticPath` + extension allowlist). No Vite, no auth, no SPA routing.
