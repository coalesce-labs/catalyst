#!/usr/bin/env node
// node-roster.mjs — cluster ENROLLMENT channel (CTL-1273).
//
// The fleet roster — who BELONGS to the cluster — lives in ONE place: the Linear
// "cluster anchor" issue (the coordination substrate the orchestrator already
// requires). Each enrolled node is a PERSISTENT attachment `catalyst://node/<name>`
// carrying { name, address }. This is the single source of truth: the daemon
// READS it to resolve its roster, and `catalyst cluster add/remove` WRITES it —
// reader and writer share one anchor, so divergence is structurally impossible
// (the bug the per-repo hosts.json caused).
//
// Distinct from cluster-heartbeat.mjs (liveness/TRANSIENT `catalyst://heartbeat/<host>`
// records): enrollment is persistent, so the roster knows OFFLINE nodes' names +
// addresses (needed for deterministic HRW re-homing). Kept as a SEPARATE module
// so the two concerns never entangle.
//
// Pure + injectable (the `post` seam; no cross-module imports beyond Node
// builtins), exactly like cluster-heartbeat.mjs, so it is PR-order-independent and
// every test injects a fake GraphQL client (no real network / linearis in the
// hot path).
//
// FAIL-OPEN contract: readNodeRoster NEVER throws — a Linear read error returns
// {}. The roster resolver in config.mjs treats {} as "anchor unreadable" and
// falls back to the next source (static → hosts.json → single-host), so a Linear
// hiccup can never silently empty the roster and mass-evict the fleet.
//
// Shared GraphQL constants (RESOLVE_ISSUE_QUERY, READ_ATTACHMENTS_QUERY,
// WRITE_ATTACHMENT_MUTATION, defaultPost, authHeader, resolveIssueId) mirror
// cluster-heartbeat.mjs per the no-cross-module-import rule: each lib stays pure
// and PR-order-independent.

const NODE_URL_PREFIX = "catalyst://node/";
const NODE_ATTACHMENT_TITLE = "catalyst-node";
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export { NODE_URL_PREFIX };

// nodeUrl — the per-node enrollment attachment url; the unique key Linear
// upserts on.
export function nodeUrl(name) {
  return `${NODE_URL_PREFIX}${name}`;
}

// authHeader — mirror cluster-heartbeat.mjs (keep local, PR-order-independent).
export function authHeader(token = "") {
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

// defaultPost — the production GraphQL POST. Injectable via `post` on every
// public function so tests never touch the network.
async function defaultPost(query, variables) {
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  const res = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(token),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`linear graphql http ${res.status}`);
  const json = await res.json();
  if (json?.errors) throw new Error(`linear graphql errors: ${JSON.stringify(json.errors)}`);
  return json?.data ?? {};
}

// ─── identifier → issue UUID ─────────────────────────────────────────────────

// CTL-1255: resolve via issue(id:), which accepts the human identifier ("CTL-1217")
// directly and returns the UUID. The previous issues(filter:{identifier}) form was
// a hard 400 (IssueFilter has no identifier field). See cluster-heartbeat.mjs.
const RESOLVE_ISSUE_QUERY = `query ResolveIssueId($id: String!) {
  issue(id: $id) { id }
}`;

export async function resolveIssueId(ticket, { post = defaultPost } = {}) {
  const data = await post(RESOLVE_ISSUE_QUERY, { id: ticket });
  return data?.issue?.id ?? null;
}

// ─── read ────────────────────────────────────────────────────────────────────

const READ_ATTACHMENTS_QUERY = `query ReadNodes($id: String!) {
  issue(id: $id) { attachments { nodes { id url metadata } } }
}`;

// parseNodeMetadata — normalise an attachment's metadata into the flat node
// record callers consume. `address` is normalised to a string or null.
// Exported for unit coverage.
export function parseNodeMetadata(metadata) {
  const m = metadata ?? {};
  const name = typeof m.name === "string" && m.name.length > 0 ? m.name : null;
  const address = typeof m.address === "string" && m.address.length > 0 ? m.address : null;
  return { name, address };
}

// readNodeRoster — read all `catalyst://node/*` enrollment attachments from the
// anchor issue. Returns { [name]: { name, address } }. FAIL-OPEN: a
// missing/erroring anchor yields {} (NOT a throw) — the resolver treats {} as
// "fall back to the next source" so a Linear hiccup never mass-evicts the fleet.
export async function readNodeRoster({ anchorIssue }, { post = defaultPost } = {}) {
  let data;
  try {
    data = await post(READ_ATTACHMENTS_QUERY, { id: anchorIssue });
  } catch {
    return {};
  }
  const nodes = data?.issue?.attachments?.nodes ?? [];
  const out = {};
  for (const n of nodes) {
    if (typeof n?.url !== "string" || !n.url.startsWith(NODE_URL_PREFIX)) continue;
    const rec = parseNodeMetadata(n.metadata);
    if (rec.name) out[rec.name] = rec;
  }
  return out;
}

