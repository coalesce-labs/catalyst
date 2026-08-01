// ticket-discussion.tsx — the interleaved Linear DISCUSSION timeline: comment
// cards and state-change rows in ONE chronological stream (CTL-1574).
//
// PORTED from catalyst-cloud's `apps/web/src/components/tickets/ticket-timeline.tsx`
// (buildTimeline / coalesceBursts / DESCRIBERS / ActivityRow / ActivityBurst /
// TicketTimeline) plus the CommentItem card from `ticket-comments.tsx` in the same
// directory. The data comes from the SAME `@catalyst-cloud/read-model`
// buildIssueDetail those components consume, so the presentation is a copy rather
// than a re-derivation. Behavior is unchanged except for four deliberate host
// adaptations:
//
//   1. Markdown goes through THIS app's sanitizing pipeline
//      (@/lib/ticket-markdown::renderTicketDescriptionHtml — marked + hljs +
//      DOMPurify + ref pills), the same one ticket-description.tsx uses.
//   2. Relative time uses @/lib/formatters::fmtRelativeDuration.
//   3. No shadcn Avatar (the monitor has none): the comment card renders a 24px
//      initials circle, and an `is_bot` author shows a Bot glyph instead.
//   4. `stateColorVar` / `priorityLabel` are inlined below over the monitor's own
//      `statusSemantic` + theme tokens (catalyst-cloud keeps them in
//      lib/issue-presenter.ts, which has no counterpart here).
//
// Design, unchanged from the source: activity events are RECESSIVE single-line
// rows (verb glyph + actor + outcome + relative time) so they read as quiet
// annotations between full-weight comment cards and the human discussion stays
// dominant; same-actor BURSTS collapse to one expandable row; the OUTCOME value
// renders in text-fg with the rest in text-muted. buildTimeline / coalesceBursts /
// describeOrNull are pure (no React, no Date.now) and exported for tests.
import { Fragment, useCallback, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Bot,
  CalendarClock,
  ChevronRight,
  CirclePlus,
  CircleUser,
  CornerUpLeft,
  Dot,
  FileText,
  Flag,
  FolderInput,
  Gauge,
  PencilLine,
  RefreshCw,
  RotateCw,
  Tag,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtRelativeDuration, statusSemantic, type StatusSemantic } from "@/lib/formatters";
import { isTicketRef, renderTicketDescriptionHtml } from "@/lib/ticket-markdown";
import type {
  TicketActivityEvent,
  TicketActivityLabel,
  TicketComment,
} from "../../../lib/ticket-discussion-reader.mjs";

// ── Tunables (ported verbatim — deliberately easy to retune) ─────────────────
/** A contiguous run of same-actor events LONGER than this collapses into one
 *  expandable "made N changes" row, so a burst of agent edits never drowns the
 *  human discussion. */
const BURST_MAX = 4;
/** Two same-actor events more than this far apart never coalesce (separate
 *  working sessions). */
const BURST_WINDOW_MS = 5 * 60 * 1000;
/** A renamed-to title longer than this is truncated with an ellipsis (rows stay
 *  one line). */
const TITLE_MAX = 48;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A neutral actor label when the replica has no name for the event's actor (a
 *  system event). */
const UNKNOWN_ACTOR = "Someone";
/** A neutral label for an author the replica has no name for (never blank). */
const UNKNOWN_AUTHOR = "Unknown";

// ── State + priority presentation (adaptation 4) ─────────────────────────────
/** Linear priority → human label. 0/absent = no priority (the row is omitted). */
const PRIORITY_LABEL = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

function priorityLabel(priority: number | null): string | null {
  if (priority == null || priority <= 0) return null;
  return PRIORITY_LABEL[priority] ?? `P${priority}`;
}

/** The semantic bucket for a LINEAR WORKFLOW state name.
 *
 *  `statusSemantic` keys off the monitor's internal worker statuses (`running`,
 *  `implementing`, …), which are NOT the strings Linear stores. The states that
 *  actually appear in this workspace's `issue_history` are the phase-contract
 *  names — Implement (2280 rows), PR (1774), Triage, Plan, Research, Validate,
 *  Remediate, Ready — and every one of them falls through to `neutral` on that
 *  table alone, which would leave the dot carrying no information on the busiest
 *  transitions. So the contract states are mapped explicitly here and
 *  `statusSemantic` remains the fallback for anything else. (catalyst-cloud's
 *  issue-presenter.ts maps a shorter list; this one is widened to the states this
 *  workspace really emits.) */
