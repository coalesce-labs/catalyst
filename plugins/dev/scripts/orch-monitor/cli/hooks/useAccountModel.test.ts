// useAccountModel.test.ts — covers shouldReconnectOnIdle directly (the pure
// decision extracted from useAccountModel's connect()) plus an integration
// check on the underlying createNodeEventSource behavior it reacts to.
//
// useAccountModel mixes React hook machinery (useEffect/useState) with a live
// EventSource connection, so we can't invoke the hook directly in bun:test —
// bun's runner has no React-hook renderer. This mirrors the established
// pattern in useFilter.test.ts / useEventLog.test.ts: test the pure logic the
// hook is built from, adjacent to the source so drift is obvious in review.

import { describe, test, expect } from "bun:test";
import { shouldReconnectOnIdle } from "./useAccountModel";
import { createNodeEventSource } from "../lib/node-event-source";

describe("shouldReconnectOnIdle (CTL-1653 Codex round-2: clean-EOF reconnect)", () => {
  test("reconnects on a clean end-of-stream (no prior onerror, still mounted, still current)", () => {
    expect(shouldReconnectOnIdle({ handled: false, alive: true, isCurrent: true })).toBe(true);
  });
  test("does NOT reconnect when onerror already handled this connection's end", () => {
    // Avoids double-scheduling: onerror's own path already calls scheduleReconnect.
    expect(shouldReconnectOnIdle({ handled: true, alive: true, isCurrent: true })).toBe(false);
  });
  test("does NOT reconnect after the component has unmounted", () => {
    expect(shouldReconnectOnIdle({ handled: false, alive: false, isCurrent: true })).toBe(false);
  });
  test("does NOT reconnect when a newer connection has already superseded this one", () => {
    expect(shouldReconnectOnIdle({ handled: false, alive: true, isCurrent: false })).toBe(false);
  });
});

/** A fetch stub that streams the given chunks then ends the body cleanly (no error). */
function fetchStreamingThenCloseCleanly(chunks: string[]): typeof fetch {
  return (() => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close(); // clean EOF — NOT an error
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as unknown as typeof fetch;
}

describe("createNodeEventSource: the gap shouldReconnectOnIdle exists to close", () => {
  test("a clean end-of-stream resolves whenIdle() WITHOUT ever invoking onerror", async () => {
    // This is the precise bug: before the fix, useAccountModel only scheduled a
    // reconnect from onerror, and this proves onerror is silent on a graceful
    // close — so a hook that reconnects ONLY from onerror can freeze forever.
    const es = createNodeEventSource("http://x/api/accounts/stream", {
      fetchImpl: fetchStreamingThenCloseCleanly([
        'event: account\ndata: {"status":"ok"}\n\n',
      ]),
    });
    let errorFired = false;
    es.onerror = () => {
      errorFired = true;
    };
    const got: string[] = [];
    es.addEventListener("account", (ev) => got.push(ev.data));
    await es.whenIdle();
    expect(got.length).toBe(1); // the frame still delivered before EOF
    expect(errorFired).toBe(false); // and yet onerror never fired
    es.close();
  });
});
