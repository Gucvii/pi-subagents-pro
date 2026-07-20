import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(() => new Promise(() => {})) };
});

import { resolveDurableAgentSessionStorePath } from "../src/agent-session-store.js";
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

function context(cwd: string, sessionId: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: { provider: "test", id: "model", name: "Test" },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      getSessionDir: () => join(cwd, "sessions"),
      getSessionFile: () => undefined,
    },
    getSystemPrompt: () => "root prompt",
  } as any;
}

const textOf = (result: any) => result.content[0].text as string;

describe("mailbox extension lifecycle wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-mailbox-wiring-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-mailbox-agentdir-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("registers the root on session_start and a memory child through AgentManager onChanged", async () => {
    const { pi, tools, lifecycle } = makePi();
    const ctx = context(cwd, `root-${Date.now()}`);
    subagentsExtension(pi);
    const mailbox = tools.get("mailbox");

    expect(textOf(await mailbox.execute("before", { operation: { kind: "receive" } }, undefined, undefined, ctx)))
      .toContain("identity is unavailable");
    await lifecycle.get("session_start")({}, ctx);
    expect(textOf(await mailbox.execute("root", { operation: { kind: "receive" } }, undefined, undefined, ctx)))
      .toBe("Mailbox is empty.");

    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const childId = registry.spawn(pi, ctx, "general-purpose", "wait", {
      description: "memory child",
      persistSession: false,
      isBackground: true,
    });
    const sent = textOf(await mailbox.execute("send", {
      operation: { kind: "send", to_agent_id: childId, message: "hello child" },
    }, undefined, undefined, ctx));
    expect(sent).toContain("Mailbox message sent.");

    await lifecycle.get("session_shutdown")({}, ctx);
  });

  it("rejects poisoned restored lineage before manager restore or mailbox registration", async () => {
    const { pi, tools, lifecycle } = makePi();
    const sessionId = `poison-${Date.now()}`;
    const ctx = context(cwd, sessionId);
    const storePath = resolveDurableAgentSessionStorePath(agentDir, cwd, sessionId)!;
    mkdirSync(dirname(storePath), { recursive: true });
    const poisonedId = "poisoned-child";
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      agents: [{
        id: poisonedId,
        type: "general-purpose",
        description: "poisoned",
        status: "completed",
        toolUses: 0,
        startedAt: 1,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0,
        lineage: {
          agentId: poisonedId,
          parentAgentId: sessionId,
          rootAgentId: "other-root",
          depth: 1,
          maxTreeLevels: 3,
        },
      }],
    }), "utf8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx);
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(registry.getRecord(poisonedId)).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Rejected invalid restored Agent record"));
    const result = await tools.get("mailbox").execute("send", {
      operation: { kind: "send", to_agent_id: poisonedId, message: "blocked" },
    }, undefined, undefined, ctx);
    expect(textOf(result)).toContain("target is unavailable or not authorized");

    await lifecycle.get("session_shutdown")({}, ctx);
  });

  it("surfaces a corrupt current durable index through receive without modifying it", async () => {
    const { pi, tools, lifecycle } = makePi();
    const sessionId = `corrupt-${Date.now()}`;
    const ctx = context(cwd, sessionId);
    const storePath = resolveDurableAgentSessionStorePath(agentDir, cwd, sessionId)!;
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, "{ broken", "utf8");

    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx);
    const result = await tools.get("mailbox").execute(
      "receive",
      { operation: { kind: "receive" } },
      undefined,
      undefined,
      ctx,
    );
    expect(textOf(result)).toContain("Durable mailbox store is corrupt");
    expect(readFileSync(storePath, "utf8")).toBe("{ broken");

    await lifecycle.get("session_shutdown")({}, ctx);
  });
});
