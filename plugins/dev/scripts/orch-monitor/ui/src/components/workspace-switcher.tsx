import { ChevronsUpDownIcon, CheckIcon, LayersIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useRepoColors } from "@/hooks/use-repo-colors";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
import { useRepoScope } from "@/hooks/use-repo-scope";
import {
  REPO_SCOPE_ALL,
  isMultiRepo,
  scopeOptions,
  singleRepoLabel,
  type RepoScope,
  type ScopeOption,
} from "@/lib/repo-scope";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// CTL-897 / SHELL7 — the config-driven workspace switcher, ported from the
// prototype `mockups/home-proto/src/components/WorkspaceSwitcher.tsx`. Two key
// changes from the prototype:
//   1. `REPOS` is no longer a hardcoded array — the repo list is sourced from the
//      read-model snapshot (`BoardPayload.repos`, the SAME list the BFF already
//      exposes), so the switcher is genuinely config-driven and scales 1..N.
//   2. The prototype's selection was a NO-OP mock (`// TODO: filter Home/Board by
//      active repo scope`). The active scope now lives in the FND store
//      (`repoScopeAtom`, lifted out of the prototype's local `useState`) so BOTH
//      this switcher's placements — the sidebar header AND the top strip — share
//      ONE scope, and the data surfaces read that atom to actually filter.
//
// Scaling rule (Gherkin):
//   - one repo  → a bare LABEL (no dropdown — nothing to scope between),
//   - 2+ repos  → a dropdown of "All" + each repo, each with a colored scope dot,
//                 a checkmark on the active scope.
//
// Color discipline: scope dots use the repo-colors config's per-repo swatch
// (violet / sky / orange …); cyan stays RESERVED for the live signal, so we never
// pull a cyan dot here — whatever the config assigned is threaded through as-is.

/** A small round scope dot. Falls back to a neutral muted dot when the config
 *  assigned the repo no color (never fabricates a color). */
function ScopeDot({ color }: { color?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", color ? "" : "bg-muted-foreground/50")}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/** Where the switcher is rendered — drives only the trigger chrome:
 *  - "sidebar": full pill in the SidebarHeader that collapses to just the active
 *    dot under the icon-rail (`group-data-[collapsible=icon]`),
 *  - "topstrip": a compact pill in the top strip, always showing its label. */
export type SwitcherPlacement = "sidebar" | "topstrip";

/** The active option (the one matching the resolved scope), for the trigger. */
function activeOption(options: ScopeOption[], scope: RepoScope): ScopeOption {
  return options.find((o) => o.scope === scope) ?? options[0];
}

/**
 * The config-driven workspace switcher. Reads the repo list off the resident
 * read-model snapshot and the active scope off the shared FND atom, so every
 * instance (sidebar + top strip) stays in lock-step. `useRepoScope` owns the
 * stale-scope reconciliation against the live repo list.
 */
export function WorkspaceSwitcher({ placement }: { placement: SwitcherPlacement }) {
  const { payload } = useBoardSnapshot();
  const repoColors = useRepoColors();
  const repos = payload?.repos ?? [];
  const { scope, setScope } = useRepoScope(repos);

  // ── single-repo (or not-yet-loaded) config → a bare label, no dropdown ──────
  // Gherkin: "Single-repo config shows just a label". With zero repos (config not
  // yet loaded) we render the same calm placeholder label so the chrome doesn't
  // jump when the first snapshot lands.
  if (!isMultiRepo(repos)) {
    const label = singleRepoLabel(repos);
    return (
      <div
        data-workspace-switcher={placement}
        data-multi="false"
        className={cn(
          "flex items-center gap-2 text-sm font-medium",
          placement === "sidebar"
            ? "px-1 text-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            : "rounded-md px-2 py-1 text-foreground",
        )}
      >
        <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "truncate",
            placement === "sidebar" && "group-data-[collapsible=icon]:hidden",
          )}
        >
          {label ?? "Workspace"}
        </span>
      </div>
    );
  }

  // ── multi-repo config → a scoping dropdown ──────────────────────────────────
  const options = scopeOptions(repos, repoColors);
  const active = activeOption(options, scope);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-workspace-switcher={placement}
        data-multi="true"
        aria-label="Scope workspace to a repo"
        className={cn(
          "flex items-center gap-2 rounded-md text-sm font-medium outline-hidden transition-colors",
          "hover:bg-secondary focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          placement === "sidebar"
            ? "px-1.5 py-1 text-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
            : "border border-border bg-secondary/30 px-2 py-1 text-foreground hover:text-foreground",
        )}
      >
        {/* The trigger ALWAYS shows the active scope's dot (for a repo scope) so
            the sidebar can collapse to just that dot under the icon-rail. "All"
            shows a neutral layers glyph instead of a dot. */}
        {active.isRepo ? (
          <ScopeDot color={active.dotColor} />
        ) : (
          <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "truncate",
            // Sidebar collapses to JUST the active dot under the icon-rail
            // (prototype `group-data-[collapsible=icon]`); the top strip keeps its
            // label at every width.
            placement === "sidebar" && "group-data-[collapsible=icon]:hidden",
          )}
        >
          {active.scope === REPO_SCOPE_ALL ? "All repos" : active.label}
        </span>
        <ChevronsUpDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            placement === "sidebar" && "ml-auto group-data-[collapsible=icon]:hidden",
          )}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[12rem]"
        data-workspace-switcher-menu
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Scope to repo
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((opt) => {
          const isActive = opt.scope === scope;
          return (
            <DropdownMenuItem
              key={opt.scope}
              data-scope={opt.scope}
              data-active={isActive}
              onSelect={() => setScope(opt.scope)}
              className="gap-2"
            >
              {opt.isRepo ? (
                <ScopeDot color={opt.dotColor} />
              ) : (
                <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">
                {opt.scope === REPO_SCOPE_ALL ? "All repos" : opt.label}
              </span>
              {/* Gherkin: "the active scope shows a checkmark". */}
              <CheckIcon
                aria-hidden
                className={cn("ml-auto size-4", isActive ? "opacity-100" : "opacity-0")}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
