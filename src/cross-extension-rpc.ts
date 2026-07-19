/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import { type ModelRegistry, resolveExactModel } from "./model-resolver.js";
import type { ThinkingLevel } from "./types.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 3;

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      const normalizedOptions = options ?? {};
      const registry = (ctx as { modelRegistry?: ModelRegistry }).modelRegistry;
      if (!registry) throw new Error("ctx.modelRegistry is unavailable");
      if (typeof normalizedOptions.model !== "string") {
        throw new Error('RPC spawn requires model as an exact "provider/modelId" string');
      }
      const thinking = normalizedOptions.thinkingLevel as ThinkingLevel | undefined;
      const allowedThinking = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      if (!thinking || !allowedThinking.has(thinking)) {
        throw new Error("RPC spawn requires an explicit valid thinkingLevel");
      }

      const resolved = resolveExactModel(normalizedOptions.model, registry);
      if (typeof resolved === "string") throw new Error(resolved);
      const canonicalModelName = `${resolved.provider}/${resolved.id}`;
      const invocation = {
        modelName: canonicalModelName,
        thinking,
        maxTurns: normalizedOptions.maxTurns,
        isolated: normalizedOptions.isolated,
        inheritContext: normalizedOptions.inheritContext,
        runInBackground: normalizedOptions.isBackground,
        isolation: normalizedOptions.isolation,
      };

      return {
        id: manager.spawn(pi, ctx, type, prompt, {
          ...normalizedOptions,
          model: resolved,
          thinkingLevel: thinking,
          invocation,
        }),
      };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      if (!manager.abort(agentId)) throw new Error("Agent not found");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop };
}
