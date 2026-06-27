// sw-recovery.test.ts — unit tests for the PWA hard-recovery (CTL-1373). Stubs the browser
// serviceWorker + CacheStorage globals so the recovery is exercised without a real browser.
import { describe, it, expect, afterEach } from "bun:test";
import { hardRecoverAndReload } from "./sw-recovery";

const g = globalThis as Record<string, unknown>;
const savedNavigator = g.navigator;
const savedCaches = g.caches;

afterEach(() => {
  g.navigator = savedNavigator;
  g.caches = savedCaches;
});

describe("hardRecoverAndReload", () => {
  it("unregisters every service worker, deletes every cache, then reloads", async () => {
    const unregistered: string[] = [];
    const deleted: string[] = [];
    g.navigator = {
      serviceWorker: {
        getRegistrations: async () => [
          { unregister: async () => (unregistered.push("a"), true) },
          { unregister: async () => (unregistered.push("b"), true) },
        ],
      },
    };
    g.caches = {
      keys: async () => ["catalyst-shell-v1", "other"],
      delete: async (k: string) => (deleted.push(k), true),
    };
    const order: string[] = [];
    await hardRecoverAndReload(() => order.push("reload"));

    expect(unregistered).toEqual(["a", "b"]);
    expect(deleted).toEqual(["catalyst-shell-v1", "other"]);
    expect(order).toEqual(["reload"]); // reload happens after the cleanup awaits resolve
  });

  it("reloads even when the SW / cache APIs throw (best-effort)", async () => {
    g.navigator = {
      serviceWorker: {
        getRegistrations: async () => {
          throw new Error("SW API blew up");
        },
      },
    };
    g.caches = {
      keys: async () => {
        throw new Error("CacheStorage blew up");
      },
      delete: async () => true,
    };
    let reloaded = false;
    await hardRecoverAndReload(() => {
      reloaded = true;
    });
    expect(reloaded).toBe(true); // the user is never trapped by a failed cleanup
  });

  it("reloads in a non-PWA context (no serviceWorker, no caches)", async () => {
    g.navigator = {}; // no serviceWorker
    g.caches = undefined;
    let reloaded = false;
    await hardRecoverAndReload(() => {
      reloaded = true;
    });
    expect(reloaded).toBe(true);
  });
});
