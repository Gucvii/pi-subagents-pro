import type { AgentLineage } from "./types.js";

/** User-facing tree levels include the main agent as level 1. */
export const DEFAULT_MAX_TREE_LEVELS = 3;
export const MIN_MAX_TREE_LEVELS = 1;
export const MAX_MAX_TREE_LEVELS = 16;
export const LINEAGE_ENTRY_TYPE = "pi-subagents:lineage";

type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

type SessionManagerLike = {
  getSessionId?: () => string;
  getBranch?: () => SessionEntryLike[];
  appendCustomEntry?: (customType: string, data?: unknown) => string;
};

// Dynamic resource loading can evaluate this package more than once in one
// process. A Symbol.for registry keeps lineage shared across those module copies;
// the persisted custom entry rehydrates it after process restart.
type LineageRegistry = {
  bySession: WeakMap<object, AgentLineage>;
  bySessionId: Map<string, AgentLineage>;
};
const LINEAGE_REGISTRY_KEY = Symbol.for("pi-subagents:lineage-registry");
const lineageRegistry: LineageRegistry = (globalThis as Record<PropertyKey, unknown>)[LINEAGE_REGISTRY_KEY] as LineageRegistry
  ?? { bySession: new WeakMap<object, AgentLineage>(), bySessionId: new Map<string, AgentLineage>() };
(globalThis as Record<PropertyKey, unknown>)[LINEAGE_REGISTRY_KEY] = lineageRegistry;
const lineageBySession = lineageRegistry.bySession;
const lineageBySessionId = lineageRegistry.bySessionId;

function cacheLineage(sessionManager: SessionManagerLike, lineage: AgentLineage): void {
  if (typeof sessionManager === "object") lineageBySession.set(sessionManager, lineage);
  const sessionId = sessionManager.getSessionId?.();
  if (sessionId) lineageBySessionId.set(sessionId, lineage);
}

export function normalizeMaxTreeLevels(value: number | undefined): number {
  if (!Number.isInteger(value)) return DEFAULT_MAX_TREE_LEVELS;
  return Math.min(MAX_MAX_TREE_LEVELS, Math.max(MIN_MAX_TREE_LEVELS, value as number));
}

function parseLineage(value: unknown): AgentLineage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AgentLineage>;
  if (
    typeof candidate.agentId !== "string"
    || candidate.agentId.length === 0
    || typeof candidate.rootAgentId !== "string"
    || candidate.rootAgentId.length === 0
    || !Number.isInteger(candidate.depth)
    || (candidate.depth as number) < 0
    || !Number.isInteger(candidate.maxTreeLevels)
  ) {
    return undefined;
  }
  const maxTreeLevels = normalizeMaxTreeLevels(candidate.maxTreeLevels);
  if ((candidate.depth as number) >= maxTreeLevels) return undefined;
  return {
    agentId: candidate.agentId,
    parentAgentId: typeof candidate.parentAgentId === "string" && candidate.parentAgentId.length > 0
      ? candidate.parentAgentId
      : undefined,
    rootAgentId: candidate.rootAgentId,
    depth: candidate.depth as number,
    maxTreeLevels,
  };
}

function parsePromptLineage(systemPrompt: string | undefined): AgentLineage | undefined {
  if (!systemPrompt?.includes("<active_agent ")) return undefined;
  const tags = [...systemPrompt.matchAll(/<agent_tree\s+([^>]+)>/g)];
  const attributes = tags.at(-1)?.[1];
  if (!attributes) return undefined;
  const attr = (name: string): string | undefined => {
    const value = new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1];
    if (value == null) return undefined;
    try { return decodeURIComponent(value); } catch { return undefined; }
  };
  return parseLineage({
    agentId: attr("agent_id"),
    parentAgentId: attr("parent_agent_id") || undefined,
    rootAgentId: attr("root_agent_id"),
    depth: Number(attr("depth")),
    maxTreeLevels: Number(attr("max_levels")),
  });
}

