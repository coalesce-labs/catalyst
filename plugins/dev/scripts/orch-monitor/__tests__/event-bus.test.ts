import { describe, it, expect } from "bun:test";
import { emit, subscribe } from "../lib/event-bus";

describe("event-bus", () => {
  it("delivers an event to multiple subscribers (fan-out)", () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = subscribe("fanout-test", (d) => a.push(d));
    const unsubB = subscribe("fanout-test", (d) => b.push(d));
    emit("fanout-test", { hello: "world" });
    expect(a).toEqual([{ hello: "world" }]);
    expect(b).toEqual([{ hello: "world" }]);
    unsubA();
    unsubB();
  });

  it("unsubscribe stops further delivery", () => {
    const received: unknown[] = [];
    const unsub = subscribe("unsub-test", (d) => received.push(d));
    emit("unsub-test", 1);
    unsub();
    emit("unsub-test", 2);
    expect(received).toEqual([1]);
  });

  it("routes strictly by type name", () => {
    const a: unknown[] = [];
    const unsub = subscribe("route-a", (d) => a.push(d));
    emit("route-b", "should-not-arrive");
    emit("route-a", "should-arrive");
    expect(a).toEqual(["should-arrive"]);
    unsub();
  });

  it("isolates a throwing subscriber from other subscribers", () => {
    const received: unknown[] = [];
    const unsubBad = subscribe("isolation-test", () => {
      throw new Error("boom");
    });
    const unsubGood = subscribe("isolation-test", (d) => received.push(d));
    const originalError = console.error;
    console.error = () => {};
    try {
      emit("isolation-test", "payload");
    } finally {
      console.error = originalError;
    }
    expect(received).toEqual(["payload"]);
    unsubBad();
    unsubGood();
  });
});
