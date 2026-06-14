import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import {
  formatTime,
  formatDateTime,
  formatRepo,
  formatSource,
  formatIcon,
  formatEvent,
  formatRef,
  formatDetails,
  formatDetailBody,
  shouldSkipEvent,
} from "../cli/lib/format.ts";
import { _resetNerdFontCacheForTesting } from "../cli/lib/nerd-font.ts";

// CTL-355: this test file asserts the pure label/text contracts of the
// formatters. Pin CATALYST_NERD_FONT=0 across the whole suite so the icon
// prefix added in CTL-355 doesn't leak into the bare-label assertions; the
// icon path is exercised separately in nerd-font.test.ts and the in-file
// "CTL-355 Nerd Font enabled" describe block at the bottom.
const _prevEnv = process.env.CATALYST_NERD_FONT;
beforeAll(() => {
  process.env.CATALYST_NERD_FONT = "0";
  _resetNerdFontCacheForTesting();
});
afterAll(() => {
  if (_prevEnv === undefined) delete process.env.CATALYST_NERD_FONT;
  else process.env.CATALYST_NERD_FONT = _prevEnv;
  _resetNerdFontCacheForTesting();
});

const baseEvent: CanonicalEvent = {
  ts: "2026-05-08T07:23:01.000Z",
  id: "00000000-0000-4000-8000-000000000000",
  severityText: "INFO",
  severityNumber: 9,
  traceId: "abc123def456abc123def456abc123de",
  spanId: "abc123de456abc12",
  resource: {
    "service.name": "github-webhook",
    "service.namespace": "catalyst",
    "service.version": "8.2.0",
    "host.name": "test-host",
    "host.id": "0000000000000000",
  },
  attributes: {
    "event.name": "github.pr.merged",
    "vcs.repository.name": "coalesce-labs/catalyst",
    "vcs.pr.number": 501,
  },
  body: { message: "PR merged", payload: {} },
};

describe("formatTime", () => {
  test("formats ISO ts as HH:MM:SS", () => {
    const result = formatTime(baseEvent);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("formatDateTime", () => {
  test("formats ISO ts as YYYY-MM-DD HH:MM:SS", () => {
    const result = formatDateTime(baseEvent);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test("is always 19 characters", () => {
    expect(formatDateTime(baseEvent).length).toBe(19);
  });

  test("uses 24h time and never emits AM/PM", () => {
    const evening = { ...baseEvent, ts: "2026-05-11T23:51:07.000Z" };
    const result = formatDateTime(evening);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(result).not.toMatch(/AM|PM/i);
  });
});

describe("formatRepo", () => {
  test("strips org prefix from repository name", () => {
    expect(formatRepo(baseEvent)).toBe("catalyst");
  });

  test("returns repo as-is when no slash", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "vcs.repository.name": "myrepo" } };
    expect(formatRepo(e)).toBe("myrepo");
  });

  test("returns empty string when no vcs.repository.name", () => {
    const e = { ...baseEvent, attributes: { "event.name": "heartbeat" } } as unknown as CanonicalEvent;
    expect(formatRepo(e)).toBe("");
  });

  test("falls back to linear.team.key for linear events without vcs.repository.name", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "linear.issue.updated", "linear.team.key": "CTL" },
    } as unknown as CanonicalEvent;
    expect(formatRepo(e)).toBe("CTL");
  });

  test("prefers vcs.repository.name over linear.team.key when both present", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "linear.issue.updated",
        "vcs.repository.name": "coalesce-labs/catalyst",
        "linear.team.key": "CTL",
      },
    } as unknown as CanonicalEvent;
    expect(formatRepo(e)).toBe("catalyst");
  });
});

