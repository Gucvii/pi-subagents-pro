import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionStore } from "../src/agent-session-store.js";
import { MAILBOX_TARGET_REJECTED, MailboxService, mailboxToolParameters } from "../src/mailbox.js";
import type { AgentLineage, MailboxMessage, PersistedAgentRecord } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(prefix: string) {
  const root: AgentLineage = { agentId: `${prefix}-root`, rootAgentId: `${prefix}-root`, depth: 0, maxTreeLevels: 4 };
  const child: AgentLineage = {
    agentId: `${prefix}-child`, parentAgentId: root.agentId, rootAgentId: root.rootAgentId, depth: 1, maxTreeLevels: 4,
  };
  const sibling: AgentLineage = {
    agentId: `${prefix}-sibling`, parentAgentId: root.agentId, rootAgentId: root.rootAgentId, depth: 1, maxTreeLevels: 4,
  };
  const grandchild: AgentLineage = {
    agentId: `${prefix}-grandchild`, parentAgentId: child.agentId, rootAgentId: root.rootAgentId, depth: 2, maxTreeLevels: 4,
  };
  return { root, child, sibling, grandchild };
}

function persistedAgent(lineage: AgentLineage): PersistedAgentRecord {
  return {
    id: lineage.agentId,
    type: "general-purpose",
    description: "mailbox fixture",
    status: "completed",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    lineage: { ...lineage },
    invocation: { sessionPersistence: "durable" },
  };
}

function durableService(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mailbox-"));
  dirs.push(dir);
  const path = join(dir, "index.json");
  const childPath = join(dir, "child-index.json");
  const lineages = tree(prefix);
  writeFileSync(path, JSON.stringify({
    version: 1,
    agents: [persistedAgent(lineages.child), persistedAgent(lineages.sibling)],
  }), "utf-8");
  writeFileSync(childPath, JSON.stringify({
    version: 1,
    agents: [persistedAgent(lineages.grandchild)],
  }), "utf-8");
  const service = new MailboxService();
  service.registerParticipant({ lineage: lineages.root, persistence: "durable" });
  service.registerParticipant({ lineage: lineages.child, persistence: "durable", storePath: path });
  service.registerParticipant({ lineage: lineages.sibling, persistence: "durable", storePath: path });
  service.registerParticipant({ lineage: lineages.grandchild, persistence: "durable", storePath: childPath });
  return { service, path, ...lineages };
}

function persistedMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    message_id: "message-1",
    from_agent_id: "root",
    to_agent_id: "child",
    message: "hello",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mailbox protocol", () => {
  it("uses a closed bounded discriminated union and exposes no sender identity fields", () => {
    expect(Value.Check(mailboxToolParameters, {
      operation: { kind: "send", to_agent_id: "child", message: "hello" },
    })).toBe(true);
    expect(Value.Check(mailboxToolParameters, { operation: { kind: "receive", limit: 2 } })).toBe(true);
    expect(Value.Check(mailboxToolParameters, { operation: { kind: "ack", message_ids: ["message-1"] } })).toBe(true);
    expect(Value.Check(mailboxToolParameters, {
      operation: { kind: "send", to_agent_id: "child", message: "hello", from_agent_id: "forged" },
    })).toBe(false);
    expect(Value.Check(mailboxToolParameters, {
      operation: { kind: "receive" },
      root_agent_id: "forged",
    })).toBe(false);
    expect(Value.Check(mailboxToolParameters, { operation: { kind: "receive", limit: 101 } })).toBe(false);
    expect(Value.Check(mailboxToolParameters, { operation: { kind: "ack", message_ids: Array(101).fill("id") } })).toBe(false);
    expect(Value.Check(mailboxToolParameters, { operation: { kind: "ack", message_ids: [""] } })).toBe(false);
  });
});

