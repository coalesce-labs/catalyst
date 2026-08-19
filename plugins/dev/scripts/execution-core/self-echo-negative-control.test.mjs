// self-echo-negative-control.test.mjs — CTL-2074.
//
// Run: cd plugins/dev/scripts/execution-core && bun test self-echo-negative-control.test.mjs
//
// The ticket's teeth. `botUserIds` is the fleet's answer to "was this Linear change
// made by us?". Since CTL-1889 both minis write THROUGH the cloud proxy
// (CATALYST_LINEAR_WRITE_PROXY=enforce), so a mirrored-back proxied write carries the
// cloud tenant's app-actor id — which, before CTL-2074, was absent from the set and so
// read as "a human replied on the daemon's own output".
//
// This is an END-TO-END test of the config → resolved Set → guard path: it builds the
// recognition Set from a REAL config fixture via readSelfEchoIdentities (NOT by
// hand-constructing `new Set([CLOUD_ID])`), so it proves Phase 1's wiring, not just
// _isBotId in isolation. Every "suppressed" assertion carries the ⭐ NEGATIVE CONTROL:
// remove the cloud id and the SAME event leaks through — the one case a config-shaped
// set that names nobody-who-writes would still pass, and the reason the fix has teeth.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSelfEchoIdentities,
  createCommentInboxWriter,
  createUpdateInboxWriter,
  handleCommentWake,
} from "./daemon.mjs";

// Synthetic, well-formed UUIDs. CLOUD_ID must be UUID-shaped so it flows through the
// rotation-durable ledger (isPlausibleIdentityId gates ledger writes on UUID shape).
const ORCH_ID = "ba2989f1-0000-4000-8000-000000000000"; // configured orchestrator app actor
const CLOUD_ID = "78f8f491-0000-4000-8000-000000000000"; // synthetic cloud-proxy identity
const HUMAN_ID = "c2a8cc92-0000-4000-8000-000000000000"; // synthetic human (e.g. Ryan)

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "self-echo-nc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Build the recognition Set the SAME way the daemon does: from a real Layer-2 config
// fixture, through readSelfEchoIdentities (config → ledger → Set). With `withCloud`
// the cloud slot is present; without it, the negative control.
function setFromConfig({ withCloud }) {
  const layer2 = join(dir, `layer2-${withCloud ? "cloud" : "nocloud"}.json`);
  const bot = { orchestrator: { botUserId: ORCH_ID } };
  if (withCloud) bot.cloud = { botUserId: CLOUD_ID };
  writeFileSync(layer2, JSON.stringify({ catalyst: { linear: { bot } } }));
  const ledger = join(dir, `ledger-${withCloud ? "cloud" : "nocloud"}.json`);
  return readSelfEchoIdentities(null, layer2, ledger);
}

// Seed an in-flight worker dir (the inbox writers only write when workers/<ticket>/
// exists). Returns the orchDir.
function seedInFlightWorker(ticket) {
  const orchDir = mkdtempSync(join(tmpdir(), "self-echo-orch-"));
  mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
  return orchDir;
}

