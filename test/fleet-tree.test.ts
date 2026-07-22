import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLineage, AgentRecord } from "../src/types.js";
import {
  type FleetOwnerProvider,
  listFleetAgentHandles,
  registerFleetOwner,
  resetFleetRegistryForTests,
} from "../src/ui/fleet-registry.js";
import { agentFleetKey, buildFleetTree, visibleFleetPreorder } from "../src/ui/fleet-tree.js";

const ROOT: AgentLineage = { agentId: "main", rootAgentId: "main", depth: 0, maxTreeLevels: 3 };
const session = { messages: [], subscribe: () => () => {} } as any;

function record(id: string, parentAgentId: string, depth: number, startedAt: number): AgentRecord {
  return {
    id,
    type: "worker",
    description: id,
    status: "running",
    toolUses: 0,
    startedAt,
    session,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    lineage: { agentId: id, parentAgentId, rootAgentId: "main", depth, maxTreeLevels: 3 },
  };
}

function provider(owner: object, records: AgentRecord[]): FleetOwnerProvider {
  return {
    owner,
    listAgents: () => records,
    getActivity: () => undefined,
    abort: vi.fn(() => true),
    steer: vi.fn(() => true),
  };
}

beforeEach(() => resetFleetRegistryForTests());

describe("Fleet owner registry", () => {
  it("lists live manager records, prevents duplicate owners, and unregisters without leaking", () => {
    const owner = {};
    const records = [record("child", "main", 1, 1)];
    const p = provider(owner, records);
    const unregister = registerFleetOwner(p);
    expect(listFleetAgentHandles().map(handle => handle.record.id)).toEqual(["child"]);
    records.push(record("later", "main", 1, 2));
    expect(listFleetAgentHandles().map(handle => handle.record.id)).toEqual(["child", "later"]);
    expect(() => registerFleetOwner(provider(owner, []))).toThrow(/already registered/);
    unregister();
    unregister();
    expect(listFleetAgentHandles()).toEqual([]);
  });

  it("isolates a throwing provider", () => {
    registerFleetOwner({ ...provider({}, []), listAgents: () => { throw new Error("broken"); } });
    registerFleetOwner(provider({}, [record("healthy", "main", 1, 1)]));
    expect(listFleetAgentHandles().map(handle => handle.record.id)).toEqual(["healthy"]);
  });
});

describe("Fleet tree projection", () => {
  it("builds main → child → grandchild across manager owners in stable preorder", () => {
    const parentOwner = provider({}, [
      record("later", "main", 1, 20),
      record("child", "main", 1, 10),
    ]);
    const childOwner = provider({}, [record("grand", "child", 2, 5)]);
    registerFleetOwner(parentOwner);
    registerFleetOwner(childOwner);
    const tree = buildFleetTree(ROOT, listFleetAgentHandles());
    expect(visibleFleetPreorder(tree, new Set()).map(item => item.node.agentId)).toEqual([
      "main", "child", "grand", "later",
    ]);
    expect(tree.byKey.get(agentFleetKey("grand"))?.parent?.agentId).toBe("child");
  });

  it("sorts equal-time siblings by id and never invents a missing parent", () => {
    const p = provider({}, [
      record("b", "main", 1, 1),
      record("a", "main", 1, 1),
      record("orphan", "missing", 2, 0),
    ]);
    registerFleetOwner(p);
    const tree = buildFleetTree(ROOT, listFleetAgentHandles());
    expect(tree.main.children.map(node => node.agentId)).toEqual(["a", "b"]);
    expect(tree.orphans.map(node => node.agentId)).toEqual(["orphan"]);
    expect(tree.orphans[0].parent).toBeUndefined();
    expect(tree.orphans[0].orphan).toBe(true);
  });

  it("removes collapsed descendants from visible preorder", () => {
    const p = provider({}, [record("child", "main", 1, 1), record("grand", "child", 2, 2)]);
    registerFleetOwner(p);
    const tree = buildFleetTree(ROOT, listFleetAgentHandles());
    expect(visibleFleetPreorder(tree, new Set([agentFleetKey("child")])).map(item => item.node.agentId)).toEqual([
      "main", "child",
    ]);
  });

  it("fails closed for invalid current lineage", () => {
    const handles = [{ record: record("child", "main", 1, 1), provider: provider({}, []) }];
    for (const current of [
      { ...ROOT, agentId: "" },
      { ...ROOT, rootAgentId: "" },
      { ...ROOT, agentId: "not-main" },
      { ...ROOT, parentAgentId: "unexpected" },
      { ...ROOT, depth: 1 },
      { ...ROOT, depth: -1 },
      { ...ROOT, depth: 3 },
      { ...ROOT, depth: 0.5 },
      { ...ROOT, maxTreeLevels: 0 },
      { ...ROOT, maxTreeLevels: 17 },
      { ...ROOT, maxTreeLevels: 2.5 },
    ]) {
      expect(buildFleetTree(current, handles).byKey.size).toBe(1);
    }
  });

  it("omits malformed and max-mismatched records instead of routing them as orphans", () => {
    const badMax = record("bad-max", "main", 1, 1);
    badMax.lineage.maxTreeLevels = 4;
    const tooDeep = record("too-deep", "main", 3, 2);
    const badDepth = record("bad-depth", "main", 1, 3);
    badDepth.lineage.depth = 1.5;
    const emptyRoot = record("empty-root", "main", 1, 4);
    emptyRoot.lineage.rootAgentId = "";
    const good = record("good", "main", 1, 5);
    const tree = buildFleetTree(ROOT, [{ record: badMax, provider: provider({}, []) },
      { record: tooDeep, provider: provider({}, []) },
      { record: badDepth, provider: provider({}, []) },
      { record: emptyRoot, provider: provider({}, []) },
      { record: good, provider: provider({}, []) }]);
    expect([...tree.byKey.values()].map(node => node.agentId)).toEqual(["main", "good"]);
    expect(tree.orphans).toEqual([]);
  });

  it("requires exact parent identity, depth, and max on every attached edge", () => {
    const parent = record("parent", "main", 1, 1);
    const wrongDepth = record("wrong-depth", "parent", 1, 2);
    const wrongParent = record("wrong-parent", "missing", 2, 3);
    const tree = buildFleetTree(ROOT, [parent, wrongDepth, wrongParent].map(item => ({
      record: item, provider: provider({}, []),
    })));
    expect(tree.main.children.map(node => node.agentId)).toEqual(["parent"]);
    expect(tree.orphans.map(node => node.agentId)).toEqual(["wrong-parent"]);
    expect(tree.byKey.has(agentFleetKey("wrong-depth"))).toBe(false);
  });
});
