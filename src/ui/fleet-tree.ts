import { MAX_MAX_TREE_LEVELS, MIN_MAX_TREE_LEVELS, validatePersistedAgentLineage } from "../lineage.js";
import type { AgentLineage } from "../types.js";
import type { FleetAgentHandle } from "./fleet-registry.js";

export interface FleetTreeNode {
  key: string;
  agentId: string;
  kind: "main" | "agent";
  handle?: FleetAgentHandle;
  parent?: FleetTreeNode;
  children: FleetTreeNode[];
  orphan: boolean;
}

export interface FleetTree {
  main: FleetTreeNode;
  orphans: FleetTreeNode[];
  byKey: Map<string, FleetTreeNode>;
}

export interface VisibleFleetNode {
  node: FleetTreeNode;
  /** Whether each ancestor level has a later sibling and therefore needs `│`. */
  ancestorContinues: boolean[];
  isLast: boolean;
}

export const mainFleetKey = (agentId: string): string => `main:${agentId}`;
export const agentFleetKey = (agentId: string): string => `agent:${agentId}`;

const compareNodes = (a: FleetTreeNode, b: FleetTreeNode): number => {
  const ar = a.handle?.record;
  const br = b.handle?.record;
  return (ar?.startedAt ?? 0) - (br?.startedAt ?? 0) || a.agentId.localeCompare(b.agentId);
};

/** Fleet also receives main-session lineage, which the persisted-child validator rejects. */
export function isValidFleetCurrentLineage(value: unknown): value is AgentLineage {
  if (!value || typeof value !== "object") return false;
  const lineage = value as Partial<AgentLineage>;
  if (
    typeof lineage.agentId !== "string"
    || lineage.agentId.trim().length === 0
    || typeof lineage.rootAgentId !== "string"
    || lineage.rootAgentId.trim().length === 0
    || !Number.isInteger(lineage.depth)
    || (lineage.depth as number) < 0
    || !Number.isInteger(lineage.maxTreeLevels)
    || (lineage.maxTreeLevels as number) < MIN_MAX_TREE_LEVELS
    || (lineage.maxTreeLevels as number) > MAX_MAX_TREE_LEVELS
    || (lineage.depth as number) >= (lineage.maxTreeLevels as number)
  ) return false;
  if (lineage.depth === 0) {
    return lineage.agentId === lineage.rootAgentId && lineage.parentAgentId === undefined;
  }
  return typeof lineage.parentAgentId === "string"
    && lineage.parentAgentId.trim().length > 0
    && lineage.parentAgentId !== lineage.agentId;
}

function emptyTree(current: Partial<AgentLineage>): FleetTree {
  const agentId = typeof current.agentId === "string" ? current.agentId : "";
  const main: FleetTreeNode = {
    key: mainFleetKey(agentId), agentId, kind: "main", children: [], orphan: false,
  };
  return { main, orphans: [], byKey: new Map([[main.key, main]]) };
}

function trustworthyForTree(handle: FleetAgentHandle, current: AgentLineage): boolean {
  const { record } = handle;
  if (!validatePersistedAgentLineage(record).ok) return false;
  const lineage = record.lineage;
  return lineage.rootAgentId === current.rootAgentId
    && lineage.maxTreeLevels === current.maxTreeLevels
    && lineage.depth > current.depth;
}

/**
 * Pure trusted-lineage projection. Records stay owned by their managers; nodes only
 * point at live handles. A missing parent is explicit; malformed lineage is omitted.
 */