// readNodeNames — the roster as a sorted, deterministic array of node names.
// The shape getClusterHosts() consumes. FAIL-OPEN ⇒ [] on any error.
export async function readNodeNames({ anchorIssue }, { post = defaultPost } = {}) {
  const map = await readNodeRoster({ anchorIssue }, { post });
  return Object.keys(map).sort();
}

// ─── write / upsert ──────────────────────────────────────────────────────────

const WRITE_ATTACHMENT_MUTATION = `mutation UpsertNode($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id url metadata } }
}`;

// registerNode — upsert the `catalyst://node/<name>` enrollment attachment on the
// anchor issue. Single-writer (the operator's CLI) ⇒ no CAS, just upsert. Mirrors
// publishHeartbeat. Returns the parsed node record written; throws on a
// resolution miss or success:false (the CLI surfaces the error).
export async function registerNode(
  { anchorIssue, name, address = null },
  { post = defaultPost } = {}
) {
  if (!name) throw new Error("node-roster: registerNode requires a name");
  const issueId = await resolveIssueId(anchorIssue, { post });
  if (!issueId) throw new Error(`node-roster: no issue found for anchor ${anchorIssue}`);
  const metadata = { name, address: address ?? null };
  const data = await post(WRITE_ATTACHMENT_MUTATION, {
    input: {
      issueId,
      title: NODE_ATTACHMENT_TITLE,
      url: nodeUrl(name),
      metadata,
    },
  });
  if (!data?.attachmentCreate?.success) {
    throw new Error(`node-roster: attachmentCreate success=false for ${name}`);
  }
  return parseNodeMetadata(metadata);
}

// ─── delete ────────────────────────────────────────────────────────────────

const DELETE_ATTACHMENT_MUTATION = `mutation DeleteNode($id: String!) {
  attachmentDelete(id: $id) { success }
}`;

// findNodeAttachmentId — read the anchor's attachments and return the id of the
// `catalyst://node/<name>` attachment, or null when absent. Internal helper for
// deregisterNode (Linear deletes attachments by their UUID, not by url).
async function findNodeAttachmentId(anchorIssue, name, post) {
  const data = await post(READ_ATTACHMENTS_QUERY, { id: anchorIssue });
  const nodes = data?.issue?.attachments?.nodes ?? [];
  const target = nodeUrl(name);
  for (const n of nodes) {
    if (n?.url === target && typeof n.id === "string") return n.id;
  }
  return null;
}

// deregisterNode — delete the `catalyst://node/<name>` enrollment attachment from
// the anchor issue. Returns { removed: true } when an attachment was deleted,
// { removed: false } when no matching attachment existed (idempotent remove).
// Throws on a delete that reports success:false. Mirrors registerNode's error
// surface so the CLI can report it.
export async function deregisterNode({ anchorIssue, name }, { post = defaultPost } = {}) {
  if (!name) throw new Error("node-roster: deregisterNode requires a name");
  const id = await findNodeAttachmentId(anchorIssue, name, post);
  if (!id) return { removed: false };
  const data = await post(DELETE_ATTACHMENT_MUTATION, { id });
  if (!data?.attachmentDelete?.success) {
    throw new Error(`node-roster: attachmentDelete success=false for ${name}`);
  }
  return { removed: true };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// A thin argv shim so a SYNCHRONOUS caller (config.mjs / cli/cluster.mjs) can
// drive these async functions through spawnSync — the same convention
// cluster-heartbeat.mjs uses (node-roster-sync.mjs is the in-process wrapper).
//
//   read <anchor>                       → stdout JSON map { name: {name,address} }; exit 0
//   names <anchor>                      → stdout JSON array of sorted names; exit 0
//   register <anchor> <name> [address]  → stdout JSON record; exit 0
//   deregister <anchor> <name>          → stdout JSON { removed }; exit 0
export async function runCli(argv, { post = defaultPost } = {}) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "read": {
      const [anchor] = rest;
      const map = await readNodeRoster({ anchorIssue: anchor }, { post });
      process.stdout.write(JSON.stringify(map) + "\n");
      return 0;
    }
    case "names": {
      const [anchor] = rest;
      const names = await readNodeNames({ anchorIssue: anchor }, { post });
      process.stdout.write(JSON.stringify(names) + "\n");
      return 0;
    }
    case "register": {
      const [anchor, name, address] = rest;
      const rec = await registerNode(
        { anchorIssue: anchor, name, address: address || null },
        { post }
      );
      process.stdout.write(JSON.stringify(rec) + "\n");
      return 0;
    }
    case "deregister": {
      const [anchor, name] = rest;
      const res = await deregisterNode({ anchorIssue: anchor, name }, { post });
      process.stdout.write(JSON.stringify(res) + "\n");
      return 0;
    }
    default:
      process.stderr.write(
        `node-roster.mjs: unknown subcommand: ${cmd ?? "(none)"}\n` +
          "usage: node-roster.mjs <read <anchor> | names <anchor> | " +
          "register <anchor> <name> [address] | deregister <anchor> <name>>\n"
      );
      return 1;
  }
}

function isMain() {
  return (
    process.argv[1] &&
    (process.argv[1].endsWith("/node-roster.mjs") || process.argv[1].endsWith("node-roster.mjs"))
  );
}

if (isMain()) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`node-roster.mjs: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