describe("formatSource", () => {
  test("maps github events to 'github'", () => {
    expect(formatSource(baseEvent)).toBe("github");
  });

  test("maps comms.message.posted to sender from event.label", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "comms.message.posted",
        "catalyst.event.label": "CTL-330",
        "catalyst.worker.ticket": "CTL-330",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("CTL-330");
  });

  test("falls back to worker ticket when comms event has no label", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "comms.message.posted",
        "catalyst.worker.ticket": "CTL-330",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("CTL-330");
  });

  test("falls back to 'comms' when comms event has no label or worker", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "comms.message.posted" },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("comms");
  });

  test("maps linear events to 'linear'", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "event.name": "linear.issue.updated" } };
    expect(formatSource(e)).toBe("linear");
  });

  test("maps orchestrator events with orch+worker to orch/ticket format", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "orchestrator.worker.done",
        "catalyst.orchestrator.id": "orch-abc",
        "catalyst.worker.ticket": "CTL-312",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc/CTL-312");
  });

  test("maps orchestrator events with orch only", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "orchestrator.worker.done",
        "catalyst.orchestrator.id": "orch-abc",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc");
  });

  test("returns system for unknown events", () => {
    const e = { ...baseEvent, attributes: { "event.name": "some.unknown.event" } } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("system");
  });

  // CTL-331: filter events surface the orchestrator id when present so users
  // can correlate filter events back to a specific orchestrator run.
  test("maps filter.register with orchestrator id to that orch id", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "filter.register",
        "catalyst.orchestrator.id": "orch-abc",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc");
  });

  test("maps filter.register without orchestrator id to 'filter'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("filter");
  });

  test("maps legacy orchestrator.filter.register alias to the orchestrator id", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "orchestrator.filter.register",
        "catalyst.orchestrator.id": "orch-abc",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc");
  });

  // CTL-337: filter.wake events are always emitted by the broker, so the SOURCE
  // column shows "broker" regardless of which orchestrator the wake is routed to.
  test("maps filter.wake.* to 'broker'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.sess_x" },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("broker");
  });

  test("maps filter.wake.* to 'broker' even when orchestrator id is present", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "filter.wake.sess_x",
        "catalyst.orchestrator.id": "orch-abc",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("broker");
  });

  test("maps legacy orchestrator.filter.wake.* alias to 'broker'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.filter.wake.sess_x" },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("broker");
  });

  test("maps broker.daemon.startup to 'broker'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "broker.daemon.startup" },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("broker");
  });
});

// CTL-391: formatEvent now returns the raw `event.name` attribute verbatim.
// The pre-CTL-391 friendly-label table (merged, ci pass, wake, filter reg, …)
// is gone — operators asked to see the actual event name as emitted. The
// formatter never truncates; Ink's `wrap="truncate"` on the EVENT cell clips
// long names with an ellipsis at render time.
describe("formatEvent", () => {
  test("returns raw github.pr.merged verbatim", () => {
    expect(formatEvent(baseEvent)).toBe("github.pr.merged");
  });

  test("returns raw github.check_suite.completed regardless of conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_suite.completed",
        "cicd.pipeline.run.result": "failure",
      },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("github.check_suite.completed");
  });

  test("returns raw github.pr.opened verbatim", () => {
    const e = {
      ...baseEvent,
      attributes: { ...baseEvent.attributes, "event.name": "github.pr.opened" },
    };
    expect(formatEvent(e)).toBe("github.pr.opened");
  });

  test("does not truncate long event names (renderer clips, formatter does not)", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "github.pr_review_comment.created" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("github.pr_review_comment.created");
  });

  test("returns raw orchestrator.worker.done verbatim", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.worker.done" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("orchestrator.worker.done");
  });

  test("returns raw filter.register verbatim", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("filter.register");
  });

  test("returns raw filter.deregister verbatim", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.deregister" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("filter.deregister");
  });

  test("returns the full filter.wake.<sessionId> name (no shortening)", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.sess_20260511T203845_16d33281" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("filter.wake.sess_20260511T203845_16d33281");
  });

  test("returns raw broker.daemon.startup verbatim", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "broker.daemon.startup" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("broker.daemon.startup");
  });

  test("returns raw comms.message.posted verbatim regardless of payload type", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "comms.message.posted" },
      body: { payload: { type: "info", channel: "orch-demo", to: "all" } },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("comms.message.posted");
  });

  test("falls back to '(legacy)' when event.name attribute is missing", () => {
    const e = { ...baseEvent, attributes: {} } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("(legacy)");
  });
});

