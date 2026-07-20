import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validatePersistedAgentLineage } from "./lineage.js";
import type { AgentRecord, AgentSessionStoreData, MailboxMessage, PersistedAgentRecord } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

type ParentSessionManager = {
  getSessionDir?: () => string;
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
};

export type AgentSessionStoreIssue = {
  kind: "unreadable-index" | "corrupt-index";
  path: string;
  message: string;
};

export type AgentSessionFileInspection =
  | { ok: true; sizeBytes: number }
  | { ok: false; kind: "missing" | "permission" | "not-file" | "corrupt" | "unreadable"; path: string; message: string };

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type LockOwner = { pid: number; token: string };

function serializeLock(owner: LockOwner): string {
  return JSON.stringify(owner);
}

function parseLock(value: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<LockOwner>;
    return Number.isInteger(parsed.pid) && (parsed.pid as number) > 0 && typeof parsed.token === "string" && parsed.token.length > 0
      ? { pid: parsed.pid as number, token: parsed.token }
      : undefined;
  } catch {
    // Legacy PID-only locks remain eligible for stale cleanup.
    const pid = Number.parseInt(value, 10);
    return pid > 0 ? { pid, token: "legacy" } : undefined;
  }
}

function acquireLock(path: string): LockOwner {
  const owner = { pid: process.pid, token: randomUUID() };
  const serialized = serializeLock(owner);
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      writeFileSync(path, serialized, { flag: "wx" });
      return owner;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      try {
        const observed = readFileSync(path, "utf-8");
        const stale = parseLock(observed);
        if (stale && !isProcessRunning(stale.pid)) {
          // Re-read immediately before unlinking. This does not make stale recovery
          // perfectly atomic, but prevents deleting a lock replaced since inspection.
          if (readFileSync(path, "utf-8") === observed) unlinkSync(path);
          continue;
        }
      } catch { /* retry */ }
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* bounded sync lock wait */ }
    }
  }
  throw new Error(`Failed to acquire agent session store lock: ${path}`);
}

function releaseLock(path: string, owner: LockOwner): void {
  try {
    if (readFileSync(path, "utf-8") === serializeLock(owner)) unlinkSync(path);
  } catch { /* already gone or replaced */ }
}

/** No path for an in-memory parent session: it cannot be resumed after restart. */
export function resolveAgentSessionStorePathFromParts(
  sessionDir: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionDir || !sessionId) return undefined;
  return join(sessionDir, "subagents", `${sessionId}.json`);
}

export function resolveAgentSessionStorePath(sessionManager: ParentSessionManager | undefined): string | undefined {
  const sessionFile = sessionManager?.getSessionFile?.();
  const sessionDir = sessionManager?.getSessionDir?.() || (sessionFile ? dirname(sessionFile) : undefined);
  return resolveAgentSessionStorePathFromParts(
    sessionDir,
    sessionManager?.getSessionId?.(),
  );
}

function projectStoreKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Canonical index path independent of Pi's parent-session directory exposure. */
export function resolveDurableAgentSessionStorePath(
  agentDir: string,
  parentCwd: string | undefined,
  parentSessionId: string | undefined,
): string | undefined {
  if (!parentCwd || !parentSessionId) return undefined;
  const projectKey = projectStoreKey(parentCwd);
  return join(agentDir, "subagent-sessions", projectKey, `${parentSessionId}.json`);
}

export function toPersistedAgentRecord(record: AgentRecord): PersistedAgentRecord {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    result: record.result,
    error: record.error,
    stopReason: record.stopReason,
    errorRef: record.errorRef,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    createdAt: record.createdAt,
    lastResumedAt: record.lastResumedAt,
    completedAt: record.completedAt,
    parentCwd: record.parentCwd,
    parentSessionId: record.parentSessionId,
    parentSessionDir: record.parentSessionDir,
    workspaceBaseCwd: record.workspaceBaseCwd,
    sessionFile: record.sessionFile ?? record.session?.sessionFile,
    sessionCwd: record.sessionCwd ?? record.session?.sessionManager?.getCwd?.(),
    configCwd: record.configCwd,
    groupId: record.groupId,
    joinMode: record.joinMode,
    resultConsumed: record.resultConsumed,
    lifetimeUsage: { ...record.lifetimeUsage },
    compactionCount: record.compactionCount,
    isBackground: record.isBackground,
    lineage: { ...record.lineage },
    invocation: record.invocation ? { ...record.invocation } : undefined,
  };
}

