import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import {
  formatTime,
  formatDateTime,
  formatRepo,
  formatSource,
  formatEvent,
  formatRef,
  formatDetails,
  formatDetailBody,
  shouldSkipEvent,
} from "../cli/lib/format.ts";

const baseEvent: CanonicalEvent = {
  ts: "2026-05-08T07:23:01.000Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: "abc123def456abc123def456abc123de",
  spanId: "abc123de456abc12",
  resource: {
    "service.name": "github-webhook",
    "service.namespace": "catalyst",
    "service.version": "8.2.0",
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
});

describe("formatSource", () => {
  test("maps github events to 'github'", () => {
    expect(formatSource(baseEvent)).toBe("github");
  });

  test("maps comms.message.posted to 'comms'", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "event.name": "comms.message.posted" } };
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
  test("maps filter.* with orchestrator id to that orch id", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "filter.register",
        "catalyst.orchestrator.id": "orch-abc",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc");
  });

  test("maps filter.* without orchestrator id to 'filter'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.sess_x" },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("filter");
  });

  test("maps legacy orchestrator.filter.* alias to the orchestrator id", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "orchestrator.filter.register",
        "catalyst.orchestrator.id": "orch-abc",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc");
  });

  test("maps broker.daemon.startup to 'broker'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "broker.daemon.startup" },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("broker");
  });
});

describe("formatEvent", () => {
  test("maps github.pr.merged to 'merged'", () => {
    expect(formatEvent(baseEvent)).toBe("merged");
  });

  test("maps github.check_suite.completed/failure to 'ci fail'", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_suite.completed",
        "cicd.pipeline.run.conclusion": "failure",
      },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("ci fail");
  });

  test("maps github.check_suite.completed/success to 'ci pass'", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_suite.completed",
        "cicd.pipeline.run.conclusion": "success",
      },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("ci pass");
  });

  test("maps github.pr.opened to 'pr open'", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "event.name": "github.pr.opened" } };
    expect(formatEvent(e)).toBe("pr open");
  });

  test("truncates unknown event names to 15 chars", () => {
    const e = { ...baseEvent, attributes: { "event.name": "some.very.long.event.name.here" } } as unknown as CanonicalEvent;
    const result = formatEvent(e);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  test("maps orchestrator.worker.done to 'done'", () => {
    const e = { ...baseEvent, attributes: { "event.name": "orchestrator.worker.done" } } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("done");
  });

  // CTL-331: filter daemon lifecycle labels.
  test("maps filter.register to 'filter reg'", () => {
    const e = { ...baseEvent, attributes: { "event.name": "filter.register" } } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("filter reg");
  });

  test("maps filter.deregister to 'filter dereg'", () => {
    const e = { ...baseEvent, attributes: { "event.name": "filter.deregister" } } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("filter dereg");
  });

  test("maps filter.wake to 'wake'", () => {
    const e = { ...baseEvent, attributes: { "event.name": "filter.wake" } } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("wake");
  });

  test("maps prefixed filter.wake.{sessionId} to 'wake' (not truncated)", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake.sess_20260511T203845_16d33281" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("wake");
  });

  test("maps legacy orchestrator.filter.register alias to 'filter reg'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.filter.register" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("filter reg");
  });

  test("maps legacy orchestrator.filter.wake.* alias to 'wake'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "orchestrator.filter.wake.sess_xyz" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("wake");
  });

  test("maps broker.daemon.startup to 'broker start'", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "broker.daemon.startup" },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("broker start");
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
});

describe("formatDetails", () => {
  test("returns payload title when present", () => {
    const e = { ...baseEvent, body: { message: "ignored", payload: { title: "feat: add thing" } } };
    expect(formatDetails(e)).toBe("feat: add thing");
  });

  test("returns message when no payload title", () => {
    const e = { ...baseEvent, body: { message: "Something happened", payload: {} } };
    expect(formatDetails(e)).toBe("Something happened");
  });

  test("returns long messages in full (scrollable detail pane handles overflow)", () => {
    const long = "x".repeat(100);
    const e = { ...baseEvent, body: { message: long } };
    expect(formatDetails(e)).toBe(long);
  });
});

describe("formatDetails (sanitizer)", () => {
  function withMessage(msg: string): CanonicalEvent {
    return { ...baseEvent, body: { message: msg, payload: {} } };
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
      ...baseEvent,
      body: { message: "ignored", payload: { title: "## <strong>feat</strong>: thing" } },
    };
    expect(formatDetails(e)).toBe("feat: thing");
  });

  test("sanitizes payload.body and truncates the raw input at 300 chars before cleanup", () => {
    const raw = "x".repeat(295) + "<p>tail</p>";
    const e = { ...baseEvent, body: { message: "", payload: { body: raw } } };
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
    const e = { ...baseEvent, body: undefined } as unknown as CanonicalEvent;
    expect(formatDetails(e)).toBe("");
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
        "cicd.pipeline.run.conclusion": "success",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips check_run.completed with neutral conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.conclusion": "neutral",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("does not skip check_run.completed with failure conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.conclusion": "failure",
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
