import { useEffect, useRef } from "react";

interface KeyboardNavOptions {
  onEscape?: () => void;
  onSlash?: () => void;
  onQuestionMark?: () => void;
}

/**
 * Binds global keyboard shortcuts for dashboard navigation.
 *
 * Shortcuts are ignored when an input, textarea, or select is focused.
 *   - Escape  → onEscape      (e.g. go back to dashboard)
 *   - /       → onSlash        (e.g. focus search input, preventDefault)
 *   - ?       → onQuestionMark (e.g. show keyboard help)
 */
export function useKeyboardNav(options: KeyboardNavOptions): void {
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case "Escape":
          callbacksRef.current.onEscape?.();
          break;
        case "/":
          e.preventDefault();
          callbacksRef.current.onSlash?.();
          break;
        case "?":
          callbacksRef.current.onQuestionMark?.();
          break;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
