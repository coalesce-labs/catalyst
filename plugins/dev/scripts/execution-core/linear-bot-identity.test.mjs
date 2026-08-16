// linear-bot-identity.test.mjs — CTL-1892.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-bot-identity.test.mjs
//
// Real files in a temp dir: the whole claim under test is "what survives a rotation
// on disk", which an in-memory fake cannot demonstrate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPlausibleIdentityId,
  readIdentityLedger,
  recordIdentity,
  resolveSelfIdentities,
  syncAndResolveSelfIdentities,
} from "./linear-bot-identity.mjs";

// The two real actors measured on this fleet. Same display name, different handle:
// `catalystorchestrator` vs `catalystorchestrator2` — Linear's suffix on a taken
// handle, which is what identifies this as a re-mint rather than a stray process.
const OLD = "f51bc697-c64b-47b8-9fba-a2981fbfe652"; // retired 2026-08-10
const NEW = "ba2989f1-f250-4273-943c-ca511c66e793"; // current, from 2026-08-10
const HUMAN = "11111111-2222-3333-4444-555555555555"; // a genuine third party

let dir;
let ledger;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lbi-"));
  ledger = join(dir, "linear-bot-identities.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Today's guard, reproduced exactly: the set IS the current config. */
const todaysGuard = (configIds) => new Set(configIds);

describe("⭐ POSITIVE CONTROL — the defect is real against today's guard", () => {
  test("⛔ today's config-only guard treats a RETIRED identity as a third party", () => {
    // This is the ticket's required failing control. It asserts the BUG, so it must
    // pass here and would stop passing only if the point-in-time guard were fixed in
    // place. It is the reason the rest of this file exists.
    const afterRotation = todaysGuard([NEW]);
    expect(afterRotation.has(OLD)).toBe(false); // ← the fleet dispatches on its own echo
    expect(afterRotation.has(NEW)).toBe(true);
  });

  test("the ledger-backed set does NOT have that hole", () => {
    recordIdentity(ledger, OLD, { source: "config:orchestrator" });
    const { ids } = resolveSelfIdentities({ configIds: new Set([NEW]), ledgerPath: ledger });
    expect(ids.has(OLD)).toBe(true);
    expect(ids.has(NEW)).toBe(true);
  });
});

describe("Feature: the fleet recognises its own writes across rotations", () => {
  test("Scenario: the app actor is rotated — an OLD echo is still suppressed as self", () => {
    // Given the orchestrator previously wrote as OLD (learned while OLD was configured)
    let r = syncAndResolveSelfIdentities({ configIds: new Set([OLD]), ledgerPath: ledger });
    expect(r.recorded).toEqual([OLD]);

    // When it now writes as NEW (config rotated; OLD is gone from config entirely)
    r = syncAndResolveSelfIdentities({ configIds: new Set([NEW]), ledgerPath: ledger });

    // Then BOTH are recognised as self — the rotation EXTENDED the set
    expect(r.ids.has(OLD)).toBe(true);
    expect(r.ids.has(NEW)).toBe(true);
    expect(r.fromLedgerOnly).toContain(OLD);
  });

  test("Scenario: a genuine third party is still NOT suppressed", () => {
    syncAndResolveSelfIdentities({ configIds: new Set([OLD, NEW]), ledgerPath: ledger });
    const { ids } = resolveSelfIdentities({ configIds: new Set([NEW]), ledgerPath: ledger });
    expect(ids.has(HUMAN)).toBe(false);
  });

  test("⛔ an OBSERVED writer never enters the ledger — only ids we write as", () => {
    // The security argument for the whole file: if observation could admit an
    // identity, a third party could suppress itself by writing to the board, and the
    // guard becomes a way to HIDE changes from the fleet. There is deliberately no
    // API that takes an observed author id.
    syncAndResolveSelfIdentities({ configIds: new Set([NEW]), ledgerPath: ledger });
    const { ids } = resolveSelfIdentities({ configIds: new Set([NEW]), ledgerPath: ledger });
    expect(ids.has(HUMAN)).toBe(false);
    expect([...ids].sort()).toEqual([NEW]);
  });

  test("repeated rotations accumulate — three identities, all still self", () => {
    const THIRD = "99999999-8888-7777-6666-555555555555";
    for (const id of [OLD, NEW, THIRD]) {
      syncAndResolveSelfIdentities({ configIds: new Set([id]), ledgerPath: ledger });
    }
    const { ids } = resolveSelfIdentities({ configIds: new Set([THIRD]), ledgerPath: ledger });
    expect([...ids].sort()).toEqual([OLD, THIRD, NEW].sort());
  });
});

describe("⛔ the ledger read is THREE-VALUED — absent and unreadable are different", () => {
  test("absent is a clean empty, with a reason", () => {
    const r = readIdentityLedger(ledger);
    expect(r.status).toBe("absent");
    expect(r.ids.size).toBe(0);
  });

  test("malformed JSON is UNREADABLE, never a healthy-looking empty", () => {
    writeFileSync(ledger, "{not json");
    expect(readIdentityLedger(ledger).status).toBe("unreadable");
  });

  test("shape is validated BEFORE coercion — the falsy-empty shapes are all unreadable", () => {
    // Each of these yields an empty set under a permissive read, which is
    // indistinguishable from a healthy empty ledger.
    for (const bad of ["null", "[]", '{"identities":"abc"}', '{"identities":null}', '"str"']) {
      writeFileSync(ledger, bad);
      expect(readIdentityLedger(ledger).status).toBe("unreadable");
    }
  });

  test("an entry with an implausible id is skipped and COUNTED, not silently dropped", () => {
    writeFileSync(ledger, JSON.stringify({ version: 1, identities: [{ id: "nope" }, { id: NEW }, null, 42] }));
    const r = readIdentityLedger(ledger);
    expect(r.status).toBe("ok");
    expect([...r.ids]).toEqual([NEW]);
    expect(r.skipped).toBe(3);
  });
});

describe("⛔ an unreadable ledger must never be overwritten", () => {
  test("recordIdentity REFUSES rather than destroying retired identities", () => {
    // Rewriting an unreadable file turns a transient read problem into the permanent
    // reopening of the rotation window — the exact failure this ticket closes.
    writeFileSync(ledger, "{corrupt");
    const r = recordIdentity(ledger, NEW);
    expect(r.recorded).toBe(false);
    expect(r.status).toBe("refused-unreadable");
    expect(readFileSync(ledger, "utf8")).toBe("{corrupt"); // untouched
  });

  test("resolve still returns the CONFIG ids when the ledger is unreadable (fail-open)", () => {
    // Losing the configured ids would suppress nothing and turn every one of the
    // fleet's own writes into a dispatch — strictly worse than the rotation window.
    writeFileSync(ledger, "{corrupt");
    const r = resolveSelfIdentities({ configIds: new Set([NEW]), ledgerPath: ledger });
    expect(r.ids.has(NEW)).toBe(true);
    expect(r.ledgerStatus).toBe("unreadable"); // ...but the degradation is REPORTED
  });

  test("the degradation is reportable, not silent", () => {
    writeFileSync(ledger, "{corrupt");
    expect(resolveSelfIdentities({ configIds: new Set(), ledgerPath: ledger }).ledgerReason).toBeTruthy();
  });
});

describe("recording is append-only, idempotent, and never throws", () => {
  test("recording the same id twice writes once", () => {
    expect(recordIdentity(ledger, NEW).recorded).toBe(true);
    const second = recordIdentity(ledger, NEW);
    expect(second.recorded).toBe(false);
    expect(second.alreadyKnown).toBe(true);
    expect(JSON.parse(readFileSync(ledger, "utf8")).identities).toHaveLength(1);
  });

  test("a new id APPENDS rather than replacing", () => {
    recordIdentity(ledger, OLD);
    recordIdentity(ledger, NEW);
    const ids = JSON.parse(readFileSync(ledger, "utf8")).identities.map((e) => e.id);
    expect(ids).toEqual([OLD, NEW]);
  });

  test("an implausible id is refused — a truncated or empty value must not enter", () => {
    for (const bad of ["", "abc", null, undefined, 42, `${NEW}x`]) {
      expect(recordIdentity(ledger, bad).recorded).toBe(false);
    }
    expect(readIdentityLedger(ledger).status).toBe("absent"); // nothing was created
  });

  test("an unwritable path is reported, never thrown", () => {
    const rd = join(dir, "ro");
    require("node:fs").mkdirSync(rd);
    chmodSync(rd, 0o500);
    const r = recordIdentity(join(rd, "l.json"), NEW);
    expect(r.recorded).toBe(false);
    expect(r.status).toBe("write-failed");
    chmodSync(rd, 0o700);
  });

  test("provenance is recorded, so a retired id can be explained later", () => {
    recordIdentity(ledger, OLD, { source: "config:orchestrator", now: () => 1000 });
    const [e] = JSON.parse(readFileSync(ledger, "utf8")).identities;
    expect(e).toMatchObject({ id: OLD, source: "config:orchestrator", firstRecordedAt: 1000 });
  });
});

describe("id shape", () => {
  test("only a well-formed UUID is plausible", () => {
    expect(isPlausibleIdentityId(NEW)).toBe(true);
    for (const bad of ["", " ", "abc", null, undefined, 42, {}, `${NEW} `]) {
      expect(isPlausibleIdentityId(bad)).toBe(false);
    }
  });
});

// ── the daemon-level seam ────────────────────────────────────────────────────
import { readSelfEchoIdentities } from "./daemon.mjs";

describe("readSelfEchoIdentities — the seam the daemon actually calls", () => {
  const layer2 = (dirPath, ids) => {
    const p = join(dirPath, "layer2.json");
    writeFileSync(
      p,
      JSON.stringify({ catalyst: { linear: { bot: { orchestrator: { botUserId: ids.orchestrator }, worker: { botUserId: ids.worker } } } } }),
    );
    return p;
  };

  test("⭐ a rotation EXTENDS the set — the retired identity is still self", () => {
    // Tick 1: OLD is configured, so the ledger learns it.
    const before = readSelfEchoIdentities(null, layer2(dir, { orchestrator: OLD }), ledger);
    expect(before.has(OLD)).toBe(true);

    // Tick 2: the app is re-minted. Config names ONLY the new id.
    const after = readSelfEchoIdentities(null, layer2(dir, { orchestrator: NEW }), ledger);
    expect(after.has(NEW)).toBe(true);
    expect(after.has(OLD)).toBe(true); // ← the window that used to be open
  });

  test("⛔ a third party is still not suppressed after a rotation", () => {
    readSelfEchoIdentities(null, layer2(dir, { orchestrator: OLD }), ledger);
    const after = readSelfEchoIdentities(null, layer2(dir, { orchestrator: NEW }), ledger);
    expect(after.has(HUMAN)).toBe(false);
  });

  test("with NO ledger path it degrades to exactly today's behaviour", () => {
    const ids = readSelfEchoIdentities(null, layer2(dir, { orchestrator: NEW }), null);
    expect([...ids]).toEqual([NEW]);
  });

  test("an unreadable ledger is REPORTED and still fail-open", () => {
    writeFileSync(ledger, "{corrupt");
    let reported = null;
    const ids = readSelfEchoIdentities(null, layer2(dir, { orchestrator: NEW }), ledger, {
      onDegraded: (d) => (reported = d),
    });
    expect(ids.has(NEW)).toBe(true); // fail-open: config ids survive
    expect(reported).toMatchObject({ status: "unreadable" }); // but it is announced
    expect(reported.reason).toBeTruthy();
  });

  test("both worker and orchestrator identities are learned", () => {
    const ids = readSelfEchoIdentities(null, layer2(dir, { orchestrator: NEW, worker: OLD }), ledger);
    expect(ids.has(NEW)).toBe(true);
    expect(ids.has(OLD)).toBe(true);
    // and both persist after the config drops them
    const after = readSelfEchoIdentities(null, layer2(dir, { orchestrator: HUMAN }), ledger);
    expect(after.has(NEW)).toBe(true);
    expect(after.has(OLD)).toBe(true);
  });
});
