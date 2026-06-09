// node-scope.ts — the shell's NODE-SCOPE contract (CTL-898 / SHELL8).
//
// When more than one orchestrator node is running, the operator can focus the
// shell's surfaces on ONE node's work (and restore the cluster-wide view with the
// All-nodes option). This module is the PURE, framework-agnostic core of that
// scope — the scope union, the All-nodes sentinel, the in-scope predicate, and a
// resolver that drops a stale focused scope when its host leaves the roster.
// AppShell/AppSidebar consume it; keeping it React-free (the same pattern
// lib/surface.ts follows) makes the scope contract unit-testable without a DOM.
//
// SINGLE-HOST IDENTITY NO-OP: with one node the scope is always `ALL_NODES` and
// the filter UI is absent (lib/cluster-signal.ts::shouldShowNodeFilter), so this
// contract is inert on today's single-node deployment — exactly the non-cluster
// path. The node-by filter threads into the shell the same way a repo scope would
// (per SHELL8's note); it is the single-host branch done correctly, with the N>1
// branch falling out of the same predicate.
import { createContext, useContext } from "react";

/** The cluster-wide sentinel — restore the All-nodes view. */
export const ALL_NODES = "all" as const;

/** The active node scope: All-nodes, or a focused host name. */
export type NodeScope = typeof ALL_NODES | (string & {});

/**
 * Whether a node-attributed item is visible under the current scope. The
 * All-nodes scope includes everything (an un-attributed `ownerHost: null` item
 * included too); a focused scope includes only items owned by that host (an
 * un-attributed item is hidden — it cannot be proven to belong to the focused
 * node). Pure so the filter is unit-testable without the store.
 */
export function isNodeInScope(scope: NodeScope, ownerHost: string | null): boolean {
  if (scope === ALL_NODES) return true;
  return ownerHost === scope;
}

/**
 * Resolve a (possibly stale) scope against the live roster: a focused scope on a
 * host that is no longer in the roster falls back to `ALL_NODES` so a node going
 * away never strands the operator on an empty view (Gherkin: a node going dark is
 * reflected without a reload). `ALL_NODES` always resolves to itself.
 */
export function resolveNodeScope(scope: NodeScope, roster: readonly string[]): NodeScope {
  if (scope === ALL_NODES) return ALL_NODES;
  return roster.includes(scope) ? scope : ALL_NODES;
}

interface NodeScopeContextValue {
  scope: NodeScope;
  setScope: (s: NodeScope) => void;
}

export const NodeScopeContext = createContext<NodeScopeContextValue | null>(null);

/**
 * The active node scope + setter. Returns the inert All-nodes scope when no
 * provider is present (single-node deployments never mount the provider's filter
 * affordance — the identity no-op) so a consumer can always read a scope safely.
 */
export function useNodeScope(): NodeScopeContextValue {
  const ctx = useContext(NodeScopeContext);
  if (!ctx) return { scope: ALL_NODES, setScope: () => {} };
  return ctx;
}
