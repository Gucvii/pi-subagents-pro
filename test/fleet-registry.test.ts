import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  type FleetRegistryChange,
  getFleetRegistryListenerCountForTests,
  publishFleetRecordChanged,
  publishFleetRecordRemoved,
  resetFleetRegistryForTests,
  subscribeFleetRegistry,
} from "../src/ui/fleet-registry.js";

describe("fleet registry change notifications", () => {
  beforeEach(() => resetFleetRegistryForTests());

  it("upgrades the frozen owners-only global shape without replacing its live Map", () => {
    const owners = new Map<object, unknown>();
    const global = globalThis as Record<symbol, unknown>;
    global[Symbol.for("pi-subagents:fleet-owners")] = Object.freeze({ owners });

    const unsubscribe = subscribeFleetRegistry(() => {});
    expect(getFleetRegistryListenerCountForTests()).toBe(1);
    expect((global[Symbol.for("pi-subagents:fleet-owners")] as { owners: Map<object, unknown> }).owners).toBe(owners);
    unsubscribe();
  });

  it("delivers the live record and isolates a throwing listener", () => {
    const record = { id: "live-record" } as AgentRecord;
    const healthy = vi.fn<(change: FleetRegistryChange) => void>();
    subscribeFleetRegistry(() => { throw new Error("broken activation"); });
    subscribeFleetRegistry(healthy);

    expect(() => publishFleetRecordChanged(record)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith({ type: "changed", record });
    expect(healthy.mock.calls[0][0].type === "changed" && healthy.mock.calls[0][0].record).toBe(record);
  });

  it("uses a minimal removal reference and unsubscribe is idempotent", () => {
    const listener = vi.fn<(change: FleetRegistryChange) => void>();
    const unsubscribe = subscribeFleetRegistry(listener);
    expect(getFleetRegistryListenerCountForTests()).toBe(1);
    publishFleetRecordRemoved("removed-id");
    expect(listener).toHaveBeenCalledWith({ type: "removed", agentId: "removed-id" });
    listener.mockClear();

    unsubscribe();
    unsubscribe();
    expect(getFleetRegistryListenerCountForTests()).toBe(0);
    publishFleetRecordRemoved("after-unsubscribe");
    expect(listener).not.toHaveBeenCalled();
  });
});