export function buildFleetTree(current: AgentLineage, handles: readonly FleetAgentHandle[]): FleetTree {
  if (!isValidFleetCurrentLineage(current)) return emptyTree(current ?? {});
  const main: FleetTreeNode = {
    key: mainFleetKey(current.agentId), agentId: current.agentId, kind: "main", children: [], orphan: false,
  };
  const byKey = new Map<string, FleetTreeNode>([[main.key, main]]);
  const byAgentId = new Map<string, FleetTreeNode>();

  for (const handle of handles) {
    const { record } = handle;
    if (!record || record.id === current.agentId || !trustworthyForTree(handle, current)) continue;
    if (byAgentId.has(record.id)) continue;
    const node: FleetTreeNode = {
      key: agentFleetKey(record.id), agentId: record.id, kind: "agent", handle, children: [], orphan: false,
    };
    byAgentId.set(record.id, node);
    byKey.set(node.key, node);
  }

  // Reject records whose referenced edge exists but contradicts its parent. Their
  // descendants are rejected too; only a genuinely absent parent can be an orphan.
  const invalidIds = new Set<string>();
  for (const node of byAgentId.values()) {
    const lineage = node.handle!.record.lineage;
    if (lineage.parentAgentId === current.agentId) {
      if (lineage.depth !== current.depth + 1) invalidIds.add(node.agentId);
      continue;
    }
    const parent = byAgentId.get(lineage.parentAgentId!);
    if (!parent) continue;
    const parentLineage = parent.handle!.record.lineage;
    if (
      parentLineage.rootAgentId !== lineage.rootAgentId
      || parentLineage.maxTreeLevels !== lineage.maxTreeLevels
      || parentLineage.agentId !== lineage.parentAgentId
      || parentLineage.depth + 1 !== lineage.depth
    ) invalidIds.add(node.agentId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of byAgentId.values()) {
      if (!invalidIds.has(node.agentId) && invalidIds.has(node.handle!.record.lineage.parentAgentId!)) {
        invalidIds.add(node.agentId);
        changed = true;
      }
    }
  }
  for (const id of invalidIds) {
    byAgentId.delete(id);
    byKey.delete(agentFleetKey(id));
  }

  const orphans: FleetTreeNode[] = [];
  for (const node of byAgentId.values()) {
    const lineage = node.handle!.record.lineage;
    if (lineage.parentAgentId === current.agentId) {
      node.parent = main;
      main.children.push(node);
      continue;
    }
    const parent = byAgentId.get(lineage.parentAgentId!);
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
      continue;
    }
    node.orphan = true;
    orphans.push(node);
  }

  // A nested Fleet must prove every displayed node is reachable from current.
  if (current.depth > 0) {
    const reachable = new Set<FleetTreeNode>();
    const visit = (node: FleetTreeNode) => {
      reachable.add(node);
      for (const child of node.children) visit(child);
    };
    for (const child of main.children) visit(child);
    for (const [key, node] of byKey) {
      if (node !== main && !reachable.has(node)) byKey.delete(key);
    }
  }

  const sortRecursively = (node: FleetTreeNode) => {
    node.children.sort(compareNodes);
    for (const child of node.children) sortRecursively(child);
  };
  sortRecursively(main);
  orphans.sort(compareNodes);
  for (const orphan of orphans) sortRecursively(orphan);
  return { main, orphans: current.depth === 0 ? orphans : [], byKey };
}

/** Visible preorder, with enough structural metadata to render real connectors. */
export function visibleFleetPreorder(tree: FleetTree, collapsed: ReadonlySet<string>): VisibleFleetNode[] {
  const visible: VisibleFleetNode[] = [{ node: tree.main, ancestorContinues: [], isLast: true }];
  const walkChildren = (parent: FleetTreeNode, ancestorContinues: boolean[]) => {
    if (collapsed.has(parent.key)) return;
    parent.children.forEach((child, index) => {
      const isLast = index === parent.children.length - 1;
      visible.push({ node: child, ancestorContinues, isLast });
      walkChildren(child, [...ancestorContinues, !isLast]);
    });
  };
  walkChildren(tree.main, []);
  tree.orphans.forEach((orphan, index) => {
    const isLast = index === tree.orphans.length - 1;
    visible.push({ node: orphan, ancestorContinues: [], isLast });
    walkChildren(orphan, [!isLast]);
  });
  return visible;
}
