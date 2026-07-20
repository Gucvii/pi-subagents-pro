import type { AgentLineage, AgentRecord } from "./types.js";

const REGISTRY_KEY = Symbol.for("pi-subagents:agent-runtime-tree");
// Stop results are process-local idempotency receipts, not a durable fact source.
// The LRU bound gives callers a clear best-effort retry window without retaining
// every stopped tree for the lifetime of a long-running Pi process.
const MAX_TOMBSTONES = 1000;

export type RuntimeAgentStatus = AgentRecord["status"];
export type RuntimeStopResult = {
  root_agent_id: string;
  stopped_agents: Array<{ agent_id: string; previous_status: RuntimeAgentStatus; depth: number }>;
  stop_failures?: Array<{ agent_id: string; message: string }>;
  already_terminal: boolean;
  reason: string | null;
};

type RuntimeNode = {
  lineage: AgentLineage;
  projectCwd: string;
  owner: object;
  stop?: (reason?: string) => boolean;
  getStatus?: () => RuntimeAgentStatus;
  active: boolean;
  settled: boolean;
  stopping: boolean;
};

type StopTombstone = {
  lineage: AgentLineage;
  projectCwd: string;
  result: RuntimeStopResult;
};

type RuntimeState = {
  nodes: Map<string, RuntimeNode>;
  tombstones: Map<string, StopTombstone>;
};

function state(): RuntimeState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[REGISTRY_KEY];
  if (existing !== undefined) {
    if (
      !existing
      || typeof existing !== "object"
      || !((existing as RuntimeState).nodes instanceof Map)
      || !((existing as RuntimeState).tombstones instanceof Map)
    ) {
      throw new Error("Agent runtime tree registry is invalid.");
    }
    return existing as RuntimeState;
  }
  const created: RuntimeState = { nodes: new Map(), tombstones: new Map() };
  global[REGISTRY_KEY] = created;
  return created;
}

function sameLineage(a: AgentLineage, b: AgentLineage): boolean {
  return a.agentId === b.agentId
    && a.parentAgentId === b.parentAgentId
    && a.rootAgentId === b.rootAgentId
    && a.depth === b.depth
    && a.maxTreeLevels === b.maxTreeLevels;
}

function descendantsOf(nodes: Iterable<RuntimeNode>, root: AgentLineage): RuntimeNode[] {
  const byParent = new Map<string, RuntimeNode[]>();
  for (const node of nodes) {
    if (node.lineage.rootAgentId !== root.rootAgentId || !node.lineage.parentAgentId) continue;
    const children = byParent.get(node.lineage.parentAgentId) ?? [];
    children.push(node);
    byParent.set(node.lineage.parentAgentId, children);
  }
  const result: RuntimeNode[] = [];
  const pending = [...(byParent.get(root.agentId) ?? [])];
  while (pending.length > 0) {
    const node = pending.pop()!;
    result.push(node);
    pending.push(...(byParent.get(node.lineage.agentId) ?? []));
  }
  return result;
}

function pruneFrom(agentId: string): void {
  const registry = state();
  let current = registry.nodes.get(agentId);
  while (current?.settled) {
    const hasChildren = [...registry.nodes.values()].some(
      (candidate) => candidate.lineage.parentAgentId === current!.lineage.agentId
        && candidate.lineage.rootAgentId === current!.lineage.rootAgentId,
    );
    if (hasChildren) return;
    registry.nodes.delete(current.lineage.agentId);
    current = current.lineage.parentAgentId
      ? registry.nodes.get(current.lineage.parentAgentId)
      : undefined;
  }
}

function rememberStop(agentId: string, tombstone: StopTombstone): void {
  const tombstones = state().tombstones;
  tombstones.delete(agentId);
  tombstones.set(agentId, tombstone);
  while (tombstones.size > MAX_TOMBSTONES) {
    const oldest = tombstones.keys().next().value;
    if (oldest) tombstones.delete(oldest);
  }
}

function isDirectChild(caller: AgentLineage, target: AgentLineage): boolean {
  return target.rootAgentId === caller.rootAgentId
    && target.parentAgentId === caller.agentId
    && target.depth === caller.depth + 1;
}

export class AgentRuntimeTree {
  register(
    lineage: AgentLineage,
    projectCwd: string,
    owner: object,
    callbacks: { stop: (reason?: string) => boolean; getStatus: () => RuntimeAgentStatus },
  ): void {
    const registry = state();
    const existing = registry.nodes.get(lineage.agentId);
    if (existing) {
      throw new Error(`Agent runtime registration conflict for "${lineage.agentId}".`);
    }
    this.assertSpawnAllowed(lineage);
    registry.tombstones.delete(lineage.agentId);
    registry.nodes.set(lineage.agentId, {
      lineage: { ...lineage },
      projectCwd,
      owner,
      stop: callbacks.stop,
      getStatus: callbacks.getStatus,
      active: true,
      settled: false,
      stopping: false,
    });
  }

