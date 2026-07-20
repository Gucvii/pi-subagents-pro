import { beforeEach, describe, expect, it } from "vitest";
import { AgentRuntimeTree } from "../src/agent-runtime-tree.js";
import type { AgentLineage, AgentRecord } from "../src/types.js";

const tree = new AgentRuntimeTree();
const root: AgentLineage = { agentId: "root", rootAgentId: "root", depth: 0, maxTreeLevels: 5 };
const child = (id: string, parent: AgentLineage): AgentLineage => ({
  agentId: id,
  parentAgentId: parent.agentId,
  rootAgentId: parent.rootAgentId,
  depth: parent.depth + 1,
  maxTreeLevels: parent.maxTreeLevels,
});

type Status = AgentRecord["status"];
function register(lineage: AgentLineage, status: Status, order: string[], owner = {}): { owner: object; status: () => Status; setStatus: (status: Status) => void } {
  let current = status;
  tree.register(lineage, "/project", owner, {
    getStatus: () => current,
    stop: () => {
      if (current !== "queued" && current !== "running") return false;
      order.push(lineage.agentId);
      current = "stopped";
      return true;
    },
  });
  return { owner, status: () => current, setStatus: (status) => { current = status; } };
}

describe("AgentRuntimeTree", () => {
  beforeEach(() => tree.resetForTests());

  it("atomically stops a multi-manager subtree deepest-first and leaves siblings alone", () => {
    const order: string[] = [];
    const a = child("a", root);
    const sibling = child("sibling", root);
    const grandchild = child("b", a);
    const greatGrandchild = child("c", grandchild);
    register(a, "running", order);
    register(sibling, "running", order);
    register(grandchild, "queued", order);
    register(greatGrandchild, "running", order);

    const result = tree.stopDirectChild(root, "/project", a.agentId, "done");

    expect(order).toEqual(["c", "b", "a"]);
    expect(result).toEqual({
      root_agent_id: "a",
      stopped_agents: [
        { agent_id: "c", previous_status: "running", depth: 3 },
        { agent_id: "b", previous_status: "queued", depth: 2 },
        { agent_id: "a", previous_status: "running", depth: 1 },
      ],
      already_terminal: false,
      reason: "done",
    });
  });

  it("publishes a stable receipt for every cascaded node before and after settlement pruning", () => {
    const order: string[] = [];
    const a = child("a", root);
    const b = child("b", a);
    const c = child("c", b);
    const aRegistration = register(a, "running", order);
    const bRegistration = register(b, "running", order);
    const cRegistration = register(c, "queued", order);

    const rootReceipt = tree.stopDirectChild(root, "/project", a.agentId, "cascade reason");
    const childReceiptBeforePrune = tree.stopDirectChild(a, "/project", b.agentId, "ignored");
    expect(childReceiptBeforePrune).toEqual({
      root_agent_id: "b",
      stopped_agents: [
        { agent_id: "c", previous_status: "queued", depth: 3 },
        { agent_id: "b", previous_status: "running", depth: 2 },
      ],
      already_terminal: false,
      reason: "cascade reason",
    });
    expect(rootReceipt.stopped_agents.map(entry => entry.agent_id)).toEqual(["c", "b", "a"]);

    tree.markSettled(a.agentId, aRegistration.owner);
    tree.markSettled(b.agentId, bRegistration.owner);
    tree.markSettled(c.agentId, cRegistration.owner);
    expect(tree.stopDirectChild(a, "/project", b.agentId, "still ignored")).toEqual(childReceiptBeforePrune);
  });

  it("uses one non-disclosing failure for sibling, ancestor, grandchild, cwd, and unknown targets", () => {
    const order: string[] = [];
    const a = child("a", root);
    const b = child("b", a);
    register(a, "running", order);
    register(b, "running", order);
    const siblingCaller = child("sibling", root);
    const attempts: Array<() => unknown> = [
      () => tree.stopDirectChild(siblingCaller, "/project", a.agentId),
      () => tree.stopDirectChild(a, "/project", root.agentId),
      () => tree.stopDirectChild(root, "/project", b.agentId),
      () => tree.stopDirectChild(root, "/other", a.agentId),
      () => tree.stopDirectChild(root, "/project", "missing"),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow("Agent was not found or is not authorized for this operation.");
    }
  });

  it("blocks late spawn under every stopping ancestor and makes repeated stops idempotent", () => {
    const order: string[] = [];
    const a = child("a", root);
    const b = child("b", a);
    register(a, "queued", order);
    register(b, "running", order);
    const first = tree.stopDirectChild(root, "/project", a.agentId);
    expect(() => tree.assertSpawnAllowed(child("late", b))).toThrow("ancestor subtree is stopping");
    expect(tree.stopDirectChild(root, "/project", a.agentId)).toEqual(first);
  });

  it("retains a completed parent skeleton until its descendant settles", () => {
    const order: string[] = [];
    const a = child("a", root);
    const b = child("b", a);
    const aRegistration = register(a, "running", order);
    const bRegistration = register(b, "running", order);
    aRegistration.setStatus("completed");
    tree.markSettled(a.agentId, aRegistration.owner);

    const result = tree.stopDirectChild(root, "/project", a.agentId);
    expect(result.already_terminal).toBe(true);
    expect(result.stopped_agents).toEqual([{ agent_id: "b", previous_status: "running", depth: 2 }]);
    expect(() => tree.activate(a, "/project", {}, {
      getStatus: () => "running",
      stop: () => true,
    })).toThrow("subtree is stopping");
    tree.markSettled(b.agentId, bRegistration.owner);
    expect(tree.stopDirectChild(root, "/project", a.agentId)).toEqual(result);
  });

  it("allows explicit resume to clear its own historical stop after the subtree settled", () => {
    const order: string[] = [];
    const a = child("a", root);
    const registration = register(a, "queued", order);
    tree.stopDirectChild(root, "/project", a.agentId);
    tree.markSettled(a.agentId, registration.owner);

    let status: Status = "running";
    expect(() => tree.activate(a, "/project", {}, {
      getStatus: () => status,
      stop: () => { status = "stopped"; return true; },
    })).not.toThrow();
  });

  it("isolates deepest-first stop callback failures and freezes them in the idempotent result", () => {
    const order: string[] = [];
    const a = child("a", root);
    const b = child("b", a);
    const c = child("c", b);
    register(a, "running", order);
    tree.register(b, "/project", {}, {
      getStatus: () => "running",
      stop: () => {
        order.push("b");
        throw new Error("owner b exploded");
      },
    });
    register(c, "running", order);

    const result = tree.stopDirectChild(root, "/project", a.agentId, "stop all");
    expect(order).toEqual(["c", "b", "a"]);
    expect(result.stop_failures).toEqual([{ agent_id: "b", message: "owner b exploded" }]);
    expect(result.stopped_agents.map(entry => entry.agent_id)).toEqual(["c", "a"]);
    expect(tree.stopDirectChild(root, "/project", a.agentId, "different")).toEqual(result);
  });

  it("allows a missing runtime main node only for depth-one spawn and rejects a pruned nested parent", () => {
    const a = child("a", root);
    expect(() => tree.assertSpawnAllowed(a)).not.toThrow();
    expect(() => tree.assertSpawnAllowed(child("orphan", a))).toThrow("parent is no longer active");

    const registration = register(a, "completed", []);
    tree.markSettled(a.agentId, registration.owner);
    expect(() => tree.assertSpawnAllowed(child("late", a))).toThrow("parent is no longer active");
    expect(() => tree.stopDirectChild(root, "/project", a.agentId)).toThrow("not found or is not authorized");
  });

  it("allows nested activation only with the exact active parent lineage, even when execution cwds differ", () => {
    const a = child("a", root);
    const b = child("b", a);
    expect(() => tree.activate(b, "/project", {}, {
      getStatus: () => "running",
      stop: () => true,
    })).toThrow("parent runtime is missing");

    register(a, "running", []);
    expect(() => tree.activate({ ...b, rootAgentId: "other" }, "/project", {}, {
      getStatus: () => "running",
      stop: () => true,
    })).toThrow("runtime is inconsistent");
    expect(() => tree.activate(b, "/worktrees/child", {}, {
      getStatus: () => "running",
      stop: () => true,
    })).not.toThrow();
  });

  it("fails closed on conflicting registrations and ignores late settlement from another owner", () => {
    const order: string[] = [];
    const a = child("a", root);
    register(a, "running", order);
    expect(() => register(a, "running", order)).toThrow("registration conflict");
    tree.markSettled(a.agentId, {});
    expect(tree.stopDirectChild(root, "/project", a.agentId).stopped_agents).toHaveLength(1);
  });
});
