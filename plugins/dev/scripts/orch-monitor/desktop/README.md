# orch-monitor desktop

Chrome-less macOS desktop shell for the orch-monitor board (Stage 1, CTL-1112). Opens a frameless Tauri v2 window pointed at the live orch-monitor URL; the SPA runs unmodified since it uses only relative paths for all fetch/EventSource calls.

## Prerequisites

- **Xcode Command Line Tools** (already present: `xcode-select --version`)
- **Rust/cargo via rustup** (not pre-installed — required for `tauri dev`/`tauri build`):
  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```

## Install

```sh
bun install
```

## Run (dev)

```sh
bun run tauri dev
```

The `predev` script runs automatically, writing the resolved window URL to `src-tauri/gen/window-url.txt` before Tauri starts.

## Configure target

By default the window opens `http://mini.rozich.com:7400/`. Override with:

```sh
CATALYST_MONITOR_URL=http://localhost:7400 bun run tauri dev
```

## Build

```sh
bun run tauri build
```

Artifacts are written to `src-tauri/target/release/bundle/` (`.app` and `.dmg`).

## Architecture

The window URL is resolved by a single pure TypeScript function, `resolveMonitorUrl` in `src/monitor-url.ts`. The `predev`/`prebuild` script (`src/write-window-url.ts`) evaluates that function against `process.env` and writes `src-tauri/gen/window-url.txt`; the Rust window builder reads the file via `include_str!` at compile time.

This keeps the resolution logic in one tested place (no duplication in Rust), and the pre-step is itself unit-tested (`bun test`).

Stage 1 loads the live remote origin — no native APIs are called from JS. Native features are later tickets:
- CTL-1113: system notifications
- CTL-1114: Dock badge
- CTL-1115: tray icon + global shortcut
- CTL-1116: code signing + auto-update
