import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadDeployConfig, DEPLOY_DEFAULTS } from "../lib/deploy-config";

let tmpDir: string;
let projectConfigPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "deploy-config-test-"));
  mkdirSync(tmpDir, { recursive: true });
  projectConfigPath = join(tmpDir, "config.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeProject(json: object): void {
  writeFileSync(projectConfigPath, JSON.stringify(json));
}

describe("loadDeployConfig", () => {
  it("returns sensible defaults when no config file exists", () => {
    const cfg = loadDeployConfig("unknown/repo", "/nonexistent/path.json");
    expect(cfg).toEqual({
      timeoutSec: DEPLOY_DEFAULTS.timeoutSec,
      productionEnvironment: DEPLOY_DEFAULTS.productionEnvironment,
      stagingEnvironment: DEPLOY_DEFAULTS.stagingEnvironment,
      skipDeployVerification: DEPLOY_DEFAULTS.skipDeployVerification,
    });
  });

  it("returns defaults when config file has no catalyst.deploy section", () => {
    writeProject({ catalyst: { project: { ticketPrefix: "PROJ" } } });
    const cfg = loadDeployConfig("any/repo", projectConfigPath);
    expect(cfg).toEqual({
      timeoutSec: DEPLOY_DEFAULTS.timeoutSec,
      productionEnvironment: DEPLOY_DEFAULTS.productionEnvironment,
      stagingEnvironment: DEPLOY_DEFAULTS.stagingEnvironment,
      skipDeployVerification: DEPLOY_DEFAULTS.skipDeployVerification,
    });
  });

  it("reads per-repo overrides from catalyst.deploy.<repo>", () => {
    writeProject({
      catalyst: {
        deploy: {
          "coalesce-labs/adva": {
            timeoutSec: 3600,
            productionEnvironment: "prod",
            stagingEnvironment: "staging",
            skipDeployVerification: false,
          },
        },
      },
    });
    const cfg = loadDeployConfig("coalesce-labs/adva", projectConfigPath);
    expect(cfg.timeoutSec).toBe(3600);
    expect(cfg.productionEnvironment).toBe("prod");
    expect(cfg.skipDeployVerification).toBe(false);
  });

  it("falls back to defaults for repos not listed in config", () => {
    writeProject({
      catalyst: {
        deploy: {
          "coalesce-labs/adva": { timeoutSec: 3600, skipDeployVerification: false },
        },
      },
    });
    const cfg = loadDeployConfig("some/other-repo", projectConfigPath);
    expect(cfg.timeoutSec).toBe(DEPLOY_DEFAULTS.timeoutSec);
    expect(cfg.skipDeployVerification).toBe(DEPLOY_DEFAULTS.skipDeployVerification);
  });

  it("merges partial per-repo overrides with defaults (only timeoutSec set)", () => {
    writeProject({
      catalyst: {
        deploy: {
          "coalesce-labs/catalyst": { timeoutSec: 600 },
        },
      },
    });
    const cfg = loadDeployConfig("coalesce-labs/catalyst", projectConfigPath);
    expect(cfg.timeoutSec).toBe(600);
    expect(cfg.productionEnvironment).toBe(DEPLOY_DEFAULTS.productionEnvironment);
    expect(cfg.skipDeployVerification).toBe(DEPLOY_DEFAULTS.skipDeployVerification);
  });

  it("rejects non-positive integer timeoutSec and falls back to default", () => {
    writeProject({
      catalyst: {
        deploy: {
          "x/y": { timeoutSec: -5 },
        },
      },
    });
    const cfg = loadDeployConfig("x/y", projectConfigPath);
    expect(cfg.timeoutSec).toBe(DEPLOY_DEFAULTS.timeoutSec);
  });

  it("rejects non-integer timeoutSec (e.g. fractional) and falls back to default", () => {
    writeProject({
      catalyst: {
        deploy: {
          "x/y": { timeoutSec: 30.5 },
        },
      },
    });
    const cfg = loadDeployConfig("x/y", projectConfigPath);
    expect(cfg.timeoutSec).toBe(DEPLOY_DEFAULTS.timeoutSec);
  });

  it("rejects non-string productionEnvironment and falls back to default", () => {
    writeProject({
      catalyst: {
        deploy: {
          "x/y": { productionEnvironment: 123 },
        },
      },
    });
    const cfg = loadDeployConfig("x/y", projectConfigPath);
    expect(cfg.productionEnvironment).toBe(DEPLOY_DEFAULTS.productionEnvironment);
  });

  it("returns defaults gracefully when config file is malformed JSON", () => {
    writeFileSync(projectConfigPath, "{ this is not valid json");
    const cfg = loadDeployConfig("x/y", projectConfigPath);
    expect(cfg.timeoutSec).toBe(DEPLOY_DEFAULTS.timeoutSec);
  });

  it("repo lookup is exact-match (no glob)", () => {
    writeProject({
      catalyst: {
        deploy: {
          "ORG/REPO": { timeoutSec: 999 },
        },
      },
    });
    // case-sensitive — different from configured key
    const cfg = loadDeployConfig("org/repo", projectConfigPath);
    expect(cfg.timeoutSec).toBe(DEPLOY_DEFAULTS.timeoutSec);
  });

  it("default skipDeployVerification is true (today's behavior — most repos don't emit GitHub Deployments)", () => {
    expect(DEPLOY_DEFAULTS.skipDeployVerification).toBe(true);
  });
});