describe("MailboxService", () => {
  it("supports parent-to-child and child-to-parent peek receive with idempotent ack", () => {
    const { service, path, root, child } = durableService(`roundtrip-${Date.now()}`);
    const down = service.send(root, child.agentId, "from parent");
    const up = service.send(child, root.agentId, "from child");

    expect(service.receive(child)).toEqual([expect.objectContaining({
      message_id: down.message_id,
      from_agent_id: root.agentId,
      to_agent_id: child.agentId,
      message: "from parent",
    })]);
    expect(service.receive(child)).toHaveLength(1);
    expect(service.receive(root)).toEqual([expect.objectContaining({ message_id: up.message_id })]);

    expect(service.ack(child, [down.message_id])).toBe(1);
    expect(service.ack(child, [down.message_id])).toBe(1);
    expect(service.receive(child)).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf-8")).mailbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ message_id: down.message_id, acknowledged_at: expect.any(String) }),
    ]));
  });

  it("rejects siblings, grandparents, unknown targets, and other roots without target disclosure", () => {
    const { service, root, child, sibling, grandchild } = durableService(`auth-${Date.now()}`);
    const other = tree(`other-${Date.now()}`).root;
    service.registerParticipant({ lineage: other, persistence: "memory" });

    for (const [caller, target] of [
      [child, sibling.agentId],
      [root, grandchild.agentId],
      [child, "unknown-agent"],
      [child, other.agentId],
    ] as const) {
      expect(() => service.send(caller, target, "blocked")).toThrow(MAILBOX_TARGET_REJECTED);
    }
  });

  it("uses immutable canonical lineage and cannot impersonate or re-parent a sender", () => {
    const { service, root, child, sibling } = durableService(`identity-${Date.now()}`);
    expect(() => service.send({ ...child, agentId: sibling.agentId, parentAgentId: child.agentId }, root.agentId, "forged"))
      .toThrow(/identity is unavailable/);
    expect(() => service.registerParticipant({
      lineage: { ...child, parentAgentId: sibling.agentId },
      persistence: "durable",
    })).toThrow(/Conflicting mailbox lineage/);
    expect(service.receive(root)).toEqual([]);
  });

  it("enforces UTF-8 byte size, receive, and acknowledgement bounds at runtime", () => {
    const { service, root, child } = durableService(`bounds-${Date.now()}`);
    expect(() => service.send(root, child.agentId, "界".repeat(5461))).not.toThrow();
    expect(() => service.send(root, child.agentId, "界".repeat(5462))).toThrow(/16384-byte UTF-8 limit/);
    expect(() => service.receive(root, 0)).toThrow(/integer from 1 to 100/);
    expect(() => service.receive(root, 101)).toThrow(/integer from 1 to 100/);
    expect(() => service.ack(root, [])).toThrow(/1 to 100/);
    expect(() => service.ack(root, Array(101).fill("id"))).toThrow(/1 to 100/);
    expect(() => service.ack(root, [""])).toThrow(/non-empty/);
    expect(() => service.ack(root, ["x".repeat(129)])).toThrow(/at most 128/);
  });

  it("safely unregisters memory participants and removes their process-only messages", () => {
    const { root, child } = tree(`unregister-${Date.now()}`);
    const service = new MailboxService();
    service.registerParticipant({ lineage: root, persistence: "durable" });
    service.registerParticipant({ lineage: child, persistence: "memory" });
    service.send(root, child.agentId, "ephemeral");
    expect(service.unregisterParticipant({ ...child, parentAgentId: "forged" })).toBe(false);
    expect(service.unregisterParticipant(child)).toBe(true);
    service.registerParticipant({ lineage: child, persistence: "memory" });
    expect(service.receive(child)).toEqual([]);
  });

  it("surfaces and clears a trusted caller's durable store issue", () => {
    const { service, root } = durableService(`issue-${Date.now()}`);
    service.setParticipantIssue(root, "Durable mailbox store is corrupt: /index. It was not modified.");
    expect(() => service.receive(root)).toThrow(/store is corrupt/);
    expect(() => service.ack(root, ["message-1"])).toThrow(/store is corrupt/);
    service.registerParticipant({ lineage: root, persistence: "durable" });
    expect(service.receive(root)).toEqual([]);
  });

  it("keeps memory mail process-local and does not create a durable index", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-memory-mailbox-"));
    dirs.push(dir);
    const forbiddenPath = join(dir, "must-not-exist.json");
    const { root, child } = tree(`memory-${Date.now()}`);
    const first = new MailboxService();
    first.registerParticipant({ lineage: root, persistence: "durable" });
    first.registerParticipant({ lineage: child, persistence: "memory", storePath: forbiddenPath });
    first.send(root, child.agentId, "ephemeral");

    const secondActivation = new MailboxService();
    secondActivation.registerParticipant({ lineage: child, persistence: "durable" });
    expect(secondActivation.receive(child)).toEqual([expect.objectContaining({ message: "ephemeral" })]);
    expect(existsSync(forbiddenPath)).toBe(false);
  });
});