describe("formatRef", () => {
  test("formats PR number with # prefix", () => {
    expect(formatRef(baseEvent)).toBe("#501");
  });

  test("formats ticket identifier when no PR", () => {
    const e = {
      ...baseEvent,
      attributes: {
        ...baseEvent.attributes,
        "vcs.pr.number": undefined,
        "linear.issue.identifier": "CTL-312",
      },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("CTL-312");
  });

  test("formats branch with → prefix when no PR or ticket", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.push",
        "vcs.ref.name": "main",
      },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("→main");
  });

  test("returns empty string when no ref info", () => {
    const e = { ...baseEvent, attributes: { "event.name": "heartbeat" } } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("");
  });

  test("formats comms recipient with → prefix", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "comms.message.posted" },
      body: { payload: { type: "info", channel: "orch-demo", to: "CTL-330" } },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("→CTL-330");
  });

  test("formats comms broadcast recipient with → prefix", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "comms.message.posted" },
      body: { payload: { type: "info", channel: "orch-demo", to: "all" } },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("→all");
  });

  test("falls back to channel for comms when recipient is missing", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "comms.message.posted" },
      body: { payload: { type: "info", channel: "orch-demo" } },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("orch-demo");
  });

  test("returns empty string for comms with no recipient or channel", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "comms.message.posted" },
      body: { payload: {} },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("");
  });

  // CTL-337: filter.register events surface the tickets / repo being watched
  // so the REF column tells the user *what* the registration is observing.
  test("formats filter.register tickets array as comma-joined list", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: {
        payload: {
          prompt: "Wake me when…",
          context: { tickets: ["ADV-904", "ADV-905"], pr_numbers: [], branches: [] },
        },
      },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("ADV-904,ADV-905");
  });

  test("formats filter.register single ticket", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: { payload: { context: { tickets: ["CTL-337"] } } },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("CTL-337");
  });

  test("formats filter.register repo as basename when no tickets", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: {
        payload: {
          interest_id: "orch-abc-pr-lifecycle",
          interest_type: "pr_lifecycle",
          repo: "rightsite-cloud/Adva",
        },
      },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("Adva");
  });

  test("returns repo as-is for filter.register when it has no slash", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: { payload: { repo: "myrepo" } },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("myrepo");
  });

  test("falls back to existing behaviour when filter.register has no tickets or repo", () => {
    // Preserve the baseEvent vcs.pr.number so we can verify the filter.register
    // branch falls through to the PR fallback when its own context is empty.
    const e = {
      ...baseEvent,
      attributes: { ...baseEvent.attributes, "event.name": "filter.register" },
      body: { payload: {} },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("#501");
  });

  test("handles legacy orchestrator.filter.register tickets", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.filter.register" },
      body: { payload: { context: { tickets: ["ADV-878", "ADV-877"] } } },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("ADV-878,ADV-877");
  });
});

describe("formatRef (filter.wake)", () => {
  // CTL-348: filter.wake events route to a specific session/orchestrator id —
  // surface it in REF so the operator can tell whose wake fired.
  test("returns the session id stripped of the filter.wake. prefix", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("orch-foo");
  });

  test("handles the legacy orchestrator.filter.wake.* alias", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.filter.wake.orch-bar" },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("orch-bar");
  });
});

// Generic fallback event — does not match any specific handler added in CTL-418.
// Using orchestrator.worker.done so tests exercise the generic fallback path.
const genericEvent: CanonicalEvent = {
  ...baseEvent,
  attributes: { ...baseEvent.attributes, "event.name": "orchestrator.worker.done" },
};

describe("formatDetails", () => {
  test("returns payload title when present", () => {
    const e = { ...genericEvent, body: { message: "ignored", payload: { title: "feat: add thing" } } };
    expect(formatDetails(e)).toBe("feat: add thing");
  });

  test("returns message when no payload title", () => {
    const e = { ...genericEvent, body: { message: "Something happened", payload: {} } };
    expect(formatDetails(e)).toBe("Something happened");
  });

  test("returns long messages in full (scrollable detail pane handles overflow)", () => {
    const long = "x".repeat(100);
    const e = { ...genericEvent, body: { message: long } };
    expect(formatDetails(e)).toBe(long);
  });
});

