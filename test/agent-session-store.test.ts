import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSessionStore,
  findPersistedAgentRecord,
  resolveAgentSessionStorePath,
  resolveDurableAgentSessionStorePath,
  toPersistedAgentRecord,
} from "../src/agent-session-store.js";
import type { AgentRecord } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "durable task",
    status: "completed",
    result: "DONE",
    toolUses: 4,
    startedAt: 100,
    completedAt: 200,
    lifetimeUsage: { input: 10, output: 20, cacheWrite: 3 },
    compactionCount: 1,
    sessionFile: "/sessions/child.jsonl",
    sessionCwd: "/repo",
    lineage: {
      agentId: "agent-1",
      parentAgentId: "main",
      rootAgentId: "main",
      depth: 1,
      maxTreeLevels: 3,
    },
    invocation: { modelName: "test/model", thinking: "off" },
    ...overrides,
  };
}

describe("AgentSessionStore", () => {
  it("stores only the JSON-safe durable Agent projection", () => {
    const source = record({
      session: { sessionFile: "/sessions/live.jsonl" } as any,
      abortController: new AbortController(),
      promise: Promise.resolve("done"),
    });

    const persisted = toPersistedAgentRecord(source);
    expect(persisted.sessionFile).toBe("/sessions/child.jsonl");
    expect(persisted).not.toHaveProperty("session");
    expect(persisted).not.toHaveProperty("promise");
    expect(persisted).not.toHaveProperty("abortController");
  });

  it("round-trips records through an atomic session-scoped store", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-session-store-"));
    dirs.push(dir);
    const path = join(dir, "subagents", "main.json");

    const first = new AgentSessionStore(path);
    first.upsert(record());
    first.upsert(record({ result: "UPDATED", toolUses: 5 }));

    const reopened = new AgentSessionStore(path);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]).toMatchObject({
      id: "agent-1",
      result: "UPDATED",
      toolUses: 5,
      sessionFile: "/sessions/child.jsonl",
    });
  });

  it("finds an explicit Agent ID across parent sessions in the same project", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
    dirs.push(agentDir);
    const firstPath = resolveDurableAgentSessionStorePath(agentDir, "/repo", "parent-1")!;
    const secondPath = resolveDurableAgentSessionStorePath(agentDir, "/repo", "parent-2")!;
    new AgentSessionStore(firstPath).upsert(record({ id: "other" }));
    new AgentSessionStore(secondPath).upsert(record({ id: "target" }));

    expect(findPersistedAgentRecord(agentDir, "/repo", "target")).toMatchObject({
      storePath: secondPath,
      record: { id: "target", sessionFile: "/sessions/child.jsonl" },
    });
    expect(findPersistedAgentRecord(agentDir, "/different-repo", "target")).toBeUndefined();
  });

  it("uses a stable agent-dir index even when Pi does not expose a parent session directory", () => {
    expect(resolveDurableAgentSessionStorePath("/agent-dir", "/repo", "main-123"))
      .toMatch(/^\/agent-dir\/subagent-sessions\/[a-f0-9]{16}\/main-123\.json$/);
  });

  it("uses the parent Pi session directory and disables that fallback for in-memory parents", () => {
    expect(resolveAgentSessionStorePath({
      getSessionDir: () => "/sessions/project",
      getSessionId: () => "main-123",
    })).toBe(join("/sessions/project", "subagents", "main-123.json"));

    expect(resolveAgentSessionStorePath({
      getSessionDir: () => "",
      getSessionId: () => "memory",
    })).toBeUndefined();
  });
});
