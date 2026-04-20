# orch-monitor UI — Design intent

This document codifies the design language of the Catalyst orchestrator monitor: what each token means, how status semantics are expressed, when to reach for [shadcn/ui][shadcn] primitives vs. hand-rolled components, and where the known tech debt lives. If you are about to add a new screen, drawer, or component, read this first.

Audience: future agents, designers, and frontend engineers touching `plugins/dev/scripts/orch-monitor/ui/`.

[shadcn]: https://ui.shadcn.com

## Design direction

The monitor is a **Linear-inspired operator dashboard**: dense, dark-mode-first, keyboard-forward, biased toward showing a lot of structured data at a glance. The aesthetic is closer to `linear.app` or `planetscale.com` than to Notion, Material, or generic SaaS admin chrome.

Opinions that are non-negotiable:

- **Dark mode is the default and the only mode today.** Light mode is out of scope (see below).
- **Monospace everywhere that is data.** IDs, tickets, timestamps, PIDs, tokens, versions, and any tabular numeric cell use `--font-mono`. Prose is the exception.
- **Density over breathing room.** Padding is small. Rows are tight. We trade whitespace for information density.
- **No purple gradients, no Inter-as-display, no Material look.** These signal a different product category and should be avoided even in one-off views.

## Surface levels

The UI composes views by stacking five neutral greys. The tokens live in [`src/app.css`](src/app.css) under `@theme inline` (lines 3–20). Use the tokens directly (`bg-surface-2`), never raw hex.

| Token | Hex | Role | Example call-sites |
|---|---|---|---|
| `--color-surface-0` | `#0b0d10` | App backdrop — the outermost layer behind everything. | [`App.tsx:86`](src/App.tsx) |
| `--color-surface-1` | `#111318` | App chrome — sidebar, top header bar, detail drawers. | [`layout/sidebar.tsx:65`](src/components/layout/sidebar.tsx), [`App.tsx:103`](src/App.tsx), [`session-detail-drawer.tsx:88`](src/components/session-detail-drawer.tsx), [`worker-detail-drawer.tsx:377`](src/components/worker-detail-drawer.tsx) |
| `--color-surface-2` | `#16191f` | Card / panel baseline — the default container surface for grouped content. | [`panel.tsx:13,69`](src/components/ui/panel.tsx), [`skeleton.tsx:13,29,65`](src/components/ui/skeleton.tsx), [`dashboard.tsx:50,137`](src/components/dashboard.tsx), [`attention-bar.tsx:24`](src/components/attention-bar.tsx) |
| `--color-surface-3` | `#1c2028` | Elevated / hover / selected / input / inline code. Slightly lifted from surface-2. | [`worker-table.tsx:149`](src/components/worker-table.tsx), [`sidebar.tsx:294,334`](src/components/layout/sidebar.tsx), [`search-input.tsx:18`](src/components/ui/search-input.tsx), [`gantt-chart.tsx:262,282`](src/components/gantt-chart.tsx) |
| `--color-surface-4` | `#232a33` | Shimmer highlight and progress-track fill only — the brightest neutral. | [`app.css:63`](src/app.css) (`.animate-shimmer`), [`dashboard.tsx:74`](src/components/dashboard.tsx) (ProgressBar track) |

Screenshots showing the stack in context:

- [`docs/surfaces/01-dashboard-overview.png`](docs/surfaces/01-dashboard-overview.png) — surface-0 (backdrop) + surface-1 (sidebar/header) + surface-2 (KPI tiles, orchestrator cards).
- [`docs/surfaces/02-orchestrator-detail.png`](docs/surfaces/02-orchestrator-detail.png) — surface-3 visible on the selected sidebar item (`adr-bootstrap`) and on the `Filter workers…` search input.
- [`docs/surfaces/03-worker-drawer.png`](docs/surfaces/03-worker-drawer.png) — surface-1 drawer with `shadow-2xl`, layered above the surface-2 content of the main view.
- [`docs/surfaces/04-gantt-timeline.png`](docs/surfaces/04-gantt-timeline.png) — the timeline panel shows the shimmer / skeleton surface-4 usage and phase colors in context.

