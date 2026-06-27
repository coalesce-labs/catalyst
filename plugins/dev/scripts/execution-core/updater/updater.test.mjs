// updater.test.mjs — CTL-1348/CTL-1350 updater daemon module. Covers the loop wiring,
// the merge-event tail (incl. EOF-seed + month-rollover), the canonical emitFn, the
// node.updater.heartbeat shape, and the unconfigured-pluginDirs WARN. The detect-only
// pull invariant + decideStackReload no-op live in plugin-pull-defer.test.mjs (the
// broker-side cutover); this file owns the updater agent itself. All seams injected — no
// real git, no real timers, no writes to the live event log.
import { describe, test, expect } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runRefreshOnce,
  makeEventTail,
  makeEmitFn,
  buildUpdaterHeartbeatEnvelope,
  startUpdater,
  deriveRefreshTraceContext,
  UPDATER_HEARTBEAT_EVENT,
  UPDATER_NO_PLUGIN_DIRS_EVENT,
  UPDATER_SERVICE_NAME,
} from "./updater.mjs";

function fakeLog() {
  const calls = [];
  const mk = (level) => (a, b) => calls.push({ level, obj: typeof a === "object" ? a : undefined, msg: typeof a === "string" ? a : b });
  return { calls, info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") };
}

describe("runRefreshOnce (CTL-1348 poll/boot/event refresh)", () => {
  test("calls refreshAllFn and emits the metric log line with the OTEL-contract fields", () => {
    const log = fakeLog();
    let calledWith = null;
    const refreshAllFn = (opts) => {
      calledWith = opts;
      return [
        { root: "/r/a", pulled: true, changed: true, failed: false, oldSha: "old", newSha: "new" },
        { root: "/r/b", pulled: true, changed: false, failed: false, oldSha: "x", newSha: "x" },
      ];
    };
    let t = 1000;
    let rootsCalledWith = null;
    const { results, checkouts } = runRefreshOnce({
      reason: "poll",
      log,
      emitFn: () => {},
      nowFn: () => (t += 5),
      nodeClass: "worker",
      hostNameVal: "mini",
      repoConfigPath: "/repo/.catalyst/config.json",
      refreshAllFn,
      resolveRootsFn: (o) => { rootsCalledWith = o; return ["/r/a", "/r/b"]; },
    });
    // Codex P1: repoConfigPath MUST reach both root resolution and the refresh, else a
    // node whose pluginDirs live in the repo config resolves zero roots and pulls nothing.
    expect(rootsCalledWith).toMatchObject({ repoConfigPath: "/repo/.catalyst/config.json" });
    expect(calledWith).toMatchObject({ repoConfigPath: "/repo/.catalyst/config.json" });
    expect(calledWith).toHaveProperty("emitFn");
    expect(results.length).toBe(2);
    expect(checkouts).toEqual([
      { root: "/r/a", headSha: "new" },
      { root: "/r/b", headSha: "x" },
    ]);
    const line = log.calls.find((c) => c.msg?.startsWith("updater: refresh"));
    expect(line).toBeTruthy();
    expect(line.obj).toMatchObject({ reason: "poll", roots: 2, pulled: 2, changed: 1, failed: 0, "catalyst.node.class": "worker" });
    expect(typeof line.obj.refresh_duration_ms).toBe("number");
    expect(line.obj.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(line.obj.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("counts failed checkouts in the metric line", () => {
    const log = fakeLog();
    runRefreshOnce({
      reason: "event",
      log,
      emitFn: () => {},
      nowFn: () => 0,
      nodeClass: "developer",
      hostNameVal: "laptop",
      refreshAllFn: () => [{ root: "/r/x", pulled: false, changed: false, failed: true, oldSha: "h", newSha: null }],
      resolveRootsFn: () => ["/r/x"],
    });
    const line = log.calls.find((c) => c.msg?.startsWith("updater: refresh"));
    expect(line.obj).toMatchObject({ failed: 1, pulled: 0, changed: 0 });
  });

  test("unconfigured pluginDirs → one updater.no-plugin-dirs WARN (idempotent via state)", () => {
    const log = fakeLog();
    const events = [];
    const emitFn = (e) => events.push(e);
    const state = {};
    const args = {
      reason: "poll",
      log,
      emitFn,
      nowFn: () => 0,
      nodeClass: "developer",
      hostNameVal: "laptop",
      refreshAllFn: () => [],
      resolveRootsFn: () => [],
      state,
    };
    runRefreshOnce(args);
    runRefreshOnce(args); // second pass must NOT re-warn
    const warns = events.filter((e) => e.event === UPDATER_NO_PLUGIN_DIRS_EVENT);
    expect(warns.length).toBe(1);
    expect(warns[0].severity).toBe("WARN");
  });
});

describe("makeEventTail (CTL-1348 merge-event latency path)", () => {
  const mergeLine = JSON.stringify({ event: "github.pr.merged", attributes: { "vcs.repository.name": "coalesce-labs/catalyst" } });
  const pushMain = JSON.stringify({ event: "github.push", attributes: { "vcs.repository.name": "coalesce-labs/catalyst", "vcs.ref.name": "refs/heads/main" } });
  const monitorMerge = JSON.stringify({ event: "phase.monitor-merge.complete.CTL-1348" });
  const noise = JSON.stringify({ event: "session.heartbeat" });

  function harness({ path = "/log/A", initialSize = 0, repoFullName = "coalesce-labs/catalyst" } = {}) {
    const files = new Map([[path, ""]]);
    let curPath = path;
    const fired = [];
    const tail = makeEventTail({
      getLogPathFn: () => curPath,
      repoFullName,
      onMerge: (ev) => fired.push(ev),
      sizeFn: (p) => (files.get(p) ?? "").length,
      readSliceFn: (p, start, end) => (files.get(p) ?? "").slice(start, end),
    });
    // seed initial content the tail must NOT replay (cursor seeded at EOF)
    if (initialSize) files.set(path, "x".repeat(initialSize));
    return {
      tail,
      fired,
      append: (line) => files.set(curPath, (files.get(curPath) ?? "") + line + "\n"),
      switchTo: (p) => {
        curPath = p;
        if (!files.has(p)) files.set(p, "");
      },
      set: (p, content) => files.set(p, content),
    };
  }

  test("a merge-to-main event fires onMerge (github.pr.merged)", () => {
    const h = harness();
    h.append(mergeLine);
    h.tail.poll();
    expect(h.fired.length).toBe(1);
  });

  test("github.push to main + phase.monitor-merge.complete also fire", () => {
    const h1 = harness();
    h1.append(pushMain);
    h1.tail.poll();
    expect(h1.fired.length).toBe(1);

    const h2 = harness();
    h2.append(monitorMerge);
    h2.tail.poll();
    expect(h2.fired.length).toBe(1);
  });

  test("a non-merge event does NOT fire", () => {
    const h = harness();
    h.append(noise);
    h.tail.poll();
    expect(h.fired.length).toBe(0);
  });

  test("seeded at EOF — pre-boot history is not replayed", () => {
    const h = harness({ initialSize: 0 });
    // simulate history present before the first poll by writing then re-seeding:
    h.set("/log/A", mergeLine + "\n");
    // a fresh tail seeded after the content exists must treat it as already-seen.
    const fired = [];
    const tail = makeEventTail({
      getLogPathFn: () => "/log/A",
      repoFullName: "coalesce-labs/catalyst",
      onMerge: (ev) => fired.push(ev),
      sizeFn: () => (mergeLine + "\n").length,
      readSliceFn: () => "",
    });
    tail.poll();
    expect(fired.length).toBe(0);
  });

  test("month-rollover: a merge in the new month's file is not missed", () => {
    const h = harness({ path: "/log/2026-06" });
    // first month: a merge fires
    h.append(mergeLine);
    h.tail.poll();
    expect(h.fired.length).toBe(1);
    // UTC rollover → new path, fresh file with its own merge
    h.switchTo("/log/2026-07");
    h.set("/log/2026-07", monitorMerge + "\n");
    h.tail.poll();
    expect(h.fired.length).toBe(2); // no missed refresh across the boundary
  });

  test("truncation/rotation guard — cursor resets when the file shrinks", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.append(noise); // push the cursor well past mergeLine's length
    h.tail.poll();
    expect(h.fired.length).toBe(0);
    h.set("/log/A", mergeLine + "\n"); // file replaced in-place, now SHORTER than the cursor
    h.tail.poll(); // size < cursor → reset to 0 → reads the whole (new) merge line
    expect(h.fired.length).toBe(1);
  });

  test("partial trailing line (no newline yet) is HELD, not consumed, until it completes", () => {
    const h = harness();
    // a merge line written WITHOUT its trailing newline (writer mid-append)
    h.set("/log/A", mergeLine);
    h.tail.poll();
    expect(h.fired.length).toBe(0); // no complete line → cursor held, nothing consumed
    // the writer finishes the line (appends the newline)
    h.set("/log/A", mergeLine + "\n");
    h.tail.poll();
    expect(h.fired.length).toBe(1); // now complete → fired (not dropped)
  });
});

describe("makeEmitFn (canonical v2 envelope, service.name=catalyst.updater)", () => {
  test("legacy {event,severity,detail} → canonical OTel envelope on the event log", () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-emit-"));
    const logPath = join(dir, "events.jsonl");
    const emit = makeEmitFn({ getLogPathFn: () => logPath, nowFn: () => 0, nodeClass: "worker", hostNameVal: "mini" });
    emit({ event: "plugin.checkout.drift", severity: "WARN", detail: { checkout: "/r/a", head_sha: "h", origin_sha: "o", behind: true } });
    const env = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(env.resource["service.name"]).toBe(UPDATER_SERVICE_NAME);
    expect(env.resource["service.namespace"]).toBe("catalyst");
    expect(env.resource["host.name"]).toBeTruthy();
    expect(env.resource["catalyst.node.class"]).toBe("worker");
    expect(env.attributes["event.name"]).toBe("plugin.checkout.drift");
    expect(env.attributes["event.label"]).toBe("/r/a");
    expect(env.severityText).toBe("WARN");
    expect(env.severityNumber).toBe(13);
    expect(env.body.payload).toMatchObject({ checkout: "/r/a", behind: true });
  });

  test("node class falls back to getNodeClass() as a STRING (regression: getNodeClass returns a string, not {class})", () => {
    // CTL-1365a refactored getNodeClass() to return the class string (resolveNodeClass()
    // returns the object). A `getNodeClass()?.class` deref would make this null — guard it.
    const dir = mkdtempSync(join(tmpdir(), "updater-cls-"));
    const logPath = join(dir, "events.jsonl");
    const emit = makeEmitFn({ getLogPathFn: () => logPath, nowFn: () => 0 }); // NO nodeClass injected
    emit({ event: "plugin.checkout.updated", detail: { checkout: "/r/a" } });
    const cls = JSON.parse(readFileSync(logPath, "utf8").trim()).resource["catalyst.node.class"];
    expect(typeof cls).toBe("string");
    expect(cls).not.toBeNull();
    expect(cls.length).toBeGreaterThan(0);
  });

  test("re-resolves the log path PER CALL (month-rollover — events never stranded)", () => {
    const dir = mkdtempSync(join(tmpdir(), "updater-rollover-"));
    const a = join(dir, "2026-06.jsonl");
    const b = join(dir, "2026-07.jsonl");
    let cur = a;
    const emit = makeEmitFn({ getLogPathFn: () => cur, nowFn: () => 0, nodeClass: "worker", hostNameVal: "mini" });
    emit({ event: "plugin.checkout.updated", detail: { checkout: "/r/a" } });
    cur = b; // UTC month rolls over
    emit({ event: "plugin.checkout.drift", severity: "WARN", detail: { checkout: "/r/a" } });
    expect(JSON.parse(readFileSync(a, "utf8").trim()).attributes["event.name"]).toBe("plugin.checkout.updated");
    expect(JSON.parse(readFileSync(b, "utf8").trim()).attributes["event.name"]).toBe("plugin.checkout.drift");
  });
});

describe("buildUpdaterHeartbeatEnvelope (DISTINCT from node.heartbeat — HRW masking)", () => {
  test("event.name is node.updater.heartbeat with {root,headSha}[] payload + class", () => {
    const env = buildUpdaterHeartbeatEnvelope({
      nowFn: () => 1234,
      nodeClass: "worker",
      hostNameVal: "mini",
      checkouts: [{ root: "/r/a", headSha: "abc" }],
    });
    expect(env.attributes["event.name"]).toBe(UPDATER_HEARTBEAT_EVENT);
    expect(env.attributes["event.name"]).not.toBe("node.heartbeat");
    expect(env.attributes["event.entity"]).toBe("node");
    expect(env.resource["service.name"]).toBe(UPDATER_SERVICE_NAME);
    expect(env.body.payload.checkouts).toEqual([{ root: "/r/a", headSha: "abc" }]);
    expect(env.body.payload.roots).toBe(1);
    expect(env.body.payload["catalyst.node.class"]).toBe("worker");
    expect(env.body.payload.epoch).toBe(1234);
  });
});

describe("deriveRefreshTraceContext", () => {
  test("deterministic 32/16 hex ids; distinct per refresh epoch", () => {
    const a = deriveRefreshTraceContext({ host: "mini", reason: "poll", epoch: 1 });
    const b = deriveRefreshTraceContext({ host: "mini", reason: "poll", epoch: 1 });
    const c = deriveRefreshTraceContext({ host: "mini", reason: "poll", epoch: 2 });
    expect(a).toEqual(b);
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.traceId).not.toBe(c.traceId);
  });
});

describe("startUpdater wiring (CTL-1348 three-timer loop)", () => {
  function captureTimers() {
    const timers = [];
    const setIntervalFn = (fn, ms) => {
      const t = { fn, ms, unrefd: false, cleared: false, unref() { this.unrefd = true; } };
      timers.push(t);
      return t;
    };
    const clearIntervalFn = (t) => { t.cleared = true; };
    return { timers, setIntervalFn, clearIntervalFn };
  }

  test("boot fires one refresh + one heartbeat; poll timer is NOT unref'd, heartbeat/event ARE; stop() clears all", () => {
    const { timers, setIntervalFn, clearIntervalFn } = captureTimers();
    let refreshCount = 0;
    const events = [];
    const handle = startUpdater({
      log: fakeLog(),
      setIntervalFn,
      clearIntervalFn,
      emitFn: (e) => events.push(e),
      refreshAllFn: () => {
        refreshCount++;
        return [{ root: "/r/a", pulled: true, changed: false, failed: false, oldSha: "s", newSha: "s" }];
      },
      resolveRootsFn: () => ["/r/a"],
      getLogPathFn: () => join(mkdtempSync(join(tmpdir(), "updater-hb-")), "events.jsonl"),
      repoFullName: "coalesce-labs/catalyst",
      pollIntervalMs: 90_000,
      eventPollIntervalMs: 5_000,
      heartbeatIntervalMs: 120_000,
    });
    expect(refreshCount).toBe(1); // boot refresh
    expect(timers.length).toBe(3);
    const poll = timers.find((t) => t.ms === 90_000);
    const hb = timers.find((t) => t.ms === 120_000);
    const ev = timers.find((t) => t.ms === 5_000);
    expect(poll.unrefd).toBe(false); // the daemon's reason to exist — must keep the loop alive
    expect(hb.unrefd).toBe(true);
    expect(ev.unrefd).toBe(true);
    // poll callback drives another refresh
    poll.fn();
    expect(refreshCount).toBe(2);
    handle.stop();
    expect(timers.every((t) => t.cleared)).toBe(true);
  });

  test("a later zero-roots refresh CLEARS the stale heartbeat checkout list (Codex P2)", () => {
    const { setIntervalFn, clearIntervalFn, timers } = captureTimers();
    let roots = ["/r/a"]; // first refresh sees one checkout
    const handle = startUpdater({
      log: fakeLog(),
      setIntervalFn,
      clearIntervalFn,
      emitFn: () => {},
      refreshAllFn: () => roots.map((r) => ({ root: r, pulled: true, changed: false, failed: false, oldSha: "s", newSha: "s" })),
      resolveRootsFn: () => roots,
      getLogPathFn: () => join(mkdtempSync(join(tmpdir(), "updater-clr-")), "events.jsonl"),
      repoFullName: "coalesce-labs/catalyst",
    });
    expect(handle._lastCheckouts()).toEqual([{ root: "/r/a", headSha: "s" }]); // boot refresh recorded it
    // pluginDirs removed → roots now resolve to zero
    roots = [];
    const poll = timers.find((t) => t.ms === 90_000);
    poll.fn();
    expect(handle._lastCheckouts()).toEqual([]); // stale checkout list cleared, not retained
    handle.stop();
  });
});