describe("formatDetails (sanitizer)", () => {
  function withMessage(msg: string): CanonicalEvent {
    return { ...genericEvent, body: { message: msg, payload: {} } };
  }

  test("decodes named HTML entities", () => {
    expect(formatDetails(withMessage("foo&nbsp;bar"))).toBe("foo bar");
    expect(formatDetails(withMessage("a&amp;b"))).toBe("a&b");
    expect(formatDetails(withMessage("&lt;tag&gt;"))).toBe("<tag>");
    expect(formatDetails(withMessage("she said &quot;hi&quot;"))).toBe('she said "hi"');
    expect(formatDetails(withMessage("don&#39;t"))).toBe("don't");
    expect(formatDetails(withMessage("don&apos;t"))).toBe("don't");
  });

  test("decodes numeric HTML entities (decimal and hex)", () => {
    expect(formatDetails(withMessage("&#65;&#66;&#67;"))).toBe("ABC");
    expect(formatDetails(withMessage("&#x41;&#x42;"))).toBe("AB");
  });

  test("passes unknown entities through unchanged", () => {
    expect(formatDetails(withMessage("&notarealentity;x"))).toBe("&notarealentity;x");
  });

  test("extracts anchor text and drops href", () => {
    expect(formatDetails(withMessage('<a href="https://x">label</a>'))).toBe("label");
  });

  test("anchor extraction is case-insensitive", () => {
    expect(formatDetails(withMessage('<A HREF="X">CAPS</A>'))).toBe("CAPS");
  });

  test("anchor with surrounding text keeps surroundings", () => {
    expect(formatDetails(withMessage('see <a href="x">docs</a> for more'))).toBe(
      "see docs for more",
    );
  });

  test("image with alt becomes [alt]", () => {
    expect(formatDetails(withMessage('<img alt="caption" src="x">'))).toBe("[caption]");
  });

  test("image without alt becomes [image]", () => {
    expect(formatDetails(withMessage('<img src="x">'))).toBe("[image]");
  });

  test("self-closing image variants are stripped", () => {
    expect(formatDetails(withMessage('<img alt="ok" src="x" />'))).toBe("[ok]");
  });

  test("strips arbitrary HTML tags, keeps inner text", () => {
    expect(formatDetails(withMessage("<p>hi</p>"))).toBe("hi");
    expect(formatDetails(withMessage('<div class="x">inner</div>'))).toBe("inner");
    expect(formatDetails(withMessage("<span>a</span> <strong>b</strong>"))).toBe("a b");
    expect(formatDetails(withMessage("line1<br>line2"))).toBe("line1 line2");
  });

  test("strips ATX-style markdown headers", () => {
    expect(formatDetails(withMessage("## Title"))).toBe("Title");
    expect(formatDetails(withMessage("### Sub"))).toBe("Sub");
    expect(formatDetails(withMessage("# Heading"))).toBe("Heading");
  });

  test("strips bold and italic markers", () => {
    expect(formatDetails(withMessage("**bold**"))).toBe("bold");
    expect(formatDetails(withMessage("__bold__"))).toBe("bold");
    expect(formatDetails(withMessage("*em*"))).toBe("em");
    expect(formatDetails(withMessage("_em_"))).toBe("em");
    expect(formatDetails(withMessage("plain **bold** plain"))).toBe("plain bold plain");
  });

  test("does not eat snake_case identifiers", () => {
    expect(formatDetails(withMessage("some_snake_case_var"))).toBe("some_snake_case_var");
  });

  test("strips triple-backtick code fences keeping inner text", () => {
    expect(formatDetails(withMessage("```code block```"))).toBe("code block");
  });

  test("strips inline backticks keeping inner text", () => {
    expect(formatDetails(withMessage("call `foo()` here"))).toBe("call foo() here");
  });

  test("collapses newlines and runs of whitespace to single space", () => {
    expect(formatDetails(withMessage("a\nb\nc"))).toBe("a b c");
    expect(formatDetails(withMessage("a    b\t\tc"))).toBe("a b c");
    expect(formatDetails(withMessage("  hello  "))).toBe("hello");
  });

  test("renders the ticket's deployment example", () => {
    const input =
      '## Deploying catalyst with &nbsp;<a href="https://pages.dev"><img alt="Cloudflare Pages" src="x"></a> finished';
    expect(formatDetails(withMessage(input))).toBe(
      "Deploying catalyst with [Cloudflare Pages] finished",
    );
  });

  test("sanitizes payload.title", () => {
    const e = {
      ...genericEvent,
      body: { message: "ignored", payload: { title: "## <strong>feat</strong>: thing" } },
    };
    expect(formatDetails(e)).toBe("feat: thing");
  });

  test("sanitizes payload.body and truncates the raw input at 300 chars before cleanup", () => {
    const raw = "x".repeat(295) + "<p>tail</p>";
    const e = { ...genericEvent, body: { message: "", payload: { body: raw } } };
    const out = formatDetails(e);
    // First 295 'x', then sanitised slice of the rest within the 300-char raw window.
    expect(out.startsWith("x".repeat(295))).toBe(true);
    expect(out).not.toContain("<p>");
  });

  test("memoises by event reference (same instance → same string)", () => {
    const e = withMessage("<p>hello &amp; goodbye</p>");
    const first = formatDetails(e);
    const second = formatDetails(e);
    expect(first).toBe("hello & goodbye");
    expect(second).toBe(first);
  });

  test("returns empty string when body is missing", () => {
    const e = { ...genericEvent, body: undefined } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("");
  });
});

describe("formatDetails (filter.register)", () => {
  // CTL-337: filter.register events surface human-readable criteria so the
  // DETAILS column tells the user *why* the registration was made.
  test("returns sanitised prompt when present", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: {
        message: "ignored",
        payload: {
          prompt: "Wake me when: any of my workers posts a comms message of type attention",
          context: { tickets: ["ADV-904"] },
        },
      },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe(
      "Wake me when: any of my workers posts a comms message of type attention",
    );
  });

  test("returns interest_type + repo when no prompt", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: {
        message: "ignored",
        payload: {
          interest_id: "orch-abc-pr-lifecycle",
          interest_type: "pr_lifecycle",
          repo: "rightsite-cloud/Adva",
        },
      },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("pr_lifecycle rightsite-cloud/Adva");
  });

  test("returns interest_type alone when no repo and no prompt", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: {
        message: "ignored",
        payload: { interest_type: "pr_lifecycle" },
      },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("pr_lifecycle");
  });

  test("sanitises markdown and HTML in the prompt", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: {
        payload: { prompt: "Wake me when **PR merged** or <p>CI passes</p>" },
      },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("Wake me when PR merged or CI passes");
  });

  test("handles legacy orchestrator.filter.register prompt", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.filter.register" },
      body: { payload: { prompt: "Wake me when ticket changes" } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("Wake me when ticket changes");
  });

  test("falls back to generic payload handling when filter.register has neither prompt nor interest_type", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.register" },
      body: { message: "fallback message", payload: {} },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("fallback message");
  });
});

