import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { agentRuntimeTree } from "../src/agent-runtime-tree.js";
import { AgentSessionStore } from "../src/agent-session-store.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx(cwd: string, sessionDir: string) {
  return {
    cwd,
    hasUI: true,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), setFooter: vi.fn() },
    model: { provider: "test", id: "model", name: "Test" },
    modelRegistry: {
      find: vi.fn(() => ({ provider: "test", id: "model", name: "Test" })),
      getAvailable: vi.fn(() => [{ provider: "test", id: "model", name: "Test" }]),
    },
    sessionManager: {
      getSessionId: () => "shutdown-root",
      getSessionDir: () => sessionDir,
      getSessionFile: () => join(sessionDir, "root.jsonl"),
      getBranch: () => [],
    },
    getSystemPrompt: () => "parent",
  } as any;
}

describe("shutdown late completion wiring", () => {
  const dirs: string[] = [];
  const oldEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME, cwd: process.cwd() };

  afterEach(() => {
    process.chdir(oldEnv.cwd);
    if (oldEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv.agentDir;
    if (oldEnv.home === undefined) delete process.env.HOME;
    else process.env.HOME = oldEnv.home;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    agentRuntimeTree.resetForTests();
    vi.restoreAllMocks();
  });

  it("allows only final durable onChanged persistence after activation closes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-shutdown-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-shutdown-agent-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-shutdown-session-"));
    dirs.push(cwd, agentDir, sessionDir);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(cwd);

    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => new Promise(resolve => {
      const session = { dispose: vi.fn(), sessionFile: join(sessionDir, "child.jsonl") } as any;
      options.onSessionCreated?.(session);
      finish = resolve;
    }));
    const upsert = vi.spyOn(AgentSessionStore.prototype, "upsert");
    const { pi, tools, lifecycle } = makePi();
    const runtimeCtx = ctx(cwd, sessionDir);
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, runtimeCtx);
    await tools.get("Agent").execute("tc", {
      prompt: "late",
      description: "late completion",
      subagent_type: "general-purpose",
      model: "test/model",
      thinking: "off",
      run_in_background: true,
    }, undefined, undefined, runtimeCtx);

    await lifecycle.get("session_shutdown")?.({}, runtimeCtx);
    const sideEffectsAtShutdown = {
      events: pi.events.emit.mock.calls.length,
      append: pi.appendEntry.mock.calls.length,
      send: pi.sendMessage.mock.calls.length,
      notify: runtimeCtx.ui.notify.mock.calls.length,
    };
    const persistedAtShutdown = upsert.mock.calls.length;

    const lateSession = { dispose: vi.fn(), sessionFile: join(sessionDir, "child.jsonl") } as any;
    finish({ responseText: "late result", session: lateSession, aborted: true, steered: false });
    await vi.waitFor(() => expect(upsert.mock.calls.length).toBeGreaterThan(persistedAtShutdown));
    expect(lateSession.dispose).toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(pi.events.emit).toHaveBeenCalledTimes(sideEffectsAtShutdown.events);
    expect(pi.appendEntry).toHaveBeenCalledTimes(sideEffectsAtShutdown.append);
    expect(pi.sendMessage).toHaveBeenCalledTimes(sideEffectsAtShutdown.send);
    expect(runtimeCtx.ui.notify).toHaveBeenCalledTimes(sideEffectsAtShutdown.notify);
  });
});
