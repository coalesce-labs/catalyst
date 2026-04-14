import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  openDb,
  closeDb,
  getAnnotation,
  getAllAnnotations,
  setDisplayName,
  addFlag,
  removeFlag,
  addNote,
  removeNote,
  addTag,
  removeTag,
  deleteAnnotation,
} from "../lib/annotations";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "annotations-test-"));
  dbPath = join(tmpDir, "annotations.db");
  openDb(dbPath);
});

afterEach(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("annotations database", () => {
  it("returns null for non-existent session", () => {
    const result = getAnnotation("nonexistent");
    expect(result).toBeNull();
  });

  it("returns empty record when no annotations exist", () => {
    const result = getAllAnnotations();
    expect(result).toEqual({});
  });

  describe("display name", () => {
    it("sets and retrieves a display name", () => {
      setDisplayName("CTL-1", "auth refactor batch");
      const ann = getAnnotation("CTL-1");
      expect(ann).not.toBeNull();
      expect(ann!.displayName).toBe("auth refactor batch");
    });

    it("updates an existing display name", () => {
      setDisplayName("CTL-1", "original");
      setDisplayName("CTL-1", "updated");
      const ann = getAnnotation("CTL-1");
      expect(ann!.displayName).toBe("updated");
    });

    it("clears display name when set to null", () => {
      setDisplayName("CTL-1", "name");
      setDisplayName("CTL-1", null);
      const ann = getAnnotation("CTL-1");
      expect(ann!.displayName).toBeNull();
    });
  });

  describe("flags", () => {
    it("adds a flag", () => {
      addFlag("CTL-2", "starred");
      const ann = getAnnotation("CTL-2");
      expect(ann!.flags).toEqual(["starred"]);
    });

    it("does not duplicate flags", () => {
      addFlag("CTL-2", "starred");
      addFlag("CTL-2", "starred");
      const ann = getAnnotation("CTL-2");
      expect(ann!.flags).toEqual(["starred"]);
    });

    it("supports multiple flags", () => {
      addFlag("CTL-2", "starred");
      addFlag("CTL-2", "flagged");
      const ann = getAnnotation("CTL-2");
      expect(ann!.flags).toContain("starred");
      expect(ann!.flags).toContain("flagged");
      expect(ann!.flags.length).toBe(2);
    });

    it("removes a flag", () => {
      addFlag("CTL-2", "starred");
      addFlag("CTL-2", "flagged");
      removeFlag("CTL-2", "starred");
      const ann = getAnnotation("CTL-2");
      expect(ann!.flags).toEqual(["flagged"]);
    });

    it("removing non-existent flag is a no-op", () => {
      addFlag("CTL-2", "starred");
      removeFlag("CTL-2", "archived");
      const ann = getAnnotation("CTL-2");
      expect(ann!.flags).toEqual(["starred"]);
    });
  });

  describe("notes", () => {
    it("adds a note with timestamp", () => {
      addNote("CTL-3", "flaky test, re-ran manually");
      const ann = getAnnotation("CTL-3");
      expect(ann!.notes.length).toBe(1);
      expect(ann!.notes[0].text).toBe("flaky test, re-ran manually");
      expect(ann!.notes[0].createdAt).toBeTruthy();
    });

    it("adds multiple notes in order", () => {
      addNote("CTL-3", "first note");
      addNote("CTL-3", "second note");
      const ann = getAnnotation("CTL-3");
      expect(ann!.notes.length).toBe(2);
      expect(ann!.notes[0].text).toBe("first note");
      expect(ann!.notes[1].text).toBe("second note");
    });

    it("removes a note by index", () => {
      addNote("CTL-3", "keep");
      addNote("CTL-3", "remove");
      addNote("CTL-3", "also keep");
      removeNote("CTL-3", 1);
      const ann = getAnnotation("CTL-3");
      expect(ann!.notes.length).toBe(2);
      expect(ann!.notes[0].text).toBe("keep");
      expect(ann!.notes[1].text).toBe("also keep");
    });

    it("removing out-of-range index is a no-op", () => {
      addNote("CTL-3", "only note");
      removeNote("CTL-3", 5);
      const ann = getAnnotation("CTL-3");
      expect(ann!.notes.length).toBe(1);
    });
  });

  describe("tags", () => {
    it("adds a tag", () => {
      addTag("CTL-4", "refactor");
      const ann = getAnnotation("CTL-4");
      expect(ann!.tags).toEqual(["refactor"]);
    });

    it("does not duplicate tags", () => {
      addTag("CTL-4", "refactor");
      addTag("CTL-4", "refactor");
      const ann = getAnnotation("CTL-4");
      expect(ann!.tags).toEqual(["refactor"]);
    });

    it("supports multiple tags", () => {
      addTag("CTL-4", "refactor");
      addTag("CTL-4", "high-cost");
      const ann = getAnnotation("CTL-4");
      expect(ann!.tags).toContain("refactor");
      expect(ann!.tags).toContain("high-cost");
    });

    it("removes a tag", () => {
      addTag("CTL-4", "refactor");
      addTag("CTL-4", "bugfix");
      removeTag("CTL-4", "refactor");
      const ann = getAnnotation("CTL-4");
      expect(ann!.tags).toEqual(["bugfix"]);
    });
  });

  describe("deleteAnnotation", () => {
    it("deletes all annotation data for a session", () => {
      setDisplayName("CTL-5", "test");
      addFlag("CTL-5", "starred");
      addNote("CTL-5", "some note");
      addTag("CTL-5", "spike");
      deleteAnnotation("CTL-5");
      expect(getAnnotation("CTL-5")).toBeNull();
    });

    it("deleting non-existent session is a no-op", () => {
      deleteAnnotation("nonexistent");
      expect(getAllAnnotations()).toEqual({});
    });
  });

  describe("getAllAnnotations", () => {
    it("returns all annotated sessions", () => {
      setDisplayName("CTL-A", "Alpha");
      addTag("CTL-B", "beta");
      const all = getAllAnnotations();
      expect(Object.keys(all)).toHaveLength(2);
      expect(all["CTL-A"].displayName).toBe("Alpha");
      expect(all["CTL-B"].tags).toEqual(["beta"]);
    });
  });

  describe("updatedAt", () => {
    it("is set on creation", () => {
      setDisplayName("CTL-6", "test");
      const ann = getAnnotation("CTL-6");
      expect(ann!.updatedAt).toBeTruthy();
      const ts = Date.parse(ann!.updatedAt);
      expect(Number.isNaN(ts)).toBe(false);
    });

    it("is updated on modification", () => {
      setDisplayName("CTL-6", "first");
      const first = getAnnotation("CTL-6")!.updatedAt;
      setDisplayName("CTL-6", "second");
      const second = getAnnotation("CTL-6")!.updatedAt;
      expect(Date.parse(second)).toBeGreaterThanOrEqual(Date.parse(first));
    });
  });
});
