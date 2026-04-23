export interface Cache<T> {
  get(key: string): T | null;
  set(key: string, value: T): void;
}

interface Entry<T> {
  value: T;
  storedAt: number;
}

export function createCache<T>(
  ttlMs: number,
  clock: () => number = Date.now,
): Cache<T> {
  const store = new Map<string, Entry<T>>();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (clock() - entry.storedAt >= ttlMs) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, storedAt: clock() });
    },
  };
}
