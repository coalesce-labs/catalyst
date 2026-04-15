export interface InputCallbacks {
  onQuit: () => void;
  onRefresh: () => void;
  onFocus: (n: number) => void;
  onScrollUp: () => void;
  onScrollDown: () => void;
}

export function handleKeypress(data: Buffer, callbacks: InputCallbacks): void {
  const key = data[0];

  if (key === 0x03) {
    callbacks.onQuit();
    return;
  }

  const ch = String.fromCharCode(key);

  if (ch === "q" || ch === "Q") {
    callbacks.onQuit();
    return;
  }
  if (ch === "r" || ch === "R") {
    callbacks.onRefresh();
    return;
  }
  if (ch >= "0" && ch <= "9") {
    callbacks.onFocus(Number(ch));
    return;
  }

  if (data.length === 3 && data[0] === 0x1b && data[1] === 0x5b) {
    if (data[2] === 0x41) {
      callbacks.onScrollUp();
      return;
    }
    if (data[2] === 0x42) {
      callbacks.onScrollDown();
      return;
    }
  }
}