/** Resolve the current session's immutable lineage, synthesizing the main agent as depth 0. */
export function resolveSessionLineage(
  sessionManager: SessionManagerLike | undefined,
  maxTreeLevels = DEFAULT_MAX_TREE_LEVELS,
  systemPrompt?: string,
): AgentLineage {
  if (sessionManager && typeof sessionManager === "object") {
    const cached = lineageBySession.get(sessionManager);
    if (cached) return cached;
    const sessionId = sessionManager.getSessionId?.();
    if (sessionId) {
      const cachedById = lineageBySessionId.get(sessionId);
      if (cachedById) {
        lineageBySession.set(sessionManager, cachedById);
        return cachedById;
      }
    }
  }
  const branch = sessionManager?.getBranch?.() ?? [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== LINEAGE_ENTRY_TYPE) continue;
    const parsed = parseLineage(entry.data);
    if (parsed) {
      if (sessionManager) cacheLineage(sessionManager, parsed);
      return parsed;
    }
  }

  // Dynamic extension loading may evaluate this module more than once, so the
  // generated immutable system tag is the cross-instance fallback when a
  // persisted custom entry is not visible through the current branch.
  const promptLineage = parsePromptLineage(systemPrompt);
  if (promptLineage) {
    if (sessionManager) cacheLineage(sessionManager, promptLineage);
    return promptLineage;
  }
  const rootAgentId = sessionManager?.getSessionId?.() || "main";
  const root: AgentLineage = {
    agentId: rootAgentId,
    rootAgentId,
    depth: 0,
    maxTreeLevels: normalizeMaxTreeLevels(maxTreeLevels),
  };
  if (sessionManager) cacheLineage(sessionManager, root);
  return root;
}

export type RestoredChildValidation = { ok: true } | { ok: false; reason: string };

/** Validate immutable lineage loaded from any durable Agent index. */
export function validatePersistedAgentLineage(
  record: { id: unknown; lineage: unknown },
): RestoredChildValidation {
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    return { ok: false, reason: "record id is empty" };
  }
  if (!record.lineage || typeof record.lineage !== "object") {
    return { ok: false, reason: "lineage is missing" };
  }
  const lineage = record.lineage as Partial<AgentLineage>;
  if (typeof lineage.agentId !== "string" || lineage.agentId.trim().length === 0) {
    return { ok: false, reason: "lineage agent id is empty" };
  }
  if (record.id !== lineage.agentId) {
    return { ok: false, reason: "record id does not match lineage agent id" };
  }
  if (typeof lineage.rootAgentId !== "string" || lineage.rootAgentId.trim().length === 0) {
    return { ok: false, reason: "lineage root id is empty" };
  }
  if (typeof lineage.parentAgentId !== "string" || lineage.parentAgentId.trim().length === 0) {
    return { ok: false, reason: "lineage parent id is empty" };
  }
  if (!Number.isInteger(lineage.depth) || (lineage.depth as number) < 1) {
    return { ok: false, reason: "lineage depth is invalid" };
  }
  if (
    !Number.isInteger(lineage.maxTreeLevels)
    || (lineage.maxTreeLevels as number) < MIN_MAX_TREE_LEVELS
    || (lineage.maxTreeLevels as number) > MAX_MAX_TREE_LEVELS
    || (lineage.depth as number) >= (lineage.maxTreeLevels as number)
  ) {
    return { ok: false, reason: "lineage tree limit is invalid" };
  }
  return { ok: true };
}

/** Fail-closed validation for a record loaded from the current parent's durable index. */
export function validateRestoredDirectChild(
  record: { id: unknown; lineage: unknown },
  current: AgentLineage,
): RestoredChildValidation {
  const persisted = validatePersistedAgentLineage(record);
  if (!persisted.ok) return persisted;
  const lineage = record.lineage as AgentLineage;
  if (lineage.rootAgentId !== current.rootAgentId) {
    return { ok: false, reason: "lineage root does not match the current tree" };
  }
  if (lineage.parentAgentId !== current.agentId) {
    return { ok: false, reason: "lineage is not a direct child of the current session" };
  }
  if (lineage.depth !== current.depth + 1) {
    return { ok: false, reason: "lineage depth is not one below the current session" };
  }
  return { ok: true };
}

export function canSpawnChild(lineage: AgentLineage): boolean {
  return lineage.depth + 1 < lineage.maxTreeLevels;
}

export function assertCanSpawnChild(lineage: AgentLineage): void {
  if (canSpawnChild(lineage)) return;
  const level = lineage.depth + 1;
  throw new Error(
    `Agent tree level limit reached: current level ${level}, maximum ${lineage.maxTreeLevels}. `
    + "Complete the task yourself or report back to the parent.",
  );
}

/** Derive child lineage from trusted session metadata; callers cannot supply depth. */
export function createChildLineage(parent: AgentLineage, childAgentId: string): AgentLineage {
  assertCanSpawnChild(parent);
  return {
    agentId: childAgentId,
    parentAgentId: parent.agentId,
    rootAgentId: parent.rootAgentId,
    depth: parent.depth + 1,
    maxTreeLevels: parent.maxTreeLevels,
  };
}

/** Bind runtime lineage and persist it before extension tools can execute. */
export function appendLineageEntry(sessionManager: SessionManagerLike, lineage: AgentLineage): void {
  cacheLineage(sessionManager, lineage);
  sessionManager.appendCustomEntry?.(LINEAGE_ENTRY_TYPE, lineage);
}
