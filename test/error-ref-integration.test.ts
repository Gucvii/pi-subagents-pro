import { afterEach, describe, expect, it, vi } from "vitest";
import { readAgentEntry } from "../src/agent-inspection.js";
import { AgentManager } from "../src/agent-manager.js";
import { agentRuntimeTree } from "../src/agent-runtime-tree.js";
import { buildNotificationDetails, formatTaskNotification } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";

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

const managers: AgentManager[] = [];
const ctx = {
  cwd: "/tmp",
  sessionManager: { getSessionId: () => "error-ref-root", getBranch: () => [] },
} as any;

function failedSession(label: string) {
  const entry = {
    type: "message",
    id: `error-${label}`,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: `provider failed ${label}`,
      timestamp: 1,
    },
  };
  return {
    dispose: vi.fn(),
    sessionManager: {
      getSessionId: () => `session-${label}`,
      getEntries: () => [entry],
    },
  } as any;
}

afterEach(() => {
  for (const manager of managers) manager.dispose();
  managers.length = 0;
  agentRuntimeTree.resetForTests();
  vi.clearAllMocks();
});

describe("error_ref manager-to-notification integration", () => {
  it("publishes directly readable refs in individual and grouped notification records", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt) => ({
      responseText: "",
      session: failedSession(prompt),
      aborted: false,
      steered: false,
      failure: `provider failed ${prompt}`,
    }));
    const completed: AgentRecord[] = [];
    const managerA = new AgentManager(record => completed.push(record));
    const managerB = new AgentManager(record => completed.push(record));
    managers.push(managerA, managerB);

    const idA = managerA.spawn({} as any, ctx, "worker", "alpha", { description: "alpha", isBackground: true });
    const idB = managerB.spawn({} as any, ctx, "worker", "beta", { description: "beta", isBackground: true });
    await Promise.all([managerA.getRecord(idA)!.promise, managerB.getRecord(idB)!.promise]);

    expect(completed).toHaveLength(2);
    const [first, second] = completed;
    const xml = completed.map(record => formatTaskNotification(record, 300)).join("\n\n");
    const details = buildNotificationDetails(first, 300);
    details.others = [buildNotificationDetails(second, 300)];
    expect(xml).toContain(`<error_ref>${first.errorRef}</error_ref>`);
    expect(xml).toContain(`<error_ref>${second.errorRef}</error_ref>`);
    expect([details.errorRef, details.others[0].errorRef]).toEqual([first.errorRef, second.errorRef]);

    for (const record of completed) {
      expect(record.errorRef).toMatch(/^e_[a-f0-9]{24}$/);
      const read = await readAgentEntry(record, record.errorRef!);
      expect(read.json).toContain(`provider failed ${record.description}`);
    }
  });
});