function stateSemantic(state: string): StatusSemantic {
  const key = state.trim().toLowerCase().replace(/\s+/g, "_");
  const EXTRA: Record<string, StatusSemantic> = {
    // In-flight pipeline states — the ticket is moving.
    research: "info",
    plan: "info",
    implement: "info",
    verify: "info",
    validate: "info",
    review: "info",
    in_review: "info",
    pr: "info",
    "monitor-merge": "info",
    "monitor-deploy": "info",
    // Something needs attention before it moves again.
    remediate: "warning",
    // Not yet started / no longer live — quiet.
    triage: "neutral",
    backlog: "neutral",
    todo: "neutral",
    ready: "neutral",
    duplicate: "neutral",
  };
  return EXTRA[key] ?? statusSemantic(key);
}

/** The theme token a state's dot resolves to. */
function stateColorVar(state: string): string {
  switch (stateSemantic(state)) {
    case "success":
      return "var(--color-green)";
    case "info":
      return "var(--color-blue)";
    case "danger":
      return "var(--color-red)";
    case "warning":
      return "var(--color-yellow)";
    default:
      return "var(--fg-muted)";
  }
}

// ── Pure timeline model ──────────────────────────────────────────────────────
export interface CommentNode {
  kind: "comment";
  ts: number;
  comment: TicketComment;
}
export interface EventNode {
  kind: "event";
  ts: number;
  event: TicketActivityEvent;
  /** The "created this issue" row — Linear's creation event (see
   *  creationEventId). Never coalesced into a burst, so creation stays visible. */
  isCreation: boolean;
}
export interface BurstNode {
  kind: "burst";
  ts: number;
  actorName: string;
  events: TicketActivityEvent[];
}
export type TimelineNode = CommentNode | EventNode | BurstNode;

/** How far (ms) a bare earliest history row may sit after the issue's own
 *  created_at and still be labeled "created this issue". Linear also emits bare
 *  rows for properties the read-model doesn't extract (subscribers, relations,
 *  attachments); on live data ~1/6 of issues' earliest bare row arrives hours or
 *  weeks late, so without this window the label is frequently a fabrication. */
const CREATION_WINDOW_MS = 5 * 60_000;

/**
 * The id of the "created this issue" event, or null. It's the EARLIEST activity
 * event that carries no recorded transition — Linear emits a bare IssueHistory row
 * for issue creation. If the earliest event already describes a real change, we
 * have no creation row to label and this returns null (a real transition is never
 * mislabeled as "created"). When the issue's own creation instant is known, the
 * bare row must also fall within CREATION_WINDOW_MS of it — a late bare row (an
 * unextracted property change) is left unlabeled rather than mislabeled.
 * Exported for tests.
 */
export function creationEventId(
  activity: TicketActivityEvent[],
  issueCreatedAt?: number | null,
): string | null {
  if (activity.length === 0) return null;
  let minTs = Infinity;
  for (const e of activity) if (e.created_at < minTs) minTs = e.created_at;
  // Among the earliest-timestamp events, the bare (no-transition) one is creation.
  const created = activity.find((e) => e.created_at === minTs && describeOrNull(e) === null);
  if (!created) return null;
  if (typeof issueCreatedAt === "number" && created.created_at - issueCreatedAt > CREATION_WINDOW_MS)
    return null;
  return created.id;
}

/**
 * Merge comments + activity into one chronological stream. Comments are FLAT —
 * each is its own node ordered by `updated_at`, NOT threaded/indented
 * (Linear-style; agent comments are top-level and the indent read as a confusing
 * reply-thread). Activity events are single nodes. Sorted by timestamp ascending;
 * on a tie the activity event sorts BEFORE a same-ms comment (the state changed,
 * THEN someone commented). A contiguous run of >BURST_MAX same-actor events within
 * BURST_WINDOW_MS collapses to one burst node — EXCEPT the creation event, which
 * never coalesces. Pure — no React, no Date.now (the caller passes `now`).
 */