describe("formatDetails (filter.wake)", () => {
  // CTL-348: render "wake → ${reason_short}" so the HUD shows why the broker
  // woke an orchestrator instead of an empty DETAIL cell.
  test("renders 'wake → {reason}' from body.payload.reason", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: { payload: { reason: "some reason", source_event_ids: [] } },
    } as unknown as CanonicalEvent;
    // CTL-419: recipient short ("orch-foo") appended after reason
    expect(formatDetails(e)).toBe("wake → some reason → orch-foo");
  });

  // CTL-350 / CTL-361: 40-char truncation was removed from the formatter — it
  // returns the full reason. CTL-361 then changed the DETAILS <Text> from
  // wrap="wrap" to wrap="truncate", so the renderer hard-clips the cell at the
  // right edge instead of reflowing. The formatter contract this test pins
  // (full string, no truncation) is unchanged regardless of renderer behaviour.
  test("preserves long reasons (no truncation; renderer clips the DETAILS cell)", () => {
    const long = "x".repeat(60);
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: { payload: { reason: long, source_event_ids: [] } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("wake → " + long + " → orch-foo");
  });

  test("appends (n) when source_event_ids has more than one entry", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: { payload: { reason: "ci_completed", source_event_ids: ["a", "b", "c"] } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("wake → ci_completed (3) → orch-foo");
  });

  test("omits the arrow when reason is empty", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: { payload: { reason: "", source_event_ids: ["a", "b"] } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("wake (2) → orch-foo");
  });

  test("handles the legacy orchestrator.filter.wake.* alias", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.filter.wake.orch-foo" },
      body: { payload: { reason: "ticket changed", source_event_ids: [] } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("wake → ticket changed → orch-foo");
  });

  // CTL-350: when source_events is populated, render structured triggering
  // event info instead of the Groq reason string. Receivers no longer need to
  // re-fetch state from GitHub/Linear/git to understand what fired the wake.
  test("prefers source_events over reason when populated", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: {
        payload: {
          reason: "match anything relevant",
          source_event_ids: ["uuid-1"],
          source_events: [{
            id: "uuid-1",
            name: "linear.issue.state_changed",
            ts: "2026-05-12T21:08:40Z",
            ticket: "ADV-87",
            payload_excerpt: { state: "Done" },
          }],
        },
      },
    } as unknown as CanonicalEvent;
    // CTL-419: recipient short appended after structured wake line
    expect(formatDetails(e)).toBe("wake ← linear.issue.state_changed ADV-87 → Done → orch-foo");
  });

  test("falls back to reason when source_events is absent", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: { payload: { reason: "legacy wake reason", source_event_ids: [] } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("wake → legacy wake reason → orch-foo");
  });

  test("renders PR ref when source_event carries pr", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: {
        payload: {
          source_events: [{
            name: "github.pr.merged",
            pr: 87,
            payload_excerpt: { merged: true },
          }],
        },
      },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toContain("github.pr.merged #87");
  });

  test("renders CI ref + conclusion suffix when source_event carries conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: {
        payload: {
          source_events: [{
            name: "github.check_suite.completed",
            pr: 501,
            payload_excerpt: { conclusion: "failure" },
          }],
        },
      },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("wake ← github.check_suite.completed #501 → failure → orch-foo");
  });

  test("appends (N) when source_events has more than one entry", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-foo" },
      body: {
        payload: {
          source_events: [
            { name: "linear.issue.state_changed", ticket: "ADV-1" },
            { name: "linear.issue.state_changed", ticket: "ADV-2" },
          ],
        },
      },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toContain("(2)");
  });
});

