const bus = new EventTarget();

export function emit(type: string, data: unknown): void {
  bus.dispatchEvent(new CustomEvent(type, { detail: data }));
}

export function subscribe(
  type: string,
  handler: (data: unknown) => void,
): () => void {
  const listener = (e: Event) => {
    try {
      handler((e as CustomEvent).detail);
    } catch (err) {
      console.error(`[event-bus] subscriber for "${type}" threw:`, err);
    }
  };
  bus.addEventListener(type, listener);
  return () => bus.removeEventListener(type, listener);
}