function isPersistedRecord(value: unknown): value is PersistedAgentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedAgentRecord>;
  return typeof record.id === "string"
    && record.id.length > 0
    && typeof record.type === "string"
    && typeof record.description === "string"
    && typeof record.status === "string"
    && typeof record.startedAt === "number"
    && typeof record.toolUses === "number"
    && (record.errorRef === undefined || /^e_[a-f0-9]{24}$/.test(record.errorRef))
    && typeof record.compactionCount === "number"
    && validatePersistedAgentLineage({ id: record.id, lineage: record.lineage }).ok;
}

function isMailboxMessage(value: unknown): value is MailboxMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<MailboxMessage>;
  return typeof message.message_id === "string"
    && message.message_id.length > 0
    && message.message_id.length <= 128
    && typeof message.from_agent_id === "string"
    && message.from_agent_id.length > 0
    && message.from_agent_id.length <= 128
    && typeof message.to_agent_id === "string"
    && message.to_agent_id.length > 0
    && message.to_agent_id.length <= 128
    && typeof message.message === "string"
    && Buffer.byteLength(message.message, "utf8") <= 16 * 1024
    && typeof message.created_at === "string"
    && message.created_at.length > 0
    && (message.acknowledged_at === undefined || typeof message.acknowledged_at === "string");
}

function isMailboxMessageForPersistedRelation(
  message: MailboxMessage,
  agents: Iterable<PersistedAgentRecord>,
): boolean {
  for (const record of agents) {
    const parentId = record.lineage.parentAgentId;
    if (!parentId) continue;
    const down = message.from_agent_id === parentId && message.to_agent_id === record.id;
    const up = message.from_agent_id === record.id && message.to_agent_id === parentId;
    if (down || up) return true;
  }
  return false;
}

/** Session-scoped durable index from Agent ID to the child's normal Pi session. */
export class AgentSessionStore {
  private readonly lockPath: string;
  private agents = new Map<string, PersistedAgentRecord>();
  private mailbox: MailboxMessage[] = [];
  private loadIssue?: AgentSessionStoreIssue;

  constructor(private readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
    this.load();
  }

  private load(): void {
    this.loadIssue = undefined;
    this.agents.clear();
    this.mailbox = [];
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8")) as AgentSessionStoreData;
      if (data?.version !== 1 || !Array.isArray(data.agents)) {
        throw new SyntaxError("invalid Agent session index schema");
      }
      for (const record of data.agents) {
        if (!isPersistedRecord(record)) throw new SyntaxError("invalid Agent record in session index");
        this.agents.set(record.id, record);
      }
      if (data.mailbox !== undefined) {
        if (
          !Array.isArray(data.mailbox)
          || !data.mailbox.every((message) =>
            isMailboxMessage(message)
            && isMailboxMessageForPersistedRelation(message, this.agents.values()))
        ) {
          throw new SyntaxError("invalid mailbox state or sender relation in Agent session index");
        }
        this.mailbox = data.mailbox.map((message) => ({ ...message }));
      }
    } catch (error: any) {
      const kind = error?.code ? "unreadable-index" : "corrupt-index";
      this.loadIssue = {
        kind,
        path: this.filePath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private save(): void {
    const data: AgentSessionStoreData = {
      version: 1,
      agents: [...this.agents.values()],
      ...(this.mailbox.length > 0 && { mailbox: this.mailbox }),
    };
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), "utf-8");
    renameSync(temporary, this.filePath);
  }

  private withLock<T>(operation: () => T, save = true): T {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockOwner = acquireLock(this.lockPath);
    try {
      this.load();
      if (this.loadIssue) {
        throw new Error(`Agent session index is ${this.loadIssue.kind === "corrupt-index" ? "corrupt" : "unreadable"}: ${this.filePath}`);
      }
      const result = operation();
      if (save) this.save();
      return result;
    } finally {
      releaseLock(this.lockPath, lockOwner);
    }
  }