**Rule of thumb.** If the element is the page background, it's surface-0. If it's app chrome you can see all the time (sidebar, header, drawers), it's surface-1. If it's a card/panel, it's surface-2. If it is a state-change version of surface-2 (hovered, selected, focused, input background), it's surface-3. If it's a pure shimmer or progress track, it's surface-4.

## Status semantics

Status semantics are currently defined **in TypeScript**, not in CSS tokens. The single source of truth is [`src/lib/formatters.ts`](src/lib/formatters.ts):

- `StatusSemantic = "success" | "info" | "danger" | "warning" | "neutral"` (line 41)
- `STATUS_SEMANTIC` map (lines 43–62) maps raw status strings (`done`, `failed`, `researching`, `stalled`, …) to a semantic.
- `SEMANTIC_BADGE_CLASSES` (lines 68–74) resolves a semantic to Tailwind utility classes that reference the named color tokens in [`src/app.css`](src/app.css) lines 13–17.
- `SEMANTIC_PILL_CLASSES` (lines 76–82) resolves a semantic to the denser "pill" variant using raw hex values — **tech debt**, see below.

Named color tokens that back the badge classes:

| Token | Hex | Used for |
|---|---|---|
| `--color-green` | `#39d07a` | success |
| `--color-blue` / `--color-accent` | `#4ea1ff` | info / primary accent |
| `--color-red` | `#ef5d5d` | danger |
| `--color-yellow` | `#eabc3b` | warning |

`neutral` has no named color — it renders on `surface-3` with muted foreground text.

**Rule.** Always reach for `statusSemantic(status)` + `StatusBadge` / `StatusPill` from [`components/ui/badge.tsx`](src/components/ui/badge.tsx). Do not hand-pick colors inside call-sites — if the status is new, extend the `STATUS_SEMANTIC` map. Do not reference `--color-green` etc. directly outside `formatters.ts`; go through the semantic.

## Typography

Stack is declared in [`src/app.css`](src/app.css):

- **Body** (line 28–30): `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. System UI font, no custom webfont.
- **Monospace** (line 19): `--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.

**When to use mono.** Every piece of "data you might grep for" is mono: orchestrator names, ticket IDs, session IDs, PIDs, timestamps, token counts, dollar amounts, version strings, branch names, status strings in tables, numeric values that a human would compare. Tabular columns pair `font-mono` with `tabular-nums` so columns line up.

**When to use body font.** Prose. Essentially one place today: markdown rendered via `.md-content` in briefings and summaries.

Avoid introducing a third display font. The system font stack is intentionally boring.

## Spacing and density

There is no `--spacing-*` token system — the UI uses Tailwind's default 4px base unit, and there is no `tailwind.config.*` or `postcss.config.*` (Tailwind is configured via `@theme inline` in [`src/app.css`](src/app.css) only).

Density conventions observed across the codebase:

- Row height in tables / lists: `py-1.5` to `py-2.5` (6–10px vertical padding).
- Horizontal padding in table cells, badges, pills: `px-2` to `px-3` (8–12px).
- Card padding: `p-4` (16px). Drawer content padding: `p-4` to `p-5`.
- Gap between cards in a grid: `gap-3` to `gap-4`.

The bias is toward **Linear-dense**, not Notion-airy. If you catch yourself reaching for `p-8` or `space-y-8` inside a panel, step back — the monitor packs a lot of signal per square inch and the rest of the app does the same.

## Borders, radius, shadow

Border color tokens (in [`src/app.css`](src/app.css) lines 9–10):

| Token | Hex | Used for |
|---|---|---|
| `--color-border` | `#262d36` | Primary border (panels, drawers, table outlines). |
| `--color-border-subtle` | `#1e242c` | Table row dividers, event-log row dividers. |

