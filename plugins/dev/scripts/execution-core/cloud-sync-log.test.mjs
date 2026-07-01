// cloud-sync-log.test.mjs — CTL-1402: the SDK apply-result signal must land as a
// full-JSON pino line with top-level fields (queryable via Alloy `| json`), never an
// unqueryable prefixed string.
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { sdkLogRecord } from "./cloud-sync-log.mjs";

// the real cloud-sync scrub (kept in sync with cloud-sync.mjs)
const scrub = (s) =>
  String(s)
    .replace(/([?&]token=)[^&\s"']+/gi, "$1***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9_-]+/g, "lin_***");

describe("sdkLogRecord — routing SDK logs to pino records", () => {
  test("apply FAILED → error level, fields at top level (result/seq/entity/source/err_message)", () => {
    const r = sdkLogRecord(
      "error",
      "catalyst.replica.apply",
      { result: "failed", seq: 343582, entity: "issues", source: "linear", err_message: "SQLITE_ERROR: no column" },
      scrub,
    );
    expect(r.level).toBe("error");
    expect(r.msg).toBe("catalyst.replica.apply");
    expect(r.fields).toEqual({
      result: "failed",
      seq: 343582,
      entity: "issues",
      source: "linear",
      err_message: "SQLITE_ERROR: no column",
    });
    // seq stays a NUMBER (not scrubbed to a string) so `| json | seq > N` works
    expect(typeof r.fields.seq).toBe("number");
  });

  test("apply APPLIED → info level (success path is info, not error)", () => {
    const r = sdkLogRecord("info", "catalyst.replica.apply", { result: "applied", seq: 1, entity: "issues" }, scrub);
    expect(r.level).toBe("info");
    expect(r.fields.result).toBe("applied");
  });

  test("undefined extra → no merge object", () => {
    const r = sdkLogRecord("info", "snapshot seeded", undefined, scrub);
    expect(r.fields).toBeUndefined();
    expect(r.msg).toBe("snapshot seeded");
  });

  test("string extra → rides a `detail` field (still JSON, still queryable)", () => {
    const r = sdkLogRecord("warn", "writer-lock release threw", "some detail", scrub);
    expect(r.level).toBe("warn");
    expect(r.fields).toEqual({ detail: "some detail" });
  });

  test("unknown level normalizes to info", () => {
    expect(sdkLogRecord("debug", "x", undefined).level).toBe("info");
    expect(sdkLogRecord("fatal", "x", undefined).level).toBe("info");
  });

  test("scrub applies to msg, string field values, and string-extra detail", () => {
    expect(sdkLogRecord("info", "connect ?token=SEKRET", undefined, scrub).msg).toBe("connect ?token=***");
    const r = sdkLogRecord("error", "m", { err_message: "auth Bearer abc.def.ghi failed" }, scrub);
    expect(r.fields.err_message).toBe("auth Bearer *** failed");
    expect(sdkLogRecord("info", "m", "lin_api_deadbeef", scrub).fields.detail).toBe("lin_***");
  });
});

describe("end-to-end: sdkLogRecord → pino emits a full-JSON line with top-level fields", () => {
  test("a failed apply frame is a parseable JSON line exposing result/seq/err_message", () => {
    const req = createRequire(import.meta.url);
    const pino = req("pino");
    const lines = [];
    const sink = { write: (s) => lines.push(s) };
    const hlog = pino({ name: "cloud-sync", level: "info" }, sink);

    // mirror the cloud-sync.mjs callback
    const r = sdkLogRecord(
      "error",
      "catalyst.replica.apply",
      { result: "failed", seq: 343582, entity: "issues", source: "linear", err_message: "errno 1" },
      scrub,
    );
    if (r.fields === undefined) hlog[r.level](r.msg);
    else hlog[r.level](r.fields, r.msg);

    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]); // must be FULL JSON (Alloy `| json` requirement)
    expect(rec.name).toBe("cloud-sync");
    expect(rec.msg).toBe("catalyst.replica.apply");
    expect(rec.result).toBe("failed"); // top-level field, not buried in a string
    expect(rec.seq).toBe(343582);
    expect(rec.err_message).toBe("errno 1");
    expect(rec.level).toBe(50); // pino numeric level for error
  });
});