  /** Re-read disk state, allowing a repaired index to clear a previous issue. */
  reload(): void {
    this.load();
  }

  getIssue(): AgentSessionStoreIssue | undefined {
    return this.loadIssue ? { ...this.loadIssue } : undefined;
  }

  list(): PersistedAgentRecord[] {
    return [...this.agents.values()];
  }

  upsert(record: AgentRecord): void {
    const persisted = toPersistedAgentRecord(record);
    this.withLock(() => this.agents.set(persisted.id, persisted));
  }

  sendMailboxMessage(message: MailboxMessage): void {
    this.withLock(() => {
      if (
        !isMailboxMessage(message)
        || !isMailboxMessageForPersistedRelation(message, this.agents.values())
      ) {
        throw new Error("Mailbox message does not match a persisted direct Agent relation.");
      }
      this.mailbox.push({ ...message });
    });
  }

  receiveMailboxMessages(toAgentId: string): MailboxMessage[] {
    return this.withLock(
      () => this.mailbox
        .filter((message) => message.to_agent_id === toAgentId && message.acknowledged_at === undefined)
        .map((message) => ({ ...message })),
      false,
    );
  }

  ackMailboxMessages(toAgentId: string, messageIds: string[]): number {
    const ids = new Set(messageIds);
    return this.withLock(() => {
      const acknowledgedAt = new Date().toISOString();
      let matched = 0;
      for (const message of this.mailbox) {
        if (message.to_agent_id !== toAgentId || !ids.has(message.message_id)) continue;
        matched++;
        message.acknowledged_at ??= acknowledgedAt;
      }
      return matched;
    });
  }
}

export type PersistedAgentLookup = {
  match?: { record: PersistedAgentRecord; storePath: string };
  issues: AgentSessionStoreIssue[];
};

/** Explicit resume fallback with diagnostics for unreadable/corrupt parent indexes. */
export function lookupPersistedAgentRecord(
  agentDir: string,
  parentCwd: string,
  agentId: string,
): PersistedAgentLookup {
  const projectDir = join(agentDir, "subagent-sessions", projectStoreKey(parentCwd));
  if (!existsSync(projectDir)) return { issues: [] };
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    return { issues: [{
      kind: "unreadable-index",
      path: projectDir,
      message: error instanceof Error ? error.message : String(error),
    }] };
  }
  const issues: AgentSessionStoreIssue[] = [];
  for (const file of files) {
    const storePath = join(projectDir, file);
    const store = new AgentSessionStore(storePath);
    const issue = store.getIssue();
    if (issue) {
      issues.push(issue);
      continue;
    }
    const record = store.list().find((candidate) => candidate.id === agentId);
    if (record) return { match: { record, storePath }, issues };
  }
  return { issues };
}

/** Backwards-compatible lookup for callers that do not need diagnostics. */
export function findPersistedAgentRecord(
  agentDir: string,
  parentCwd: string,
  agentId: string,
): { record: PersistedAgentRecord; storePath: string } | undefined {
  return lookupPersistedAgentRecord(agentDir, parentCwd, agentId).match;
}

/** Validate a durable child JSONL before attempting a lazy resume. */
export function inspectAgentSessionFile(filePath: string): AgentSessionFileInspection {
  let sizeBytes: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, kind: "not-file", path: filePath, message: "the session path is not a file" };
    }
    sizeBytes = stat.size;
  } catch (error: any) {
    const kind = error?.code === "ENOENT" ? "missing" : error?.code === "EACCES" ? "permission" : "unreadable";
    return { ok: false, kind, path: filePath, message: error instanceof Error ? error.message : String(error) };
  }

  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    let entries = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      try { JSON.parse(line); entries++; } catch {
        return { ok: false, kind: "corrupt", path: filePath, message: `invalid JSONL at line ${index + 1}` };
      }
    }
    if (entries === 0) {
      return { ok: false, kind: "corrupt", path: filePath, message: "session JSONL is empty" };
    }
  } catch (error: any) {
    const kind = error?.code === "EACCES" ? "permission" : "unreadable";
    return { ok: false, kind, path: filePath, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, sizeBytes };
}
