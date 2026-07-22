import type { AgentRecord } from "../types.js";
import type { AgentActivity } from "./agent-widget.js";

const REGISTRY_KEY = Symbol.for("pi-subagents:fleet-owners");

export interface FleetOwnerProvider {
  /** The actual manager. Its identity is the duplicate-registration key. */
  owner: object;
  listAgents(): AgentRecord[];
  getActivity(agentId: string): AgentActivity | undefined;
  abort(agentId: string): boolean;
  steer(agentId: string, message: string): boolean;
}

export interface FleetAgentHandle {
  record: AgentRecord;
  provider: FleetOwnerProvider;
}

export type FleetRegistryChange =
  | { type: "changed"; record: AgentRecord }
  | { type: "removed"; agentId: string };

export type FleetRegistryListener = (change: FleetRegistryChange) => void;

type FleetRegistryState = {
  owners: Map<object, FleetOwnerProvider>;
  listeners: Set<FleetRegistryListener>;
};

function state(): FleetRegistryState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[REGISTRY_KEY];
  if (existing !== undefined) {
    if (!existing || typeof existing !== "object" || !((existing as FleetRegistryState).owners instanceof Map)) {
      throw new Error("Fleet owner registry is invalid.");
    }
    const compatible = existing as Partial<FleetRegistryState> & Pick<FleetRegistryState, "owners">;
    // Older copies in the same process created an owners-only state. Preserve its
    // live Map while upgrading the container (also works if the old object is frozen).
    if (compatible.listeners === undefined) {
      const upgraded: FleetRegistryState = { owners: compatible.owners, listeners: new Set() };
      global[REGISTRY_KEY] = upgraded;
      return upgraded;
    }
    if (!(compatible.listeners instanceof Set)) throw new Error("Fleet owner registry listeners are invalid.");
    return compatible as FleetRegistryState;
  }
  const created: FleetRegistryState = { owners: new Map(), listeners: new Set() };
  global[REGISTRY_KEY] = created;
  return created;
}

/**
 * Process-global routing registry. It retains providers, never AgentRecord copies;
 * every list call asks every live manager for its current records.
 */
export function registerFleetOwner(provider: FleetOwnerProvider): () => void {
  const owners = state().owners;
  if (owners.has(provider.owner)) {
    throw new Error("Fleet owner is already registered.");
  }
  owners.set(provider.owner, provider);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    if (owners.get(provider.owner) === provider) owners.delete(provider.owner);
  };
}

/** A broken child provider cannot hide records from healthy managers. */
export function listFleetAgentHandles(): FleetAgentHandle[] {
  const result: FleetAgentHandle[] = [];
  for (const provider of state().owners.values()) {
    let records: AgentRecord[];
    try {
      records = provider.listAgents();
    } catch {
      continue;
    }
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (record && typeof record === "object") result.push({ record, provider });
    }
  }
  return result;
}

/** Whether this exact provider is still the registered owner for its manager. */
export function isFleetOwnerRegistered(provider: FleetOwnerProvider): boolean {
  return state().owners.get(provider.owner) === provider;
}

/** Subscribe to process-global record changes. Unsubscribe is safe and idempotent. */
export function subscribeFleetRegistry(listener: FleetRegistryListener): () => void {
  if (typeof listener !== "function") throw new TypeError("Fleet registry listener must be a function.");
  const listeners = state().listeners;
  listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
  };
}

/** Publish the actual live record; listeners must not retain a copied registry snapshot. */
export function publishFleetRecordChanged(record: AgentRecord): void {
  publish({ type: "changed", record });
}

/** Publish only the identity needed to refresh views after a record is removed. */
export function publishFleetRecordRemoved(agentId: string): void {
  publish({ type: "removed", agentId });
}

function publish(change: FleetRegistryChange): void {
  // Snapshot iteration makes subscribe/unsubscribe during delivery deterministic.
  for (const listener of [...state().listeners]) {
    try { listener(change); } catch { /* one broken activation cannot block others */ }
  }
}

/** Test-only observable avoids tests reaching into process-global private state. */
export function getFleetRegistrySizeForTests(): number {
  return state().owners.size;
}

export function getFleetRegistryListenerCountForTests(): number {
  return state().listeners.size;
}

/** Test-only process-global cleanup, mirroring AgentRuntimeTree.resetForTests(). */
export function resetFleetRegistryForTests(): void {
  const registry = state();
  registry.owners.clear();
  registry.listeners.clear();
}
