import { describe, expect, it } from "vitest";
import { buildNotificationDetails, formatTaskNotification } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";

function makeRecord(): AgentRecord {
  return {
    id: "agent-1",
    type: "reviewer",
    description: "Review implementation",
    status: "completed",
    result: "No critical issues.",
    toolUses: 3,
    startedAt: 1_000,
    completedAt: 2_500,
    lifetimeUsage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 5 },
    compactionCount: 0,
    invocation: {
      modelName: "opencode-go/deepseek-v4-flash",
      thinking: "max",
      runInBackground: true,
    },
  };
}

describe("completion notification presentation", () => {
  it("includes model and effort in model-visible structured content", () => {
    const notification = formatTaskNotification(makeRecord(), 500);

    expect(notification).toContain("<model>opencode-go/deepseek-v4-flash</model>");
    expect(notification).toContain("<thinking>max</thinking>");
  });

  it("preserves model and effort for the custom TUI renderer", () => {
    const details = buildNotificationDetails(makeRecord(), 500);

    expect(details.modelName).toBe("opencode-go/deepseek-v4-flash");
    expect(details.thinking).toBe("max");
  });
});
