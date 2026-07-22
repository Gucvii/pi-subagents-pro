import { Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { FleetList, type FleetUICtx, formatFleetElapsed, formatFleetTokens, rightAlign } from "../src/ui/fleet-list.js";
import { getFleetRegistrySizeForTests, registerFleetOwner, resetFleetRegistryForTests } from "../src/ui/fleet-registry.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
// Kitty-protocol key-RELEASE for ↓ (event type 3) — listeners receive these too.
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

beforeEach(() => resetFleetRegistryForTests());

/** A no-op session so a record is "openable" by default (the list hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  const id = over.id ?? "a1";
  return {
    id,
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    lineage: { agentId: id, parentAgentId: "root", rootAgentId: "root", depth: 1, maxTreeLevels: 3 },
    ...over,
  } as AgentRecord;
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: vi.fn(() => true),
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  /** The overlay component (a real ConversationViewer) once one is opened. */
  overlayComponent: () => { handleInput(data: string): void } | undefined;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Render the currently-registered below-editor widget at the given width. */
  render: (width?: number) => string[];
  setEditorText: (t: string) => void;
  /** Whether an overlay has been opened. */
  overlayOpened: () => boolean;
  /** Whether the most recently opened overlay's `done` was invoked (closed). */
  overlayClosed: () => boolean;
  notifications: () => string[];
  widgetClears: () => number;
  /** Simulate the viewer closing itself (Esc → done); flushes the close microtask. */
  closeOverlay: () => Promise<void>;
  /** The fake `tui` handed to the widget factory; tests set `focusedComponent` on it. */
  widgetTui: { requestRender(): void; focusedComponent?: unknown };
}

function harness(agents: AgentRecord[], activity = new Map<string, AgentActivity>()): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
  const notifications: string[] = [];
  let widgetClears = 0;
  let overlayComponent: { handleInput(data: string): void } | undefined;
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    setWidget: (_key, content) => {
      if (content === undefined) widgetClears++;
      widgetFactory = content as any;
    },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    notify: (message) => { notifications.push(message); },
    custom: ((factory: any) => {
      opened = true;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => { closed = true; overlayDone = undefined; resolve(r); };
        overlayDone = done;
        // Construct the overlay component so the controller wires viewerClose,
        // and keep it so tests can drive the real ConversationViewer's input.
        overlayComponent = factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const fleet = new FleetList(manager, activity);
  fleet.setCurrentIdentity({ agentId: "root", rootAgentId: "root", depth: 0, maxTreeLevels: 3 });
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    ui,
    manager,
    overlayComponent: () => overlayComponent,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    notifications: () => notifications,
    widgetClears: () => widgetClears,
    closeOverlay: async () => { overlayDone?.(undefined); await Promise.resolve(); },
    widgetTui: fakeTui,
  };
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("uses only a down-arrow and compact count", () => {
    expect(formatFleetTokens(16_900)).toBe("↓ 16.9k");
    expect(formatFleetTokens(950)).toBe("↓ 950");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M");
  });
});

describe("rightAlign", () => {
  it("returns the complete right side with no forced gap when widths are equal", () => {
    expect(rightAlign("left", "ends-in-k", 9)).toBe("ends-in-k");
  });

  it("clamps only the right side when it is wider than the total width", () => {
    expect(rightAlign("left", "ends-in-k", 8)).toBe(truncateToWidth("ends-in-k", 8));
  });
});

