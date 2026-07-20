import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { agentRuntimeTree } from "../src/agent-runtime-tree.js";
import type { AgentLineage, AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete IS called for foreground agents (lifecycle symmetry)", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("completed");
    // resultConsumed is set by spawnAndWait so onComplete skips notifications
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — spawnAndWait onSpawned + foreground output file wiring (#105)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("fields set on the record in onSpawned are visible when onSessionCreated fires", async () => {
    // The load-bearing ordering guarantee: onSpawned fires synchronously inside
    // spawn(), before runAgent's async onSessionCreated fires. index.ts relies on
    // this to set record.outputFile so streamToOutputFile can pick it up.
    manager = new AgentManager();
    let capturedId: string | undefined;
    let outputFileSeenAtSessionCreated: string | undefined;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = mockSession();
      // Yield one microtask to mirror real behavior: in production, onSessionCreated
      // fires async (after network/session setup). onSpawned fires synchronously
      // inside spawn() before runAgent's promise even starts. This await lets the
      // remainder of startAgent (record.promise = …, onSpawned?.()) finish first.
      await Promise.resolve();
      opts.onSessionCreated?.(session);
      outputFileSeenAtSessionCreated = capturedId
        ? manager.getRecord(capturedId)?.outputFile
        : undefined;
      return { responseText: "done", session, aborted: false, steered: false };
    });

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => {
      capturedId = fgId;
      manager.getRecord(fgId)!.outputFile = "/fake/agent.jsonl";
    });

    expect(outputFileSeenAtSessionCreated).toBe("/fake/agent.jsonl");
  });

  it("onSpawned id matches the id returned by spawnAndWait", async () => {
    manager = new AgentManager();
    let spawnedId: string | undefined;
    resolvedRun();

    const { id } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => { spawnedId = fgId; });

    expect(spawnedId).toBe(id);
  });

  it("onComplete fires on the error path with resultConsumed=true", async () => {
    // The .then path is covered by the lifecycle-symmetry test above; this guards
    // the .catch path which lacks try/catch around onComplete (a known asymmetry).
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => { completedRecord = r; });
    vi.mocked(runAgent).mockRejectedValue(new Error("agent failed"));

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("error");
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted and dispose invoke the removal callback exactly once per record", async () => {
    const removed = vi.fn();
    manager = new AgentManager(undefined, 4, undefined, undefined, 3, undefined, removed);
    resolvedRun();
    const first = manager.spawn(mockPi, mockCtx, "general-purpose", "one", { description: "one" });
    const second = manager.spawn(mockPi, mockCtx, "general-purpose", "two", { description: "two" });
    await Promise.all([manager.getRecord(first)!.promise, manager.getRecord(second)!.promise]);

    manager.clearCompleted();
    expect(removed).toHaveBeenCalledTimes(2);
    expect(removed.mock.calls.map(([record]) => record.id).sort()).toEqual([first, second].sort());

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const third = manager.spawn(mockPi, mockCtx, "general-purpose", "three", { description: "three" });
    manager.dispose();
    expect(removed).toHaveBeenCalledTimes(3);
    expect(removed).toHaveBeenLastCalledWith(expect.objectContaining({ id: third }));
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) still removes running=false queued=false records when resultConsumed=false for error status", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    // Error records with unread results are also preserved — the LLM should
    // be able to read the error message via get_subagent_result before the
    // record is evicted.
    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { text: "second" };
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/packages/api",
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    expect(createWorktree).toHaveBeenCalledWith("/", id);
    // Worktree wins for the working dir — at workPath, so subdirectory scoping
    // survives isolation. Config still anchored to the parent.
    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp" }),
    );
    expect(cleanupWorktree).toHaveBeenCalledWith("/", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    // Parent session sitting in a repo subdirectory: workPath would point at
    // the copied subdir. Without SpawnOptions.cwd the agent must stay at the
    // copy's root — moving it would also move .pi config discovery.
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/sub/dir",
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.configCwd).toBeUndefined();
  });

  it.each(["error", "stopped"] as const)("preserves branch evidence on %s cleanup and omits an unreadable memory error_ref", async (terminal) => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy",
    });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: true, branch: "pi-agent-saved", path: "/wt/copy" });
    let rejectRun!: (error: Error) => void;
    const session = {
      dispose: vi.fn(),
      sessionManager: {
        getSessionId: () => "memory-worktree-session",
        getEntries: () => [{
          type: "message",
          id: "provider-error",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed", timestamp: 1 },
        }],
      },
    } as any;
    vi.mocked(runAgent).mockImplementationOnce((_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      return new Promise((_resolve, reject) => { rejectRun = reject; });
    });
    const changed: string[] = [];
    manager = new AgentManager(undefined, 4, undefined, undefined, 3, record => changed.push(record.result ?? ""));
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      persistSession: false,
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    if (terminal === "stopped") manager.abort(id, "stop test");
    rejectRun(new Error("provider rejected"));
    await record.promise;

    expect(record.status).toBe(terminal);
    expect(record.result).toContain("Changes saved to branch `pi-agent-saved`");
    expect(record.result).toContain("git merge pi-agent-saved");
    expect(changed.at(-1)).toContain("pi-agent-saved");
    expect(record.session).toBeUndefined();
    expect(session.dispose).toHaveBeenCalled();
    expect(record.errorRef).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
      isBackground: true,
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // aborted:false, as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    // The agent loop ends and the promise settles "normally".
    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");        // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
  });
});

