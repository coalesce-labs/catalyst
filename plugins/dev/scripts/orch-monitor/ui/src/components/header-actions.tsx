// header-actions.tsx — the single right-aligned action slot in the app header
// (CTL-1003 §A1). The thin top strip (app-shell.tsx) renders ONE <HeaderActionsSlot/>
// where the old ⌘K search button lived; a detail page renders its prev/next
// chevrons into it via <HeaderActions> (a portal). This keeps the page-specific
// pager controls in the SINGLE header bar without the detail Shell re-rendering a
// second header. Null until the slot DOM node mounts (no flash, no error).

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The dom id of the header's right-aligned action slot. */
export const HEADER_ACTIONS_ID = "app-header-actions";

/** The slot the app header renders once (where the old search button was). A
 *  page portals its actions into this node via <HeaderActions>. */
export function HeaderActionsSlot() {
  return (
    <div
      id={HEADER_ACTIONS_ID}
      className="ml-auto flex items-center gap-1"
    />
  );
}

/** Portal `children` into the header's action slot. Renders nothing until the
 *  slot node is in the DOM (the effect grabs it after mount). */
export function HeaderActions({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setNode(document.getElementById(HEADER_ACTIONS_ID));
  }, []);
  return node ? createPortal(children, node) : null;
}
