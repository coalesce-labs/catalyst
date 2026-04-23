import type { ProviderName } from "./config";

export interface RateLimiter {
  tryAcquire(provider: ProviderName): boolean;
  release(provider: ProviderName): void;
}

interface ProviderSlot {
  inFlight: number;
  lastAcquiredAt: number;
}

export interface RateLimiterOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  clock?: () => number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { maxConcurrent, minIntervalMs } = opts;
  const clock = opts.clock ?? Date.now;
  const slots = new Map<ProviderName, ProviderSlot>();

  function getSlot(provider: ProviderName): ProviderSlot {
    let slot = slots.get(provider);
    if (!slot) {
      slot = { inFlight: 0, lastAcquiredAt: -Infinity };
      slots.set(provider, slot);
    }
    return slot;
  }

  return {
    tryAcquire(provider) {
      const slot = getSlot(provider);
      if (slot.inFlight >= maxConcurrent) return false;
      if (clock() - slot.lastAcquiredAt < minIntervalMs) return false;
      slot.inFlight += 1;
      slot.lastAcquiredAt = clock();
      return true;
    },
    release(provider) {
      const slot = getSlot(provider);
      if (slot.inFlight > 0) slot.inFlight -= 1;
    },
  };
}
