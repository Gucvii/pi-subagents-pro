/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import { type AgentSession, keyText } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatDuration, formatSessionTokens, formatStorageBytes, getAgentSessionStorage, getDisplayName, getPromptModeLabel } from "./agent-widget.js";
import { type ConversationProjection, projectConversation, renderConversation, sanitizeSingleLineText, sanitizeTerminalText } from "./conversation-renderer.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

function safeDisplay(value: string, maxChars = 1000): string {
  return sanitizeSingleLineText(value.slice(0, maxChars));
}

const TURN_MARKER = /^──\s+Turn\s+(\d+)$/i;
const ANCHOR_CONTEXT_RADIUS = 12;
const ANCHOR_CONTEXT_CHARS = 160;

type TurnAnchor = {
  turnNumber: number;
  lineInTurn: number;
  fractionInTurn: number;
  turnSpan: number;
  context?: string;
  contextDelta: number;
};

type TurnRange = { start: number; end: number; number: number };

function normalizedAnchorLine(line: string): string {
  return sanitizeTerminalText(line)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, ANCHOR_CONTEXT_CHARS)
    .toLocaleLowerCase();
}

function turnNumberAt(line: string): number | undefined {
  const match = TURN_MARKER.exec(normalizedAnchorLine(line));
  return match ? Number(match[1]) : undefined;
}

function findTurnRange(lines: string[], turnNumber: number): TurnRange | undefined {
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    const number = turnNumberAt(lines[index] ?? "");
    if (number === turnNumber) start = index;
    else if (start >= 0 && number !== undefined) return { start, end: index, number: turnNumber };
  }
  return start >= 0 ? { start, end: lines.length, number: turnNumber } : undefined;
}

