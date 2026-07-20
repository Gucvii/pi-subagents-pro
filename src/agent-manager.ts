/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { createChildLineage, DEFAULT_MAX_TREE_LEVELS, normalizeMaxTreeLevels, resolveSessionLineage } from "./lineage.js";
import type { AgentInvocation, AgentLineage, AgentRecord, IsolationMode, PersistedAgentRecord, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type OnAgentChanged = (record: AgentRecord) => void;
export type OnAgentRemoved = (record: AgentRecord) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  lineage: AgentLineage;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Persist the child conversation as a durable Pi session. Default: true. */
  persistSession?: boolean;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
}

interface ResumeRuntime {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onChanged?: OnAgentChanged;
  private onRemoved?: OnAgentRemoved;
  private maxConcurrent: number;
  private maxTreeLevels: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    maxTreeLevels = DEFAULT_MAX_TREE_LEVELS,
    onChanged?: OnAgentChanged,
    onRemoved?: OnAgentRemoved,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onChanged = onChanged;
    this.onRemoved = onRemoved;
    this.maxConcurrent = maxConcurrent;
    this.maxTreeLevels = normalizeMaxTreeLevels(maxTreeLevels);
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  private notifyChanged(record: AgentRecord): void {
    try { this.onChanged?.(record); } catch { /* persistence is best-effort at runtime */ }
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setMaxTreeLevels(levels: number): void {
    this.maxTreeLevels = normalizeMaxTreeLevels(levels);
  }

  getMaxTreeLevels(): number {
    return this.maxTreeLevels;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    // Resolve lineage from trusted session metadata. Callers never provide depth,
    // so Agent params, schedules, and RPC cannot reset themselves to the root.
    const resolvedParentLineage = resolveSessionLineage(
      ctx.sessionManager,
      this.maxTreeLevels,
      ctx.getSystemPrompt?.(),
    );
    // The main session starts each new tree with the current setting. Existing
    // child trees keep their frozen maxTreeLevels for deterministic resumes.
    const parentLineage = resolvedParentLineage.depth === 0
      ? { ...resolvedParentLineage, maxTreeLevels: this.maxTreeLevels }
      : resolvedParentLineage;
    const persistSession = options.persistSession ?? (getAgentConfig(type)?.persistSession !== false);
    options = { ...options, persistSession };
    const id = randomUUID().slice(0, 17);
    const lineage = createChildLineage(parentLineage, id);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      createdAt: Date.now(),
      parentCwd: ctx.cwd,
      parentSessionId: ctx.sessionManager?.getSessionId?.(),
      parentSessionDir: ctx.sessionManager?.getSessionDir?.(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      lineage,
      invocation: {
        ...options.invocation,
        sessionPersistence: persistSession ? "durable" : "memory",
      },
    };
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, lineage, options };

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ id, args });
      this.notifyChanged(record);
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.removeRecord(id, record);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, lineage, options }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
    }

    record.status = "running";
    record.startedAt = Date.now();
    record.sessionCwd = worktreeCwd ?? customCwd ?? ctx.cwd;
    record.workspaceBaseCwd = baseCwd;
    record.configCwd = customCwd !== undefined ? ctx.cwd : undefined;
    if (options.isBackground) this.runningBackground++;
    this.notifyChanged(record);
    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const promise = runAgent(ctx, type, prompt, {
      pi,
      lineage,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      persistSession: options.persistSession,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        record.sessionFile = session.sessionFile;
        record.sessionCwd = session.sessionManager?.getCwd?.() ?? record.sessionCwd;
        this.notifyChanged(record);
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered, failure }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
          record.session?.dispose();
          record.session = undefined;
          record.sessionCwd = baseCwd;
        }

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          this.notifyChanged(record);
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        } else {
          this.runningBackground--;
          this.notifyChanged(record);
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
          record.session?.dispose();
          record.session = undefined;
          record.sessionCwd = baseCwd;
        }

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          this.notifyChanged(record);
          this.onComplete?.(record);
        } else {
          this.runningBackground--;
          this.notifyChanged(record);
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming starts.
    this.onSpawned?.(id);
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.notifyChanged(record);
        this.onComplete?.(record);
      }
    }
  }

  /**
   * Called synchronously right after spawn, before onSessionCreated fires.
   * Lets the caller set up the output file path on the record.
   * The record is guaranteed to be in this.agents at this point.
   */
  private onSpawned?: (id: string) => void;

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // Temporarily register the onSpawned hook so startAgent can call it.
    const prevOnSpawned = this.onSpawned;
    this.onSpawned = onSpawned;
    try {
      const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
      const record = this.agents.get(id)!;
      await record.promise;
      return { id, record };
    } finally {
      this.onSpawned = prevOnSpawned;
    }
  }

  /** Rehydrate durable Agent IDs without eagerly opening every child session. */
  restorePersisted(records: PersistedAgentRecord[]): number {
    let restored = 0;
    for (const persisted of records) {
      if (this.agents.has(persisted.id)) continue;
      const interrupted = persisted.status === "running" || persisted.status === "queued";
      const record: AgentRecord = {
        ...persisted,
        status: interrupted ? "stopped" : persisted.status,
        createdAt: persisted.createdAt ?? persisted.startedAt,
        lastResumedAt: persisted.lastResumedAt,
        error: interrupted
          ? "The previous Pi process exited before this Agent completed. Resume to continue."
          : persisted.error,
        lifetimeUsage: { ...persisted.lifetimeUsage },
        lineage: { ...persisted.lineage },
        invocation: persisted.invocation ? { ...persisted.invocation } : undefined,
      };
      this.agents.set(record.id, record);
      this.notifyChanged(record);
      restored++;
    }
    return restored;
  }

  /** Resume a live session, or lazily reopen its durable Pi session after restart. */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    runtime?: ResumeRuntime,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record || (!record.session && (!record.sessionFile || !runtime))) return undefined;

    record.status = "running";
    const resumedAt = Date.now();
    record.startedAt = resumedAt;
    record.lastResumedAt = resumedAt;
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.resultConsumed = true;
    this.notifyChanged(record);
    this.onStart?.(record);

    try {
      let text = "";
      let failure: string | undefined;
      if (record.session) {
        const resumed = await resumeAgent(record.session, prompt, {
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses++;
          },
          onAssistantUsage: (usage) => addUsage(record.lifetimeUsage, usage),
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
          },
          signal,
        });
        text = resumed.text;
        failure = resumed.failure;
      } else {
        const isolation = record.invocation?.isolation;
        const baseCwd = record.workspaceBaseCwd ?? runtime!.ctx.cwd;
        const resumeWorktree = isolation === "worktree"
          ? createWorktree(baseCwd, `${record.id}-resume-${Date.now()}`)
          : undefined;
        if (isolation === "worktree" && !resumeWorktree) {
          throw new Error('Cannot restore isolation: "worktree" — the base repository is unavailable.');
        }
        const resumeCwd = resumeWorktree
          ? (record.configCwd ? resumeWorktree.workPath : resumeWorktree.path)
          : record.sessionCwd;

        try {
          const reopened = await runAgent(runtime!.ctx, record.type, prompt, {
            pi: runtime!.pi,
            agentId: record.id,
            lineage: record.lineage,
            resumeSessionFile: record.sessionFile,
            cwd: resumeCwd,
            configCwd: record.configCwd,
            model: runtime!.model,
            thinkingLevel: runtime!.thinkingLevel,
            maxTurns: record.invocation?.maxTurns,
            isolated: record.invocation?.isolated,
            signal,
            onToolActivity: (activity) => {
              if (activity.type === "end") record.toolUses++;
            },
            onAssistantUsage: (usage) => addUsage(record.lifetimeUsage, usage),
            onCompaction: (info) => {
              record.compactionCount++;
              this.onCompact?.(record, info);
            },
            onSessionCreated: (session) => {
              record.session = session;
              record.sessionFile = session.sessionFile;
              record.sessionCwd = session.sessionManager?.getCwd?.() ?? resumeCwd;
              this.notifyChanged(record);
            },
          });
          record.session = reopened.session;
          text = reopened.responseText;
          failure = reopened.failure;
        } finally {
          if (resumeWorktree) {
            const worktreeResult = cleanupWorktree(baseCwd, resumeWorktree, record.description);
            record.worktreeResult = worktreeResult;
            record.sessionCwd = baseCwd;
            record.session?.dispose();
            record.session = undefined;
            if (worktreeResult.hasChanges && worktreeResult.branch) {
              text = (text ?? "") + `\n\n---\nChanges saved to branch \`${worktreeResult.branch}\`. Merge with: \`git merge ${worktreeResult.branch}\``;
            }
          }
        }
      }

      record.status = failure ? "error" : "completed";
      if (failure) record.error = failure;
      record.result = text;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    this.notifyChanged(record);
    try { this.onComplete?.(record); } catch { /* completion side effects are isolated */ }
    return record;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      this.notifyChanged(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    this.notifyChanged(record);
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    if (!this.agents.delete(id)) return;
    try { this.onRemoved?.(record); } catch { /* cleanup side effects are isolated */ }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        this.notifyChanged(record);
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        this.notifyChanged(record);
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const [id, record] of [...this.agents]) {
      this.removeRecord(id, record);
    }
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