describe("formatDetails (comms.message.posted, CTL-391)", () => {
  // CTL-391: EVENT now shows the raw event.name (`comms.message.posted`), so
  // the sender+type composition that used to live in the EVENT cell
  // ("ADV-939: info") moves into DETAILS. The body, when present, follows
  // the prefix after an em-dash.
  test("prepends '<sender>: <type> — ' when sender and body are present", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "comms.message.posted",
        "catalyst.event.label": "CTL-330",
        "catalyst.worker.ticket": "CTL-330",
      },
      body: { message: "stalled: CI failed", payload: { type: "attention", channel: "orch-demo", to: "all" } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("CTL-330: attention — stalled: CI failed");
  });

  test("falls back to catalyst.worker.ticket when event.label is missing", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "comms.message.posted",
        "catalyst.worker.ticket": "CTL-330",
      },
      body: { message: "hi", payload: { type: "info" } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("CTL-330: info — hi");
  });

  test("omits the sender prefix when no event.label or worker ticket is present", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "comms.message.posted" },
      body: { message: "broadcast", payload: { type: "info" } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("info — broadcast");
  });

  test("falls back to 'comms' type when payload.type is missing", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "comms.message.posted",
        "catalyst.event.label": "CTL-330",
      },
      body: { message: "msg", payload: {} },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("CTL-330: comms — msg");
  });

  test("renders only the prefix when the message body is empty", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "comms.message.posted",
        "catalyst.event.label": "CTL-330",
      },
      body: { payload: { type: "attention" } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("CTL-330: attention");
  });
});

describe("formatDetails (broker.daemon)", () => {
  // CTL-348: broker.daemon.* events sometimes carry a free-form payload.detail
  // string; surface it in DETAIL when present, fall through otherwise.
  test("renders payload.detail when present", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "broker.daemon.startup" },
      body: { payload: { detail: "started pid=123" } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("started pid=123");
  });

  test("falls through to message when no payload.detail", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "broker.daemon.startup" },
      body: { message: "broker started", payload: { pid: 7170 } },
    } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("broker started");
  });
});

describe("formatDetailBody", () => {
  function withMessage(msg: string): CanonicalEvent {
    return { ...baseEvent, body: { message: msg, payload: {} } };
  }

  test("returns empty string when message is missing", () => {
    const e = { ...baseEvent, body: { message: "", payload: {} } };
    expect(formatDetailBody(e)).toBe("");
  });

  test("preserves paragraph breaks", () => {
    expect(formatDetailBody(withMessage("para 1\n\npara 2"))).toBe("para 1\n\npara 2");
  });

  test("preserves single newlines as line breaks", () => {
    expect(formatDetailBody(withMessage("line 1\nline 2"))).toBe("line 1\nline 2");
  });

  test("collapses 3+ blank lines to a single blank line", () => {
    expect(formatDetailBody(withMessage("a\n\n\n\nb"))).toBe("a\n\nb");
  });

  test("collapses runs of inline whitespace per line", () => {
    expect(formatDetailBody(withMessage("a    b\nc\t\td"))).toBe("a b\nc d");
  });

  test("decodes entities and strips tags across paragraphs", () => {
    const input = "<p>hello &amp; <strong>world</strong></p>\n\n<a href=\"x\">link</a>";
    expect(formatDetailBody(withMessage(input))).toBe("hello & world\n\nlink");
  });

  test("memoises by event reference", () => {
    const e = withMessage("<p>cached</p>");
    expect(formatDetailBody(e)).toBe("cached");
    expect(formatDetailBody(e)).toBe("cached");
  });
});

