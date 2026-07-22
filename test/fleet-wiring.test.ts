/**
 * fleet-wiring.test.ts — end-to-end wiring of the FleetView through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the fleet the live UI (so it captures input), that spawning a background
 * agent actually registers the `belowEditor` widget once the first agent has a session,
 * and that `session_shutdown` tears it down. runAgent is mocked (no LLM); the
 * manager, settings load, completion routing, and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import {
  getFleetRegistryListenerCountForTests,
  getFleetRegistrySizeForTests,
  listFleetAgentHandles,
  resetFleetRegistryForTests,
} from "../src/ui/fleet-registry.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces the widget + fleet touch; setWidget is spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctxWith(
  ui: ReturnType<typeof uiCtx>,
  sessionId = "s1",
  lineage?: { agentId: string; parentAgentId?: string; rootAgentId: string; depth: number; maxTreeLevels: number },
) {
  const branch = lineage
    ? [{ type: "custom", customType: "pi-subagents:lineage", data: lineage }]
    : [];
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: { provider: "test", id: "model", name: "Test Model" },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => provider === "test" && id === "model"
        ? { provider, id, name: "Test Model" }
        : undefined),
      getAvailable: vi.fn(() => [{ provider: "test", id: "model", name: "Test Model" }]),
    },
    sessionManager: { getSessionId: () => sessionId, getSessionDir: () => process.cwd(), getBranch: () => branch },
    getSystemPrompt: () => "parent",
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    resetFleetRegistryForTests();
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // async join → completion routes straight to sendIndividualNudge (no batch
    // debounce), so fleet.onAgentFinished fires synchronously on the result.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async" }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not register an activation that never receives session_start", () => {
    const { pi } = makePi();
    subagentsExtension(pi);
    expect(getFleetRegistrySizeForTests()).toBe(0);
  });

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("wakes an idle foreign Widget, ages a foreign completion, and stops updates after unsubscribe", async () => {
    const finish = new Map<string, () => void>();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => {
      const session = { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => vi.fn()) } as any;
      queueMicrotask(() => options.onSessionCreated?.(session));
      return new Promise(resolve => {
        finish.set(prompt, () => resolve({ responseText: `done ${prompt}`, session, aborted: false, steered: false }));
      });
    });

    const observer = makePi();
    const producer = makePi();
    subagentsExtension(observer.pi);
    subagentsExtension(producer.pi);
    expect(getFleetRegistryListenerCountForTests()).toBe(2);

    const observerUI = uiCtx();
    const producerUI = uiCtx();
    const observerCtx = ctxWith(observerUI, "observer-root");
    const producerCtx = ctxWith(producerUI, "producer-root");
    await observer.lifecycle.get("session_start")?.({}, observerCtx);
    await observer.lifecycle.get("tool_execution_start")?.({}, observerCtx);
    expect(observerUI.setWidget.mock.calls.some(call => call[0] === "agents" && typeof call[1] === "function")).toBe(false);

    await producer.lifecycle.get("session_start")?.({}, producerCtx);
    await producer.tools.get("Agent").execute(
      "tc-foreign",
      { prompt: "foreign-work", description: "appeared from another manager", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined, undefined, producerCtx,
    );
    await flush();

    const widgetFactory = observerUI.setWidget.mock.calls
      .filter(call => call[0] === "agents" && typeof call[1] === "function")
      .at(-1)?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
    expect(widgetFactory, "a stopped/empty Widget should wake on a foreign publish").toBeDefined();
    const component = widgetFactory!({ terminal: { columns: 160 }, requestRender: vi.fn() }, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    expect(component.render().join("\n")).toContain("appeared from another manager");

    finish.get("foreign-work")?.();
    await flush();
    expect(component.render().join("\n")).toContain("appeared from another manager");
    await observer.lifecycle.get("tool_execution_start")?.({}, observerCtx);
    expect(observerUI.setWidget).toHaveBeenLastCalledWith("agents", undefined);

    await observer.lifecycle.get("session_shutdown")?.({}, observerCtx);
    expect(getFleetRegistryListenerCountForTests()).toBe(1);
    const observerUpdatesAfterShutdown = observerUI.setWidget.mock.calls.length;
    await producer.tools.get("Agent").execute(
      "tc-after-unsubscribe",
      { prompt: "after-unsubscribe", description: "must not update observer", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined, undefined, producerCtx,
    );
    await flush();
    expect(observerUI.setWidget.mock.calls).toHaveLength(observerUpdatesAfterShutdown);

    await producer.lifecycle.get("session_shutdown")?.({}, producerCtx);
    expect(getFleetRegistryListenerCountForTests()).toBe(0);
  });

  it("registers the belowEditor widget once a spawned agent has a session, then clears it on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(ui));
    expect(getFleetRegistrySizeForTests()).toBe(1);
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // fleet captures THIS ui

    const spawn = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined,
      undefined,
      ctxWith(ui),
    );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush(); // completion → fleet.onAgentFinished → update → widget registers

    const fleetRegs = ui.setWidget.mock.calls.filter(c => c[0] === "fleet" && typeof c[1] === "function");
    expect(fleetRegs.length, "fleet widget should register with a render factory").toBeGreaterThan(0);
    expect(ui.setWidget.mock.calls.some(c => c[0] === "agents" && typeof c[1] === "function"),
      "the current Fleet root must not duplicate into the above-editor widget").toBe(false);

    const fleetFactory = fleetRegs.at(-1)![1] as (tui: any, theme: any) => { render(width: number): string[] };
    const lines = fleetFactory({ requestRender: vi.fn() }, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }).render(120);
    expect(lines.some(line => line.includes("main"))).toBe(true);
    expect(lines.some(line => line.includes("live one"))).toBe(true);

    // Deduplicating the live AgentWidget must not suppress the existing static
    // follow-up notification/card delivered into the parent conversation.
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification", display: true }),
      { deliverAs: "followUp", triggerTurn: true },
    ));

    await lifecycle.get("session_shutdown")?.({}, ctxWith(ui));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined); // Fleet dispose cleared it
    expect(ui.setWidget).toHaveBeenCalledWith("agents", undefined); // Widget dispose cleared it
    expect(ui.setStatus).toHaveBeenCalledWith("subagents", undefined);
    expect(getFleetRegistrySizeForTests()).toBe(0);
  });

  it("aggregates a foreign-root grandchild from its real child manager without duplicating the current root", async () => {
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => {
      const session = {
        dispose: vi.fn(),
        messages: [],
        subscribe: vi.fn(() => vi.fn()),
      } as any;
      queueMicrotask(() => {
        options.onSessionCreated?.(session);
        if (prompt === "hold grandchild") {
          options.onTurnEnd?.(7);
          options.onToolActivity?.({ type: "start", toolName: "bash" });
          options.onToolActivity?.({ type: "end", toolName: "bash" });
          options.onToolActivity?.({ type: "start", toolName: "bash" });
          options.onAssistantUsage?.({ input: 1_200, output: 300, cacheWrite: 0 });
        } else if (prompt === "hold B") {
          options.onTurnEnd?.(2);
        }
      });
      return new Promise(() => {});
    });

    // Two extension activations own two actual AgentManagers. The first owns the
    // old-root parent/current-root child; the second (the parent Agent activation)
    // owns the nested grandchild.
    const rootRuntime = makePi();
    const childRuntime = makePi();
    subagentsExtension(rootRuntime.pi);
    subagentsExtension(childRuntime.pi);
    const rootUI = uiCtx();
    const childUI = uiCtx();
    const rootA = ctxWith(rootUI, "root-A");
    const rootB = ctxWith(rootUI, "root-B");

    await rootRuntime.lifecycle.get("session_start")?.({}, rootA);
    await rootRuntime.lifecycle.get("tool_execution_start")?.({}, rootA);
    await rootRuntime.tools.get("Agent").execute(
      "tc-parent",
      { prompt: "hold parent", description: "old root parent", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined, undefined, rootA,
    );
    await flush();
    const parent = listFleetAgentHandles().find(handle => handle.record.description === "old root parent")?.record;
    expect(parent).toBeDefined();

    const parentActivation = ctxWith(childUI, "child-manager-session", parent!.lineage);
    await childRuntime.lifecycle.get("session_start")?.({}, parentActivation);
    await childRuntime.lifecycle.get("tool_execution_start")?.({}, parentActivation);
    await childRuntime.tools.get("Agent").execute(
      "tc-grand",
      { prompt: "hold grandchild", description: "foreign grandchild", subagent_type: "general-purpose", model: "test/model", thinking: "off", max_turns: 12, run_in_background: true },
      undefined, undefined, parentActivation,
    );
    await flush();
    const grandHandle = listFleetAgentHandles().find(handle => handle.record.description === "foreign grandchild");
    expect(grandHandle?.record.lineage).toMatchObject({
      parentAgentId: parent!.id,
      rootAgentId: "root-A",
      depth: 2,
    });
    expect(grandHandle?.provider.owner).not.toBe(
      listFleetAgentHandles().find(handle => handle.record === parent)?.provider.owner,
    );

    await rootRuntime.lifecycle.get("session_before_switch")?.({}, rootA);
    await rootRuntime.lifecycle.get("session_start")?.({}, rootB);
    await rootRuntime.lifecycle.get("tool_execution_start")?.({}, rootB);
    await rootRuntime.tools.get("Agent").execute(
      "tc-B",
      { prompt: "hold B", description: "current root worker", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined, undefined, rootB,
    );
    await flush();
    expect(listFleetAgentHandles().find(handle => handle.record.description === "current root worker")?.record.lineage.rootAgentId)
      .toBe("root-B");
    // Refresh the UI after the async session-created callback made the row openable.
    await rootRuntime.lifecycle.get("tool_execution_start")?.({}, rootB);

    const widgetFactory = rootUI.setWidget.mock.calls
      .filter(c => c[0] === "agents" && typeof c[1] === "function")
      .at(-1)?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
    expect(widgetFactory).toBeDefined();
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const widgetLines = widgetFactory!({ terminal: { columns: 200 }, requestRender: vi.fn() }, theme)
      .render().join("\n");
    expect(widgetLines).toContain("old root parent");
    expect(widgetLines).toContain("foreign grandchild");
    expect(widgetLines).toContain("↻ 7≤12");
    expect(widgetLines).toContain("1 tool use");
    expect(widgetLines).toContain("1.5k");
    expect(widgetLines).not.toContain("current root worker");


    await childRuntime.lifecycle.get("session_shutdown")?.({}, parentActivation);
    await rootRuntime.lifecycle.get("session_shutdown")?.({}, rootB);
  });

  it("shows both running roots in Widget when Fleet is off", async () => {
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      defaultJoinMode: "async",
      fleetView: false,
      widgetMode: "all",
    }));
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      const session = { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => vi.fn()) } as any;
      queueMicrotask(() => options.onSessionCreated?.(session));
      return new Promise(() => {});
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    const rootA = ctxWith(ui, "fleet-off-A");
    const rootB = ctxWith(ui, "fleet-off-B");
    await lifecycle.get("session_start")?.({}, rootA);
    await lifecycle.get("tool_execution_start")?.({}, rootA);
    await tools.get("Agent").execute(
      "tc-off-A",
      { prompt: "hold A", description: "off root A", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined, undefined, rootA,
    );
    await flush();
    await lifecycle.get("session_before_switch")?.({}, rootA);
    await lifecycle.get("session_start")?.({}, rootB);
    await tools.get("Agent").execute(
      "tc-off-B",
      { prompt: "hold B", description: "off root B", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined, undefined, rootB,
    );
    await flush();

    const factory = ui.setWidget.mock.calls
      .filter(c => c[0] === "agents" && typeof c[1] === "function")
      .at(-1)?.[1] as ((tui: any, theme: any) => { render(): string[] }) | undefined;
    expect(factory).toBeDefined();
    const lines = factory!({ terminal: { columns: 160 }, requestRender: vi.fn() }, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }).render().join("\n");
    expect(lines).toContain("off root A");
    expect(lines).toContain("off root B");
    expect(ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function")).toBe(false);

    await lifecycle.get("session_shutdown")?.({}, rootB);
  });

  it("shows running plus sessionless queued records through real concurrency wiring", async () => {
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      defaultJoinMode: "async",
      maxConcurrent: 1,
    }));
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      const session = {
        dispose: vi.fn(),
        messages: [],
        subscribe: vi.fn(() => vi.fn()),
      } as any;
      queueMicrotask(() => options.onSessionCreated?.(session));
      return new Promise(() => {});
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(ui));
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    await tools.get("Agent").execute(
      "tc-running",
      { prompt: "hold", description: "running slot", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined, undefined, ctxWith(ui),
    );
    await flush(); // first record receives its session
    await tools.get("Agent").execute(
      "tc-queued",
      { prompt: "wait", description: "queued slot", subagent_type: "general-purpose", model: "test/model", thinking: "low", run_in_background: true },
      undefined, undefined, ctxWith(ui),
    );

    expect(runAgent).toHaveBeenCalledTimes(1); // second record is genuinely queued/sessionless
    const fleetFactory = ui.setWidget.mock.calls
      .filter(c => c[0] === "fleet" && typeof c[1] === "function")
      .at(-1)?.[1] as ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
    expect(fleetFactory).toBeDefined();
    const lines = fleetFactory!({ requestRender: vi.fn() }, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    }).render(160);
    expect(lines.some(line => line.includes("running slot"))).toBe(true);
    expect(lines.some(line => line.includes("queued slot") && line.includes("model · low · durable"))).toBe(true);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(ui));
  });

  it("restores the configured above-editor widget when Fleet is disabled", async () => {
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({
      schedulingEnabled: false,
      defaultJoinMode: "async",
      fleetView: false,
      widgetMode: "all",
    }));
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("session_start")?.({}, ctxWith(ui));
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    await tools.get("Agent").execute(
      "tc-widget",
      { prompt: "go", description: "widget one", subagent_type: "general-purpose", model: "test/model", thinking: "off", run_in_background: true },
      undefined,
      undefined,
      ctxWith(ui),
    );
    await flush();

    expect(ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function")).toBe(false);
    expect(ui.setWidget.mock.calls.some(c => c[0] === "agents" && typeof c[1] === "function")).toBe(true);
    await lifecycle.get("session_shutdown")?.({}, ctxWith(ui));
  });
});