// Read inbox.jsonl as parsed entries; [] when the file was never written.
function readInbox(orchDir, ticket) {
  const p = join(orchDir, "workers", ticket, "inbox.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("CTL-2074 — self-echo suppression of a proxied-identity COMMENT (config→Set→guard)", () => {
  test("sanity: the Set built from config actually carries the cloud id", () => {
    expect(setFromConfig({ withCloud: true }).has(CLOUD_ID)).toBe(true);
    expect(setFromConfig({ withCloud: false }).has(CLOUD_ID)).toBe(false);
  });

  test("proxied-identity comment is suppressed (no inbox entry) when the cloud id is in the set", () => {
    const orchDir = seedInFlightWorker("CTL-2074");
    try {
      const writer = createCommentInboxWriter(orchDir, setFromConfig({ withCloud: true }));
      writer({ ticket: "CTL-2074", commentId: "c1", body: "mirror", authorId: CLOUD_ID });
      expect(readInbox(orchDir, "CTL-2074")).toEqual([]); // suppressed
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  });

  // ⭐ THE NEGATIVE CONTROL — with the id removed the SAME event is recorded, so the
  //    suppression assertion above has teeth. A set that names nobody who writes would
  //    pass every prior config-shaped check; this is the one that fails without the id.
  test("⭐ NEGATIVE CONTROL: remove the cloud id and the same proxied comment IS recorded", () => {
    const orchDir = seedInFlightWorker("CTL-2074");
    try {
      const writer = createCommentInboxWriter(orchDir, setFromConfig({ withCloud: false }));
      writer({ ticket: "CTL-2074", commentId: "c1", body: "mirror", authorId: CLOUD_ID });
      const inbox = readInbox(orchDir, "CTL-2074");
      expect(inbox).toHaveLength(1); // leaks through — proves the guard NEEDS the id
      expect(inbox[0].authorId).toBe(CLOUD_ID);
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  });

  test("a genuine human reply is recorded in BOTH configurations (still wakes the worker)", () => {
    for (const withCloud of [true, false]) {
      const orchDir = seedInFlightWorker("CTL-2074");
      try {
        const writer = createCommentInboxWriter(orchDir, setFromConfig({ withCloud }));
        writer({ ticket: "CTL-2074", commentId: "h1", body: "human", authorId: HUMAN_ID });
        expect(readInbox(orchDir, "CTL-2074")).toHaveLength(1);
      } finally {
        rmSync(orchDir, { recursive: true, force: true });
      }
    }
  });
});

describe("CTL-2074 — self-echo suppression of a proxied-identity DESCRIPTION UPDATE", () => {
  test("proxied-identity description update is suppressed when the cloud id is in the set", () => {
    const orchDir = seedInFlightWorker("CTL-2074");
    try {
      const writer = createUpdateInboxWriter(orchDir, setFromConfig({ withCloud: true }));
      writer({ ticket: "CTL-2074", description: "updated", descriptionChanged: true, actorId: CLOUD_ID });
      expect(readInbox(orchDir, "CTL-2074")).toEqual([]);
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  });

  test("⭐ NEGATIVE CONTROL: without the cloud id the same description update IS recorded", () => {
    const orchDir = seedInFlightWorker("CTL-2074");
    try {
      const writer = createUpdateInboxWriter(orchDir, setFromConfig({ withCloud: false }));
      writer({ ticket: "CTL-2074", description: "updated", descriptionChanged: true, actorId: CLOUD_ID });
      expect(readInbox(orchDir, "CTL-2074")).toHaveLength(1);
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  });

  test("a genuine human description update is recorded in both configurations", () => {
    for (const withCloud of [true, false]) {
      const orchDir = seedInFlightWorker("CTL-2074");
      try {
        const writer = createUpdateInboxWriter(orchDir, setFromConfig({ withCloud }));
        writer({ ticket: "CTL-2074", description: "updated", descriptionChanged: true, actorId: HUMAN_ID });
        expect(readInbox(orchDir, "CTL-2074")).toHaveLength(1);
      } finally {
        rmSync(orchDir, { recursive: true, force: true });
      }
    }
  });
});

describe("CTL-2074 — handleCommentWake needs-human clear respects the proxied identity", () => {
  // Capture every removeLabel(ticket, label) call. The needs-human clear fires only
  // when handleCommentWake believes a human authored the comment; a proxied-identity
  // comment recognised as self must short-circuit BEFORE the clear.
  function runWake({ authorId, botSet }) {
    const orchDir = mkdtempSync(join(tmpdir(), "self-echo-wake-"));
    const removed = [];
    return handleCommentWake(
      { ticket: "CTL-2074", authorId },
      {
        orchDir,
        botUserId: botSet,
        dispatch: () => {},
        removeLabel: async (_ticket, label) => {
          removed.push(label);
          return { removed: true, wrote: true };
        },
        isManagedTicket: () => true, // this installation manages the ticket
        forgetIntent: () => {},
        appendWorkerTransitionEvent: () => {},
        clearDispositionEmit: () => {},
        resolveSession: () => null,
        clearStall: () => false,
      }
    )
      .then(() => removed)
      .finally(() => rmSync(orchDir, { recursive: true, force: true }));
  }

  test("proxied-id comment does NOT clear needs-human when the cloud id is in the set", async () => {
    const removed = await runWake({ authorId: CLOUD_ID, botSet: setFromConfig({ withCloud: true }) });
    expect(removed).not.toContain("needs-human"); // self-echo guard short-circuited
  });

  test("⭐ NEGATIVE CONTROL: drop the cloud id and the SAME proxied comment clears needs-human (the defect)", async () => {
    const removed = await runWake({ authorId: CLOUD_ID, botSet: setFromConfig({ withCloud: false }) });
    expect(removed).toContain("needs-human"); // the daemon's own write reads as a human
  });

  test("a genuine human reply DOES clear needs-human (still wakes the worker) in both configs", async () => {
    for (const withCloud of [true, false]) {
      const removed = await runWake({ authorId: HUMAN_ID, botSet: setFromConfig({ withCloud }) });
      expect(removed).toContain("needs-human");
    }
  });
});