// Regression for #44: ESC during a foreground Agent call must propagate to
// the child. Pi delivers parent abort via AbortSignal; the manager wires the
// signal's "abort" event to this.abort(id).
describe("AgentManager — steer()", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.steer("nope", "hi")).toBe(false);
  });

  it("delivers to a live session via session.steer()", () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    // Simulate the session becoming ready.
    captured?.({ steer, dispose: vi.fn() });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    record.session = undefined; // not ready

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("refuses to steer an agent that is no longer running", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: false });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(manager.steer(id, "too late")).toBe(false);
  });
});

describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
      isBackground: true,
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

// #144 — a run that RESOLVES with a failed final turn (pi never rejects on
// retry exhaustion) must map to status "error", not "completed".
describe("AgentManager — resolved runs with a failed final turn map to error (#144)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  const failedRun = (failure: string, responseText = "") =>
    vi.mocked(runAgent).mockResolvedValue({
      responseText,
      session: mockSession(),
      aborted: false,
      steered: false,
      failure,
    } as any);

  it("sets status='error' and captures the provider message", async () => {
    manager = new AgentManager();
    failedRun("retries exhausted: 529 overloaded");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted: 529 overloaded");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("keeps earlier-turn text available as result context, but never as a clean completion", async () => {
    manager = new AgentManager();
    failedRun("provider died", "partial progress from an earlier turn");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("partial progress from an earlier turn");
  });

  it("onComplete sees the error status (routes to subagents:failed in the host)", async () => {
    let completed: AgentRecord | undefined;
    manager = new AgentManager((r) => { completed = r; });
    failedRun("boom");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(completed?.status).toBe("error");
  });

  it("an external stop still wins over a late failure resolution", async () => {
    manager = new AgentManager();
    let resolveRun: ((v: unknown) => void) | undefined;
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    record.status = "stopped"; // external abort() path
    resolveRun!({ responseText: "", session, aborted: false, steered: false, failure: "late error" });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
  });

  it("resume(): a failed final turn on the resumed prompt maps to error too", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    // resumeAgent bounds its fallback to this invocation, so a failed empty
    // resume yields text "" — never the prior turn's answer (#144 root-fix).
    vi.mocked(resumeMock).mockResolvedValue({
      text: "",
      failure: "retries exhausted on resume",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted on resume");
    expect(record.result).toBe(""); // no stale prior answer
  });

  it("resume(): partial text produced before the failure is kept as result", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "new partial progress",
      failure: "provider died mid-turn",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.result).toBe("new partial progress"); // salvageable, this-run text
  });

  it("resume(): does not reuse the previous invocation's error_ref when this run fails before a new error entry", async () => {
    const oldError = {
      type: "message",
      id: "old-provider-error",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "old provider failure", timestamp: 1 },
    };
    const session = {
      dispose: vi.fn(),
      sessionManager: {
        getSessionId: () => "resume-boundary-session",
        getEntries: () => [oldError],
      },
    } as any;
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: "old provider failure",
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    const oldRef = record.errorRef;
    expect(oldRef).toMatch(/^e_/);

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockRejectedValueOnce(new Error("resume setup failed before prompt append"));
    await manager.resume(id, "retry");

    expect(record.status).toBe("error");
    expect(record.error).toContain("resume setup failed");
    expect(record.errorRef).toBeUndefined();
    expect(record.errorRef).not.toBe(oldRef);
  });

  it("resume(): claims the invocation before boundary I/O so an immediate stop prevents the runner call", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockClear();
    const resumed = manager.resume(id, "more");
    expect(manager.abort(id, "immediate stop")).toBe(true);
    await resumed;

    expect(resumeMock).not.toHaveBeenCalled();
    expect(record.status).toBe("stopped");
  });

  it("resume(): uses a fresh abort controller and stopped wins over its rejection", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    const originalController = record.abortController;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    let resumedSignal: AbortSignal | undefined;
    vi.mocked(resumeMock).mockImplementation((_session, _prompt, options) => new Promise((_resolve, reject) => {
      resumedSignal = options.signal;
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));

    const resumed = manager.resume(id, "more");
    await vi.waitFor(() => expect(resumedSignal).toBeDefined());
    expect(record.abortController).not.toBe(originalController);
    expect(manager.abort(id, "stop resumed run")).toBe(true);
    await resumed;

    expect(resumedSignal?.aborted).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
    expect(record.stopReason).toBe("stop resumed run");
  });
});