describe("durable mailbox store", () => {
  it("reopens mailbox state and remains compatible with legacy version 1 indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-durable-mailbox-"));
    dirs.push(dir);
    const path = join(dir, "index.json");
    const child: AgentLineage = { agentId: "child", parentAgentId: "root", rootAgentId: "root", depth: 1, maxTreeLevels: 3 };
    writeFileSync(path, JSON.stringify({ version: 1, agents: [persistedAgent(child)] }), "utf-8");

    const legacy = new AgentSessionStore(path);
    expect(legacy.receiveMailboxMessages("child")).toEqual([]);
    legacy.sendMailboxMessage(persistedMessage());

    const reopened = new AgentSessionStore(path);
    expect(reopened.receiveMailboxMessages("child")).toEqual([persistedMessage()]);
  });

  it("rejects a forged durable sender relation without modifying the index", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-forged-mailbox-"));
    dirs.push(dir);
    const path = join(dir, "index.json");
    const child: AgentLineage = {
      agentId: "child", parentAgentId: "root", rootAgentId: "root", depth: 1, maxTreeLevels: 3,
    };
    const content = JSON.stringify({
      version: 1,
      agents: [persistedAgent(child)],
      mailbox: [persistedMessage({ from_agent_id: "forged-sender" })],
    });
    writeFileSync(path, content, "utf-8");

    const store = new AgentSessionStore(path);
    expect(store.getIssue()).toMatchObject({ kind: "corrupt-index" });
    expect(() => store.receiveMailboxMessages("child")).toThrow(/index is corrupt/);
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("does not overwrite a corrupt index during mailbox operations", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-corrupt-mailbox-"));
    dirs.push(dir);
    const path = join(dir, "index.json");
    writeFileSync(path, "{ broken", "utf-8");
    const store = new AgentSessionStore(path);

    expect(() => store.sendMailboxMessage(persistedMessage())).toThrow(/index is corrupt/);
    expect(() => store.receiveMailboxMessages("child")).toThrow(/index is corrupt/);
    expect(() => store.ackMailboxMessages("child", ["message-1"])).toThrow(/index is corrupt/);
    expect(readFileSync(path, "utf-8")).toBe("{ broken");
  });

  it("reloads under the lock so stale store instances do not lose sequential mutations", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-concurrent-mailbox-"));
    dirs.push(dir);
    const path = join(dir, "index.json");
    const child: AgentLineage = { agentId: "child", parentAgentId: "root", rootAgentId: "root", depth: 1, maxTreeLevels: 3 };
    writeFileSync(path, JSON.stringify({ version: 1, agents: [persistedAgent(child)] }), "utf-8");
    const first = new AgentSessionStore(path);
    const second = new AgentSessionStore(path);

    first.sendMailboxMessage(persistedMessage({ message_id: "one" }));
    second.sendMailboxMessage(persistedMessage({ message_id: "two" }));

    expect(new AgentSessionStore(path).receiveMailboxMessages("child").map((message) => message.message_id).sort())
      .toEqual(["one", "two"]);
  });

  it("rejects obviously invalid mailbox IDs while leaving the index untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-invalid-mailbox-"));
    dirs.push(dir);
    const path = join(dir, "index.json");
    const content = JSON.stringify({ version: 1, agents: [], mailbox: [persistedMessage({ message_id: "" })] });
    writeFileSync(path, content, "utf-8");
    const store = new AgentSessionStore(path);
    expect(store.getIssue()?.kind).toBe("corrupt-index");
    expect(() => store.receiveMailboxMessages("child")).toThrow(/index is corrupt/);
    expect(readFileSync(path, "utf-8")).toBe(content);
  });
});