describe("FleetList registry lifecycle", () => {
  it("does not register before binding, registers once across switches, and disposes idempotently", () => {
    const fleet = new FleetList(fakeManager([]), new Map());
    expect(getFleetRegistrySizeForTests()).toBe(0);
    expect(fleet.getCurrentRootAgentId()).toBeUndefined();
    fleet.setCurrentIdentity({ agentId: "A", rootAgentId: "A", depth: 0, maxTreeLevels: 3 });
    expect(getFleetRegistrySizeForTests()).toBe(1);
    expect(fleet.getCurrentRootAgentId()).toBe("A");
    fleet.onSessionBeforeSwitch();
    expect(getFleetRegistrySizeForTests()).toBe(1);
    expect(fleet.getCurrentRootAgentId()).toBeUndefined();
    fleet.setCurrentIdentity({ agentId: "B", rootAgentId: "B", depth: 0, maxTreeLevels: 3 });
    expect(fleet.getCurrentRootAgentId()).toBe("B");
    fleet.onSessionBeforeSwitch();
    fleet.setCurrentIdentity({ agentId: "C", rootAgentId: "C", depth: 0, maxTreeLevels: 3 });
    expect(getFleetRegistrySizeForTests()).toBe(1);
    fleet.dispose();
    fleet.dispose();
    expect(getFleetRegistrySizeForTests()).toBe(0);
  });

  it("refuses an invalid first identity without registering", () => {
    const fleet = new FleetList(fakeManager([]), new Map());
    fleet.setCurrentIdentity({ agentId: "", rootAgentId: "", depth: 0, maxTreeLevels: 0 });
    expect(getFleetRegistrySizeForTests()).toBe(0);
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("renders main and the agent tree before any key, then activates on ↓", () => {
    const h = harness([makeRecord({ description: "default visible" })]);
    const initial = h.render();
    expect(initial.some(line => line.includes("main"))).toBe(true);
    expect(initial.some(line => line.includes("default visible"))).toBe(true);

    const res = h.press(DOWN);
    expect(res).toEqual({ consume: true });
    // main selected, list active → nav hint shown
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("also activates on ← (matches the '←/↓ manage' hint)", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("does NOT activate when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);          // activate → selection on main (idx 0)
    h.press(DOWN_RELEASE);  // release half of the SAME tap — must be a no-op
    expect(h.render().find(l => l.includes("main"))).toContain("⏺");
    h.press(DOWN);          // a real second tap → first agent
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("⏺");
    expect(h.render().find(l => l.includes("two"))).toContain("◯");
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate → index 0 (main)
    h.press(DOWN); // → 1 (a1)
    expect(h.render().find(l => l.includes("one"))).toContain("⏺");
    h.press(DOWN); // → 2 (a2)
    h.press(DOWN); // clamp at 2
    expect(h.render().find(l => l.includes("two"))).toContain("⏺");
    expect(h.render().find(l => l.includes("one"))).toContain("◯");
  });

  it("active ↑ on main dismisses the tree; inactive ↑ remains editor history", () => {
    const h = harness([makeRecord()]);
    expect(h.press(UP)).toBeUndefined();
    h.press(DOWN);
    expect(h.press(UP)).toEqual({ consume: true });
    expect(h.render()).toEqual([]);
  });

  it("keeps the refresh timer running while dismissed", () => {
    vi.useFakeTimers();
    try {
      const h = harness([makeRecord()]);
      const listAgents = vi.spyOn(h.manager, "listAgents");
      h.press(DOWN);
      h.press(UP);
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(1000);
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      expect(h.render()).toEqual([]);
      expect(h.widgetClears()).toBe(0);
      h.fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("↓ or ← restores a dismissed tree and enters navigation with explicit Editor focus", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    h.press(UP);
    h.widgetTui.focusedComponent = realEditor();
    h.render();
    expect(h.press(DOWN)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
    h.press(UP);
    h.widgetTui.focusedComponent = realEditor();
    h.render();
    expect(h.press(LEFT)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("Esc exits navigation without hiding the tree", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(ESC)).toEqual({ consume: true });
    const lines = h.render();
    expect(lines.some(l => l.includes("←/↓ manage"))).toBe(true);
    expect(lines.some(l => l.includes("Sleep then report 1"))).toBe(true);
  });

  it("resets dismissal after the tree becomes empty so the next batch auto-appears", () => {
    const agents = [makeRecord({ id: "old", description: "old batch" })];
    const h = harness(agents);
    h.press(DOWN);
    h.press(UP);
    expect(h.render()).toEqual([]);
    expect(h.widgetClears()).toBe(0); // dismissed keeps the sole widget/TUI context registered

    agents[0] = makeRecord({ id: "old", description: "old batch", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.update();
    expect(h.widgetClears()).toBe(1); // genuinely empty tears down the widget
    agents[0] = makeRecord({ id: "new", description: "new batch" });
    h.fleet.update();
    expect(h.render().some(line => line.includes("new batch"))).toBe(true);
  });

  it("uses → to enter the first child and passes non-nav keys through", () => {
    const h = harness([makeRecord({ description: "child" })]);
    h.press(DOWN);
    expect(h.press(RIGHT)).toEqual({ consume: true });
    expect(h.render().find(l => l.includes("child"))).toContain("⏺");
    expect(h.press("z")).toBeUndefined();
    expect(h.render().some(l => l.includes("←/↓ manage"))).toBe(true);
  });

  it("ignores all input while disabled and hides the widget", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.render()).toEqual([]);
  });

  it("re-arms the refresh timer when the list is re-shown (toggle off→on)", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager, new Map());
      fleet.setCurrentIdentity({ agentId: "root", rootAgentId: "root", depth: 0, maxTreeLevels: 3 });
      fleet.setUICtx({
        setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
        notify: () => {}, custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update();          // shows list, arms the timer
      fleet.setEnabled(false); // hides, clears the timer
      fleet.setEnabled(true);  // re-shows — must re-arm the timer
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(1000); // a tick should fire and re-read the roster
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

function realEditor(): Editor {
  const fakeTui = { requestRender: () => {} };
  const editorTheme = { borderColor: (s: string) => s, selectList: {} };
  return new Editor(fakeTui as any, editorTheme as any);
}

describe("FleetList vs other focused components (#123)", () => {
  // pi dispatches terminal input to extension listeners BEFORE the focused
  // component (pi-tui TUI.handleInput), and ctx.ui.select/confirm/input swap
  // the prompt editor out of the editor container while getEditorText() still
  // reads the detached (empty) editor. So while another component owns the
  // keyboard — another extension's selector (rpiv-ask-user-question), pi's own
  // menus, our /agents settings — the list must not consume its keys.

  /** Hand the fleet list its `tui` (happens on first widget render in pi) with the given focus. */
  function focusInHarness(h: Harness, focused: unknown): void {
    h.widgetTui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ↓ from a focused selector (activation)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { kind: "selector" }); // e.g. ExtensionSelectorComponent
    expect(h.press(DOWN)).toBeUndefined(); // must flow through to the selector
  });

  it("does not steal navigation keys from a selector opened while the list was active", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true }); // activate at the prompt
    focusInHarness(h, { kind: "selector" });          // a dialog takes focus
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    // and the list dropped back to its inactive hint
    expect(h.render().some(l => l.includes("←/↓ manage"))).toBe(true);
  });

  it("keeps a dismissed widget registered and restores only after explicit Editor focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    h.press(DOWN);
    h.press(UP);
    expect(h.render()).toEqual([]);
    expect(h.widgetClears()).toBe(0);

    focusInHarness(h, { kind: "selector" });
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(LEFT)).toBeUndefined();
    expect(h.render()).toEqual([]);

    h.widgetTui.focusedComponent = undefined;
    expect(h.press(DOWN)).toBeUndefined(); // dismissed + unknown focus fails open
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
    expect(h.render().some(line => line.includes("enter view"))).toBe(true);
  });

  it("still activates when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("assumes the editor when focus is unknowable (no tui yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    // No render yet → the list has never seen a tui: activation must still work.
    expect(h.press(DOWN)).toEqual({ consume: true });
  });
});

describe("FleetList rendering", () => {
  it("projects only the current root and leaves foreign-root records to Widget", () => {
    const current = makeRecord({ id: "current", description: "current root worker" });
    const foreign = makeRecord({
      id: "foreign",
      description: "foreign root worker",
      lineage: { agentId: "foreign", parentAgentId: "other-root", rootAgentId: "other-root", depth: 1, maxTreeLevels: 3 },
    });
    const lines = harness([current, foreign]).render();
    expect(lines.some(line => line.includes("current root worker"))).toBe(true);
    expect(lines.some(line => line.includes("foreign root worker"))).toBe(false);
  });

  it("merges identity, live metadata, and right-aligned stats into one agent row", () => {
    const record = makeRecord({
      description: "Sleep then report 1",
      toolUses: 1,
      invocation: {
        modelName: "opencode-go/deepseek-v4-flash",
        thinking: "max",
        maxTurns: 20,
        sessionPersistence: "memory",
      },
    });
    const activity = new Map([[record.id, {
      activeTools: new Map([["tool-1", "bash"]]),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
      maxTurns: 20,
      lifetimeUsage: record.lifetimeUsage,
    }]]);
    const lines = harness([record], activity).render(200);
    // hint + blank + main + exactly one row for this agent; no activity row.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("←/↓ manage");
    expect(lines.find(l => l.includes("main"))).toContain("⏺"); // main selected by default
    const agentLines = lines.filter(l => l.includes("Sleep then report 1"));
    expect(agentLines).toHaveLength(1);
    const agentLine = agentLines[0];
    expect(agentLine).toContain("◯");
    expect(agentLine.indexOf("└─")).toBeLessThan(agentLine.indexOf("◯"));
    expect(agentLine).not.toMatch(/[●✓✗■]/);
    expect(agentLine).not.toContain("running command");
    expect(agentLine).not.toContain("(Agent)");
    expect(agentLine).toContain("deepseek-v4-flash · max · memory · ↻ 1≤20 · 1 tool");
    expect(agentLine).not.toContain("opencode-go/");
    expect(agentLine).not.toContain("effort");
    expect(agentLine).not.toContain("session");
    expect(agentLine).toContain("↓ 13.1k");
    expect(agentLine).not.toContain("tokens");
    expect(agentLine).toMatch(/\d+s · ↓/); // "<seconds>s · ↓ ..." (timing-agnostic)
    expect(lines.some(line => line.includes("running command") || line.includes("bash"))).toBe(false);
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const lines = harness(agents).render();
    const oldIdx = lines.findIndex(l => l.includes("oldest"));
    const newIdx = lines.findIndex(l => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx); // earliest sits above the later one
  });

  it("renders a sessionless queued agent with metadata beside a running agent", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({
        id: "pending",
        description: "queued one",
        status: "queued",
        session: undefined,
        invocation: { modelName: "test/queued-model", thinking: "low", sessionPersistence: "memory" },
      }),
    ];
    const lines = harness(agents).render(160);
    expect(lines.some(l => l.includes("running one"))).toBe(true);
    expect(lines.some(l => l.includes("queued one") && l.includes("queued-model · low · memory"))).toBe(true);
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    const lines = h.render(120);
    // 8 agents, cap 5 visible → "↓ 3 more"
    expect(lines.some(l => l.includes("↓ 3 more"))).toBe(true);
  });

  it("clamps every line and drops left-tail metadata before fixed right stats on narrow widths", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({
        id: `a${i}`,
        description: `a very long agent description number ${i} that keeps going`,
        invocation: { modelName: "provider/a-very-long-model", thinking: "high", sessionPersistence: "memory" },
      }));
    const h = harness(agents);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
    const narrowAgent = h.render(40).find(line => line.includes("└─") || line.includes("├─"))!;
    expect(narrowAgent).toContain("↓ 13.1k");
    expect(narrowAgent).not.toContain("a-very-long-model");
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.press(DOWN); // activate (main)
    // step down to the last agent (8 agents → roster index 8)
    for (let i = 0; i < 8; i++) h.press(DOWN);
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 7"))).toContain("⏺");
    expect(lines.some(l => l.includes("↑"))).toBe(true); // hidden-above indicator
  });
});

describe("FleetList overlay lifecycle", () => {
  it("renders a missing-parent orphan but never routes it to a manager", () => {
    const orphan = makeRecord({
      id: "orphan",
      description: "untrusted orphan",
      lineage: { agentId: "orphan", parentAgentId: "missing", rootAgentId: "root", depth: 2, maxTreeLevels: 3 },
    });
    const h = harness([orphan]);
    expect(h.render().some(line => line.includes("untrusted orphan") && line.includes("orphan"))).toBe(true);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false);
    expect(h.manager.abort).not.toHaveBeenCalled();
    expect(h.manager.steer).not.toHaveBeenCalled();
  });

  it("closes and isolates an old viewer across a session switch", async () => {
    const agents = [makeRecord({ id: "A-child", description: "session A" })];
    const h = harness(agents);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);
    const oldViewer = h.overlayComponent()!;

    h.fleet.onSessionBeforeSwitch();
    expect(h.overlayClosed()).toBe(true);
    agents.splice(0, 1, makeRecord({
      id: "B-child",
      description: "session B",
      lineage: { agentId: "B-child", parentAgentId: "B", rootAgentId: "B", depth: 1, maxTreeLevels: 3 },
    }));
    h.fleet.setCurrentIdentity({ agentId: "B", rootAgentId: "B", depth: 0, maxTreeLevels: 3 });

    oldViewer.handleInput("\r");
    for (const ch of "stale") oldViewer.handleInput(ch);
    oldViewer.handleInput("\r");
    oldViewer.handleInput("x");
    oldViewer.handleInput("x");
    await Promise.resolve(); // old custom().then must not reset B's selection/state

    expect(h.manager.steer).not.toHaveBeenCalled();
    expect(h.manager.abort).not.toHaveBeenCalled();
    expect(h.render().some(line => line.includes("session A"))).toBe(false);
    expect(h.render().some(line => line.includes("session B"))).toBe(true);
  });

  it("Enter on 'main' just deactivates (no overlay)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // active, index 0 (main)
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false); // never opened an overlay
    expect(h.render().some(l => l.includes("←/↓ manage"))).toBe(true);
  });

  it("Enter on a sessionless queued row reports that no session is available", () => {
    const queued = makeRecord({ id: "queued", description: "waiting", status: "queued", session: undefined });
    const h = harness([queued]);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.press(ENTER)).toEqual({ consume: true });
    expect(h.overlayOpened()).toBe(false);
    expect(h.notifications()).toEqual(["Agent is queued — no session available."]);
  });

  it("keeps the cursor on the viewed agent after closing, even if the list reordered", async () => {
    const fakeSession = { subscribe: () => () => {}, messages: [] };
    const agents = [
      makeRecord({ id: "a1", description: "one", session: fakeSession as any }),
      makeRecord({ id: "a2", description: "two", session: fakeSession as any }),
      makeRecord({ id: "a3", description: "three", session: fakeSession as any }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate (main, idx 0)
    h.press(DOWN); // a1 (idx 1)
    h.press(DOWN); // a2 (idx 2)
    h.press(ENTER); // open a2
    // a1 finishes and drops out while viewing → a2 shifts from idx 2 to idx 1.
    agents.splice(0, 1);
    await h.closeOverlay();
    // Selection follows a2 ("two") to its new position, not whatever is at idx 2 now.
    expect(h.render().find(l => l.includes("two"))).toContain("⏺");
    expect(h.render().find(l => l.includes("three"))).toContain("◯");
  });

  it("routes cross-owner grandchild open, steer, and abort to its manager", () => {
    const child = makeRecord({ id: "child", description: "child" });
    const grand = makeRecord({
      id: "grand",
      description: "grand",
      lineage: { agentId: "grand", parentAgentId: "child", rootAgentId: "root", depth: 2, maxTreeLevels: 3 },
    });
    const childManager = fakeManager([grand]);
    const abort = vi.fn(() => true);
    (childManager as any).abort = abort;
    registerFleetOwner({
      owner: childManager,
      listAgents: () => childManager.listAgents(),
      getActivity: () => undefined,
      abort: (id) => childManager.abort(id),
      steer: (id, message) => childManager.steer(id, message),
    });
    const h = harness([child]);
    h.press(DOWN);  // activate main
    h.press(RIGHT); // enter child
    h.press(RIGHT); // enter grandchild
    h.press(ENTER);
    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");
    for (const ch of "redirect") viewer!.handleInput(ch);
    viewer!.handleInput("\r");
    expect(childManager.steer).toHaveBeenCalledWith("grand", "redirect");
    viewer!.handleInput("x");
    viewer!.handleInput("x");
    expect(abort).toHaveBeenCalledWith("grand");
    expect(h.manager.steer).not.toHaveBeenCalled();
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");                       // Enter → open composer
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r");                       // Enter → send

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN); // active (main)
    h.press(DOWN); // → the agent
    h.press(ENTER); // opens overlay
    expect(h.overlayOpened()).toBe(true);
    // The agent finishes, well past the linger window...
    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false);                          // viewer stays open
    expect(h.render().some(l => l.includes("the one"))).toBe(true); // and stays listed while viewed
  });

  it("lingers a finished agent in the list, then drops it after the window", () => {
    const recent = makeRecord({ id: "r", description: "recent done", status: "completed", completedAt: Date.now() });
    expect(harness([recent]).render().some(l => l.includes("recent done"))).toBe(true);
    const old = makeRecord({ id: "o", description: "old done", status: "completed", completedAt: Date.now() - 60_000 });
    expect(harness([old]).render().some(l => l.includes("old done"))).toBe(false);
  });

  it("retains a sessionless completed parent while a cross-manager grandchild is active", () => {
    const parent = makeRecord({
      id: "parent",
      description: "old parent",
      status: "completed",
      completedAt: Date.now() - 60_000,
      session: undefined,
    });
    const grand = makeRecord({
      id: "grand",
      description: "live grandchild",
      lineage: { agentId: "grand", parentAgentId: "parent", rootAgentId: "root", depth: 2, maxTreeLevels: 3 },
    });
    const childManager = fakeManager([grand]);
    registerFleetOwner({
      owner: childManager,
      listAgents: () => childManager.listAgents(),
      getActivity: () => undefined,
      abort: (id) => childManager.abort(id),
      steer: (id, message) => childManager.steer(id, message),
    });
    const h = harness([parent]);

    let lines = h.render();
    const parentLine = lines.find(line => line.includes("old parent"));
    const grandLine = lines.find(line => line.includes("live grandchild"));
    expect(parentLine).toBeDefined();
    expect(grandLine).toBeDefined();
    expect(parentLine).not.toContain("orphan");
    expect(grandLine).not.toContain("orphan");

    grand.status = "completed";
    grand.completedAt = Date.now() - 60_000;
    h.fleet.update();
    lines = h.render();
    expect(lines.some(line => line.includes("old parent"))).toBe(false);
    expect(lines.some(line => line.includes("live grandchild"))).toBe(false);
  });
});
