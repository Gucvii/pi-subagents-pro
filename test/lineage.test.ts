import { describe, expect, it, vi } from "vitest";
import {
  appendLineageEntry,
  assertCanSpawnChild,
  canSpawnChild,
  createChildLineage,
  DEFAULT_MAX_TREE_LEVELS,
  LINEAGE_ENTRY_TYPE,
  normalizeMaxTreeLevels,
  resolveSessionLineage,
  validateRestoredDirectChild,
} from "../src/lineage.js";

describe("Agent tree lineage", () => {
  it("counts the main agent as level 1 and defaults to three total levels", () => {
    const root = resolveSessionLineage({
      getSessionId: () => "main-session",
      getBranch: () => [],
    });

    expect(root).toEqual({
      agentId: "main-session",
      rootAgentId: "main-session",
      depth: 0,
      maxTreeLevels: DEFAULT_MAX_TREE_LEVELS,
    });

    const child = createChildLineage(root, "child");
    const grandchild = createChildLineage(child, "grandchild");
    expect(child.depth).toBe(1);
    expect(grandchild.depth).toBe(2);
    expect(canSpawnChild(child)).toBe(true);
    expect(canSpawnChild(grandchild)).toBe(false);
    expect(() => createChildLineage(grandchild, "forbidden")).toThrow(
      "current level 3, maximum 3",
    );
  });

  it("restores the latest valid persisted lineage instead of trusting caller input", () => {
    const persisted = {
      agentId: "child",
      parentAgentId: "main",
      rootAgentId: "main",
      depth: 1,
      maxTreeLevels: 3,
    };
    const resolved = resolveSessionLineage({
      getSessionId: () => "different-session",
      getBranch: () => [
        { type: "custom", customType: LINEAGE_ENTRY_TYPE, data: persisted },
        { type: "custom", customType: LINEAGE_ENTRY_TYPE, data: { depth: -1 } },
      ],
    }, 10);

    expect(resolved).toEqual(persisted);
  });

  it("rehydrates lineage from the generated child system tag across module instances", () => {
    const resolved = resolveSessionLineage(
      undefined,
      10,
      '<active_agent name="worker"/>\n<agent_tree level="3" max_levels="3" depth="2" agent_id="grandchild" parent_agent_id="child" root_agent_id="main">',
    );

    expect(resolved).toEqual({
      agentId: "grandchild",
      parentAgentId: "child",
      rootAgentId: "main",
      depth: 2,
      maxTreeLevels: 3,
    });
  });

  it("fail-closes restored records unless they are exact direct children", () => {
    const current = { agentId: "parent", rootAgentId: "root", parentAgentId: "root", depth: 1, maxTreeLevels: 4 };
    const valid = {
      id: "child",
      lineage: { agentId: "child", parentAgentId: "parent", rootAgentId: "root", depth: 2, maxTreeLevels: 4 },
    };
    expect(validateRestoredDirectChild(valid, current)).toEqual({ ok: true });
    // A child freezes the tree limit it was created with; changing the root setting
    // later must not make an otherwise valid durable session unrestorable.
    expect(validateRestoredDirectChild({
      ...valid,
      lineage: { ...valid.lineage, maxTreeLevels: 3 },
    }, current)).toEqual({ ok: true });

    const invalid = [
      { ...valid, id: "other" },
      { ...valid, lineage: { ...valid.lineage, agentId: "" } },
      { ...valid, lineage: { ...valid.lineage, parentAgentId: "" } },
      { ...valid, lineage: { ...valid.lineage, rootAgentId: "" } },
      { ...valid, lineage: { ...valid.lineage, parentAgentId: "sibling" } },
      { ...valid, lineage: { ...valid.lineage, rootAgentId: "other-root" } },
      { ...valid, lineage: { ...valid.lineage, depth: 3 } },
      { ...valid, lineage: { ...valid.lineage, maxTreeLevels: 99 } },
    ];
    for (const record of invalid) {
      expect(validateRestoredDirectChild(record, current)).toMatchObject({ ok: false });
    }
  });

  it("persists lineage as a Pi custom session entry", () => {
    const appendCustomEntry = vi.fn();
    const lineage = {
      agentId: "child",
      parentAgentId: "main",
      rootAgentId: "main",
      depth: 1,
      maxTreeLevels: 3,
    };

    appendLineageEntry({ appendCustomEntry }, lineage);
    expect(appendCustomEntry).toHaveBeenCalledWith(LINEAGE_ENTRY_TYPE, lineage);
  });

  it("normalizes hand-edited limits and rejects spawning at level one of one", () => {
    expect(normalizeMaxTreeLevels(undefined)).toBe(3);
    expect(normalizeMaxTreeLevels(0)).toBe(1);
    expect(normalizeMaxTreeLevels(999)).toBe(16);

    const rootOnly = { agentId: "main", rootAgentId: "main", depth: 0, maxTreeLevels: 1 };
    expect(() => assertCanSpawnChild(rootOnly)).toThrow("current level 1, maximum 1");
  });
});
