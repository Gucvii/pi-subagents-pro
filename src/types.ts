/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

/** Persistence of the child conversation session itself. */
export type SessionPersistence = "durable" | "memory";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Durable Pi session by default; false explicitly opts this agent into memory-only execution. */
  persistSession?: boolean;
  /** Write the subagent's .output transcript. Defaults to true; false suppresses only that transcript. */
  outputTranscript?: boolean;
  /** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
  sessionDir?: string;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /** Isolation mode — "worktree" runs the agent in a temporary git worktree */
  isolation?: IsolationMode;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export type JoinMode = 'async' | 'group' | 'smart';

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent (foreground + background).
 * - `background`: hide foreground agents (they already render inline as the
 *   Agent tool result, #118); show background/queued/scheduled/RPC.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = 'all' | 'background' | 'off';

/** Immutable position of a session in one main-agent/subagent tree. */
export interface AgentLineage {
  /** Current main/subagent identity. The main session id is used at depth 0. */
  agentId: string;
  /** Immediate spawning agent; absent only for the main agent. */
  parentAgentId?: string;
  /** Main-session identity shared by the whole tree. */
  rootAgentId: string;
  /** Zero-based edge depth: main = 0, direct child = 1. */
  depth: number;
  /** User-facing total tree levels, including the main agent as level 1. */
  maxTreeLevels: number;
}

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  /** First creation time; unlike startedAt, this is not replaced on resume. */
  createdAt?: number;
  /** Most recent explicit resume time. */
  lastResumedAt?: number;
  completedAt?: number;
  session?: AgentSession;
  /** Parent Pi session that owns this Agent ID and durable index entry. */
  parentCwd?: string;
  parentSessionId?: string;
  parentSessionDir?: string;
  /** Stable repository/cwd used to recreate worktree isolation on resume. */
  workspaceBaseCwd?: string;
  /** Durable Pi session file used for lazy cross-process resume. */
  sessionFile?: string;
  /** Child working directory recorded with the durable session. */
  sessionCwd?: string;
  /** Project config root used when the child worked in another cwd. */
  configCwd?: string;
  abortController?: AbortController;
  promise?: Promise<string>;
  groupId?: string;
  joinMode?: JoinMode;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /**
   * Whether this agent was spawned to run in the background. Tri-state, set at
   * spawn from `SpawnOptions.isBackground`: `true` = background, `false` =
   * foreground (has an inline Agent tool-result surface), `undefined` = the
   * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
   * and has no inline surface). The widget's background-only filter keys off this
   * — and excludes only explicit `false`, so `undefined` agents stay visible.
   * Reliable across ALL spawn paths, unlike the UI-only `invocation` snapshot,
   * which only the Agent-tool path populates.
   */
  isBackground?: boolean;
  /** Immutable parent/root/depth metadata assigned by AgentManager. */
  lineage: AgentLineage;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
}

/** JSON-safe AgentRecord projection stored beside the parent Pi session. */
export interface PersistedAgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: AgentRecord["status"];
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  createdAt?: number;
  lastResumedAt?: number;
  completedAt?: number;
  parentCwd?: string;
  parentSessionId?: string;
  parentSessionDir?: string;
  workspaceBaseCwd?: string;
  sessionFile?: string;
  sessionCwd?: string;
  configCwd?: string;
  groupId?: string;
  joinMode?: JoinMode;
  resultConsumed?: boolean;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  isBackground?: boolean;
  lineage: AgentLineage;
  invocation?: AgentInvocation;
}

export interface MailboxMessage {
  message_id: string;
  from_agent_id: string;
  to_agent_id: string;
  message: string;
  created_at: string;
  acknowledged_at?: string;
}

export interface AgentSessionStoreData {
  version: 1;
  agents: PersistedAgentRecord[];
  /** Additive mailbox state; absent in legacy version 1 indexes. */
  mailbox?: MailboxMessage[];
}
export interface AgentInvocation {
  /** Effective provider/model identifier used by the child. */
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  /** Durable by default; memory sessions expire with the current Pi process. */
  sessionPersistence?: SessionPersistence;
  isolation?: IsolationMode;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  /** Effective provider/model identifier used by the child. */
  modelName?: string;
  /** Effective thinking level used by the child. */
  thinking?: ThinkingLevel;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/**
 * A subagent spawn registered to fire on a schedule.
 *
 * Stored at `<cwd>/.pi/subagent-schedules/<sessionId>.json`. Session-scoped:
 * survives `/resume` but resets on `/new`, mirroring pi-chonky-tasks.
 */
export interface ScheduledSubagent {
  id: string;
  /** Unique within store. Defaults to `description`. */
  name: string;
  description: string;
  /** Raw user input — cron expr | "+10m" | ISO | "5m". */
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  /** Computed at create time for interval/once. */
  intervalMs?: number;

  // spawn params (subset of Agent tool params; no inherit_context, no resume)
  subagent_type: SubagentType;
  prompt: string;
  /** Optional only for loading legacy persisted schedules; new jobs require it. */
  model?: string;
  /** Optional only for loading legacy persisted schedules; new jobs require it. */
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;

  // state
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  /** Refreshed on every fire and on store load. */
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  /** For future migrations. */
  version: 1;
  jobs: ScheduledSubagent[];
}