  activate(
    lineage: AgentLineage,
    projectCwd: string,
    owner: object,
    callbacks: { stop: (reason?: string) => boolean; getStatus: () => RuntimeAgentStatus },
  ): void {
    const registry = state();
    const existing = registry.nodes.get(lineage.agentId);
    if (existing?.stopping) {
      throw new Error("Cannot spawn or resume Agent while its subtree is stopping.");
    }
    if (existing && (!existing.settled || !sameLineage(existing.lineage, lineage) || existing.projectCwd !== projectCwd)) {
      throw new Error(`Agent runtime registration conflict for "${lineage.agentId}".`);
    }
    this.assertParentActive(lineage, "spawn or resume");
    registry.tombstones.delete(lineage.agentId);
    registry.nodes.set(lineage.agentId, {
      lineage: { ...lineage },
      projectCwd,
      owner,
      stop: callbacks.stop,
      getStatus: callbacks.getStatus,
      active: true,
      settled: false,
      stopping: false,
    });
  }

  assertSpawnAllowed(child: AgentLineage): void {
    this.assertParentActive(child, "spawn");
  }

  /**
   * Revalidate a node that was already registered by spawn() and is now leaving
   * the manager queue. Parent completion is allowed: registration already proved
   * the parent relation, and completed ancestors are retained only as skeletons
   * while descendants remain. A stopping marker, however, always wins the race.
   */
  assertQueuedStartAllowed(lineage: AgentLineage): void {
    const node = state().nodes.get(lineage.agentId);
    if (!node || !sameLineage(node.lineage, lineage) || !node.active || node.settled) {
      throw new Error("Cannot start queued Agent because its runtime is missing, inactive, or inconsistent.");
    }
    if (node.stopping) {
      throw new Error("Cannot start queued Agent while its subtree is stopping.");
    }
    this.assertAncestorsNotStopping(node.lineage);
  }

  private assertParentActive(lineage: AgentLineage, operation: "spawn" | "spawn or resume"): void {
    const nodes = state().nodes;
    const parent = lineage.parentAgentId ? nodes.get(lineage.parentAgentId) : undefined;
    // A main activation has no runtime node of its own, so main → child is the
    // sole missing-parent exception. Nested operations fail closed: a stale
    // child context must not recreate an orphan after its parent was pruned.
    if (lineage.depth >= 2 && !parent) {
      throw new Error(`Cannot ${operation} Agent because its parent is no longer active (parent runtime is missing).`);
    }
    if (!parent) return;
    if (parent.stopping) {
      throw new Error("Cannot spawn or resume Agent while its ancestor subtree is stopping.");
    }
    // Execution cwd is intentionally not a lineage invariant: custom-cwd and
    // worktree descendants commonly run somewhere other than their parent.
    // projectCwd remains an authorization boundary only for direct-child stop.
    const relationMatches = parent.lineage.agentId === lineage.parentAgentId
      && parent.lineage.rootAgentId === lineage.rootAgentId
      && parent.lineage.depth === lineage.depth - 1
      && parent.lineage.maxTreeLevels === lineage.maxTreeLevels;
    let parentStatus: RuntimeAgentStatus | undefined;
    try {
      parentStatus = parent.getStatus?.();
    } catch {
      // A status callback belongs to another manager. Treat an unreadable parent
      // as inactive rather than letting nested work proceed on an assumption.
    }
    const statusIsActive = parentStatus === "queued" || parentStatus === "running";
    if (!relationMatches || !parent.active || parent.settled || !statusIsActive) {
      throw new Error(`Cannot ${operation} Agent because its parent is no longer active or its runtime is inconsistent.`);
    }
    this.assertAncestorsNotStopping(parent.lineage);
  }

  private assertAncestorsNotStopping(lineage: AgentLineage): void {
    const nodes = state().nodes;
    let parentId = lineage.parentAgentId;
    while (parentId) {
      const parent = nodes.get(parentId);
      if (!parent) break;
      if (parent.stopping) throw new Error("Cannot spawn or resume Agent while its ancestor subtree is stopping.");
      parentId = parent.lineage.parentAgentId;
    }
  }

