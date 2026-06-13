// test-setup.mjs — bun [test].preload for the broker suite (CTL-1086).
// Pin CATALYST_DIR to a fresh per-run temp dir BEFORE any test module loads so
// no broker test — and no code-under-test reaching a default appendEvent seam
// during the afterEach-delete window — can append to ~/catalyst/events/*.jsonl.
// Mirrors execution-core/test-setup.mjs (CTL-810). CATALYST_HERMETIC_DIR is the
// stable record the tripwire asserts on; sibling tests may repoint CATALYST_DIR.
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const hermeticDir = mkdtempSync(join(tmpdir(), "catalyst-broker-hermetic-"));
process.env.CATALYST_DIR = hermeticDir;
process.env.CATALYST_HERMETIC_DIR = hermeticDir;
process.env.CATALYST_TEST = "1";
