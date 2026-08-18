// index-serving-root-health.mjs — CTL-1935. Does this node's catalyst-index serving root
// actually carry the pinned release?
//
// ⛔ WHY THIS IS NOT COVERED BY THE DEP-SKEW DETECTOR. evaluateDepSkew (CTL-1931) is anchored on
// a DAEMON's boot breadcrumb — it answers "is the running writer serving a configured root?".
// catalyst-index is an on-demand CLI: there is no long-lived pid and no boot record, so a cold
// index run leaves nothing for that detector to grade. The gap is exactly the one measured on
// mini-2 on 2026-08-17: `which catalyst-index` -> not found, and the only catalyst-cloud checkout
// on the host sat 332 commits behind main, so a run would have executed WITHOUT CTC-661's
// resample fix and looked completely normal doing it.
//
// ⛔ AND WHY BOTH HALVES ARE CHECKED. Measured on the dev laptop 2026-08-18: a checkout 18 commits
// behind the pin FAILED ancestry while PASSING the content probe, because the probed symbol had
// merged before that HEAD. On mini-2, 332 behind, the content probe failed too. Either half alone
// clears a root the other condemns.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { STATUS, mkCheck } from "./doctor-status.mjs";

const NAME = "index-serving-root";

export function defaultPinPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "index-serving-root.json");
}

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function checkIndexServingRoot(deps = {}) {
  const {
    pinPath = defaultPinPath(),
    readJson = (p) => JSON.parse(readFileSync(p, "utf8")),
    readText = (p) => readFileSync(p, "utf8"),
    exists = existsSync,
    git = (root, args) => {
      const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      return { status: r.status, stdout: (r.stdout ?? "").trim() };
    },
    env = process.env,
  } = deps;

  let pin;
  try {
    pin = readJson(pinPath);
  } catch (e) {
    // ⛔ Unreadable pin => INFO naming the reason, never a pass. "I could not look" and "it is
    // fine" must not render identically — that is the false-clean shape this check exists for.
    return mkCheck(NAME, STATUS.INFO, `cannot read the index serving-root pin (${pinPath}): ${e.message}`);
  }

  const sha = typeof pin?.sha === "string" ? pin.sha : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return mkCheck(NAME, STATUS.WARN, `the pin file records '${sha || "(nothing)"}' as the sha — a pin must be a full 40-char hex sha, or it is not a pin`);
  }
  const probeFile = pin?.probe?.file;
  const probeSymbol = pin?.probe?.symbol;
  if (typeof probeFile !== "string" || typeof probeSymbol !== "string") {
    return mkCheck(NAME, STATUS.WARN, "the pin file records no content probe — ancestry alone cannot tell whether the tree on disk holds the pinned code");
  }

  const root = env.CATALYST_INDEX_ROOT || expand(String(pin?.path ?? ""));
  if (!root) return mkCheck(NAME, STATUS.WARN, "the pin file records no serving-root path");

  // ⚠️ NOT PROVISIONED IS NOT CLEAN. A node with no serving root is a node where a cold index
  // would fall back to whatever checkout the operator's session is sitting in — the defect.
  if (!exists(join(root, ".git"))) {
    return mkCheck(NAME, STATUS.WARN, `no index serving root at ${root} — a cold index here would run from whatever checkout the invoking session happens to be in (run: catalyst-index-root setup)`);
  }

  const head = git(root, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout) {
    return mkCheck(NAME, STATUS.WARN, `could not read HEAD in ${root} — the pin is UNPROVEN`);
  }
  const hasPin = git(root, ["cat-file", "-e", `${sha}^{commit}`]);
  if (hasPin.status !== 0) {
    return mkCheck(NAME, STATUS.WARN, `pinned ${sha.slice(0, 9)} is not present in ${root} — the root has never fetched the pinned release (run: catalyst-index-root setup)`);
  }
  const ancestor = git(root, ["merge-base", "--is-ancestor", sha, head.stdout]);
  const ancestryOk = ancestor.status === 0;

  let contentOk = false;
  let contentWhy = "";
  const probePath = join(root, probeFile);
  if (!exists(probePath)) {
    contentWhy = `${probeFile} is absent from the tree`;
  } else {
    try {
      contentOk = readText(probePath).includes(probeSymbol);
      if (!contentOk) contentWhy = `${probeSymbol} is absent from ${probeFile}`;
    } catch (e) {
      contentWhy = `${probeFile} is unreadable: ${e.message}`;
    }
  }

  const dirty = git(root, ["status", "--porcelain", "--", probeFile]);
  const cleanOk = dirty.status === 0 && dirty.stdout === "";

  if (ancestryOk && contentOk && cleanOk) {
    return mkCheck(NAME, STATUS.PASS, `index serving root ${root} carries the pinned ${sha.slice(0, 9)} (ancestry + ${probeSymbol} present + tree clean)`);
  }

  const why = [];
  if (!ancestryOk) why.push(`HEAD ${head.stdout.slice(0, 9)} does NOT contain pinned ${sha.slice(0, 9)}`);
  if (!contentOk) why.push(contentWhy);
  if (!cleanOk) why.push(dirty.status !== 0 ? `could not read git status for ${probeFile}` : `${probeFile} is locally modified`);
  return mkCheck(
    NAME,
    STATUS.WARN,
    `index serving root ${root} is NOT the pinned release — ${why.join("; ")}. A cold index from here runs code nobody pinned (CTL-1935).`,
  );
}
