import { describe, it, expect } from "bun:test";
import {
  createWebhookSubscriber,
  DEFAULT_WEBHOOK_EVENTS,
  type SubscriberRunner,
  type SubscriberRunnerResult,
} from "../lib/webhook-subscriber";

const SMEE = "https://smee.io/test-channel";
const SECRET = "s3cret";

function recordRunner(
  responses: (args: string[]) => SubscriberRunnerResult,
): { runner: SubscriberRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: SubscriberRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve(responses(args));
  };
  return { runner, calls };
}

describe("createWebhookSubscriber", () => {
  it("creates a hook when none exists for the repo", async () => {
    const { runner, calls } = recordRunner((args) => {
      // GET hooks → empty list
      if (args.includes("repos/owner/repo/hooks") && !args.includes("-X")) {
        return { stdout: "[]", ok: true };
      }
      // POST → returns hook with id
      return { stdout: '{"id":777}', ok: true };
    });
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await sub.ensureSubscribed("owner/repo");
    // Verify GET then POST
    expect(calls.length).toBe(2);
    const post = calls[1];
    expect(post).toContain("-X");
    expect(post).toContain("POST");
    expect(post).toContain("repos/owner/repo/hooks");
    expect(post).toContain(`config[url]=${SMEE}`);
    expect(post).toContain(`config[secret]=${SECRET}`);
    expect(post).toContain("events[]=pull_request");
    expect(sub.listSubscribed()).toEqual([
      { repo: "owner/repo", hookId: 777 },
    ]);
  });

  it("reuses an existing matching hook (no POST) when events match", async () => {
    const { runner, calls } = recordRunner(() => ({
      stdout: JSON.stringify([
        { id: 42, config: { url: SMEE }, events: ["pull_request"] },
        { id: 99, config: { url: "https://example.com/other" }, events: [] },
      ]),
      ok: true,
    }));
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await sub.ensureSubscribed("owner/repo");
    expect(calls.length).toBe(1);
    expect(sub.listSubscribed()).toEqual([
      { repo: "owner/repo", hookId: 42 },
    ]);
  });

  it("matches existing hook URL case-insensitively", async () => {
    const { runner, calls } = recordRunner(() => ({
      stdout: JSON.stringify([
        { id: 5, config: { url: SMEE.toUpperCase() }, events: ["pull_request"] },
      ]),
      ok: true,
    }));
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await sub.ensureSubscribed("o/r");
    expect(calls.length).toBe(1);
    expect(sub.listSubscribed()[0]?.hookId).toBe(5);
  });

  it("dedupes concurrent calls for the same repo", async () => {
    let listCalls = 0;
    let postCalls = 0;
    const runner: SubscriberRunner = (args) => {
      const isList =
        args.includes("repos/owner/repo/hooks") && !args.includes("-X");
      if (isList) {
        listCalls++;
        return new Promise<SubscriberRunnerResult>((resolve) =>
          setTimeout(() => resolve({ stdout: "[]", ok: true }), 10),
        );
      }
      postCalls++;
      return Promise.resolve({ stdout: '{"id":1}', ok: true });
    };
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await Promise.all([
      sub.ensureSubscribed("owner/repo"),
      sub.ensureSubscribed("owner/repo"),
      sub.ensureSubscribed("owner/repo"),
    ]);
    expect(listCalls).toBe(1);
    expect(postCalls).toBe(1);
  });

  it("caches successful subscription so repeat calls are no-ops", async () => {
    const { runner, calls } = recordRunner((args) => {
      const isList =
        args.includes("repos/owner/repo/hooks") && !args.includes("-X");
      if (isList) return { stdout: "[]", ok: true };
      return { stdout: '{"id":1}', ok: true };
    });
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await sub.ensureSubscribed("owner/repo");
    const after1 = calls.length;
    await sub.ensureSubscribed("owner/repo");
    expect(calls.length).toBe(after1);
  });

  it("does not throw when gh subprocess fails on list", async () => {
    const { runner } = recordRunner(() => ({
      stdout: "",
      ok: false,
    }));
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    let threw = false;
    try {
      await sub.ensureSubscribed("o/r");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(sub.listSubscribed()).toEqual([]);
  });

  it("does not throw when gh fails on POST", async () => {
    const runner: SubscriberRunner = (args) => {
      const isList =
        args.includes("repos/o/r/hooks") && !args.includes("-X");
      if (isList) return Promise.resolve({ stdout: "[]", ok: true });
      return Promise.resolve({ stdout: "", ok: false });
    };
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await sub.ensureSubscribed("o/r");
    expect(sub.listSubscribed()).toEqual([]);
  });

  it("subscribes to all events from DEFAULT_WEBHOOK_EVENTS", async () => {
    const { runner, calls } = recordRunner((args) => {
      const isList =
        args.includes("repos/o/r/hooks") && !args.includes("-X");
      if (isList) return { stdout: "[]", ok: true };
      return { stdout: '{"id":1}', ok: true };
    });
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: [...DEFAULT_WEBHOOK_EVENTS],
      runner,
    });
    await sub.ensureSubscribed("o/r");
    const post = calls[1];
    for (const evt of DEFAULT_WEBHOOK_EVENTS) {
      expect(post).toContain(`events[]=${evt}`);
    }
  });

  it("logs both reuse and create paths", async () => {
    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(`info:${m}`),
      warn: (m: string) => logs.push(`warn:${m}`),
      error: (m: string) => logs.push(`error:${m}`),
    };
    // Reuse path
    const reuseRunner: SubscriberRunner = () =>
      Promise.resolve({
        stdout: JSON.stringify([
          { id: 11, config: { url: SMEE }, events: ["pull_request"] },
        ]),
        ok: true,
      });
    const sub1 = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner: reuseRunner,
      logger,
    });
    await sub1.ensureSubscribed("a/b");
    expect(logs.some((l) => l.startsWith("info:") && l.includes("reusing"))).toBe(true);

    // Create path
    logs.length = 0;
    const createRunner: SubscriberRunner = (args) => {
      const isList =
        args.includes("repos/a/b/hooks") && !args.includes("-X");
      if (isList) return Promise.resolve({ stdout: "[]", ok: true });
      return Promise.resolve({ stdout: '{"id":22}', ok: true });
    };
    const sub2 = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner: createRunner,
      logger,
    });
    await sub2.ensureSubscribed("a/b");
    expect(
      logs.some((l) => l.startsWith("info:") && l.includes("subscribed")),
    ).toBe(true);
  });

  // CTL-226: existing webhooks must auto-upgrade when DEFAULT_WEBHOOK_EVENTS
  // grows. Without this, hooks created against the old list (e.g. before
  // `release` was added) silently never deliver the new event types.
  it("PATCHes existing hook when its events list is missing required types", async () => {
    const calls: string[][] = [];
    const runner: SubscriberRunner = (args) => {
      calls.push([...args]);
      const isList =
        args.includes("repos/o/r/hooks") &&
        !args.includes("-X") &&
        !args.some((a) => /\/hooks\/\d+/.test(a));
      if (isList) {
        return Promise.resolve({
          stdout: JSON.stringify([
            // existing hook missing the new "release" event
            {
              id: 7,
              config: { url: SMEE },
              events: ["pull_request", "check_suite"],
            },
          ]),
          ok: true,
        });
      }
      // PATCH response
      return Promise.resolve({ stdout: '{"id":7}', ok: true });
    };
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request", "check_suite", "release"],
      runner,
    });
    await sub.ensureSubscribed("o/r");
    expect(calls.length).toBe(2);
    const patch = calls[1];
    expect(patch).toContain("-X");
    expect(patch).toContain("PATCH");
    expect(patch).toContain("repos/o/r/hooks/7");
    expect(patch).toContain("events[]=pull_request");
    expect(patch).toContain("events[]=check_suite");
    expect(patch).toContain("events[]=release");
    expect(sub.listSubscribed()).toEqual([{ repo: "o/r", hookId: 7 }]);
  });

  it("does NOT PATCH when existing hook events match exactly", async () => {
    const { runner, calls } = recordRunner(() => ({
      stdout: JSON.stringify([
        {
          id: 7,
          config: { url: SMEE },
          events: ["pull_request", "release"],
        },
      ]),
      ok: true,
    }));
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      // Order differs from the existing hook — must still be a match.
      events: ["release", "pull_request"],
      runner,
    });
    await sub.ensureSubscribed("o/r");
    expect(calls.length).toBe(1);
  });

  it("PATCHes when existing hook has an extra unwanted event", async () => {
    const calls: string[][] = [];
    const runner: SubscriberRunner = (args) => {
      calls.push([...args]);
      const isList =
        args.includes("repos/o/r/hooks") &&
        !args.includes("-X") &&
        !args.some((a) => /\/hooks\/\d+/.test(a));
      if (isList) {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              id: 9,
              config: { url: SMEE },
              events: ["pull_request", "deprecated_event"],
            },
          ]),
          ok: true,
        });
      }
      return Promise.resolve({ stdout: '{"id":9}', ok: true });
    };
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await sub.ensureSubscribed("o/r");
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain("PATCH");
  });

  it("PATCH failure is non-fatal and still caches the hook", async () => {
    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(`info:${m}`),
      warn: (m: string) => logs.push(`warn:${m}`),
      error: (m: string) => logs.push(`error:${m}`),
    };
    let listCount = 0;
    const runner: SubscriberRunner = (args) => {
      const isList =
        args.includes("repos/o/r/hooks") &&
        !args.includes("-X") &&
        !args.some((a) => /\/hooks\/\d+/.test(a));
      if (isList) {
        listCount++;
        return Promise.resolve({
          stdout: JSON.stringify([
            { id: 5, config: { url: SMEE }, events: ["pull_request"] },
          ]),
          ok: true,
        });
      }
      // PATCH fails
      return Promise.resolve({ stdout: "", ok: false });
    };
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request", "release"],
      runner,
      logger,
    });
    await sub.ensureSubscribed("o/r");
    expect(listCount).toBe(1);
    expect(sub.listSubscribed()).toEqual([{ repo: "o/r", hookId: 5 }]);
    expect(
      logs.some((l) => l.startsWith("warn:") && l.includes("upgrade events")),
    ).toBe(true);
  });

  it("treats existing hook with no events array as stale (PATCHes)", async () => {
    const calls: string[][] = [];
    const runner: SubscriberRunner = (args) => {
      calls.push([...args]);
      const isList =
        args.includes("repos/o/r/hooks") &&
        !args.includes("-X") &&
        !args.some((a) => /\/hooks\/\d+/.test(a));
      if (isList) {
        return Promise.resolve({
          stdout: JSON.stringify([{ id: 12, config: { url: SMEE } }]),
          ok: true,
        });
      }
      return Promise.resolve({ stdout: '{"id":12}', ok: true });
    };
    const sub = createWebhookSubscriber({
      smeeChannel: SMEE,
      secret: SECRET,
      events: ["pull_request"],
      runner,
    });
    await sub.ensureSubscribed("o/r");
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain("PATCH");
  });

  // CTL-226: pin the new event-type entries in DEFAULT_WEBHOOK_EVENTS so a
  // future accidental removal fails the test rather than silently regresses.
  it("DEFAULT_WEBHOOK_EVENTS includes release and workflow_run", () => {
    expect(DEFAULT_WEBHOOK_EVENTS).toContain("release");
    expect(DEFAULT_WEBHOOK_EVENTS).toContain("workflow_run");
    expect(DEFAULT_WEBHOOK_EVENTS).toContain("deployment_status");
  });
});
