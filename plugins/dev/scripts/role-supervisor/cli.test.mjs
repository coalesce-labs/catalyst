// cli.test.mjs — CTL-2095. Tests for the launch-steward / launch-concierge /
// activity / complete CLI verbs added to role-supervisor.
//
// Design: most tests use spawnSync to drive the CLI as a subprocess.
// All launcher tests pass --dry-run so install.sh never touches launchd.
// All tests use a scratch CATALYST_DIR so nothing touches the real ~/catalyst.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI = join(__dirname, "cli.mjs");

let passes = 0, failures = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS: ${name}`); passes++; }
  catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failures++; }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "cli-test-"));
  const env = { CATALYST_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oat" };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runCli(argv, { env = {}, timeout = 10000 } = {}) {
  return spawnSync("node", [CLI, ...argv], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
}

// Write a minimal manifest directly for idempotency / state tests.
function writeManifest(dir, role, obj = {}) {
  const roleDir = join(dir, "roles", role);
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(
    join(roleDir, "manifest.json"),
    JSON.stringify({ role, scope: "test", skill: "catalyst-dev:steward", cwd: "/tmp", activity: {}, scope_active: true, ...obj }, null, 2),
  );
}

// ── Phase 1: launch verbs ───────────────────────────────────────────────────

console.log("1. launch-steward: role derivation and dry-run");
await t("--slug p13 derives role steward-p13, exits 0 in dry-run, prints manifest would-write", async () => {
  const s = scratch();
  const r = runCli(
    ["launch-steward", "--slug", "p13", "--scope", "P13 · Test", "--cwd", "/tmp", "--dry-run"],
    { env: s.env },
  );
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /steward-p13/, "output should name the derived role");
  // No manifest file should have been created.
  assert.equal(existsSync(join(s.dir, "roles", "steward-p13", "manifest.json")), false,
    "dry-run must not create the manifest file");
  s.cleanup();
});

console.log("2. launch-steward: contract guard — wrong skill");
await t("--skill catalyst-dev:concierge exits 2 with a message naming the invariant", async () => {
  const s = scratch();
  const r = runCli(
    ["launch-steward", "--slug", "x", "--skill", "catalyst-dev:concierge", "--cwd", "/tmp", "--dry-run"],
    { env: s.env },
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr + r.stdout, /catalyst-dev:steward/, "message must name the required skill");
  s.cleanup();
});

await t("--brief flag is rejected with exit 2", async () => {
  const s = scratch();
  const r = runCli(
    ["launch-steward", "--slug", "x", "--brief", "some-brief.txt", "--dry-run"],
    { env: s.env },
  );
  assert.equal(r.status, 2, `expected exit 2 on --brief, got ${r.status}`);
  assert.match(r.stderr + r.stdout, /brief/, "message must mention the --brief guard");
  s.cleanup();
});

console.log("3. launch-steward: missing required arg");
await t("missing --slug exits 2 with a usage line", async () => {
  const s = scratch();
  const r = runCli(["launch-steward", "--scope", "x", "--cwd", "/tmp", "--dry-run"], { env: s.env });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr + r.stdout, /usage|--slug/, "message must name --slug");
  s.cleanup();
});

console.log("4. launch-steward: idempotency");
await t("a second dry-run call with an existing manifest prints 'keep existing'", async () => {
  const s = scratch();
  // Seed the manifest so the existing-check fires.
  writeManifest(s.dir, "steward-demo");
  const r = runCli(
    ["launch-steward", "--slug", "demo", "--scope", "Demo scope", "--cwd", "/tmp", "--dry-run"],
    { env: s.env },
  );
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /keep.*existing|kept.*existing/i, "should report keeping the existing manifest");
  s.cleanup();
});

console.log("5. launch-concierge: role derivation");
await t("--human ryan derives role concierge-ryan, exits 0 in dry-run", async () => {
  const s = scratch();
  const r = runCli(
    ["launch-concierge", "--human", "ryan", "--cwd", "/tmp", "--dry-run"],
    { env: s.env },
  );
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /concierge-ryan/, "output should name the derived role");
  assert.equal(existsSync(join(s.dir, "roles", "concierge-ryan", "manifest.json")), false,
    "dry-run must not create the manifest file");
  s.cleanup();
});

await t("launch-concierge missing --human exits 2 with usage", async () => {
  const s = scratch();
  const r = runCli(["launch-concierge", "--cwd", "/tmp", "--dry-run"], { env: s.env });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr + r.stdout, /usage|--human/, "message must name --human");
  s.cleanup();
});

// ── Phase 2: activity and complete verbs ────────────────────────────────────

console.log("6. activity verb: writes merged activity");
await t("activity <role> --in-flight 2 --open-asks 1 --human-newer false merges into manifest", async () => {
  const s = scratch();
  writeManifest(s.dir, "steward-act", { activity: { inFlightTickets: 0 } });
  const r = runCli(
    ["activity", "steward-act", "--in-flight", "2", "--open-asks", "1", "--human-newer", "false"],
    { env: s.env },
  );
  assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
  const manifest = JSON.parse(readFileSync(join(s.dir, "roles", "steward-act", "manifest.json"), "utf8"));
  assert.equal(manifest.activity.inFlightTickets, 2, "inFlightTickets should be updated");
  assert.equal(manifest.activity.openAsksRaised, 1, "openAsksRaised should be updated");
  assert.equal(manifest.activity.humanCommentNewerThanLastReply, false, "humanCommentNewerThanLastReply should be false");
  // Must not clobber other manifest fields.
  assert.equal(manifest.scope, "test", "activity update must not clobber unrelated manifest fields");
  s.cleanup();
});

console.log("7. complete verb: marks scope done");
await t("complete <role> zeroes activity and sets scope_active:false", async () => {
  const s = scratch();
  writeManifest(s.dir, "steward-done", { activity: { inFlightTickets: 3 }, scope_active: true });
  const r = runCli(["complete", "steward-done"], { env: s.env });
  assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
  const manifest = JSON.parse(readFileSync(join(s.dir, "roles", "steward-done", "manifest.json"), "utf8"));
  assert.equal(manifest.scope_active, false, "scope_active must be false after complete");
  assert.equal(manifest.activity.inFlightTickets ?? 0, 0, "inFlightTickets must be zeroed");
  assert.equal(manifest.activity.openAsksRaised ?? 0, 0, "openAsksRaised must be zeroed");
  assert.equal(manifest.activity.humanCommentNewerThanLastReply ?? false, false);
  s.cleanup();
});

// ── default: unknown verb ───────────────────────────────────────────────────
console.log("8. usage includes the new verbs");
await t("unknown verb prints usage that names launch-steward and launch-concierge", async () => {
  const r = runCli(["unknown-verb-xyz"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr + r.stdout, /launch-steward/, "usage must name launch-steward");
  assert.match(r.stderr + r.stdout, /launch-concierge/, "usage must name launch-concierge");
});

console.log(`\ncli.test.mjs: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
