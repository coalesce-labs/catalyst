export interface DetailLayoutInput {
  /** Combined height available to the event list + detail pane. */
  visibleRows: number;
  /** Whether the detail pane is open. */
  inDetailMode: boolean;
  /** Length of buildDetailLines(...) for the selected event (includes title). */
  detailLineCount: number;
  /** Currently selected event index in the filtered list. */
  selectedIndex: number;
  /** Total events in the filtered list. */
  totalEvents: number;
  /** Pre-detail scrollOffset from useSelection. */
  currentScrollOffset: number;
  /** Floor for list height when the pane is open. Default 5. */
  minListRows?: number;
}

export interface DetailLayoutResult {
  /** Rows the DetailPane occupies (borders + title + content). 0 when closed. */
  detailPaneRows: number;
  /** maxHeight prop for DetailPane (scrollable rows shown). 0 when closed. */
  detailContentRows: number;
  /** Rows allocated to the EventList above the pane. */
  listRows: number;
  /** scrollOffset to pass into EventList so the selection stays visible. */
  listScrollOffset: number;
}

export interface BottomOverlaySize {
  /** Rows the overlay occupies (content + borders). */
  paneRows: number;
  /** Rows allocated to the EventList above the overlay. */
  listRows: number;
  /** True when the overlay's natural height fit without capping. */
  fits: boolean;
}

// Generic bottom-anchored overlay sizing. The overlay (detail pane, help
// panel, future modals) renders at its natural height, but is capped so the
// list above always retains at least `minListRows` rows.
export function computeBottomOverlaySize(
  visibleRows: number,
  naturalRows: number,
  minListRows: number = 5,
): BottomOverlaySize {
  const cappedMax = Math.max(minListRows + 2, visibleRows - minListRows);
  const paneRows = Math.min(naturalRows, cappedMax);
  const fits = naturalRows <= cappedMax;
  const listRows = Math.max(1, visibleRows - paneRows);
  return { paneRows, listRows, fits };
}

// Keep the selection visible after the list shrinks (an overlay opened, etc.).
// Returns a scrollOffset clamped to [0, maxOffset]; recenters around the
// selection only when it would otherwise fall outside the visible window.
export function reanchorListScrollOffset(
  selectedIndex: number,
  totalEvents: number,
  listRows: number,
  currentScrollOffset: number,
): number {
  const safeScroll = Math.max(0, currentScrollOffset);
  const maxOffset = Math.max(0, totalEvents - listRows);
  let offset = Math.min(safeScroll, maxOffset);
  if (selectedIndex < offset || selectedIndex >= offset + listRows) {
    offset = Math.max(0, Math.min(selectedIndex - Math.floor(listRows / 2), maxOffset));
  }
  return offset;
}

// When in detail mode, the DetailPane renders inside a single-border Box as:
//   borders(2) + title(1) + min(scrollable, maxHeight) + scrollbar(1 iff overflow)
// We size the pane to its natural content height, but cap it so the list
// always retains at least `minListRows` rows.
export function computeDetailLayout(input: DetailLayoutInput): DetailLayoutResult {
  const minListRows = input.minListRows ?? 5;

  if (!input.inDetailMode) {
    return {
      detailPaneRows: 0,
      detailContentRows: 0,
      listRows: Math.max(1, input.visibleRows),
      listScrollOffset: Math.max(0, input.currentScrollOffset),
    };
  }

  const natural = input.detailLineCount + 2; // +2 for top+bottom borders
  const { paneRows, listRows, fits } = computeBottomOverlaySize(
    input.visibleRows,
    natural,
    minListRows,
  );
  // When content fits, no scrollbar — usable scrollable = detailLineCount - 1 (title sticky).
  // When capped, layout is borders(2) + title(1) + visible + scrollbar(1) = paneRows
  //   → visible = paneRows - 4.
  const detailContentRows = fits
    ? Math.max(1, input.detailLineCount - 1)
    : Math.max(1, paneRows - 4);
  const listScrollOffset = reanchorListScrollOffset(
    input.selectedIndex,
    input.totalEvents,
    listRows,
    input.currentScrollOffset,
  );

  return { detailPaneRows: paneRows, detailContentRows, listRows, listScrollOffset };
}
