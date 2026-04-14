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

export function startInputHandler(callbacks: InputCallbacks): () => void {
  if (!process.stdin.isTTY) {
    console.warn("[input] stdin is not a TTY — keyboard controls disabled");
    return () => {};
  }

  const onData = (data: Buffer) => {
    try {
      handleKeypress(data, callbacks);
    } catch (err) {
      console.error("[input] keypress handler error:", err);
    }
  };

  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  } catch (err) {
    console.error("[input] failed to enable raw mode:", err);
    return () => {};
  }

  return () => {
    process.stdin.off("data", onData);
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      // stdin may already be closed
    }
  };
}