function isGenericAnchorLine(line: string): boolean {
  if (!line || TURN_MARKER.test(line)) return true;
  return /^(?:user|assistant|├─ thinking\b|└─ provider error\b|branch summary\s*·|compaction\s*·|custom\s*·|│\s*arguments$|│\s*\[collapsed\]|\[conversation truncated\b|\[\d+ older messages omitted\b)/.test(line);
}

function captureTurnAnchor(lines: string[], top: number): TurnAnchor | undefined {
  let range: TurnRange | undefined;
  for (let index = Math.min(top, lines.length - 1); index >= 0; index--) {
    const number = turnNumberAt(lines[index] ?? "");
    if (number !== undefined) {
      range = findTurnRange(lines, number);
      break;
    }
  }
  if (!range || top >= range.end) return undefined;

  const lineInTurn = Math.max(0, top - range.start);
  const turnSpan = Math.max(1, range.end - range.start - 1);
  let context: string | undefined;
  let contextDelta = 0;
  for (let distance = 0; distance <= ANCHOR_CONTEXT_RADIUS && !context; distance++) {
    const candidates = distance === 0 ? [top] : [top + distance, top - distance];
    for (const index of candidates) {
      if (index < range.start || index >= range.end) continue;
      const normalized = normalizedAnchorLine(lines[index] ?? "");
      if (!isGenericAnchorLine(normalized)) {
        context = normalized;
        contextDelta = index - top;
        break;
      }
    }
  }
  return { turnNumber: range.number, lineInTurn, fractionInTurn: lineInTurn / turnSpan, turnSpan, context, contextDelta };
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  /** Immutable rendered lines while the reader is away from live follow. */
  private pausedContentLines: string[] | undefined;
  private pausedProjection: ConversationProjection | undefined;
  private pausedLiveActivity: string | undefined;
  private pausedRunning = false;
  /** Width used to produce pausedContentLines; resize reflows the frozen projection. */
  private pausedRenderWidth: number | undefined;
  private hasKeybindingsManager = false;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Global detail state for thinking, tool arguments, and long outputs. */
  private expanded = false;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
  ) {
    this.hasKeybindingsManager = keybindings !== undefined;
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.keys.toggleDetails(data)) {
      this.expanded = !this.expanded;
      if (!this.autoScroll) this.rerenderPausedWithAnchor();
      this.stopArmed = false;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const contentLines = this.buildContentLines(this.lastInnerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.keys.scrollUp(data)) {
      if (maxScroll > 0) this.pause(contentLines);
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      if (!this.autoScroll && this.scrollOffset >= maxScroll) this.resumeLiveFollow();
    } else if (this.keys.pageUp(data)) {
      if (maxScroll > 0) this.pause(contentLines);
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      if (!this.autoScroll && this.scrollOffset >= maxScroll) this.resumeLiveFollow();
    } else if (matchesKey(data, "home")) {
      if (maxScroll > 0) this.pause(contentLines);
      this.scrollOffset = 0;
    } else if (matchesKey(data, "end")) {
      this.resumeLiveFollow();
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    if (!this.autoScroll && this.pausedRenderWidth !== innerW) this.rerenderPausedWithAnchor(innerW);
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = safeDisplay(getDisplayName(this.record.type), 200);
    // Legacy/in-memory test records may predate persisted lineage. Such records
    // are direct children; never invent an ancestor name.
    const lineage = this.record.lineage ?? { depth: 1, parentAgentId: undefined };
    const parentCrumb = lineage.depth >= 2 && lineage.parentAgentId
      ? safeDisplay(lineage.parentAgentId, 8)
      : undefined;
    const breadcrumb = ["main", lineage.depth >= 3 ? "…" : undefined, parentCrumb, name].filter(Boolean).join(" › ");
    const levelTag = `L${lineage.depth + 1}`;
    const persistenceTag = this.record.invocation?.sessionPersistence ?? "durable";
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${safeDisplay(modeLabel, 100)})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.activity?.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    lines.push(row(
      `${statusIcon} ${th.bold(breadcrumb)}${modeTag} ${th.fg("dim", `${levelTag} · ${safeDisplay(persistenceTag, 100)}`)}  ${th.fg("muted", safeDisplay(this.record.description))} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", safeDisplay(headerParts.join(" · "), 2000))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions stay on the left. Navigation compacts before any core action is
      // removed, and the optional line count is always the first thing dropped.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [th.fg("dim", `${this.detailsKeyText()} ${this.expanded ? "collapse" : "details"}`)];
      if (!this.autoScroll) actions.push(th.fg("warning", "paused"));
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      const verboseNavigation = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");
      const compactNavigation = th.fg("dim", "↑↓/Pg scroll · Esc close");
      const actionHints = actions.join(sep);
      const footerRight = visibleWidth(actionHints) + visibleWidth(verboseNavigation) + 1 <= innerW
        ? verboseNavigation
        : compactNavigation;

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the core actions.
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, actionHints].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actionHints;

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void {
    if (!this.autoScroll) this.rerenderPausedWithAnchor();
  }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = (modelName ? [modelName, ...tags] : tags).map((part) => safeDisplay(part));
    const storage = getAgentSessionStorage(this.record);
    if (storage.sizeBytes != null) parts.push(formatStorageBytes(storage.sizeBytes));
    if (storage.path) parts.push(safeDisplay(storage.path, 2000));
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (!this.autoScroll && this.pausedContentLines) return this.pausedContentLines;
    return this.buildLiveContentLines(width);
  }

  private buildLiveContentLines(width: number): string[] {
    return this.renderProjection(
      projectConversation(this.session.messages),
      width,
      this.record.status === "running",
      this.currentLiveActivity(),
    );
  }

  private renderProjection(projection: ConversationProjection, width: number, running: boolean, liveActivity?: string): string[] {
    if (width <= 0) return [];
    return renderConversation(projection, {
      width,
      expanded: this.expanded,
      running,
      theme: this.theme,
      liveActivity,
    });
  }

  private currentLiveActivity(): string | undefined {
    return this.record.status === "running" && this.activity
      ? describeActivity(this.activity.activeTools, this.activity.responseText)
      : undefined;
  }

  private pause(lines: string[]): void {
    if (!this.autoScroll) return;
    this.autoScroll = false;
    this.pausedProjection = projectConversation(this.session.messages);
    this.pausedRunning = this.record.status === "running";
    this.pausedLiveActivity = this.currentLiveActivity();
    this.pausedContentLines = lines.slice();
    this.pausedRenderWidth = this.lastInnerW;
  }

  private resumeLiveFollow(): void {
    this.autoScroll = true;
    this.pausedContentLines = undefined;
    this.pausedProjection = undefined;
    this.pausedLiveActivity = undefined;
    this.pausedRunning = false;
    this.pausedRenderWidth = undefined;
    const live = this.buildLiveContentLines(this.lastInnerW);
    this.scrollOffset = Math.max(0, live.length - this.viewportHeight());
  }

  private rerenderPausedWithAnchor(width = this.lastInnerW): void {
    const oldLines = this.pausedContentLines;
    if (!oldLines) return;
    const viewportHeight = this.viewportHeight();
    const oldOffset = Math.min(this.scrollOffset, Math.max(0, oldLines.length - viewportHeight));
    const anchor = captureTurnAnchor(oldLines, oldOffset);
    const next = this.pausedProjection
      ? this.renderProjection(this.pausedProjection, width, this.pausedRunning, this.pausedLiveActivity)
      : oldLines.slice();
    let nextOffset = Math.min(oldOffset, Math.max(0, next.length - viewportHeight));
    const nextTurn = anchor ? findTurnRange(next, anchor.turnNumber) : undefined;
    if (anchor && nextTurn) {
      const nextSpan = Math.max(1, nextTurn.end - nextTurn.start - 1);
      const fallbackLine = nextSpan === anchor.turnSpan
        ? anchor.lineInTurn
        : Math.round(anchor.fractionInTurn * nextSpan);
      nextOffset = nextTurn.start + Math.min(nextSpan, fallbackLine);

      if (anchor.context) {
        const expectedContext = nextOffset + anchor.contextDelta;
        let bestIndex = -1;
        let bestQuality = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        // Deliberately search only inside the captured Turn. Repeated USER,
        // ASSISTANT, THINKING, and branch structure in other Turns is irrelevant.
        for (let index = nextTurn.start; index < nextTurn.end; index++) {
          const candidate = normalizedAnchorLine(next[index] ?? "");
          if (isGenericAnchorLine(candidate)) continue;
          const quality = candidate === anchor.context
            ? 3
            : candidate.length >= 4 && (candidate.startsWith(anchor.context) || anchor.context.startsWith(candidate))
              ? 2
              : candidate.length >= 4 && (candidate.includes(anchor.context) || anchor.context.includes(candidate)) ? 1 : 0;
          if (quality === 0) continue;
          const distance = Math.abs(index - expectedContext);
          if (quality > bestQuality || (quality === bestQuality && distance < bestDistance)) {
            bestIndex = index;
            bestQuality = quality;
            bestDistance = distance;
          }
        }
        if (bestIndex >= 0) nextOffset = bestIndex - anchor.contextDelta;
      }
      nextOffset = Math.max(nextTurn.start, Math.min(nextOffset, nextTurn.end - 1));
    }
    this.pausedContentLines = next;
    this.pausedRenderWidth = width;
    this.scrollOffset = Math.min(nextOffset, Math.max(0, next.length - viewportHeight));
  }

  private detailsKeyText(): string {
    try {
      const configured = safeDisplay(keyText("app.tools.expand"), 100).trim();
      return configured || (this.hasKeybindingsManager ? "unbound" : "Ctrl+O");
    } catch {
      return "Ctrl+O";
    }
  }
}
