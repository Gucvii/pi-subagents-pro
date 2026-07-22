import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { projectConversation, renderConversation } from "../src/ui/conversation-renderer.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

beforeAll(() => initTheme("dark"));

function theme(marker = "") {
  return {
    fg: (_color: string, text: string) => `${marker}${text}`,
    bold: (text: string) => text,
  };
}

function text(lines: string[]): string {
  return lines.join("\n").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function render(messages: unknown[], expanded = false, running = false, width = 80): string[] {
  return renderConversation(projectConversation(messages), {
    width,
    expanded,
    running,
    theme: theme(),
  });
}

function viewer(messages: unknown[], themed = theme()) {
  const tui = { terminal: { rows: 100, columns: 80 }, requestRender: vi.fn() } as never;
  const session = { messages, subscribe: vi.fn(() => vi.fn()) } as never;
  const record = {
    id: "child-1",
    type: "general-purpose",
    description: "inspect flow",
    status: "running",
    toolUses: 1,
    startedAt: Date.now(),
    lineage: { agentId: "child-1", parentAgentId: "main-id", rootAgentId: "main-id", depth: 1, maxTreeLevels: 3 },
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  } as AgentRecord;
  return new ConversationViewer(tui, session, record, undefined, themed, vi.fn());
}

function content(view: ConversationViewer, width = 76): string[] {
  return (view as unknown as { buildContentLines(width: number): string[] }).buildContentLines(width);
}

describe("conversation execution-flow renderer", () => {
  it("groups messages under user-opened turns and renders Markdown structure", () => {
    const output = text(render([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "# Heading\n\n- one\n- two\n\n```ts\nconst n = 1;\n```" }] },
      { role: "user", content: "second" },
    ]));
    expect(output).toContain("── Turn 1");
    expect(output).toContain("── Turn 2");
    expect(output).toContain("Heading");
    expect(output).toContain("const n = 1;");
    expect(output.indexOf("USER")).toBeLessThan(output.indexOf("ASSISTANT"));
  });

  it("renders one ASSISTANT lane per turn across split assistant messages without reordering", () => {
    const output = text(render([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "before" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "reason" },
        { type: "toolCall", id: "split", name: "read", input: { path: "x" } },
      ] },
      { role: "toolResult", id: "split", content: [{ type: "text", text: "result" }] },
      { role: "assistant", content: [{ type: "text", text: "final" }] },
    ], true));
    expect(output.match(/ASSISTANT/g)).toHaveLength(1);
    expect(output.indexOf("before")).toBeLessThan(output.indexOf("reason"));
    expect(output.indexOf("reason")).toBeLessThan(output.indexOf("READ"));
    expect(output.indexOf("READ")).toBeLessThan(output.indexOf("result"));
    expect(output.indexOf("result")).toBeLessThan(output.indexOf("final"));
  });

  it("keeps anomalous repeated users in one projected turn readable", () => {
    const output = text(renderConversation({
      omittedMessages: 0,
      turns: [{
        number: 1,
        items: [
          { kind: "user", parts: [{ kind: "text", text: "first user" }] },
          { kind: "assistant", parts: [{ kind: "text", text: "first answer" }] },
          { kind: "user", parts: [{ kind: "text", text: "second user" }] },
          { kind: "assistant", parts: [{ kind: "text", text: "second answer" }] },
        ],
      }],
    }, { width: 80, expanded: false, running: false, theme: theme() }));
    expect(output.match(/USER/g)).toHaveLength(2);
    expect(output.match(/ASSISTANT/g)).toHaveLength(1);
    expect(output.indexOf("first user")).toBeLessThan(output.indexOf("second user"));
    expect(output.indexOf("second user")).toBeLessThan(output.indexOf("second answer"));
  });

  it("keeps thinking in order and folds it until Ctrl+O expands details", () => {
    const view = viewer([{ role: "user", content: "go" }, {
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        { type: "thinking", thinking: "secret one\nsecret two" },
        { type: "text", text: "after" },
      ],
    }]);
    const folded = text(content(view));
    expect(folded).toContain("THINKING  2 lines · 21 chars  [collapsed]");
    expect(folded).not.toContain("secret one");
    view.handleInput("\x0f");
    const expanded = text(content(view));
    expect(expanded).toContain("secret one");
    expect(expanded.indexOf("before")).toBeLessThan(expanded.indexOf("secret one"));
    expect(expanded.indexOf("secret one")).toBeLessThan(expanded.indexOf("after"));
    expect(text(view.render(80))).toContain("Ctrl+O collapse");
  });

  it("pairs strict public-schema tool calls/results and expands canonical arguments", () => {
    const toolCall = { type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/real.ts", content: "hello" } } satisfies ToolCall;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "write",
      content: [{ type: "text", text: "written" }],
      isError: false,
      timestamp: 1,
    } satisfies ToolResultMessage;
    const fixture = [
      { role: "assistant", content: [toolCall] },
      toolResult,
    ];
    const output = text(render(fixture, true));
    expect(output.match(/WRITE/g)).toHaveLength(1);
    expect(output).toContain("src/real.ts");
    expect(output).toContain("arguments");
    expect(output).toContain('"content": "hello"');
    expect(output).toContain("written");
  });

  it("pairs tool results once and shows success, error, running, and standalone states", () => {
    const output = text(render([
      { role: "user", content: "tools" },
      { role: "assistant", content: [
        { type: "toolCall", id: "ok", name: "read", input: { path: "src/index.ts" } },
        { type: "toolCall", toolCallId: "bad", name: "bash", input: { command: "false" } },
        { type: "toolCall", toolUseId: "live", name: "grep", input: { pattern: "TODO" } },
      ] },
      { role: "toolResult", toolUseId: "ok", content: [{ type: "text", text: "done" }], durationMs: 12 },
      { role: "toolResult", id: "bad", content: [{ type: "text", text: "failed" }], isError: true },
      { role: "toolResult", id: "orphan", toolName: "write", content: [{ type: "text", text: "orphaned" }] },
    ], false, true));
    expect(output.match(/READ/g)).toHaveLength(1);
    expect(output).toContain("READ  src/index.ts  ✓ 12ms");
    expect(output).toContain("BASH  false  ✗");
    expect(output).toContain("GREP  TODO  ◌");
    expect(output).toContain("WRITE  unmatched result  ✓");
  });

  it("collapses long successful output but expands errors with a hard truncation marker", () => {
    const long = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const success = text(render([
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", input: { path: "x" } }] },
      { role: "toolResult", id: "a", content: [{ type: "text", text: long }] },
    ]));
    expect(success).toContain("[collapsed] 100 lines");
    expect(success).not.toContain("line 99");

    const error = text(render([
      { role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", input: { command: "bad" } }] },
      { role: "toolResult", id: "b", isError: true, content: [{ type: "text", text: "x".repeat(10_000) }] },
    ]));
    expect(error).toContain("[truncated at viewer safety limit]");
  });

  it("does not count a trailing newline as an extra output or thinking line", () => {
    const output = text(render([
      { role: "assistant", content: [
        { type: "thinking", thinking: "one thought\n" },
        { type: "toolCall", id: "newline", name: "bash", input: { command: "logs" } },
      ] },
      {
        role: "toolResult",
        toolCallId: "newline",
        toolName: "bash",
        content: [{ type: "text", text: `${Array.from({ length: 10 }, (_, index) => `log ${index + 1}`).join("\n")}\n` }],
        isError: false,
      },
    ]));
    expect(output).toContain("THINKING  1 line · 12 chars");
    expect(output).toContain("[collapsed] 10 lines");
    expect(output).not.toContain("11 lines");
  });

  it("shows image metadata without exposing base64", () => {
    const payload = "QUJDREVGRw==";
    const output = text(render([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: payload }] }]));
    expect(output).toContain("[image image/png");
    expect(output).not.toContain(payload);
  });

  it("renders real CustomMessage content parts as bounded text and image metadata", () => {
    const payload = "QUJDREVGR0hJSktMTU5PUA==";
    const fixture = {
      role: "custom",
      customType: "extension-status",
      display: true,
      content: [
        { type: "text", text: `extension ready ${"x".repeat(100_000)}` },
        { type: "image", mimeType: "image/webp", data: payload },
      ],
    };
    const output = text(render([fixture]));
    expect(output).toContain("CUSTOM · extension ready");
    expect(output).toContain("[image image/webp");
    expect(output.length).toBeLessThan(70_000);
    expect(output).not.toContain(payload);
    expect(output).not.toContain("metadata entry");
  });

  it("renders custom, branch/compaction summaries, and provider errors", () => {
    const output = text(render([
      { role: "custom", customType: "notice", content: "custom note" },
      { role: "branchSummary", summary: "branch note" },
      { role: "compactionSummary", summary: "compact note", tokensBefore: 123 },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "provider unavailable" },
    ]));
    expect(output).toContain("CUSTOM · custom note");
    expect(output).toContain("BRANCH SUMMARY · branch note");
    expect(output).toContain("COMPACTION · compact note");
    expect(output).toContain("PROVIDER ERROR");
    expect(output).toContain("provider unavailable");
  });

  it("does not expose hidden custom messages and safely wraps visible multiline metadata", () => {
    const hidden = "hidden extension state";
    const lines = render([
      { role: "custom", display: false, content: hidden },
      { role: "custom", content: `first line\n${"wide".repeat(50)}` },
    ], false, false, 40);
    expect(text(lines)).not.toContain(hidden);
    expect(text(lines)).toContain("CUSTOM · first line");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("does not pair a result that precedes its call and pairs duplicate ids FIFO", () => {
    const output = text(render([
      { role: "toolResult", id: "late", toolName: "read", content: [{ type: "text", text: "early" }] },
      { role: "assistant", content: [
        { type: "toolCall", id: "late", name: "read", input: { path: "later.ts" } },
        { type: "toolCall", id: "same", name: "read", input: { path: "one.ts" } },
        { type: "toolCall", id: "same", name: "read", input: { path: "two.ts" } },
      ] },
      { role: "toolResult", id: "same", content: [{ type: "text", text: "first result" }] },
      { role: "toolResult", id: "same", content: [{ type: "text", text: "second result" }] },
    ], false, true));
    expect(output).toContain("READ  unmatched result  ✓");
    expect(output).toContain("READ  later.ts  ◌");
    expect(output.indexOf("one.ts")).toBeLessThan(output.indexOf("first result"));
    expect(output.indexOf("first result")).toBeLessThan(output.indexOf("two.ts"));
    expect(output.indexOf("two.ts")).toBeLessThan(output.indexOf("second result"));
  });

  it("shows tool-result image metadata without base64", () => {
    const payload = "QUJDREVGR0hJSg==";
    const output = text(render([
      { role: "assistant", content: [{ type: "toolCall", id: "image", name: "read", input: { path: "shot.png" } }] },
      { role: "toolResult", id: "image", content: [{ type: "image", mimeType: "image/png", data: payload }] },
    ]));
    expect(output).toContain("[image image/png");
    expect(output).not.toContain(payload);
  });

  it("puts live activity at the end of the current turn", () => {
    const lines = renderConversation(projectConversation([{ role: "user", content: "work" }]), {
      width: 80,
      expanded: false,
      running: true,
      theme: theme(),
      liveActivity: "reading\nsrc/index.ts\tactively",
    });
    expect(lines.at(-1)).not.toMatch(/[\r\n\t]/);
    expect(text(lines.at(-1) ? [lines.at(-1) as string] : [])).toContain("└─ ◌ reading src/index.ts actively");
  });

  it("hard-bounds pathological expanded histories", () => {
    const contentBlocks = Array.from({ length: 20 }, () => ({ type: "thinking", thinking: "x".repeat(20_000) }));
    const lines = render([{ role: "assistant", content: contentBlocks }], true, false, 8);
    expect(lines).toHaveLength(2000);
    expect(text([lines.at(-1) as string])).toContain("[conv");
  });

  it("bounds canonical arguments during traversal for huge strings, arrays, depth, and cycles", () => {
    const hugeArray = new Array(1_000_000).fill("array-value");
    Object.defineProperty(hugeArray, 500, { get: () => { throw new Error("walked beyond node budget"); } });
    const hugeObject: Record<string, unknown> = {};
    for (let index = 0; index < 100_000; index++) hugeObject[`property${index}`] = `value${index}`;
    Object.defineProperty(hugeObject, "property500", { get: () => { throw new Error("read beyond object node budget"); }, enumerable: true });
    const circular: Record<string, unknown> = { label: "circle" };
    circular.self = circular;
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 10_000; index++) deep = { next: deep };
    const started = performance.now();
    const output = text(render([{
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "bounded",
          name: "write",
          arguments: { circular, deep, text: "s".repeat(1_000_000), zArray: hugeArray },
        },
        { type: "toolCall", id: "bounded-object", name: "write", arguments: { object: hugeObject } },
      ],
    }], true));
    const elapsed = performance.now() - started;
    expect(output.length).toBeLessThan(20_000);
    expect(output).toContain("[arguments truncated]");
    expect(output).toContain("[Circular]");
    // A deliberately generous process-level guard catches accidental full walks without timing normal rendering.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("fully removes ESC/C1 CSI and OSC terminal injection from external fields", () => {
    const osc52 = "\x1b]52;c;Y2xpcGJvYXJkLXNlY3JldA==\x07";
    const c1Osc = "\u009d52;c;YzEtY2xpcGJvYXJk\u009c";
    const csi = "\x1b[31mRED\x1b[0m\u009b32mGREEN\u009b0m\rOVERWRITE";
    const output = text(render([
      { role: "custom", customType: `notice${c1Osc}` },
      { role: "assistant", content: [
        { type: "toolCall", id: "inject", name: `read${osc52}`, arguments: { path: `/tmp/${csi}` } },
        { type: "image", mimeType: `image/png${c1Osc}`, data: "QUJD" },
      ], stopReason: "error", errorMessage: `provider ${osc52}${csi}` },
      { role: "toolResult", toolCallId: "inject", toolName: `read${c1Osc}`, content: [{ type: "text", text: `result ${osc52}${csi}` }], isError: true },
    ], true));
    expect(output).not.toContain("clipboard-secret");
    expect(output).not.toContain("Y2xpcGJvYXJkLXNlY3JldA==");
    expect(output).not.toContain("YzEtY2xpcGJvYXJk");
    expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(output).toContain("REDGREEN");
  });

  it.each([8, 40, 80, 120, 216])("keeps every projected line within width %i", (width) => {
    const lines = render([
      { role: "user", content: `界${"x".repeat(500)}` },
      { role: "assistant", content: [{ type: "text", text: `# title\n${"long".repeat(200)}` }] },
    ], true, true, width);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("keeps paused content fixed when a late result is inserted at an earlier tool call", () => {
    const messages: unknown[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "late", name: "read", arguments: { path: "early.txt" } }] },
      ...Array.from({ length: 80 }, (_, index) => ({ role: "user", content: `stable message ${index}` })),
    ];
    const view = viewer(messages);
    view.render(80);
    view.handleInput("\x1b[A");
    const state = view as unknown as { pausedContentLines: string[]; scrollOffset: number; viewportHeight(): number };
    const beforeOffset = state.scrollOffset;
    const before = state.pausedContentLines.slice(beforeOffset, beforeOffset + state.viewportHeight());
    messages.push({ role: "toolResult", toolCallId: "late", toolName: "read", content: [{ type: "text", text: "late result\nwith inserted lines" }], isError: false });
    view.render(80);
    const after = state.pausedContentLines.slice(state.scrollOffset, state.scrollOffset + state.viewportHeight());
    expect(state.scrollOffset).toBe(beforeOffset);
    expect(after).toEqual(before);
    view.handleInput("\x0f");
    expect(text(state.pausedContentLines)).not.toContain("late result");
    expect(text(view.render(80))).toContain("paused");
  });

  it("reflows a paused projection on both shrink and grow while preserving the top anchor", () => {
    const messages: unknown[] = Array.from({ length: 90 }, (_, index) => ({
      role: "user",
      content: `resize anchor ${index} ${"long-content ".repeat(10)}`,
    }));
    const view = viewer(messages);
    view.render(80); // inner width 76
    for (let page = 0; page < 4; page++) view.handleInput("\x1b[5~");
    const state = view as unknown as {
      pausedContentLines: string[];
      pausedRenderWidth: number;
      scrollOffset: number;
      viewportHeight(): number;
    };
    const top = () => state.pausedContentLines
      .slice(state.scrollOffset, state.scrollOffset + state.viewportHeight())
      .map((line) => text([line]).trim())
      .find(Boolean) ?? "";
    const originalAnchor = top();
    const originalCount = state.pausedContentLines.length;

    messages.push({ role: "user", content: "must remain outside the paused snapshot" });
    view.render(44); // inner width 40: genuine reflow must add lines, not merely truncate
    const shrunkAnchor = top();
    const shrunkCount = state.pausedContentLines.length;
    expect(state.pausedRenderWidth).toBe(40);
    expect(shrunkCount).toBeGreaterThan(originalCount);
    expect(originalAnchor.includes(shrunkAnchor) || shrunkAnchor.includes(originalAnchor)).toBe(true);
    expect(text(state.pausedContentLines)).not.toContain("must remain outside");
    for (const line of state.pausedContentLines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);

    view.render(124); // inner width 120: reflow must merge wrapped lines again
    const grownAnchor = top();
    expect(state.pausedRenderWidth).toBe(120);
    expect(state.pausedContentLines.length).toBeLessThan(shrunkCount);
    expect(originalAnchor.includes(grownAnchor) || grownAnchor.includes(originalAnchor)).toBe(true);
    for (const line of state.pausedContentLines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
  });

  it.each(["USER", "ASSISTANT"])("keeps a Turn 5 %s top scoped to Turn 5 through 76→25→100 reflow", (topLabel) => {
    const messages: unknown[] = [];
    for (let turn = 1; turn <= 5; turn++) {
      messages.push({
        role: "user",
        content: `turn-${turn}-user-context-token ${`user-${turn}-detail `.repeat(turn === 5 ? 35 : 8)}`,
      });
      messages.push({
        role: "assistant",
        content: [{
          type: "text",
          text: `turn-${turn}-assistant-context-token ${`assistant-${turn}-detail `.repeat(turn === 5 ? 500 : 8)}`,
        }],
      });
    }
    const view = viewer(messages);
    view.render(80); // inner width 76
    view.handleInput("\x1b[A");
    const state = view as unknown as {
      pausedContentLines: string[];
      pausedRenderWidth: number;
      scrollOffset: number;
    };
    const cleanLines = () => state.pausedContentLines.map((line) => text([line]).trim());
    const turn5 = cleanLines().indexOf("── Turn 5");
    const labelIndex = cleanLines().findIndex((line, index) => index > turn5 && line === topLabel);
    expect(turn5).toBeGreaterThanOrEqual(0);
    expect(labelIndex).toBeGreaterThan(turn5);
    state.scrollOffset = labelIndex;

    const contextToken = topLabel === "USER" ? "turn-5-user-context-token" : "turn-5-assistant-context-token";
    const assertStableAnchor = (expectedWidth: number) => {
      const lines = cleanLines();
      expect(state.pausedRenderWidth).toBe(expectedWidth);
      expect(lines[state.scrollOffset]).toBe(topLabel);
      expect(lines.slice(state.scrollOffset, state.scrollOffset + 4).join("").replace(/\s/g, "")).toContain(contextToken);
      const owningMarker = lines.slice(0, state.scrollOffset + 1).reverse().find((line) => /^── Turn \d+$/.test(line));
      expect(owningMarker).toBe("── Turn 5");
    };

    assertStableAnchor(76);
    view.render(29); // inner width 25
    assertStableAnchor(25);
    view.render(104); // inner width 100
    assertStableAnchor(100);
  });

  it("anchors the current top content while toggling details in paused mode", () => {
    const messages: unknown[] = [
      { role: "assistant", content: [{ type: "toolCall", id: "expand", name: "write", arguments: { path: "a.ts", content: "one\ntwo\nthree" } }] },
      ...Array.from({ length: 90 }, (_, index) => ({ role: "user", content: `anchor message ${index}` })),
    ];
    const view = viewer(messages);
    view.render(80);
    view.handleInput("\x1b[5~");
    const state = view as unknown as { pausedContentLines: string[]; scrollOffset: number; viewportHeight(): number };
    const visibleAnchor = () => state.pausedContentLines
      .slice(state.scrollOffset, state.scrollOffset + state.viewportHeight())
      .map((line) => text([line]))
      .find((line) => line.trim());
    const before = visibleAnchor();
    view.handleInput("\x0f");
    expect(visibleAnchor()).toBe(before);
    expect((view as unknown as { autoScroll: boolean }).autoScroll).toBe(false);
  });

  it("End clears the paused snapshot, resumes live follow, and reveals new content", () => {
    const messages: unknown[] = Array.from({ length: 80 }, (_, index) => ({ role: "user", content: `old ${index}` }));
    const view = viewer(messages);
    view.render(80);
    view.handleInput("\x1b[5~");
    messages.push({ role: "user", content: "NEW LIVE CONTENT" });
    expect(text(content(view))).not.toContain("NEW LIVE CONTENT");
    view.handleInput("\x1b[F");
    expect((view as unknown as { autoScroll: boolean }).autoScroll).toBe(true);
    expect((view as unknown as { pausedContentLines?: string[] }).pausedContentLines).toBeUndefined();
    expect(text(view.render(80))).toContain("NEW LIVE CONTENT");
  });

  it("shows trusted lineage, user-facing level, and persistence in the header", () => {
    const view = viewer([]);
    const record = (view as unknown as { record: AgentRecord }).record;
    record.lineage = {
      agentId: "child-1",
      parentAgentId: "parent-agent-long",
      rootAgentId: "main-id",
      depth: 2,
      maxTreeLevels: 4,
    };
    record.invocation = { sessionPersistence: "memory" };
    const output = text(view.render(120));
    expect(output).toContain("main › parent-a › Agent");
    expect(output).toContain("L3 · memory");
  });

  it("folds newline injection in all single-line renderer metadata", () => {
    const lines = render([
      { role: "assistant", content: [
        { type: "toolCall", id: "inject", name: "read\nBROKEN\tNAME", input: { path: "src\nfile.ts" } },
        { type: "image", mimeType: "image/png\r\nBROKEN-MIME", data: "QUJD" },
      ] },
      { role: "custom", customType: "label\nBROKEN-TYPE", content: [] },
    ], false, true, 80);
    expect(lines.every((line) => !/[\r\n\t\u0085\u2028\u2029]/.test(line))).toBe(true);
    const output = text(lines);
    expect(output).toContain("READ BROKEN NAME  src file.ts");
    expect(output).toContain("[image image/png BROKEN-MIME");
  });

  it("folds newline injection in header description, breadcrumb, model, and path without breaking borders", () => {
    const view = viewer([]);
    const record = (view as unknown as { record: AgentRecord }).record;
    record.description = "inspect\nBROKEN-DESCRIPTION\tflow";
    record.lineage.parentAgentId = "parent\nBROKEN-BREADCRUMB";
    record.lineage.depth = 2;
    record.invocation = { modelName: "provider/model\nBROKEN-MODEL", sessionPersistence: "durable" };
    record.sessionFile = "/tmp/session\nBROKEN-PATH.jsonl";
    const lines = view.render(160);
    expect(lines.every((line) => !/[\r\n\t\u0085\u2028\u2029]/.test(line))).toBe(true);
    const output = text(lines);
    expect(output).toContain("inspect BROKEN-DESCRIPTION flow");
    expect(output).toContain("provider/model BROKEN-MODEL");
    expect(output).toContain("/tmp/session BROKEN-PATH.jsonl");
    expect(lines).toHaveLength((view as unknown as { viewportHeight(): number }).viewportHeight() + 7);
  });

  it("does not cache theme method results across renders", () => {
    let marker = "A:";
    const dynamicTheme = {
      fg: (_color: string, value: string) => `${marker}${value}`,
      bold: (value: string) => value,
    };
    const view = viewer([{ role: "user", content: "hello" }], dynamicTheme);
    expect(content(view).join("\n")).toContain("A:USER");
    marker = "B:";
    view.invalidate();
    const rerendered = content(view).join("\n");
    expect(rerendered).toContain("B:USER");
    expect(rerendered).not.toContain("A:USER");
  });
});