No `--radius-*` or `--shadow-*` custom properties exist yet. Radii are Tailwind utilities (`rounded`, `rounded-md`, `rounded-lg`, `rounded-full`). The only shadow in the app is `shadow-2xl` on the session / worker detail drawers.

## When to hand-roll vs. reach for shadcn

**Current state.** Zero shadcn components are installed in this UI. `package.json` does not list `@radix-ui/*`, `cmdk`, `class-variance-authority`, or shadcn generator output. The `components/ui/` directory name mirrors shadcn's convention, but every file in it is hand-rolled on top of Tailwind + `cn()` + `lucide-react`.

**Policy going forward.** For **generic interaction primitives** where accessibility + keyboard handling + focus management matter, reach for shadcn/ui. For **domain-specific visualization** of orchestrators, workers, phases, costs, and timelines, keep hand-rolling — shadcn has nothing to offer there.

### Reach for shadcn when adding

| Primitive | Use-case in the monitor |
|---|---|
| `Sheet` | Replace the hand-rolled drawers in [`session-detail-drawer.tsx`](src/components/session-detail-drawer.tsx) and [`worker-detail-drawer.tsx`](src/components/worker-detail-drawer.tsx) when we next touch them. |
| `Dialog` | Any modal — confirm actions, larger forms. |
| `Tooltip` | Hover-text on dense cells (token counts, cost, status abbreviations). |
| `Tabs` | The `Overview / Workers / Timeline / Events` pattern in [`orchestrator-view.tsx`](src/components/orchestrator-view.tsx) is a hand-rolled tab set — move to shadcn `Tabs` when we extend it. |
| `DropdownMenu` | Per-row action menus. |
| `ContextMenu` | Right-click on a worker / event / orchestrator. |
| `Command` | Command palette (cmd-K) for switching orchestrators, jumping to tickets. |
| `ScrollArea` | Long scroll regions where we want styled scrollbars + shadow cues. |
| `Separator` | Horizontal / vertical dividers inside grouped content. |

### Keep hand-rolling

| Component | Why hand-rolled | File |
|---|---|---|
| `Panel`, `PanelHeader`, `SectionLabel`, `MetricCard` | Domain containers with token-locked surfaces + specific typography. | [`components/ui/panel.tsx`](src/components/ui/panel.tsx) |
| `StatusBadge`, `StatusPill` | Driven by the `statusSemantic()` classifier; no shadcn equivalent. | [`components/ui/badge.tsx`](src/components/ui/badge.tsx) |
| `StatusDot`, `HealthIcon`, `ConnectionDot` | Small animated indicators with specific state semantics. | [`components/ui/status-dot.tsx`](src/components/ui/status-dot.tsx) |
| `ProgressBar` | Gradient-fill progress driven by a `pct`, with explicit surface-4 track. | [`components/ui/progress-bar.tsx`](src/components/ui/progress-bar.tsx) |
| `Skeleton`, `SkeletonDashboard` | Page-shape-specific shimmer placeholders. | [`components/ui/skeleton.tsx`](src/components/ui/skeleton.tsx) |
| `GanttChart` | Custom SVG timeline of worker phase spans — nothing generic would fit. | [`components/gantt-chart.tsx`](src/components/gantt-chart.tsx) |
| `WorkerTable`, `EventLog`, `WaveCards`, `KpiStrip`, `OrchestratorView`, `Dashboard`, `AttentionBar`, `CostCard` | Feature-level domain views. | [`components/`](src/components/) |
| `NavItem`, `SidebarGroup`, `Sidebar`, `SearchInput`, `SortHeader`, `ExternalLink`, `EmptyState`, `ConnectionBanner` | Tight integration with the monitor's sidebar / table conventions. | [`components/ui/`](src/components/ui/), [`components/layout/`](src/components/layout/) |