describe("AgentManager — bounded Agent tree", () => {
  let manager: AgentManager;
  let parentManager: AgentManager | undefined;
  afterEach(() => {
    manager?.dispose();
    parentManager?.dispose();
  });

  const ctxAt = (depth: number, maxTreeLevels = 3) => ({
    cwd: "/tmp",
    sessionManager: {
      getSessionId: () => `session-depth-${depth}`,
      getBranch: () => [{
        type: "custom",
        customType: "pi-subagents:lineage",
        data: {
          agentId: depth === 0 ? "main" : `agent-${depth}`,
          parentAgentId: depth === 0 ? undefined : depth === 1 ? "main" : `agent-${depth - 1}`,
          rootAgentId: "main",
          depth,
          maxTreeLevels,
        },
      }],
    },
  } as any);

  it("assigns trusted parent/root/depth metadata to a child record", async () => {
    let finishParent!: (value: any) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { finishParent = resolve; }))
      .mockResolvedValueOnce({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    parentManager = new AgentManager();
    const parentId = parentManager.spawn(mockPi, ctxAt(0), "worker", "parent", { description: "parent", isBackground: true });
    const parent = parentManager.getRecord(parentId)!;

    manager = new AgentManager();
    const childCtx = {
      cwd: "/tmp",
      sessionManager: {
        getSessionId: () => parent.id,
        getBranch: () => [{ type: "custom", customType: "pi-subagents:lineage", data: parent.lineage }],
      },
    } as any;
    const id = manager.spawn(mockPi, childCtx, "worker", "go", { description: "nested" });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.lineage).toEqual({
      agentId: id,
      parentAgentId: parent.id,
      rootAgentId: "main",
      depth: 2,
      maxTreeLevels: 3,
    });
    expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3].lineage).toEqual(record.lineage);
    finishParent({ responseText: "parent done", session: mockSession(), aborted: false, steered: false });
    await parent.promise;
  });

  it("rejects level four before creating a record or invoking the runner", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockClear();

    expect(() => manager.spawn(mockPi, ctxAt(2), "worker", "forbidden", { description: "too deep" }))
      .toThrow("current level 3, maximum 3");
    expect(manager.listAgents()).toHaveLength(0);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("uses the configured limit for a main session without lineage metadata", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager(undefined, 4, undefined, undefined, 1);
    const rootCtx = {
      cwd: "/tmp",
      sessionManager: { getSessionId: () => "root-only-session", getBranch: () => [] },
    } as any;

    expect(() => manager.spawn(mockPi, rootCtx, "worker", "forbidden", { description: "root only" }))
      .toThrow("current level 1, maximum 1");
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — real multi-manager stop cascade", () => {
  const managers: AgentManager[] = [];
  afterEach(() => {
    for (const manager of managers) manager.dispose();
    managers.length = 0;
    agentRuntimeTree.resetForTests();
  });

  it("starts a valid queued child after its parent completes normally", async () => {
    let finishParent!: (value: any) => void;
    let finishBlocker!: (value: any) => void;
    const startedPrompts: string[] = [];
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt) => {
      startedPrompts.push(prompt);
      if (prompt === "parent") return new Promise(resolve => { finishParent = resolve; });
      if (prompt === "blocker") return new Promise(resolve => { finishBlocker = resolve; });
      return Promise.resolve({ responseText: "child done", session: mockSession(), aborted: false, steered: false });
    });
    const parentManager = new AgentManager(undefined, 1, undefined, undefined, 3);
    const childManager = new AgentManager(undefined, 1, undefined, undefined, 3);
    managers.push(parentManager, childManager);
    const rootCtx = {
      cwd: "/tmp",
      sessionManager: { getSessionId: () => "main", getBranch: () => [] },
    } as any;

    const blockerId = childManager.spawn(mockPi, rootCtx, "worker", "blocker", {
      description: "queue blocker", isBackground: true,
    });
    const parentId = parentManager.spawn(mockPi, rootCtx, "worker", "parent", {
      description: "parent", isBackground: true,
    });
    const parent = parentManager.getRecord(parentId)!;
    const childCtx = {
      cwd: "/tmp",
      sessionManager: {
        getSessionId: () => parent.id,
        getBranch: () => [{ type: "custom", customType: "pi-subagents:lineage", data: parent.lineage }],
      },
    } as any;
    const childId = childManager.spawn(mockPi, childCtx, "worker", "queued-child", {
      description: "queued child", isBackground: true,
    });
    const child = childManager.getRecord(childId)!;
    expect(child.status).toBe("queued");

    finishParent({ responseText: "parent done", session: mockSession(), aborted: false, steered: false });
    await parent.promise;
    expect(parent.status).toBe("completed");
    expect(child.status).toBe("queued");

    const blocker = childManager.getRecord(blockerId)!;
    finishBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await blocker.promise;
    await child.promise;

    expect(startedPrompts).toEqual(["blocker", "parent", "queued-child"]);
    expect(child.status).toBe("completed");
  });

  it("never starts a queued child after its ancestor receives the stopping marker", async () => {
    let finishBlocker!: (value: any) => void;
    const startedPrompts: string[] = [];
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => {
      startedPrompts.push(prompt);
      if (prompt === "blocker") return new Promise(resolve => { finishBlocker = resolve; });
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      });
    });
    const parentManager = new AgentManager(undefined, 1, undefined, undefined, 3);
    const childManager = new AgentManager(undefined, 1, undefined, undefined, 3);
    managers.push(parentManager, childManager);
    const rootCtx = {
      cwd: "/tmp",
      sessionManager: { getSessionId: () => "main", getBranch: () => [] },
    } as any;

    const blockerId = childManager.spawn(mockPi, rootCtx, "worker", "blocker", {
      description: "queue blocker", isBackground: true,
    });
    const parentId = parentManager.spawn(mockPi, rootCtx, "worker", "parent", {
      description: "parent", isBackground: true,
    });
    const parent = parentManager.getRecord(parentId)!;
    const childCtx = {
      cwd: "/tmp",
      sessionManager: {
        getSessionId: () => parent.id,
        getBranch: () => [{ type: "custom", customType: "pi-subagents:lineage", data: parent.lineage }],
      },
    } as any;
    const childId = childManager.spawn(mockPi, childCtx, "worker", "queued-child", {
      description: "queued child", isBackground: true,
    });
    const child = childManager.getRecord(childId)!;
    expect(child.status).toBe("queued");

    const caller: AgentLineage = { agentId: "main", rootAgentId: "main", depth: 0, maxTreeLevels: 3 };
    agentRuntimeTree.stopDirectChild(caller, "/tmp", parentId, "stop before queue drain");
    expect(parent.status).toBe("stopped");
    expect(child.status).toBe("stopped");
    await parent.promise;

    const blocker = childManager.getRecord(blockerId)!;
    finishBlocker({ responseText: "blocker done", session: mockSession(), aborted: false, steered: false });
    await blocker.promise;

    expect(startedPrompts).toEqual(["blocker", "parent"]);
    expect(child.status).toBe("stopped");
    expect(child.promise).toBeUndefined();
  });

  it("stops queued/running descendants deepest-first, drains, settles, and rejects a real late spawn", async () => {
    const abortOrder: string[] = [];
    const completions: string[] = [];
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        abortOrder.push(prompt);
        reject(new Error(`aborted ${prompt}`));
      }, { once: true });
    }));
    const complete = (record: AgentRecord) => {
      completions.push(record.description);
      throw new Error(`callback failed for ${record.description}`);
    };
    const parentManager = new AgentManager(complete, 1, undefined, undefined, 4);
    const childManager = new AgentManager(complete, 1, undefined, undefined, 4);
    const grandManager = new AgentManager(complete, 1, undefined, undefined, 4);
    managers.push(parentManager, childManager, grandManager);

    const rootCtx = {
      cwd: "/tmp",
      sessionManager: { getSessionId: () => "main", getBranch: () => [] },
    } as any;
    const parentId = parentManager.spawn(mockPi, rootCtx, "worker", "parent-run", { description: "parent", isBackground: true });
    const parent = parentManager.getRecord(parentId)!;
    const ctxFor = (record: AgentRecord) => ({
      cwd: "/tmp",
      sessionManager: {
        getSessionId: () => record.id,
        getBranch: () => [{ type: "custom", customType: "pi-subagents:lineage", data: record.lineage }],
      },
    }) as any;
    const childId = childManager.spawn(mockPi, ctxFor(parent), "worker", "child-run", { description: "child", isBackground: true });
    const child = childManager.getRecord(childId)!;
    const grandRunningId = grandManager.spawn(mockPi, ctxFor(child), "worker", "grand-run", { description: "grand-running", isBackground: true });
    const grandQueuedId = grandManager.spawn(mockPi, ctxFor(child), "worker", "grand-queued", { description: "grand-queued", isBackground: true });
    const grandRunning = grandManager.getRecord(grandRunningId)!;
    const grandQueued = grandManager.getRecord(grandQueuedId)!;
    expect(grandQueued.status).toBe("queued");

    const caller: AgentLineage = { agentId: "main", rootAgentId: "main", depth: 0, maxTreeLevels: 4 };
    const stop = agentRuntimeTree.stopDirectChild(caller, "/tmp", parentId, "integration stop");
    expect(stop.stopped_agents.map(entry => entry.agent_id)).toEqual(expect.arrayContaining([
      parentId, childId, grandRunningId, grandQueuedId,
    ]));
    expect(abortOrder.indexOf("grand-run")).toBeLessThan(abortOrder.indexOf("child-run"));
    expect(abortOrder.indexOf("child-run")).toBeLessThan(abortOrder.indexOf("parent-run"));
    expect(parent.abortController?.signal.aborted).toBe(true);
    expect(child.abortController?.signal.aborted).toBe(true);
    expect(grandRunning.abortController?.signal.aborted).toBe(true);
    expect(grandQueued.status).toBe("stopped");

    await Promise.all([parent.promise, child.promise, grandRunning.promise]);
    expect(() => grandManager.spawn(mockPi, ctxFor(child), "worker", "late", {
      description: "late grandchild",
      isBackground: true,
    })).toThrow("parent is no longer active");
    expect([parent.status, child.status, grandRunning.status, grandQueued.status]).toEqual([
      "stopped", "stopped", "stopped", "stopped",
    ]);
    expect(completions).toEqual(expect.arrayContaining(["parent", "child", "grand-running", "grand-queued"]));
    expect(parentManager.hasRunning()).toBe(false);
    expect(childManager.hasRunning()).toBe(false);
    expect(grandManager.hasRunning()).toBe(false);
    expect(agentRuntimeTree.stopDirectChild(caller, "/tmp", parentId, "ignored")).toEqual(stop);
  });

  it("supports a three-level custom-cwd/worktree-style chain across managers and cascades from the authorized root cwd", async () => {
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("cascade abort")), { once: true });
    }));
    const parentManager = new AgentManager(undefined, 4, undefined, undefined, 5);
    const childManager = new AgentManager(undefined, 4, undefined, undefined, 5);
    const grandManager = new AgentManager(undefined, 4, undefined, undefined, 5);
    managers.push(parentManager, childManager, grandManager);

    const rootCtx = {
      cwd: "/authorization/root",
      sessionManager: { getSessionId: () => "cwd-main", getBranch: () => [] },
    } as any;
    const parentId = parentManager.spawn(mockPi, rootCtx, "worker", "parent", {
      description: "custom parent", isBackground: true, cwd: "/private/tmp",
    });
    const parent = parentManager.getRecord(parentId)!;
    const childCtx = {
      cwd: "/tmp/pi-agent-worktrees/parent-copy",
      sessionManager: {
        getSessionId: () => parent.id,
        getBranch: () => [{ type: "custom", customType: "pi-subagents:lineage", data: parent.lineage }],
      },
    } as any;
    const childId = childManager.spawn(mockPi, childCtx, "worker", "child", {
      description: "worktree child", isBackground: true, cwd: "/tmp",
    });
    const child = childManager.getRecord(childId)!;
    const grandCtx = {
      cwd: "/private/tmp/pi-agent-worktrees/child-copy",
      sessionManager: {
        getSessionId: () => child.id,
        getBranch: () => [{ type: "custom", customType: "pi-subagents:lineage", data: child.lineage }],
      },
    } as any;
    const grandId = grandManager.spawn(mockPi, grandCtx, "worker", "grandchild", {
      description: "custom grandchild", isBackground: true, cwd: "/private/tmp",
    });
    const grandchild = grandManager.getRecord(grandId)!;

    expect([parent.parentCwd, child.parentCwd, grandchild.parentCwd]).toEqual([
      "/authorization/root",
      "/tmp/pi-agent-worktrees/parent-copy",
      "/private/tmp/pi-agent-worktrees/child-copy",
    ]);
    const caller: AgentLineage = { agentId: "cwd-main", rootAgentId: "cwd-main", depth: 0, maxTreeLevels: 5 };
    const stopped = agentRuntimeTree.stopDirectChild(caller, rootCtx.cwd, parentId, "cross-cwd cascade");
    expect(stopped.stopped_agents.map(({ agent_id }) => agent_id)).toEqual([grandId, childId, parentId]);
    await Promise.all([parent.promise, child.promise, grandchild.promise]);
    expect([parent.status, child.status, grandchild.status]).toEqual(["stopped", "stopped", "stopped"]);
  });
});

