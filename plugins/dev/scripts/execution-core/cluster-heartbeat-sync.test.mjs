// cluster-heartbeat-sync.test.mjs — synchronous bridge over cluster-heartbeat CLI
// (CTL-1090). Every test injects a fake `spawn` so nothing forks a process.
// Mirrors cluster-claim-sync.test.mjs in structure and fail-open contract.
import { describe, test, expect } from "bun:test";
import { publishHeartbeatSync, readPeerHeartbeatsSync } from "./cluster-heartbeat-sync.mjs";

describe("publishHeartbeatSync — argv + fail-open contract", () => {
  test("returns ok:true and forwards anchor/host/tickets to the CLI", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = args;
      return {
        status: 0,
        stdout: JSON.stringify({ host: "mini", last_seen: "t", in_flight_tickets: [] }) + "\n",
      };
    };
    const result = publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: [] },
      { spawn },
    );
    expect(result.ok).toBe(true);
    expect(captured).toContain("publish");
    expect(captured).toContain("CTL-9");
    expect(captured).toContain("mini");
  });

  test("passes tickets as a comma-separated string", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = args;
      return {
        status: 0,
        stdout:
          JSON.stringify({ host: "mini", last_seen: "t", in_flight_tickets: ["CTL-1", "CTL-2"] }) +
          "\n",
      };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: ["CTL-1", "CTL-2"] },
      { spawn },
    );
    expect(captured).toContain("CTL-1,CTL-2");
  });

  test("builds the right argv: <node> <cli> publish <anchor> <host> <tickets>", () => {
    let capturedBin, capturedArgs;
    const spawn = (bin, args) => {
      capturedBin = bin;
      capturedArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: [] },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    expect(capturedBin).toBe("/usr/bin/node");
    expect(capturedArgs[0]).toBe("/x/cluster-heartbeat.mjs");
    expect(capturedArgs[1]).toBe("publish");
    expect(capturedArgs[2]).toBe("CTL-9");
    expect(capturedArgs[3]).toBe("mini");
  });

  test("CTL-1092: appends maxParallel as the 4th positional arg when it is a positive int", () => {
    let capturedArgs;
    const spawn = (_bin, args) => {
      capturedArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[],"max_parallel":3}\n' };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: ["CTL-1"], maxParallel: 3 },
      { spawn },
    );
    // argv: [cli, "publish", anchor, host, ticketsCsv, maxParallel]
    expect(capturedArgs[4]).toBe("CTL-1");
    expect(capturedArgs[5]).toBe("3");
  });

  test("CTL-1092: omits maxParallel (back-compat 3-arg form) when null/absent/non-positive", () => {
    const grab = (args) => {
      let captured;
      const spawn = (_bin, a) => {
        captured = a;
        return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
      };
      publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini", inFlightTickets: [], ...args }, { spawn });
      return captured;
    };
    // ticketsCsv is "" here, so a present maxParallel would be argv[5]; none must be appended.
    expect(grab({}).length).toBe(5); // no maxParallel
    expect(grab({ maxParallel: null }).length).toBe(5);
    expect(grab({ maxParallel: 0 }).length).toBe(5);
    expect(grab({ maxParallel: -1 }).length).toBe(5);
    expect(grab({ maxParallel: 2.5 }).length).toBe(5);
    expect(grab({ maxParallel: 4 }).length).toBe(6); // positive int → appended
  });

  test("fail-open: non-zero exit → ok:false (never throws)", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("fail-open: spawn throws → ok:false (never throws)", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("fail-open: unparseable stdout → ok:false", () => {
    const spawn = () => ({ status: 0, stdout: "not json" });
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("fail-open: timeout (status null) → ok:false", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("defaults inFlightTickets to [] when omitted", () => {
    let capturedArgs;
    const spawn = (bin, args) => {
      capturedArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
    };
    publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    // the CSV arg should be an empty string for no tickets
    const csvArg = capturedArgs[capturedArgs.length - 1];
    expect(csvArg).toBe("");
  });

  // CTL-1251: failures now carry a diagnostic `error` reason (still fail-open).
  test("non-zero exit surfaces exit code + stderr tail in error", () => {
    const spawn = () => ({ status: 2, stdout: "", stderr: "Linear 401 Unauthorized\n" });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit 2");
    expect(r.error).toContain("401 Unauthorized");
  });

  test("timeout (status null, res.error set) surfaces the spawn error", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ETIMEDOUT");
  });

  test("spawn throw surfaces the thrown message in error", () => {
    const spawn = () => { throw new Error("EACCES"); };
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("EACCES");
  });

  test("unparseable stdout → ok:false with an error reason", () => {
    const spawn = () => ({ status: 0, stdout: "not json" });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  test("stderr is truncated so a noisy subprocess can't bloat the log line", () => {
    const spawn = () => ({ status: 1, stdout: "", stderr: "x".repeat(5000) });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.error.length).toBeLessThan(260); // ~200 stderr tail + "exit 1: " prefix
  });
});

describe("readPeerHeartbeatsSync — parsing + fail-open contract", () => {
  test("parses and returns the CLI map", () => {
    const map = {
      mini: { host: "mini", last_seen: "2026-06-13T01:00:00Z", in_flight_tickets: [] },
    };
    const spawn = () => ({ status: 0, stdout: JSON.stringify(map) + "\n" });
    expect(readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual(map);
  });

  test("builds the right argv: <node> <cli> read <anchor>", () => {
    let capturedBin, capturedArgs;
    const spawn = (bin, args) => {
      capturedBin = bin;
      capturedArgs = args;
      return { status: 0, stdout: "{}\n" };
    };
    readPeerHeartbeatsSync(
      { anchorIssue: "CTL-9" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    expect(capturedBin).toBe("/usr/bin/node");
    expect(capturedArgs).toEqual(["/x/cluster-heartbeat.mjs", "read", "CTL-9"]);
  });

  test("unparseable stdout → {}", () => {
    expect(
      readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "not json" }) }),
    ).toEqual({});
  });

  test("empty stdout → {}", () => {
    expect(
      readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "" }) }),
    ).toEqual({});
  });

  test("non-zero exit → {}", () => {
    expect(
      readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 1, stdout: "" }) }),
    ).toEqual({});
  });

  test("spawn throws → {}", () => {
    expect(
      readPeerHeartbeatsSync(
        { anchorIssue: "CTL-9" },
        {
          spawn: () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).toEqual({});
  });

  test("timeout / status null → {}", () => {
    expect(
      readPeerHeartbeatsSync(
        { anchorIssue: "CTL-9" },
        { spawn: () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null }) },
      ),
    ).toEqual({});
  });

  test("array stdout (non-object) → {}", () => {
    expect(
      readPeerHeartbeatsSync(
        { anchorIssue: "CTL-9" },
        { spawn: () => ({ status: 0, stdout: "[]\n" }) },
      ),
    ).toEqual({});
  });
});
