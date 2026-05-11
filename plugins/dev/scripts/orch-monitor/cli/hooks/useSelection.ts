import { useState, useEffect } from "react";

export function useSelection(totalItems: number, visibleRows: number) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);

  // Auto-follow: track the bottom, but keep one row of breathing room
  // so the newest event is never obscured by the status bar chrome.
  useEffect(() => {
    if (autoFollow && totalItems > 0) {
      setSelectedIndex(totalItems - 1);
    }
  }, [autoFollow, totalItems]);

  // Keep selected item in the visible viewport.
  // In auto-follow mode, target visibleRows-2 (not -1) so there's always
  // one empty row between the selected item and the status bar.
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + visibleRows) {
      const bottomBuffer = autoFollow ? 2 : 1;
      setScrollOffset(Math.max(0, selectedIndex - visibleRows + bottomBuffer));
    }
  }, [selectedIndex, scrollOffset, visibleRows, autoFollow]);

  function moveUp() {
    setAutoFollow(false);
    setSelectedIndex((i) => Math.max(0, i - 1));
  }

  function moveDown() {
    setAutoFollow(false);
    setSelectedIndex((i) => Math.min(Math.max(0, totalItems - 1), i + 1));
  }

  function pageUp() {
    setAutoFollow(false);
    setSelectedIndex((i) => Math.max(0, i - visibleRows));
  }

  function pageDown() {
    setAutoFollow(false);
    setSelectedIndex((i) => Math.min(Math.max(0, totalItems - 1), i + visibleRows));
  }

  function jumpToBottom() {
    setAutoFollow(true);
    setSelectedIndex(Math.max(0, totalItems - 1));
  }

  return { selectedIndex, scrollOffset, moveUp, moveDown, pageUp, pageDown, jumpToBottom, autoFollow };
}