  markSettled(agentId: string, owner: object): void {
    const node = state().nodes.get(agentId);
    if (!node || node.owner !== owner || node.settled) return;
    node.active = false;
    node.settled = true;
    node.stop = undefined;
    node.getStatus = undefined;
    pruneFrom(agentId);
  }

  stopDirectChild(caller: AgentLineage, projectCwd: string, targetId: string, reason?: string): RuntimeStopResult {
    const registry = state();
    const target = registry.nodes.get(targetId);
    if (!target) {
      const tombstone = registry.tombstones.get(targetId);
      if (tombstone && tombstone.projectCwd === projectCwd && isDirectChild(caller, tombstone.lineage)) {
        return tombstone.result;
      }
      throw new Error("Agent was not found or is not authorized for this operation.");
    }
    if (target.projectCwd !== projectCwd || !isDirectChild(caller, target.lineage)) {
      throw new Error("Agent was not found or is not authorized for this operation.");
    }
    const prior = registry.tombstones.get(targetId);
    if (target.stopping && prior) return prior.result;

    const subtree = [target, ...descendantsOf(registry.nodes.values(), target.lineage)];
    const subtreeIds = new Set(subtree.map((node) => node.lineage.agentId));
    const ordered = subtree.sort((a, b) => b.lineage.depth - a.lineage.depth);
    const statuses = new Map(ordered.map((node) => [node.lineage.agentId, node.getStatus?.()]));
    const receipts = new Map<string, { result: RuntimeStopResult; failures: NonNullable<RuntimeStopResult["stop_failures"]> }>();
    const stopReason = reason ?? null;

    // Every node receives its own stable in-flight receipt before any callback
    // can settle/prune it or synchronously query another node in the cascade.
    for (const node of ordered) {
      const status = statuses.get(node.lineage.agentId);
      const receipt = {
        result: {
          root_agent_id: node.lineage.agentId,
          stopped_agents: [],
          already_terminal: status !== "queued" && status !== "running",
          reason: stopReason,
        } satisfies RuntimeStopResult,
        failures: [] as NonNullable<RuntimeStopResult["stop_failures"]>,
      };
      receipts.set(node.lineage.agentId, receipt);
      node.stopping = true;
      rememberStop(node.lineage.agentId, {
        lineage: { ...node.lineage },
        projectCwd: node.projectCwd,
        result: receipt.result,
      });
    }

    const receiptAncestors = (node: RuntimeNode): Array<{ result: RuntimeStopResult; failures: NonNullable<RuntimeStopResult["stop_failures"]> }> => {
      const ancestors = [];
      let current: RuntimeNode | undefined = node;
      while (current && subtreeIds.has(current.lineage.agentId)) {
        const receipt = receipts.get(current.lineage.agentId);
        if (receipt) ancestors.push(receipt);
        current = current.lineage.parentAgentId ? registry.nodes.get(current.lineage.parentAgentId) : undefined;
      }
      return ancestors;
    };

    for (const node of ordered) {
      const previousStatus = statuses.get(node.lineage.agentId);
      if (previousStatus !== "queued" && previousStatus !== "running") continue;
      const ancestors = receiptAncestors(node);
      try {
        if (node.stop?.(reason)) {
          const stopped = {
            agent_id: node.lineage.agentId,
            previous_status: previousStatus,
            depth: node.lineage.depth,
          };
          for (const receipt of ancestors) receipt.result.stopped_agents.push(stopped);
        } else {
          const failure = {
            agent_id: node.lineage.agentId,
            message: "Stop callback did not accept the active Agent.",
          };
          for (const receipt of ancestors) receipt.failures.push(failure);
        }
      } catch (error) {
        const failure = {
          agent_id: node.lineage.agentId,
          message: error instanceof Error ? error.message : String(error),
        };
        for (const receipt of ancestors) receipt.failures.push(failure);
      }
    }
    for (const receipt of receipts.values()) {
      if (receipt.failures.length > 0) receipt.result.stop_failures = receipt.failures;
    }
    for (const node of ordered) {
      if (node.settled) pruneFrom(node.lineage.agentId);
    }
    return receipts.get(targetId)!.result;
  }

  stopChildren(lineage: AgentLineage, projectCwd: string, reason?: string): RuntimeStopResult[] {
    const direct = [...state().nodes.values()].filter(
      (node) => node.projectCwd === projectCwd && isDirectChild(lineage, node.lineage),
    );
    return direct.map((node) => this.stopDirectChild(lineage, projectCwd, node.lineage.agentId, reason));
  }

  resetForTests(): void {
    state().nodes.clear();
    state().tombstones.clear();
  }
}

export const agentRuntimeTree = new AgentRuntimeTree();
