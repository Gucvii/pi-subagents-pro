import { describe, expect, it, vi } from "vitest";
import { deriveAgentDescription, formatPromptPreview, renderAgentCallCard, renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import { type AgentActivity, AgentWidget, fgPreservingNestedStyles, formatInvocationIdentity, formatSessionTokens, formatTurns } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("formatTurns", () => {
  it("separates the turn glyph from the first digit", () => {
    expect(formatTurns(9, 100)).toBe("↻ 9≤100");
    expect(formatTurns(9)).toBe("↻ 9");
  });
});

describe("agent invocation presentation", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  it("renders prompt, model, effort, context, and background mode before launch", () => {
    const component = renderAgentCallCard({
      displayName: "Reviewer",
      description: "复核旧插件缺陷",
      prompt: "Read the implementation and report only verified issues.",
      model: "opencode-go/deepseek-v4-flash",
      thinking: "max",
      runInBackground: true,
      inheritContext: false,
      sessionPersistence: "durable",
    }, theme);

    expect(component.render(200).map(line => line.trimEnd())).toEqual([
      "◆ Reviewer  复核旧插件缺陷  BACKGROUND",
      "  opencode-go/deepseek-v4-flash · effort max · fresh context · durable session",
      "  └─ prompt Read the implementation and report only verified issues.",
    ]);
  });

  it("shows a clean inheritance state, then updates the same card with the resolved identity", () => {
    const call = {
      displayName: "Agent",
      prompt: "Inspect the repository.",
      runInBackground: false,
      inheritContext: false,
    };
    const component = renderAgentCallCard(call, theme);

    expect(component.render(200).map(line => line.trimEnd())).toContain(
      "  inherits main · fresh context",
    );

    const updated = renderAgentCallCard({
      ...call,
      model: "openai-codex/gpt-5.6-sol",
      thinking: "medium",
      sessionPersistence: "memory" as const,
    }, theme, component);

    expect(updated).toBe(component);
    expect(updated.render(200).map(line => line.trimEnd())).toContain(
      "  openai-codex/gpt-5.6-sol · effort medium · fresh context · memory session",
    );
    expect(updated.render(200).join("\n")).not.toContain("<inherit main>");
  });

  it("normalizes and truncates prompt previews", () => {
    expect(formatPromptPreview(" first\n\n second ")).toBe("first second");
    expect(formatPromptPreview("123456", 5)).toBe("1234…");
  });

  it("derives optional descriptions from the prompt", () => {
    expect(deriveAgentDescription("  Review auth. Then report. ")).toBe("Review auth.");
    expect(deriveAgentDescription("", 10)).toBe("Subagent task");
    expect(deriveAgentDescription("123456", 5)).toBe("1234…");
  });

  it("formats compact model and effort identity", () => {
    expect(formatInvocationIdentity({
      modelName: "opencode-go/deepseek-v4-flash",
      thinking: "max",
      sessionPersistence: "durable",
    }, true)).toBe("deepseek-v4-flash · effort max · durable session");
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  function makeRecord(id: string, opts: { isBackground?: boolean; rootAgentId?: string } = {}) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: opts.isBackground,
      lineage: { agentId: id, parentAgentId: opts.rootAgentId ?? "root", rootAgentId: opts.rootAgentId ?? "root", depth: 1, maxTreeLevels: 3 },
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(
    manager: unknown,
    activityId: string,
    mode?: () => WidgetMode,
    predicate?: (record: ReturnType<typeof makeRecord>) => boolean,
  ): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
      predicate,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode with model and effort", () => {
    const record = {
      ...makeRecord("background", { isBackground: true }),
      invocation: { modelName: "opencode-go/deepseek-v4-flash", thinking: "max" },
    };
    const manager = { listAgents: () => [record] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
    expect(lines).toContain("deepseek-v4-flash · effort max");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  it("applies the optional record predicate after mode filtering", () => {
    const foreground = makeRecord("foreground", { isBackground: false, rootAgentId: "foreign" });
    const current = makeRecord("current", { isBackground: true, rootAgentId: "current-root" });
    const foreign = makeRecord("foreign", { isBackground: true, rootAgentId: "foreign-root" });
    const manager = { listAgents: () => [foreground, current, foreign] };
    const seen: string[] = [];
    const lines = renderLines(manager, "foreign", () => "background", record => {
      seen.push(record.id);
      return record.lineage.rootAgentId !== "current-root";
    });

    expect(seen).toEqual(["current", "foreign", "current", "foreign"]); // update + render; foreground was removed by mode first
    expect(lines).toContain("foreign description");
    expect(lines).not.toContain("current description");
    expect(lines).not.toContain("foreground description");
  });

  it("uses live records and resolves activity by record identity while isolating provider errors", () => {
    const broken = { ...makeRecord("same"), description: "broken owner" };
    const healthy = { ...makeRecord("same"), description: "healthy owner" };
    const healthyActivity: AgentActivity = {
      ...makeActivity(),
      turnCount: 9,
      maxTurns: 10,
      toolUses: 3,
      lifetimeUsage: { input: 2_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const owners = new WeakMap<object, "broken" | "healthy">([
      [broken, "broken"],
      [healthy, "healthy"],
    ]);
    const widget = new AgentWidget(
      { listAgents: () => [] } as any,
      new Map(),
      () => "all",
      () => true,
      () => [broken, healthy],
      record => {
        if (owners.get(record) === "broken") throw new Error("provider failed");
        return owners.get(record) === "healthy" ? healthyActivity : undefined;
      },
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    const lines = factory({ terminal: { columns: 160 }, requestRender: () => {} }, theme).render().join("\n");

    expect(lines).toContain("broken owner");
    expect(lines).toContain("healthy owner");
    expect(lines).toContain("↻ 9≤10");
    expect(lines).toContain("3 tool uses");
    expect(lines).toContain("2.0k");
  });

  it("supports live current-root deduplication with Fleet off and suspended fallbacks", () => {
    const rootA = makeRecord("agent-A", { isBackground: true, rootAgentId: "root-A" });
    const rootB = makeRecord("agent-B", { isBackground: true, rootAgentId: "root-B" });
    const manager = { listAgents: () => [rootA, rootB] };
    let fleetEnabled = true;
    let currentRoot: string | undefined = "root-A";
    const predicate = (record: ReturnType<typeof makeRecord>) =>
      !fleetEnabled || currentRoot === undefined || record.lineage.rootAgentId !== currentRoot;
    const render = () => renderLines(manager, "agent-A", () => "all", predicate);

    expect(render()).not.toContain("agent-A description");
    expect(render()).toContain("agent-B description");
    currentRoot = "root-B";
    expect(render()).toContain("agent-A description");
    expect(render()).not.toContain("agent-B description");
    fleetEnabled = false;
    expect(render()).toContain("agent-A description");
    expect(render()).toContain("agent-B description");
    fleetEnabled = true;
    currentRoot = undefined;
    expect(render()).toContain("agent-A description");
    expect(render()).toContain("agent-B description");
  });

  it("restarts its stopped interval when an update discovers an active external record", () => {
    vi.useFakeTimers();
    try {
      const records: ReturnType<typeof makeRecord>[] = [];
      const source = vi.fn(() => records);
      const widget = new AgentWidget(
        { listAgents: () => [] } as any,
        new Map(),
        () => "all",
        () => true,
        source,
      );
      widget.setUICtx({ setStatus: vi.fn(), setWidget: vi.fn() });
      widget.update();
      const idleCalls = source.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(source).toHaveBeenCalledTimes(idleCalls);

      records.push(makeRecord("external"));
      widget.update();
      const discoveredCalls = source.mock.calls.length;
      vi.advanceTimersByTime(250);
      expect(source.mock.calls.length).toBeGreaterThan(discoveredCalls);
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });
});
