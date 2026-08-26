// neutral-schema.test.mjs — CTL-1461 Phase 1.
//
// Run: bun test scripts/packaging/__tests__/neutral-schema.test.mjs
//
// One fixture per axis the code branches on (effects / invocation / exposure
// × missing / unknown-value), each with a mutation control proving the good
// fixture passes and the specific bad fixture fails for the reason claimed.

import { describe, test, expect } from "bun:test";

import { EFFECTS, MUTATING_EFFECTS, EXPOSURES, INVOCATIONS, validateNeutralDeclaration } from "../core/neutral-schema.mjs";

function goodDecl() {
  return { effects: [], invocation: "auto", exposure: ["catalog"] };
}

describe("closed vocabularies — exported and correctly shaped", () => {
  test("EFFECTS is the four-member set", () => {
    expect([...EFFECTS].sort()).toEqual(["file-read", "file-write", "network", "shell-exec"]);
  });
  test("MUTATING_EFFECTS is exactly the pair that drives the invocation-parity rule", () => {
    expect([...MUTATING_EFFECTS].sort()).toEqual(["file-write", "shell-exec"]);
  });
  test("EXPOSURES is catalog/internal", () => {
    expect([...EXPOSURES].sort()).toEqual(["catalog", "internal"]);
  });
  test("INVOCATIONS is explicit/auto", () => {
    expect([...INVOCATIONS].sort()).toEqual(["auto", "explicit"]);
  });
});

describe("validateNeutralDeclaration — the good fixture passes (positive control)", () => {
  test("does not throw", () => {
    expect(() => validateNeutralDeclaration(goodDecl(), "test.yaml")).not.toThrow();
  });
});

describe("validateNeutralDeclaration — not an object", () => {
  for (const bad of [null, undefined, "x", 1, ["a"]]) {
    test(`${JSON.stringify(bad)} throws`, () => {
      expect(() => validateNeutralDeclaration(bad, "test.yaml")).toThrow(/must be an object/);
    });
  }
});

describe("validateNeutralDeclaration — unknown key", () => {
  test("an extra key is rejected, naming the key and the file", () => {
    const decl = { ...goodDecl(), bogus: true };
    expect(() => validateNeutralDeclaration(decl, "test.yaml")).toThrow(/bogus/);
    try {
      validateNeutralDeclaration(decl, "test.yaml");
    } catch (err) {
      expect(String(err.message)).toContain("test.yaml");
      expect(String(err.message)).toContain("bogus");
    }
  });
});

describe("validateNeutralDeclaration — effects axis", () => {
  test("missing effects is an error", () => {
    const decl = goodDecl();
    delete decl.effects;
    expect(() => validateNeutralDeclaration(decl, "test.yaml")).toThrow(/effects/);
  });

  test("effects present but not an array is an error", () => {
    expect(() => validateNeutralDeclaration({ ...goodDecl(), effects: "file-read" }, "test.yaml")).toThrow(/effects/);
  });

  test("an out-of-set effect value is rejected, naming the value and the accepted set", () => {
    const decl = { ...goodDecl(), effects: ["teleport"] };
    expect(() => validateNeutralDeclaration(decl, "test.yaml")).toThrow(/teleport/);
    try {
      validateNeutralDeclaration(decl, "test.yaml");
    } catch (err) {
      expect(String(err.message)).toContain("teleport");
      for (const effect of EFFECTS) expect(String(err.message)).toContain(effect);
    }
  });

  test("every real effect value is individually accepted (mutation control: the good fixture must actually pass for each)", () => {
    for (const effect of EFFECTS) {
      expect(() => validateNeutralDeclaration({ ...goodDecl(), effects: [effect] }, "test.yaml")).not.toThrow();
    }
  });
});

describe("validateNeutralDeclaration — invocation axis", () => {
  test("missing invocation is an error", () => {
    const decl = goodDecl();
    delete decl.invocation;
    expect(() => validateNeutralDeclaration(decl, "test.yaml")).toThrow(/invocation/);
  });

  test("an out-of-set invocation value is rejected, naming the accepted set", () => {
    const decl = { ...goodDecl(), invocation: "sometimes" };
    expect(() => validateNeutralDeclaration(decl, "test.yaml")).toThrow(/invocation/);
    try {
      validateNeutralDeclaration(decl, "test.yaml");
    } catch (err) {
      expect(String(err.message)).toContain("explicit");
      expect(String(err.message)).toContain("auto");
    }
  });

  test("both real invocation values are individually accepted", () => {
    for (const invocation of INVOCATIONS) {
      expect(() => validateNeutralDeclaration({ ...goodDecl(), invocation }, "test.yaml")).not.toThrow();
    }
  });
});

describe("validateNeutralDeclaration — exposure axis", () => {
  test("missing exposure is an error", () => {
    const decl = goodDecl();
    delete decl.exposure;
    expect(() => validateNeutralDeclaration(decl, "test.yaml")).toThrow(/exposure/);
  });

  test("an empty exposure array is an error (a half-declaration is worse than none)", () => {
    expect(() => validateNeutralDeclaration({ ...goodDecl(), exposure: [] }, "test.yaml")).toThrow(/exposure/);
  });

  test("an out-of-set exposure value is rejected, naming the accepted set", () => {
    const decl = { ...goodDecl(), exposure: ["public"] };
    expect(() => validateNeutralDeclaration(decl, "test.yaml")).toThrow(/public/);
    try {
      validateNeutralDeclaration(decl, "test.yaml");
    } catch (err) {
      expect(String(err.message)).toContain("catalog");
      expect(String(err.message)).toContain("internal");
    }
  });

  test("both real exposure values are individually accepted", () => {
    for (const exposure of EXPOSURES) {
      expect(() => validateNeutralDeclaration({ ...goodDecl(), exposure: [exposure] }, "test.yaml")).not.toThrow();
    }
  });
});
