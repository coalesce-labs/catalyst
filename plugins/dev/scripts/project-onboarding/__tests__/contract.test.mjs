import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SCHEMA_VERSION, normalizeOnboardingRequest } from "../contract.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("normalizes an explicit existing-team local request without mutating its input", () => {
  const request = fixture("local-existing-team");
  const original = structuredClone(request);
  request.vcsRepo = " coalesce-labs/catalyst ";
  request.projectKey = " CTL ";

  const normalized = normalizeOnboardingRequest(request);

  assert.equal(SCHEMA_VERSION, "1");
  assert.deepEqual(normalized, {
    schemaVersion: "1",
    vcsRepo: "coalesce-labs/catalyst",
    projectKey: "CTL",
    team: { intent: "existing", key: "CTL" },
    deploymentMode: "single-host",
    controller: { id: "mini-1", nodeClass: "worker" },
    targetPolicy: {
      targets: [{ id: "mini-1", nodeClass: "worker", online: true }],
      includeController: true,
      executionNodeClasses: ["worker"],
    },
  });
  assert.deepEqual(request, {
    ...original,
    vcsRepo: " coalesce-labs/catalyst ",
    projectKey: " CTL ",
  });
});

test("rejects every missing or ambiguous required request field", () => {
  const valid = fixture("local-existing-team");
  const invalidRequests = [
    { ...valid, vcsRepo: "" },
    { ...valid, vcsRepo: "coalesce-labs/catalyst/extra" },
    { ...valid, projectKey: "" },
    { ...valid, team: { intent: "unknown", key: "CTL" } },
    { ...valid, deploymentMode: "hybrid" },
    { ...valid, targetPolicy: undefined },
    { ...valid, targetPolicy: { ...valid.targetPolicy, targets: [] } },
  ];

  for (const request of invalidRequests) {
    assert.throws(() => normalizeOnboardingRequest(request), /required|valid|explicit/i);
  }
});

test("requires explicit confirmation before normalizing a create-team request", () => {
  const request = fixture("confirmed-create-team");
  const withoutConfirmation = structuredClone(request);
  delete withoutConfirmation.team.confirmed;

  assert.throws(() => normalizeOnboardingRequest(withoutConfirmation), /confirmed/i);
  assert.deepEqual(normalizeOnboardingRequest(request).team, {
    intent: "create",
    key: "NEW",
    confirmed: true,
  });
});

test("normalizes target IDs in locale-independent code-unit order for every input permutation", () => {
  const request = fixture("locale-sensitive-targets");
  const reversed = {
    ...request,
    targetPolicy: { ...request.targetPolicy, targets: [...request.targetPolicy.targets].reverse() },
  };

  const normalized = normalizeOnboardingRequest(request);
  const reversedNormalized = normalizeOnboardingRequest(reversed);

  assert.deepEqual(
    normalized.targetPolicy.targets.map(({ id }) => id),
    ["I", "i", "z", "ä", "İ", "ı"]
  );
  assert.equal(JSON.stringify(normalized), JSON.stringify(reversedNormalized));
});

test("contract remains a pure module with no adapter or host capability imports", () => {
  const source = readFileSync(fileURLToPath(new URL("../contract.mjs", import.meta.url)), "utf8");

  assert.doesNotMatch(
    source,
    /from\s+["'](?:node:(?:fs|child_process|http|https)|[^"']*(?:adapter|provider|config|http-client)[^"']*)["']/i
  );
});