describe("shouldSkipEvent", () => {
  test("skips session.heartbeat", () => {
    const e = { ...baseEvent, attributes: { "event.name": "session.heartbeat" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips orchestrator.archived", () => {
    const e = { ...baseEvent, attributes: { "event.name": "orchestrator.archived" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips session.started", () => {
    const e = { ...baseEvent, attributes: { "event.name": "session.started" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips session.ended", () => {
    const e = { ...baseEvent, attributes: { "event.name": "session.ended" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips check_run.completed with success conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.result": "success",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips check_run.completed with neutral conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.result": "neutral",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("does not skip check_run.completed with failure conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.result": "failure",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(false);
  });

  test("does not skip github.pr.merged", () => {
    expect(shouldSkipEvent(baseEvent)).toBe(false);
  });

  test("skips filter.wake with 'No matching events found' reason", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake" },
      body: { payload: { reason: "No matching events found" } },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("does not skip filter.wake with other reason", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake" },
      body: { payload: { reason: "ci_completed" } },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(false);
  });
});

// CTL-355: when Nerd Font is detected, formatSource prepends a 2-char "icon "
// prefix and formatRef swaps "#" for the PR symbol. These tests pin
// CATALYST_NERD_FONT=1, reset the cache, and assert the prefixed output.
describe("formatSource / formatRef — CTL-355 Nerd Font enabled", () => {
  const outerEnv = process.env.CATALYST_NERD_FONT;
  beforeAll(() => {
    process.env.CATALYST_NERD_FONT = "1";
    _resetNerdFontCacheForTesting();
  });
  afterAll(() => {
    if (outerEnv === undefined) delete process.env.CATALYST_NERD_FONT;
    else process.env.CATALYST_NERD_FONT = outerEnv;
    _resetNerdFontCacheForTesting();
  });

  test("formatSource prepends GitHub icon for github.* events", () => {
    const out = formatSource(baseEvent);
    expect(out).toBe(`\u{F09B} github`);
    // First char is the icon (BMP, single codepoint); second char is a space;
    // remaining chars are the bare label.
    expect(out.codePointAt(0)).toBe(0xf09b);
    expect(out.charAt(1)).toBe(" ");
    expect(out.slice(2)).toBe("github");
  });

  test("formatSource prepends linear ticket icon for linear.* events", () => {
    const e = {
      ...baseEvent,
      attributes: { ...baseEvent.attributes, "event.name": "linear.issue.state_changed" },
    } as CanonicalEvent;
    const out = formatSource(e);
    // CTL-358: nf-fa-ticket (U+F145) — Linear has no native NF logo; ticket
    // is the closest semantic match and lives in stable FA4 BMP range.
    expect(out.codePointAt(0)).toBe(0xf145);
    expect(out.slice(2)).toBe("linear");
  });

  test("formatSource prepends broker bolt for filter.wake.* events", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-abc" },
    } as CanonicalEvent;
    const out = formatSource(e);
    expect(out.codePointAt(0)).toBe(0xf0e7);
    expect(out.slice(2)).toBe("broker");
  });

  test("formatSource prepends cogs for orchestrator-derived source", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "session.phase",
        "catalyst.orchestrator.id": "orch-abc",
        "catalyst.worker.ticket": "CTL-312",
      },
    } as CanonicalEvent;
    const out = formatSource(e);
    // CTL-358: nf-fa-cogs (U+F085, multiple gears) — orchestration. The
    // previous nf-md-robot (U+F544) was repurposed in Nerd Fonts v3 and
    // rendered as a down-arrow.
    expect(out.codePointAt(0)).toBe(0xf085);
    expect(out.slice(2)).toBe("orch-abc/CTL-312");
  });

  test("formatRef uses PR glyph + trailing space instead of '#' for github.pr.* events", () => {
    const out = formatRef(baseEvent);
    // CTL-358: prefix is " " (glyph + space), so out == " 501"
    expect(out.codePointAt(0)).toBe(0xf407);
    expect(out.charAt(1)).toBe(" ");
    expect(out.slice(2)).toBe("501");
  });
});

// CTL-391: the SOURCE icon — previously concatenated inside the EVENT column
// string by formatSourceEvent — moves into its own 1-cell ICON column to the
// left of EVENT. formatIcon returns just the BMP glyph (no trailing space)
// when a Nerd Font is detected, or "" when not, so the cell can render
// blank without disturbing column alignment.
describe("formatIcon (CTL-391, bare mode)", () => {
  // The earlier "CTL-355 Nerd Font enabled" block's afterAll deletes
  // CATALYST_NERD_FONT and resets the detection cache, so a fresh probe
  // here would see whatever Nerd Fonts the host machine has installed.
  // Pin the env explicitly so this block is hermetic.
  const innerOuterEnv = process.env.CATALYST_NERD_FONT;
  beforeAll(() => {
    process.env.CATALYST_NERD_FONT = "0";
    _resetNerdFontCacheForTesting();
  });
  afterAll(() => {
    if (innerOuterEnv === undefined) delete process.env.CATALYST_NERD_FONT;
    else process.env.CATALYST_NERD_FONT = innerOuterEnv;
    _resetNerdFontCacheForTesting();
  });

  test("returns empty string for any event when no Nerd Font is detected", () => {
    expect(formatIcon(baseEvent)).toBe("");
    const linear = {
      ...baseEvent,
      attributes: { ...baseEvent.attributes, "event.name": "linear.issue.updated" },
    } as CanonicalEvent;
    expect(formatIcon(linear)).toBe("");
    const wake = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.sess_x" },
    } as unknown as CanonicalEvent;
    expect(formatIcon(wake)).toBe("");
  });
});

describe("formatIcon (CTL-391, Nerd Font enabled)", () => {
  const outerEnv = process.env.CATALYST_NERD_FONT;
  beforeAll(() => {
    process.env.CATALYST_NERD_FONT = "1";
    _resetNerdFontCacheForTesting();
  });
  afterAll(() => {
    if (outerEnv === undefined) delete process.env.CATALYST_NERD_FONT;
    else process.env.CATALYST_NERD_FONT = outerEnv;
    _resetNerdFontCacheForTesting();
  });

  test("github events get the octocat glyph alone (no trailing space)", () => {
    const out = formatIcon(baseEvent);
    expect(out.length).toBe(1);
    expect(out.codePointAt(0)).toBe(0xf09b);
  });

  test("linear events get the linear ticket glyph", () => {
    const e = {
      ...baseEvent,
      attributes: { ...baseEvent.attributes, "event.name": "linear.issue.state_changed" },
    } as CanonicalEvent;
    const out = formatIcon(e);
    expect(out.length).toBe(1);
    expect(out.codePointAt(0)).toBe(0xf145);
  });

  test("filter.wake.* gets the broker bolt glyph (broker is the wake source)", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.orch-abc" },
    } as unknown as CanonicalEvent;
    const out = formatIcon(e);
    expect(out.length).toBe(1);
    expect(out.codePointAt(0)).toBe(0xf0e7);
  });

  test("comms.message.posted anchors on the comments speech-bubble glyph regardless of sender", () => {
    // Even when classifySource would return the sender's ticket label (e.g.
    // "CTL-330"), the icon stays the speech bubble — the glyph belongs to
    // the comms channel, not to the worker that posted the message.
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "comms.message.posted",
        "catalyst.event.label": "CTL-330",
        "catalyst.worker.ticket": "CTL-330",
      },
      body: { payload: { type: "attention" } },
    } as unknown as CanonicalEvent;
    const out = formatIcon(e);
    expect(out.length).toBe(1);
    expect(out.codePointAt(0)).toBe(0xf086);
  });

  test("orchestrator-derived sources get the catalyst cogs glyph", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "session.phase",
        "catalyst.orchestrator.id": "orch-abc",
        "catalyst.worker.ticket": "CTL-312",
      },
    } as CanonicalEvent;
    const out = formatIcon(e);
    expect(out.length).toBe(1);
    expect(out.codePointAt(0)).toBe(0xf085);
  });
});

