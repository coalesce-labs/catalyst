// use-detail-entry-state.ts — the React/router/jotai glue for the CTL-1049
// back-stack entry state convention. Reads the TanStack Router per-history-entry
// key off `location.state.__TSR_key`, hands back the entry's transient detail-view
// state atom (`detailEntryStateFamily`), and bounds the family's memory with an
// LRU over the keys it has touched.
//
// The pure DEFAULTS + LRU arithmetic live in detail-entry-state.ts (unit-tested
// under `bun test`); this hook is the thin runtime that maps the live router key
// onto the family and prunes evicted entries. Every detail page (ticket + worker)
// calls `useDetailEntryState()` once — the convention is shared scaffolding, not
// per-page code (the CTL-1049 "future detail page inherits it" Gherkin).

import { useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { useRouterState } from "@tanstack/react-router";
import {
  detailEntryStateFamily,
} from "../board/nav-store";
import {
  touchEntryLRU,
  type DetailEntryState,
} from "../board/detail-entry-state";

/**
 * Read the current history entry's per-entry key. TanStack stamps every entry
 * with `location.state.__TSR_key` (a per-entry UUID); a PUSH mints a new one, a
 * traverse (back/forward) re-presents the original. We fall back to the
 * `location.key` (also per-entry) on the off-chance `__TSR_key` is absent (e.g. a
 * hand-built history state), so the hook never keys everything onto one atom.
 */
export function useDetailEntryKey(): string {
  return useRouterState({
    // TanStack stamps the per-entry UUID onto `location.state` — `__TSR_key` is the
    // canonical one; `state.key` is the older history-entry key it also carries. We
    // fall back through both (then a stable literal) so the hook never keys
    // everything onto one atom even on a hand-built history state.
    select: (s) => s.location.state.__TSR_key ?? s.location.state.key ?? "__detail_entry_root__",
  });
}

/**
 * The shared back-stack entry-state hook. Returns the live `[state, setState]`
 * for the CURRENT history entry. A fresh PUSH → a new key → a new family atom →
 * the defaults; a back/forward traverse → the same key → the restored atom.
 *
 * Side effect: maintains a module-lifetime LRU of touched keys and calls
 * `detailEntryStateFamily.remove(evictedKey)` for any key pushed past the cap, so
 * the family can't grow unbounded across a long session.
 */
export function useDetailEntryState(): {
  key: string;
  state: DetailEntryState;
  setState: (next: DetailEntryState | ((prev: DetailEntryState) => DetailEntryState)) => void;
} {
  const key = useDetailEntryKey();
  const [state, setState] = useAtom(detailEntryStateFamily(key));

  // Bound the family: keep an LRU of touched keys (module-lifetime, shared across
  // all detail mounts via the ref's stable container) and evict the overflow.
  const lruRef = useRef<string[]>(LRU_ORDER);
  useEffect(() => {
    const { order, evicted } = touchEntryLRU(lruRef.current, key);
    LRU_ORDER = order;
    lruRef.current = order;
    for (const k of evicted) {
      // Never evict the key we're currently mounted on (it's at the end of the
      // order, so touchEntryLRU already protects it — this is belt-and-braces).
      if (k !== key) detailEntryStateFamily.remove(k);
    }
  }, [key]);

  return { key, state, setState };
}

// Module-lifetime LRU recency order (most-recent LAST). Shared across every
// detail mount so the cap is global, not per-component. Lives at module scope —
// the family it bounds is likewise a module singleton.
let LRU_ORDER: string[] = [];
