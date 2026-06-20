import { it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as store from "../lib/push-subscriptions";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "push-subs-"));
  store.openDb(join(dir, "push.db"));
});
afterEach(() => {
  store.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const SUB = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "P", auth: "A" },
};

it("upsert then list returns the subscription", () => {
  store.upsertSubscription(SUB);
  expect(store.listSubscriptions()).toHaveLength(1);
});

it("upsert is idempotent on endpoint (PRIMARY KEY)", () => {
  store.upsertSubscription(SUB);
  store.upsertSubscription(SUB);
  expect(store.listSubscriptions()).toHaveLength(1);
});

it("prune removes the endpoint", () => {
  store.upsertSubscription(SUB);
  store.deleteSubscription(SUB.endpoint);
  expect(store.listSubscriptions()).toHaveLength(0);
});

it("ensureDb throws before openDb", () => {
  store.closeDb();
  expect(() => store.listSubscriptions()).toThrow();
});

it("list returns correct p256dh and auth keys", () => {
  store.upsertSubscription(SUB);
  const subs = store.listSubscriptions();
  expect(subs[0]).toEqual(SUB);
});

it("upsert updates keys when endpoint already exists (ON CONFLICT DO UPDATE)", () => {
  store.upsertSubscription(SUB);
  const updated = { endpoint: SUB.endpoint, keys: { p256dh: "P2", auth: "A2" } };
  store.upsertSubscription(updated);
  const subs = store.listSubscriptions();
  expect(subs).toHaveLength(1);
  expect(subs[0].keys.p256dh).toBe("P2");
  expect(subs[0].keys.auth).toBe("A2");
});
