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

type FleetRegistryState = { owners: Map<object, FleetOwnerProvider> };

function state(): FleetRegistryState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[REGISTRY_KEY];
  if (existing !== undefined) {
    if (!existing || typeof existing !== "object" || !((existing as FleetRegistryState).owners instanceof Map)) {
      throw new Error("Fleet owner registry is invalid.");
    }
    return existing as FleetRegistryState;
  }
  const created: FleetRegistryState = { owners: new Map() };
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

/** Test-only observable avoids tests reaching into process-global private state. */
export function getFleetRegistrySizeForTests(): number {
  return state().owners.size;
}

/** Test-only process-global cleanup, mirroring AgentRuntimeTree.resetForTests(). */
export function resetFleetRegistryForTests(): void {
  state().owners.clear();
}
