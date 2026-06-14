/** The single input-focus guard for every keyboard path (CTL-1025). Covers the
 *  union of what the two prior guards checked: INPUT / TEXTAREA / SELECT / a
 *  contenteditable host. Pure + structural so it unit-tests without a DOM. */
export interface TypingTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

export function isTypingTarget(target: TypingTargetLike | null | undefined): boolean {
  if (!target) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable === true
  );
}
