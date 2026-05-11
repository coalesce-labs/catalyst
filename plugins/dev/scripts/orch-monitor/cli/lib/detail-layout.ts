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

// When in detail mode, the DetailPane renders inside a single-border Box as:
//   borders(2) + title(1) + min(scrollable, maxHeight) + scrollbar(1 iff overflow)
// We size the pane to its natural content height, but cap it so the list
// always retains at least `minListRows` rows.
export function computeDetailLayout(input: DetailLayoutInput): DetailLayoutResult {
  const minListRows = input.minListRows ?? 5;
  const safeScroll = Math.max(0, input.currentScrollOffset);

  if (!input.inDetailMode) {
    return {
      detailPaneRows: 0,
      detailContentRows: 0,
      listRows: Math.max(1, input.visibleRows),
      listScrollOffset: safeScroll,
    };
  }

  const cappedMax = Math.max(minListRows + 2, input.visibleRows - minListRows);
  const natural = input.detailLineCount + 2; // +2 for top+bottom borders
  const paneRows = Math.min(natural, cappedMax);
  const fits = natural <= cappedMax;
  // When content fits, no scrollbar — usable scrollable = detailLineCount - 1 (title sticky).
  // When capped, layout is borders(2) + title(1) + visible + scrollbar(1) = paneRows
  //   → visible = paneRows - 4.
  const detailContentRows = fits
    ? Math.max(1, input.detailLineCount - 1)
    : Math.max(1, paneRows - 4);
  const listRows = Math.max(1, input.visibleRows - paneRows);

  const maxOffset = Math.max(0, input.totalEvents - listRows);
  let listScrollOffset = Math.min(safeScroll, maxOffset);
  if (
    input.selectedIndex < listScrollOffset ||
    input.selectedIndex >= listScrollOffset + listRows
  ) {
    listScrollOffset = Math.max(
      0,
      Math.min(input.selectedIndex - Math.floor(listRows / 2), maxOffset),
    );
  }

  return { detailPaneRows: paneRows, detailContentRows, listRows, listScrollOffset };
}