describe("session.context display (CTL-374)", () => {
  // CTL-391: formatEvent returns the raw event.name verbatim. The compact
  // "ctx" / "ctx warn" labels are gone — context details still land in the
  // DETAILS cell via the formatDetails arms below.
  test("formatEvent returns raw session.context verbatim", () => {
    const e: CanonicalEvent = {
      ...baseEvent,
      attributes: { "event.name": "session.context" },
    };
    expect(formatEvent(e)).toBe("session.context");
  });

  test("formatEvent returns raw attention.context_pressure verbatim", () => {
    const e: CanonicalEvent = {
      ...baseEvent,
      attributes: { "event.name": "attention.context_pressure" },
    };
    expect(formatEvent(e)).toBe("attention.context_pressure");
  });

  test("formatDetails for session.context renders compact context summary", () => {
    const e: CanonicalEvent = {
      ...baseEvent,
      attributes: {
        "event.name": "session.context",
        "claude.context.used_pct": 24,
        "claude.context.tokens": 245000,
        "claude.turn": 126,
        "claude.model": "claude-opus-4-7",
      },
      body: {
        payload: {
          context_pct: 24,
          context_tokens: 245000,
          context_max: 1_000_000,
          turn: 126,
          cost_usd: 23.02,
          model: "claude-opus-4-7",
        },
      },
    };
    const out = formatDetails(e);
    expect(out).toContain("24%");
    expect(out).toContain("245k tok");
    expect(out).toContain("t126");
    expect(out).toContain("$23.02");
  });

  test("formatDetails omits cost when payload has none", () => {
    const e: CanonicalEvent = {
      ...baseEvent,
      attributes: {
        "event.name": "session.context",
        "claude.context.used_pct": 8,
        "claude.context.tokens": 80000,
        "claude.turn": 3,
      },
      body: {
        payload: { context_pct: 8, context_tokens: 80000, turn: 3 },
      },
    };
    const out = formatDetails(e);
    expect(out).toContain("8%");
    expect(out).toContain("80k tok");
    expect(out).toContain("t3");
    expect(out).not.toContain("$");
  });

  test("formatDetails for attention.context_pressure shows the crossing", () => {
    const e: CanonicalEvent = {
      ...baseEvent,
      attributes: { "event.name": "attention.context_pressure" },
      body: {
        payload: { prev_pct: 50, new_pct: 72, threshold: 70 },
      },
    };
    const out = formatDetails(e);
    expect(out).toContain("50%");
    expect(out).toContain("72%");
    expect(out).toContain("70");
  });

  test("formatDetails falls back gracefully when payload is missing", () => {
    const e: CanonicalEvent = {
      ...baseEvent,
      attributes: { "event.name": "session.context" },
      body: { message: "context tick" },
    };
    // Should not throw and should return a non-empty string.
    const out = formatDetails(e);
    expect(typeof out).toBe("string");
  });
});