### Hybrid cases

When we pull in a shadcn primitive (e.g. `Dialog`), wrap it in a local file that token-locks surfaces and colors to our system. Do not ship raw shadcn defaults — its stock greys and purples will drift from our palette.

## Known tech debt to migrate

Everywhere the UI currently bypasses the token system. None of these break the build; all of them drift the look. Migrate opportunistically when the surrounding component is touched.

**Raw hex in [`src/lib/formatters.ts`](src/lib/formatters.ts):**

- `SEMANTIC_PILL_CLASSES` (lines 76–82) — four semantic pills all use raw hex instead of tokens:
  - `success` → `bg-[#1a4a3a]` text `[#8af4cc]`
  - `info` → `bg-[#1f3a5a]` text `[#9ec7f4]`
  - `danger` → `bg-[#5a2a2a]` text `[#f4a8a8]`
  - `warning` → `bg-[#5a4a1a]` text `[#f4dc8a]`
- `PHASE_COLORS` map (lines 84–99) — phase bar colors in the Gantt, hardcoded hex, no token mapping:
  - `dispatched` `#475569`, `researching` `#3b82f6`, `planning` `#a855f7`, `implementing`/`in_progress` `#10b981`, `validating` `#f59e0b`, `shipping`/`pr-open`/`pr_open` `#14b8a6`, `merging`/`merged`/`done` `#6b7280`, `failed` `#ef4444`, `stalled` `#eab308`, fallback `#3b82f6` (line 101).

**Raw hex in [`src/components/event-log.tsx`](src/components/event-log.tsx):**

- `KIND_STYLES` map (lines 12–19) — eight event-kind badges all raw hex:
  - `status` `bg-[#1f3a5a] text-[#9ec7f4]`, `phase` `bg-[#2a3c1f] text-[#b5d67a]`, `pr` `bg-[#3a2a5a] text-[#c8a8f4]`, `live` `bg-[#5a2a2a] text-[#f4a8a8]`, `attn` `bg-[#5a4a1a] text-[#f4dc8a]`, `new` `bg-[#1a4a3a] text-[#8af4cc]`, `wave` `bg-[#4a3a1f] text-[#f4c88a]`, `brief` `bg-[#3a4a1a] text-[#c8f48a]`.

**Scattered raw hex:**

- [`components/attention-bar.tsx:57`](src/components/attention-bar.tsx) — `text-[#f4a8a8]` / `text-[#f4dc8a]` for error / warning severity.
- [`components/worker-table.tsx:34,36`](src/components/worker-table.tsx) — `text-[#f4a8a8]` (failed), `text-[#9ec7f4]` (active).
- [`components/ui/status-dot.tsx:25,61`](src/components/ui/status-dot.tsx) — `bg-[#6b7280]` for connecting/dead state.
- [`src/app.css:204`](src/app.css) — `color: #f4c88a` for inline code text inside `.md-content`.
- [`components/wave-cards.tsx:38`](src/components/wave-cards.tsx) — `bg-[#0f1216]`, an orphan surface between surface-0 and surface-1 with no token.

**Suggested migration** (not blocking this doc): add semantic background/foreground token pairs (`--color-success-bg`, `--color-success-fg`, etc.) to `@theme inline`, then rewrite `SEMANTIC_PILL_CLASSES`, `KIND_STYLES`, and the scattered `text-[#…]` to reference them. Map `PHASE_COLORS` through token names too (e.g., `phase-research`, `phase-implement`, `phase-validate`).

## Out of scope (today)

- **Light mode.** The monitor is dark-only. Tokens do not have light-mode pairs.
- **Mobile / narrow viewports.** The layout assumes a desktop operator. Responsive breakpoints exist for mid-width but mobile is not a target.
- **Internationalization / RTL.** All strings are English; layout assumes LTR.
- **Print styles.** Not supported.

If any of the above ever come into scope, they will each need their own DESIGN.md update.
