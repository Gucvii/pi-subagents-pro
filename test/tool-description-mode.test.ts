// End-to-end test for `toolDescriptionMode` (#91): settings file → sanitize →
// applier → registration-time description pick. Instantiates the real extension
// with a mock pi (same pattern as print-mode.test.ts) inside a temp cwd, then
// inspects the registered Agent tool's description.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

const EXAMPLE_TEMPLATE = fileURLToPath(new URL("../examples/agent-tool-description.md", import.meta.url));

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

describe("toolDescriptionMode", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function setup(settings?: Record<string, unknown>, beforeInstantiate?: () => void) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-"));
    // Isolate global settings (getAgentDir / ~/.pi) so the dev's real
    // subagents.json can't leak into the "default is full" assertion.
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-tooldesc-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    if (settings) {
      writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(settings));
    }
    beforeInstantiate?.();
    process.chdir(tmpDir);

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("exposes mutually exclusive spawn, resume, and schedule operation schemas", () => {
    const tools = setup();
    const parameters = tools.get("Agent").parameters;
    const variants = parameters.properties.operation.anyOf;
    const byKind = new Map(variants.map((variant: any) => [variant.properties.kind.const, variant]));
    const spawn = byKind.get("spawn");
    const resume = byKind.get("resume");
    const schedule = byKind.get("schedule");

    expect(parameters.required).toEqual(["operation"]);
    expect(parameters.additionalProperties).toBe(false);
    expect(spawn.required).toEqual(["kind", "prompt", "subagent_type"]);
    expect(spawn.additionalProperties).toBe(false);
    expect(spawn.properties.model.pattern).toBe("^[^/\\s]+/[^/\\s]+$");
    expect(spawn.properties.thinking.anyOf.map((entry: { const: string }) => entry.const)).toEqual([
      "off", "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(spawn.properties.session_persistence.anyOf.map((entry: { const: string }) => entry.const))
      .toEqual(["durable", "memory"]);
    expect(resume.required).toEqual(["kind", "agent_id", "prompt"]);
    expect(resume.additionalProperties).toBe(false);
    expect(resume.properties).not.toHaveProperty("subagent_type");
    expect(resume.properties).not.toHaveProperty("model");
    expect(schedule.required).toEqual(["kind", "schedule", "prompt", "subagent_type"]);
    expect(schedule.additionalProperties).toBe(false);
    expect(schedule.properties).not.toHaveProperty("resume");
    expect(schedule.properties).not.toHaveProperty("inherit_context");
    expect(schedule.properties).not.toHaveProperty("run_in_background");
    expect(schedule.properties).not.toHaveProperty("session_persistence");
    expect(resume.properties).not.toHaveProperty("session_persistence");

    expect(Value.Check(parameters, {
      operation: { kind: "spawn", prompt: "inspect", subagent_type: "Explore" },
    })).toBe(true);
    expect(Value.Check(parameters, {
      operation: { kind: "spawn", prompt: "sensitive", subagent_type: "general-purpose", session_persistence: "memory" },
    })).toBe(true);
    expect(Value.Check(parameters, {
      operation: { kind: "resume", agent_id: "agent-1", prompt: "continue" },
    })).toBe(true);
    expect(Value.Check(parameters, {
      operation: { kind: "schedule", schedule: "1h", prompt: "report", subagent_type: "general-purpose" },
    })).toBe(true);
    expect(Value.Check(parameters, { operation: { kind: "spawn", prompt: "missing type" } })).toBe(false);
    expect(Value.Check(parameters, {
      operation: { kind: "resume", agent_id: "agent-1", prompt: "continue", model: "test/model" },
    })).toBe(false);
    expect(Value.Check(parameters, {
      operation: { kind: "schedule", schedule: "1h", prompt: "report", subagent_type: "general-purpose", inherit_context: true },
    })).toBe(false);
    expect(Value.Check(parameters, {
      operation: { kind: "schedule", schedule: "1h", prompt: "report", subagent_type: "general-purpose", session_persistence: "memory" },
    })).toBe(false);
  });

  it("registers closed inspection schemas accepted by TypeBox Value.Check", () => {
    const tools = setup();
    const inspect = tools.get("inspect_agent");
    const readEntry = tools.get("read_agent_entry");
    const inspectParameters = inspect.parameters;
    const selectionVariants = inspectParameters.properties.entries.anyOf;

    expect(inspect.description).toContain("Routine rule");
    expect(readEntry.description).toContain("Do not use for routine health checks");
    expect(inspectParameters.additionalProperties).toBe(false);
    expect(selectionVariants).toHaveLength(2);
    expect(selectionVariants.every((variant: { additionalProperties: boolean }) => variant.additionalProperties === false)).toBe(true);
    expect(Value.Check(inspectParameters, { agent_id: "agent-1" })).toBe(true);
    expect(Value.Check(inspectParameters, { agent_id: "agent-1", entries: { kind: "tail", limit: 20, types: ["error"] } })).toBe(true);
    expect(Value.Check(inspectParameters, { agent_id: "agent-1", entries: { kind: "after", cursor: `e_${"a".repeat(24)}`, limit: 50 } })).toBe(true);
    expect(Value.Check(inspectParameters, { agent_id: "agent-1", entries: { kind: "after", cursor: `e_${"a".repeat(25)}` } })).toBe(false);
    expect(Value.Check(inspectParameters, { agent_id: "agent-1", entries: { kind: "tail", cursor: "not-allowed" } })).toBe(false);
    expect(Value.Check(inspectParameters, { agent_id: "agent-1", entries: { kind: "tail", limit: 21 } })).toBe(false);
    expect(readEntry.parameters.additionalProperties).toBe(false);
    const validRef = `e_${"b".repeat(24)}`;
    expect(Value.Check(readEntry.parameters, { agent_id: "agent-1", ref: validRef })).toBe(true);
    expect(Value.Check(readEntry.parameters, { agent_id: "agent-1", ref: `${validRef}0` })).toBe(false);
    expect(Value.Check(readEntry.parameters, { agent_id: "agent-1", ref: validRef, offset: -1 })).toBe(false);
    expect(Value.Check(readEntry.parameters, { agent_id: "agent-1", ref: validRef, max_bytes: 16001 })).toBe(false);
  });

  it("wires both inspection tools to non-disclosing unknown-Agent errors", async () => {
    const tools = setup();
    const ctx = { cwd: tmpDir };
    const inspectResult = await tools.get("inspect_agent").execute("call-1", { agent_id: "unknown" }, undefined, undefined, ctx);
    const readResult = await tools.get("read_agent_entry").execute(
      "call-2",
      { agent_id: "unknown", ref: `e_${"0".repeat(24)}` },
      undefined,
      undefined,
      ctx,
    );

    expect(JSON.parse(inspectResult.content[0].text)).toEqual({
      error: { code: "not_found", message: "Agent was not found in this project." },
    });
    expect(JSON.parse(readResult.content[0].text)).toEqual({
      error: { code: "not_found", message: "Agent was not found in this project." },
    });
  });

  it("defaults to the full description", () => {
    const tools = setup();
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
    expect(desc).toContain("## Writing the prompt");
    // Full agent descriptions are embedded (a late Explore sentence survives).
    expect(desc).toContain("very thorough");
  });

  it("compact mode swaps in the short description with one-line type list", () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Run exactly one Agent operation");
    expect(desc).not.toContain("## Usage notes");
    expect(desc).not.toContain("## Writing the prompt");
    // Type list keeps every agent but only the first sentence of each description.
    expect(desc).toContain("- general-purpose:");
    expect(desc).toContain("- Explore: Fast read-only search agent for locating code. (Tools:");
    expect(desc).not.toContain("very thorough");
    // The point of the feature: materially smaller than the full version.
    expect(desc.length).toBeLessThan(2050);
  });

  it("invalid mode in the settings file is dropped — full description", () => {
    const tools = setup({ toolDescriptionMode: "tiny" });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("## Usage notes");
  });

  it("compact keeps every load-bearing contract — fails when a behavior change forgets compact", () => {
    const tools = setup({ toolDescriptionMode: "compact" });
    const desc: string = tools.get("Agent").description;
    // One keyword per behavioral contract the orchestrator must know about.
    // If you change one of these behaviors, update BOTH descriptions.
    for (const contract of [
      "run_in_background",
      "resume",
      "steer_subagent",
      'isolation: "worktree"',
      ".pi/agents/",
      "self-contained",
    ]) {
      expect(desc).toContain(contract);
    }
  });

  it("custom mode renders the project template with placeholders substituted", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(tmpDir, ".pi", "agent-tool-description.md"),
        "My agents:\n{{typeList}}\n\nGlobal dir: {{agentDir}}\nUnknown: {{nope}}\nCost: $& stays literal",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("My agents:");
    expect(desc).toContain("- general-purpose:"); // {{typeList}} expanded
    expect(desc).toContain(`Global dir: ${hermeticAgentDir}`); // {{agentDir}} expanded
    expect(desc).toContain("Unknown: {{nope}}"); // unknown placeholder left verbatim
    expect(desc).toContain("Cost: $& stays literal"); // no $-pattern expansion
    expect(desc).not.toContain("## Usage notes");
  });

  it("custom mode falls back to the global file when no project file exists", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(hermeticAgentDir, "agent-tool-description.md"), "GLOBAL CUSTOM\n{{compactTypeList}}");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("GLOBAL CUSTOM");
    expect(desc).toContain("- Explore: Fast read-only search agent for locating code. (Tools:");
  });

  it("{{scheduleGuideline}} expands to the schedule bullet when scheduling is on (default)", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{scheduleGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    // The expansion carries its own leading "\n- " bullet.
    expect(desc).toContain('RULES:\n- Use operation.kind="schedule" only when');
  });

  it("{{scheduleGuideline}} expands to the empty string when scheduling is disabled", () => {
    const tools = setup({ toolDescriptionMode: "custom", schedulingEnabled: false }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), "RULES:{{scheduleGuideline}}\nEND");
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("RULES:\nEND");
    expect(desc).not.toContain("schedule");
    const variants = tools.get("Agent").parameters.properties.operation.anyOf;
    expect(variants.map((variant: any) => variant.properties.kind.const)).toEqual(["spawn", "resume"]);
  });

  it("every documented placeholder is replaced — no {{ }} residue", () => {
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(
        join(tmpDir, ".pi", "agent-tool-description.md"),
        "A {{typeList}} B {{compactTypeList}} C {{agentDir}} D {{scheduleGuideline}} E",
      );
    });
    const desc: string = tools.get("Agent").description;
    expect(desc).not.toContain("{{");
    expect(desc).not.toContain("}}");
  });

  it("the shipped example template renders byte-identical to the full description", async () => {
    // Guards examples/agent-tool-description.md against going stale: it must
    // reproduce the full description exactly. If you edit one, edit the other.
    const example = readFileSync(EXAMPLE_TEMPLATE, "utf-8");
    const tools = setup({ toolDescriptionMode: "custom" }, () => {
      writeFileSync(join(tmpDir, ".pi", "agent-tool-description.md"), example);
    });
    const customDesc: string = tools.get("Agent").description;

    // Second instance in the same hermetic cwd, flipped to full mode.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "full" }));
    const second = makePi();
    subagentsExtension(second.pi);
    try {
      expect(customDesc).toBe(second.tools.get("Agent").description);
    } finally {
      await second.handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    }
  });

  it("custom mode without a file falls back to the full description with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = setup({ toolDescriptionMode: "custom" });
      const desc: string = tools.get("Agent").description;
      expect(desc).toContain("## Usage notes");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no agent-tool-description.md found"));
    } finally {
      warn.mockRestore();
    }
  });
});