describe("AgentManager — durable cross-process resume", () => {
  let manager: AgentManager;
  afterEach(() => {
    manager?.dispose();
    agentRuntimeTree.resetForTests();
  });

  const persisted = (status: "completed" | "running" = "completed") => ({
    id: "durable-agent",
    type: "general-purpose",
    description: "durable task",
    status,
    result: status === "completed" ? "FIRST" : undefined,
    toolUses: 2,
    startedAt: 100,
    completedAt: status === "completed" ? 200 : undefined,
    sessionFile: "/sessions/child.jsonl",
    sessionCwd: "/repo",
    lifetimeUsage: { input: 1, output: 2, cacheWrite: 0 },
    compactionCount: 0,
    lineage: {
      agentId: "durable-agent",
      parentAgentId: "main",
      rootAgentId: "main",
      depth: 1,
      maxTreeLevels: 3,
    },
    invocation: { modelName: "test/model", thinking: "off" as const },
  });

  it("rehydrates stable Agent IDs and marks interrupted runs resumable", () => {
    const changed = vi.fn();
    manager = new AgentManager(undefined, 4, undefined, undefined, 3, changed);

    expect(manager.restorePersisted([persisted("running")])).toBe(1);
    expect(manager.getRecord("durable-agent")).toMatchObject({
      id: "durable-agent",
      status: "stopped",
      sessionFile: "/sessions/child.jsonl",
      error: expect.stringContaining("previous Pi process exited"),
    });
    expect(changed).toHaveBeenCalled();
  });

  it.each(["missing", "pruned"] as const)("rejects a nested durable resume when its parent runtime is %s without mutating the record", async (parentState) => {
    manager = new AgentManager();
    const parentLineage: AgentLineage = {
      agentId: "parent-agent",
      parentAgentId: "main",
      rootAgentId: "main",
      depth: 1,
      maxTreeLevels: 3,
    };
    const nested = {
      ...persisted(),
      parentCwd: "/tmp",
      lineage: {
        agentId: "durable-agent",
        parentAgentId: parentLineage.agentId,
        rootAgentId: parentLineage.rootAgentId,
        depth: 2,
        maxTreeLevels: 3,
      },
    };
    manager.restorePersisted([nested]);
    if (parentState === "pruned") {
      const owner = {};
      agentRuntimeTree.register(parentLineage, "/tmp", owner, {
        getStatus: () => "completed",
        stop: () => false,
      });
      agentRuntimeTree.markSettled(parentLineage.agentId, owner);
    }
    const record = manager.getRecord(nested.id)!;
    const before = {
      status: record.status,
      result: record.result,
      error: record.error,
      abortController: record.abortController,
      promise: record.promise,
    };
    vi.mocked(runAgent).mockClear();

    await expect(manager.resume(nested.id, "continue", undefined, {
      pi: mockPi,
      ctx: mockCtx,
      thinkingLevel: "off",
    })).rejects.toThrow("parent runtime is missing");
    expect({
      status: record.status,
      result: record.result,
      error: record.error,
      abortController: record.abortController,
      promise: record.promise,
    }).toEqual(before);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("allows a nested durable resume while its exact parent runtime remains active", async () => {
    manager = new AgentManager();
    const parentLineage: AgentLineage = {
      agentId: "parent-agent",
      parentAgentId: "main",
      rootAgentId: "main",
      depth: 1,
      maxTreeLevels: 3,
    };
    agentRuntimeTree.register(parentLineage, "/tmp", {}, {
      getStatus: () => "running",
      stop: () => true,
    });
    manager.restorePersisted([{
      ...persisted(),
      parentCwd: "/tmp",
      lineage: {
        agentId: "durable-agent",
        parentAgentId: parentLineage.agentId,
        rootAgentId: parentLineage.rootAgentId,
        depth: 2,
        maxTreeLevels: 3,
      },
    }]);
    resolvedRun();

    const record = await manager.resume("durable-agent", "continue", undefined, {
      pi: mockPi,
      ctx: mockCtx,
      thinkingLevel: "off",
    });

    expect(record?.status).toBe("completed");
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("lazily opens the durable Pi session only when resume is requested", async () => {
    manager = new AgentManager();
    manager.restorePersisted([persisted()]);
    const reopenedSession = mockSession();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "SECOND",
      session: reopenedSession,
      aborted: false,
      steered: false,
    });

    const record = await manager.resume("durable-agent", "continue", undefined, {
      pi: mockPi,
      ctx: mockCtx,
      model: { provider: "test", id: "model" } as any,
      thinkingLevel: "off",
    });

    expect(record?.result).toBe("SECOND");
    expect(record?.status).toBe("completed");
    expect(record?.session).toBe(reopenedSession);
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      mockCtx,
      "general-purpose",
      "continue",
      expect.objectContaining({
        agentId: "durable-agent",
        resumeSessionFile: "/sessions/child.jsonl",
        cwd: "/repo",
        thinkingLevel: "off",
      }),
    );
  });

  it("recreates and cleans worktree isolation when a durable session is resumed", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/resume",
      workPath: "/wt/resume/pkg",
      branch: "pi-agent-resume",
      baseSha: "abc",
    });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: false });
    manager = new AgentManager();
    manager.restorePersisted([{
      ...persisted(),
      workspaceBaseCwd: "/repo",
      configCwd: "/config",
      invocation: { ...persisted().invocation, isolation: "worktree" as const },
    }]);
    const reopenedSession = mockSession();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "ISOLATED",
      session: reopenedSession,
      aborted: false,
      steered: false,
    });

    const record = await manager.resume("durable-agent", "continue", undefined, {
      pi: mockPi,
      ctx: mockCtx,
      thinkingLevel: "off",
    });

    expect(createWorktree).toHaveBeenCalledWith("/repo", expect.stringContaining("durable-agent-resume-"));
    expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3]).toMatchObject({
      cwd: "/wt/resume/pkg",
      configCwd: "/config",
      resumeSessionFile: "/sessions/child.jsonl",
    });
    expect(cleanupWorktree).toHaveBeenCalledWith("/repo", expect.objectContaining({ path: "/wt/resume" }), "durable task");
    expect(reopenedSession.dispose).toHaveBeenCalled();
    expect(record?.session).toBeUndefined();
    expect(record?.sessionCwd).toBe("/repo");
  });
});