export function buildTimeline(
  comments: TicketComment[],
  activity: TicketActivityEvent[],
  issueCreatedAt?: number | null,
): TimelineNode[] {
  const createdId = creationEventId(activity, issueCreatedAt);
  const nodes: Array<CommentNode | EventNode> = [
    ...comments.map((c): CommentNode => ({ kind: "comment", ts: c.updated_at, comment: c })),
    ...activity.map(
      (e): EventNode => ({
        kind: "event",
        ts: e.created_at,
        event: e,
        isCreation: e.id === createdId,
      }),
    ),
  ];
  // Stable in V8: tie → event (rank 0) before comment (rank 1).
  const rank = (n: CommentNode | EventNode) => (n.kind === "event" ? 0 : 1);
  nodes.sort((a, b) => a.ts - b.ts || rank(a) - rank(b));
  return coalesceBursts(nodes);
}

/** Same-actor test for burst coalescing: compare `actor_id` when both events
 *  carry one (two accounts can share a display name — merging them would
 *  misattribute the whole burst to the first), fall back to the display name
 *  only when ids are absent. */
function sameActor(a: TicketActivityEvent, b: TicketActivityEvent): boolean {
  if (a.actor_id != null && b.actor_id != null) return a.actor_id === b.actor_id;
  return a.actor_name === b.actor_name;
}

/** Fold contiguous same-actor event runs longer than BURST_MAX (within
 *  BURST_WINDOW_MS) into one burst node. A comment, a different actor, an
 *  actor-less (system) event, or a window gap breaks a run. Exported for tests. */
export function coalesceBursts(nodes: Array<CommentNode | EventNode>): TimelineNode[] {
  const out: TimelineNode[] = [];
  let run: EventNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length > BURST_MAX) {
      out.push({
        kind: "burst",
        ts: run[run.length - 1]!.ts,
        actorName: run[0]!.event.actor_name ?? UNKNOWN_ACTOR,
        events: run.map((r) => r.event),
      });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const node of nodes) {
    if (node.kind === "event" && !node.isCreation && node.event.actor_name != null) {
      const prev = run[run.length - 1];
      if (
        prev &&
        (!sameActor(prev.event, node.event) || node.ts - prev.ts > BURST_WINDOW_MS)
      ) {
        flush();
      }
      run.push(node);
    } else {
      flush();
      out.push(node);
    }
  }
  flush();
  return out;
}

// ── Event wording ────────────────────────────────────────────────────────────
export interface Descriptor {
  icon: LucideIcon;
  /** When set, ActivityRow renders this CSS color as a state DOT instead of the
   *  icon — used for state transitions so the row carries the app's state-color
   *  vocabulary. */
  dot?: string;
  /** Everything after the actor name: the verb phrase + outcome (outcome values
   *  in text-fg). */
  body: ReactNode;
}

/** The result/outcome value, emphasized so the eye lands on what changed. */
function fg(value: ReactNode): ReactNode {
  return <span className="text-fg">{value}</span>;
}

/** "YYYY-MM-DD" (a Linear TimelessDate, stored as-is) → "Mar 14". Never shifts
 *  timezone. */
function fmtDueDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2]!;
  return `${month} ${Number(m[3])}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** Inline label swatches (dot + name). Color is never the sole signal — the name
 *  is always shown. Labels with a null name are filtered out before this renders.
 *  Chips are separated by a real space (not just a flex gap) so the text reads
 *  correctly for screen readers + copy-paste, not "bugui". */
function LabelSwatches({ labels }: { labels: TicketActivityLabel[] }) {
  return (
    <>
      {labels.map((l, i) => (
        <Fragment key={l.id}>
          {i > 0 ? " " : null}
          <span className="inline-flex items-center gap-1 align-middle">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: l.color ?? "var(--fg-dim)" }}
            />
            <span className="text-fg">{l.name}</span>
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** Named labels only (a null-name label can't be shown without fabricating). */
function namedLabels(labels: TicketActivityLabel[]): TicketActivityLabel[] {
  return labels.filter((l) => l.name != null);
}

/** Ordered list of per-property describers — the FIRST that applies to an event
 *  wins (an event usually touches one property). Each returns null when it doesn't
 *  apply, so we fall through to the next, and ultimately to a generic "updated
 *  this issue" so an event is never silently dropped. */
const DESCRIBERS: Array<(e: TicketActivityEvent) => Descriptor | null> = [
  // Workflow state — the leading glyph is the DESTINATION state's color dot.
  (e) => {
    if (e.to_state == null && e.from_state == null) return null;
    if (e.to_state != null && e.from_state != null)
      return {
        icon: RefreshCw,
        dot: stateColorVar(e.to_state),
        body: (
          <>
            moved {fg(e.from_state)} → {fg(e.to_state)}
          </>
        ),
      };
    if (e.to_state != null)
      return {
        icon: RefreshCw,
        dot: stateColorVar(e.to_state),
        body: <>set the state to {fg(e.to_state)}</>,
      };
    return null;
  },
  // Assignee.
  (e) => {
    if (e.to_assignee_id == null && e.from_assignee_id == null) return null;
    if (e.to_assignee_id != null) {
      if (e.to_assignee_name != null && e.to_assignee_name === e.actor_name)
        return { icon: CircleUser, body: <>self-assigned this</> };
      return {
        icon: CircleUser,
        body: <>assigned this to {fg(e.to_assignee_name ?? "someone")}</>,
      };
    }
    return {
      icon: CircleUser,
      body:
        e.from_assignee_name != null ? (
          <>unassigned {fg(e.from_assignee_name)}</>
        ) : (
          <>unassigned this</>
        ),
    };
  },
  // Labels added.
  (e) => {
    const added = namedLabels(e.added_labels);
    if (added.length === 0) return null;
    return {
      icon: Tag,
      body: (
        <>
          added label{added.length > 1 ? "s" : ""} <LabelSwatches labels={added} />
        </>
      ),
    };
  },
  // Labels removed.
  (e) => {
    const removed = namedLabels(e.removed_labels);
    if (removed.length === 0) return null;
    return {
      icon: Tag,
      body: (
        <>
          removed label{removed.length > 1 ? "s" : ""} <LabelSwatches labels={removed} />
        </>
      ),
    };
  },
  // Priority.
  (e) => {
    if (e.to_priority == null && e.from_priority == null) return null;
    const name = e.to_priority == null ? null : priorityLabel(e.to_priority);
    return {
      icon: Flag,
      body: name != null ? <>changed priority to {fg(name)}</> : <>cleared the priority</>,
    };
  },
  // Estimate.
  (e) => {
    if (e.to_estimate == null && e.from_estimate == null) return null;
    return {
      icon: Gauge,
      body:
        e.to_estimate != null ? (
          <>set the estimate to {fg(`${e.to_estimate} pts`)}</>
        ) : (
          <>cleared the estimate</>
        ),
    };
  },
  // Title.
  (e) => {
    if (e.to_title == null) return null;
    return {
      icon: PencilLine,
      body: <>renamed this to {fg(`“${truncate(e.to_title, TITLE_MAX)}”`)}</>,
    };
  },
  // Project.
  (e) => {
    if (e.to_project_id == null && e.from_project_id == null) return null;
    if (e.to_project_name != null)
      return { icon: FolderInput, body: <>moved this to project {fg(e.to_project_name)}</> };
    if (e.to_project_id != null)
      return { icon: FolderInput, body: <>moved this to another project</> };
    if (e.from_project_name != null)
      return { icon: FolderInput, body: <>removed this from project {fg(e.from_project_name)}</> };
    return { icon: FolderInput, body: <>removed this from its project</> };
  },
  // Cycle.
  (e) => {
    if (e.to_cycle_id == null && e.from_cycle_id == null) return null;
    if (e.to_cycle_number != null)
      return { icon: RotateCw, body: <>moved this to {fg(`Cycle ${e.to_cycle_number}`)}</> };
    if (e.to_cycle_id != null) return { icon: RotateCw, body: <>moved this to another cycle</> };
    if (e.from_cycle_number != null)
      return { icon: RotateCw, body: <>removed this from {fg(`Cycle ${e.from_cycle_number}`)}</> };
    return { icon: RotateCw, body: <>removed this from its cycle</> };
  },
  // Parent issue.
  (e) => {
    if (e.to_parent_id == null && e.from_parent_id == null) return null;
    const mono = (id: string) => <span className="font-mono text-accent">{id}</span>;
    if (e.to_parent_identifier != null)
      return { icon: CornerUpLeft, body: <>set the parent to {mono(e.to_parent_identifier)}</> };
    if (e.to_parent_id != null) return { icon: CornerUpLeft, body: <>set a parent issue</> };
    if (e.from_parent_identifier != null)
      return { icon: CornerUpLeft, body: <>removed the parent {mono(e.from_parent_identifier)}</> };
    return { icon: CornerUpLeft, body: <>removed the parent issue</> };
  },
  // Due date.
  (e) => {
    if (e.to_due_date == null && e.from_due_date == null) return null;
    return {
      icon: CalendarClock,
      body:
        e.to_due_date != null ? (
          <>set the due date to {fg(fmtDueDate(e.to_due_date))}</>
        ) : (
          <>removed the due date</>
        ),
    };
  },
  // Archived (null-preserving: 1 archived, 0 unarchived).
  (e) => {
    if (e.auto_archived === 1) return { icon: Archive, body: <>auto-archived this</> };
    if (e.archived === 1) return { icon: Archive, body: <>archived this</> };
    if (e.archived === 0 || e.auto_archived === 0)
      return { icon: Archive, body: <>unarchived this</> };
    return null;
  },
  // Auto-closed.
  (e) => (e.auto_closed === 1 ? { icon: XCircle, body: <>auto-closed this</> } : null),
  // Trashed (1 trashed, 0 restored).
  (e) => {
    if (e.trashed === 1) return { icon: Trash2, body: <>moved this to trash</> };
    if (e.trashed === 0) return { icon: Trash2, body: <>restored this from trash</> };
    return null;
  },
  // Description edited.
  (e) =>
    e.updated_description === 1 ? { icon: FileText, body: <>edited the description</> } : null,
];

/** The matching describer for an event, or null when it touched nothing we
 *  describe (a bare event — e.g. the creation row, which the timeline labels
 *  separately). Pure; exported for tests. */
export function describeOrNull(event: TicketActivityEvent): Descriptor | null {
  for (const d of DESCRIBERS) {
    const hit = d(event);
    if (hit) return hit;
  }
  return null;
}

function describe(event: TicketActivityEvent): Descriptor {
  return describeOrNull(event) ?? { icon: Dot, body: <>updated this issue</> };
}

// ── Comment card ─────────────────────────────────────────────────────────────
/** Up to two initials from an author name (e.g. "Ada Lovelace" → "AL"). Exported
 *  for tests. */
export function initialsOf(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/** The 24px author mark — the author's Linear avatar when one is mirrored, else
 *  an initials circle, or a Bot glyph for an agent author. Replaces the source's
 *  shadcn Avatar (adaptation 3) with a plain <img> + failure fallback; the border
 *  is what gives it definition against the card's own bg-surface-2. */
function AuthorMark({
  name,
  isBot,
  avatarUrl,
}: {
  name: string | null;
  isBot: boolean;
  avatarUrl: string | null;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = Boolean(avatarUrl) && !imgFailed;
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2 text-[10px] font-medium text-muted"
    >
      {showImg ? (
        <img
          src={avatarUrl ?? undefined}
          alt=""
          className="size-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : isBot ? (
        <Bot className="size-3.5" />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

/** A single rendered comment — a bordered, elevated card (bg-surface-2 +
 *  shadow-card) with the author header above the markdown body, so it is visually
 *  distinct from the recessive single-line activity rows. An agent (`is_bot`)
 *  comment carries a muted "· agent" marker. The body goes through the same
 *  sanitizing path as the ticket description, so nothing reaches the DOM
 *  unsanitized. */
function CommentItem({ comment, now }: { comment: TicketComment; now: number }) {
  const when = fmtRelativeDuration(now - comment.updated_at);
  const name = comment.author_name ?? UNKNOWN_AUTHOR;
  const isBot = Boolean(comment.is_bot);
  const navigate = useNavigate();
  // Soft-navigate ticket-ref pill clicks through TanStack Router — same
  // interception as ticket-description.tsx, else a pill click is a full document
  // navigation that discards the monitor's in-memory state.
  const interceptTicketLinks = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a.ticket-ref-pill") as HTMLAnchorElement | null;
      if (!anchor) return;
      const ref = (anchor.textContent ?? "").trim();
      if (!isTicketRef(ref)) return;
      e.preventDefault();
      void navigate({ to: "/ticket/$id", params: { id: ref } });
    },
    [navigate],
  );
  return (
    <li
      data-ticket-comment={comment.id}
      data-comment-agent={isBot ? "true" : undefined}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 px-3.5 py-3 shadow-card"
    >
      <div data-ticket-comment-header className="flex items-center gap-2">
        <AuthorMark
          name={comment.author_name}
          isBot={isBot}
          avatarUrl={comment.author_avatar_url}
        />
        <span className="text-[12px] font-medium text-fg">{name}</span>
        {isBot && <span className="font-mono text-[11px] text-muted">· agent</span>}
        {when && (
          <span className="font-mono text-[11px] text-fg-dim" title={String(comment.updated_at)}>
            · {when}
          </span>
        )}
      </div>
      {comment.body ? (
        <div
          data-ticket-comment-body
          className="ticket-desc prose prose-invert"
          onClick={interceptTicketLinks}
          dangerouslySetInnerHTML={{ __html: renderTicketDescriptionHtml(comment.body) }}
        />
      ) : (
        <div className="font-mono text-[12px] text-muted">(empty comment)</div>
      )}
    </li>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────
/** One recessive activity event line. Lighter than a comment card by design
 *  (metadata, not prose). `isCreation` renders "created this issue" instead of the
 *  per-property description. */
function ActivityRow({
  event,
  isCreation,
  now,
}: {
  event: TicketActivityEvent;
  isCreation?: boolean;
  now: number;
}) {
  const desc: Descriptor = isCreation
    ? { icon: CirclePlus, body: <>created this issue</> }
    : describe(event);
  const { icon: Icon, body, dot } = desc;
  const actorName = event.actor_name ?? UNKNOWN_ACTOR;
  const when = fmtRelativeDuration(now - event.created_at);
  const iso = new Date(event.created_at).toISOString();
  return (
    <li
      data-ticket-activity
      className="flex items-center gap-2 py-0.5 text-[12px] leading-snug text-muted"
    >
      {/* No avatar on activity rows (Linear-style): just the leading glyph + actor
          name, kept tight. State transitions show the destination state's color
          dot; everything else a verb icon. */}
      {dot ? (
        <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full" style={{ background: dot }} />
        </span>
      ) : (
        <Icon aria-hidden className="size-3.5 shrink-0 text-fg-dim" />
      )}
      <span className="min-w-0 truncate">
        <span className="text-fg">{actorName}</span> {body}
      </span>
      <span className="flex-1" />
      {when && (
        <time className="shrink-0 font-mono text-[11px] text-fg-dim" dateTime={iso} title={iso}>
          {when}
        </time>
      )}
    </li>
  );
}

/** A collapsed run of same-actor events — keeps a noisy history from drowning the
 *  discussion. */
function ActivityBurst({ node, now }: { node: BurstNode; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-ticket-activity-burst className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 self-start text-left text-[12px] text-fg-dim hover:text-muted"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        <span>
          <span className="text-fg">{node.actorName}</span> made {node.events.length} changes
        </span>
      </button>
      {open && (
        <ol className="flex flex-col gap-0.5 pl-5">
          {node.events.map((e) => (
            <ActivityRow key={e.id} event={e} now={now} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Reverse an ascending stream by TIMESTAMP GROUP: groups of equal-ts nodes swap
 *  position but keep their internal order, so the same-millisecond tie-break
 *  ("the state changed, THEN someone commented") still reads top-down. A plain
 *  Array.reverse() would invert it. */
function reverseByTimestamp(nodes: TimelineNode[]): TimelineNode[] {
  const out: TimelineNode[] = [];
  let end = nodes.length;
  while (end > 0) {
    let start = end - 1;
    while (start > 0 && nodes[start - 1]?.ts === nodes[end - 1]?.ts) start--;
    for (let i = start; i < end; i++) {
      const n = nodes[i];
      if (n) out.push(n);
    }
    end = start;
  }
  return out;
}

/** The collapse + display-order math, pure so it stays testable (bun has no DOM).
 *  Collapse keeps the NEWEST `limit` nodes (the stream is oldest-first);
 *  `newestFirst` then flips DISPLAY order only — the underlying timeline stays
 *  ascending, so burst coalescing is unaffected, and equal-ts groups keep their
 *  tie-break order (see reverseByTimestamp). */
export function visibleTimelineNodes(
  nodes: TimelineNode[],
  { limit, showAll, newestFirst }: { limit?: number; showAll: boolean; newestFirst: boolean },
): { collapsed: boolean; shown: TimelineNode[] } {
  const collapsed = limit != null && !showAll && nodes.length > limit;
  const kept = limit != null && collapsed ? nodes.slice(-limit) : nodes;
  return { collapsed, shown: newestFirst ? reverseByTimestamp(kept) : kept };
}

// ── Section ──────────────────────────────────────────────────────────────────
/**
 * The interleaved activity + comment timeline.
 *
 * `loaded` false holds a skeleton line so nothing below jumps. `available` false
 * means the replica could not be read (or the ticket is not mirrored) — that is
 * reported as its OWN state rather than as "no discussion", because claiming
 * emptiness about a source we never reached would be a fabrication.
 *
 * `limit` renders only the newest N nodes with a "Show all N" toggle — the inbox
 * reading pane uses it to keep the conversation near the respond verb without
 * pushing it off-screen; the ticket page passes no limit and shows everything.
 */
export function TicketTimeline({
  comments,
  activity,
  loaded,
  available = true,
  now = Date.now(),
  limit,
  newestFirst = false,
  issueCreatedAt = null,
  error = null,
}: {
  comments: TicketComment[];
  activity: TicketActivityEvent[];
  loaded: boolean;
  available?: boolean;
  now?: number;
  limit?: number;
  /** Render newest node at the TOP. Purely a render-layer flip — buildTimeline
   *  stays ascending (bursts coalesce on the ascending stream), and collapse
   *  still keeps the newest `limit` nodes. */
  newestFirst?: boolean;
  /** The issue's own creation instant — gates the "created this issue" label. */
  issueCreatedAt?: number | null;
  /** Transport failure reason (fetch/HTTP), so an unreachable MONITOR is not
   *  misreported as an unreadable REPLICA. */
  error?: string | null;
}) {
  const [showAll, setShowAll] = useState(false);

  if (!loaded) {
    return (
      <div data-ticket-timeline-skeleton className="font-mono text-[12px] text-fg-dim">
        Loading discussion…
      </div>
    );
  }

  if (!available) {
    return (
      <div data-ticket-timeline-unavailable className="font-mono text-[12px] text-muted">
        {error
          ? `Linear discussion could not be loaded — request failed (${error}).`
          : "Linear discussion unavailable — the local replica could not be read."}
      </div>
    );
  }

  const nodes = buildTimeline(comments, activity, issueCreatedAt);
  if (nodes.length === 0) {
    return (
      <div data-ticket-timeline-empty className="font-mono text-[12px] text-muted">
        No Linear discussion yet.
      </div>
    );
  }

  const { collapsed, shown } = visibleTimelineNodes(nodes, { limit, showAll, newestFirst });

  return (
    <div data-ticket-timeline>
      {collapsed && (
        <button
          type="button"
          data-ticket-timeline-show-all
          onClick={() => setShowAll(true)}
          className="mb-2 text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
        >
          Show all {nodes.length}
        </button>
      )}
      <ol className="flex flex-col gap-3">
        {shown.map((node) => {
          if (node.kind === "comment") {
            return <CommentItem key={`c-${node.comment.id}`} comment={node.comment} now={now} />;
          }
          if (node.kind === "burst") {
            return <ActivityBurst key={`b-${node.events[0]!.id}`} node={node} now={now} />;
          }
          return (
            <ActivityRow
              key={`e-${node.event.id}`}
              event={node.event}
              isCreation={node.isCreation}
              now={now}
            />
          );
        })}
      </ol>
    </div>
  );
}
