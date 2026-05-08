import { useState, useEffect } from "react";

export function useSelection(totalItems: number, visibleRows: number) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + visibleRows) {
      setScrollOffset(selectedIndex - visibleRows + 1);
    }
  }, [selectedIndex, scrollOffset, visibleRows]);

  function moveUp() {
    setSelectedIndex((i) => Math.max(0, i - 1));
  }

  function moveDown() {
    setSelectedIndex((i) => Math.min(Math.max(0, totalItems - 1), i + 1));
  }

  function pageUp() {
    setSelectedIndex((i) => Math.max(0, i - visibleRows));
  }

  function pageDown() {
    setSelectedIndex((i) => Math.min(Math.max(0, totalItems - 1), i + visibleRows));
  }

  function jumpToBottom() {
    setSelectedIndex(Math.max(0, totalItems - 1));
  }

  return { selectedIndex, scrollOffset, moveUp, moveDown, pageUp, pageDown, jumpToBottom };
}
