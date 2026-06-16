import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventRing } from "../lib/event-ring";
import {
  readSubStepEvents,
  readSubStepEventsFromFile,
} from "../lib/substep-reader";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "substep-ring-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function eventsDir(): string {
  const d = join(workdir, "events");
  mkdirSync(d, { recursive: true });
  return d;
}

function monthFile(): string {
  const month = new Date().toISOString().slice(0, 7);
  return join(workdir, "events", `${month}.jsonl`);
}

function substep(
  ticket: string,
  kind: "started" | "complete" | "failed",
  payload: Record<string, unknown>,
  ts: string,
): string {
  return JSON.stringify({
    ts,
    attributes: { "event.name": `workflow.substep.${kind}.${ticket}` },
    body: { payload },
  });
}

describe("readSubStepEvents (ring) — CTL-1215 B1", () => {
  it("returns only the requested ticket's substeps, ascending ts, fields extracted", () => {
    eventsDir();
    const lines = [
      substep("CTL-1", "started", { workflowName: "phase-implement", stepLabel: "tdd", stepIndex: 0, status: "started" }, "2026-06-04T00:00:02Z"),
      substep("CTL-2", "started", { workflowName: "phase-plan", stepLabel: "draft", stepIndex: 0, status: "started" }, "2026-06-04T00:00:03Z"),
      substep("CTL-1", "complete", { workflowName: "phase-implement", stepLabel: "tdd", stepIndex: 0, status: "complete" }, "2026-06-04T00:00:01Z"),
    ];
    writeFileSync(monthFile(), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir });
    ring.start();
    try {
      const got = readSubStepEvents(ring, "CTL-1");
      expect(got.length).toBe(2);
      // ascending ts
      expect(got[0].ts).toBe("2026-06-04T00:00:01Z");
      expect(got[1].ts).toBe("2026-06-04T00:00:02Z");
      expect(got[0].status).toBe("complete");
      expect(got[1].status).toBe("started");
      expect(got[1].workflowName).toBe("phase-implement");
      expect(got[1].stepLabel).toBe("tdd");
      expect(got[1].stepIndex).toBe(0);
    } finally {
      ring.stop();
    }
  });

  it("ring path matches the legacy file path (parity)", () => {
    const dir = eventsDir();
    const lines = [
      substep("CTL-1", "started", { workflowName: "w", stepLabel: "a", stepIndex: 0, status: "started" }, "2026-06-04T00:00:01Z"),
      substep("CTL-1", "failed", { workflowName: "w", stepLabel: "a", stepIndex: 0, status: "failed" }, "2026-06-04T00:00:02Z"),
      substep("CTL-9", "started", { workflowName: "w", stepLabel: "z", stepIndex: 1, status: "started" }, "2026-06-04T00:00:03Z"),
    ];
    writeFileSync(monthFile(), lines.join("\n") + "\n");

    const ring = createEventRing({ catalystDir: workdir });
    ring.start();
    try {
      const fromRing = readSubStepEvents(ring, "CTL-1");
      const fromFile = readSubStepEventsFromFile(dir, "CTL-1");
      expect(fromRing).toEqual(fromFile);
    } finally {
      ring.stop();
    }
  });

  it("returns empty for a ticket with no substeps", () => {
    eventsDir();
    writeFileSync(
      monthFile(),
      substep("CTL-5", "started", { workflowName: "w", stepLabel: "a", stepIndex: 0, status: "started" }, "2026-06-04T00:00:01Z") + "\n",
    );
    const ring = createEventRing({ catalystDir: workdir });
    ring.start();
    try {
      expect(readSubStepEvents(ring, "CTL-404")).toEqual([]);
    } finally {
      ring.stop();
    }
  });
});