describe("AgentManager — disposed fail-closed lifecycle", () => {
  afterEach(() => agentRuntimeTree.resetForTests());

  it("rejects stale spawn before validation, runtime registration, record creation, or runner/session work", () => {
    const manager = new AgentManager();
    manager.dispose();
    vi.mocked(runAgent).mockClear();
    const register = vi.spyOn(agentRuntimeTree, "register");

    expect(() => manager.spawn(mockPi, mockCtx, "worker", "stale", {
      description: "stale spawn",
      cwd: "/definitely/missing",
      isBackground: true,
    })).toThrow("manager is disposed");

    expect(register).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
    register.mockRestore();
  });

  it("rejects stale resume before runtime activation or runner work", async () => {
    const manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "worker", "initial", {
      description: "initial",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    manager.dispose();

    const activate = vi.spyOn(agentRuntimeTree, "activate");
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockClear();
    vi.mocked(runAgent).mockClear();

    await expect(manager.resume(id, "stale resume", undefined, {
      pi: mockPi,
      ctx: mockCtx,
      thinkingLevel: "off",
    })).rejects.toThrow("manager is disposed");

    expect(activate).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    activate.mockRestore();
  });

  it("never drains a stale queued entry once disposal has begun", () => {
    const manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager.spawn(mockPi, mockCtx, "worker", "running", { description: "running", isBackground: true });
    manager.spawn(mockPi, mockCtx, "worker", "queued-a", { description: "queued-a", isBackground: true });
    manager.spawn(mockPi, mockCtx, "worker", "queued-b", { description: "queued-b", isBackground: true });
    expect(runAgent).toHaveBeenCalledTimes(1);

    // Model a completion/disposal race where capacity was released immediately
    // before abortAll visits queued records and those aborts call drainQueue().
    (manager as any).runningBackground = 0;
    manager.dispose();

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(manager.listAgents()).toEqual([]);
  });
});
