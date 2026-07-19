import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRecord, AgentSessionStoreData, PersistedAgentRecord } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

type ParentSessionManager = {
  getSessionDir?: () => string;
  getSessionId?: () => string;
  getSessionFile?: () => string | undefined;
};

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(path: string): void {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      writeFileSync(path, `${process.pid}`, { flag: "wx" });
      return;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      try {
        const pid = Number.parseInt(readFileSync(path, "utf-8"), 10);
        if (pid && !isProcessRunning(pid)) {
          unlinkSync(path);
          continue;
        }
      } catch { /* retry */ }
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* bounded sync lock wait */ }
    }
  }
  throw new Error(`Failed to acquire agent session store lock: ${path}`);
}

function releaseLock(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
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
    toolUses: record.toolUses,
    startedAt: record.startedAt,
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
    && typeof record.type === "string"
    && typeof record.description === "string"
    && typeof record.status === "string"
    && typeof record.startedAt === "number"
    && typeof record.toolUses === "number"
    && typeof record.compactionCount === "number"
    && !!record.lineage
    && typeof record.lineage.depth === "number"
    && typeof record.lineage.maxTreeLevels === "number";
}

/** Session-scoped durable index from Agent ID to the child's normal Pi session. */
export class AgentSessionStore {
  private readonly lockPath: string;
  private agents = new Map<string, PersistedAgentRecord>();

  constructor(private readonly filePath: string) {
    this.lockPath = `${filePath}.lock`;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8")) as AgentSessionStoreData;
      this.agents.clear();
      for (const record of data.agents ?? []) {
        if (isPersistedRecord(record)) this.agents.set(record.id, record);
      }
    } catch { /* corrupt store is ignored; the next successful mutation repairs it */ }
  }

  private save(): void {
    const data: AgentSessionStoreData = { version: 1, agents: [...this.agents.values()] };
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), "utf-8");
    renameSync(temporary, this.filePath);
  }

  private withLock<T>(mutation: () => T): T {
    mkdirSync(dirname(this.filePath), { recursive: true });
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = mutation();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  list(): PersistedAgentRecord[] {
    return [...this.agents.values()];
  }

  upsert(record: AgentRecord): void {
    const persisted = toPersistedAgentRecord(record);
    this.withLock(() => this.agents.set(persisted.id, persisted));
  }
}

/** Explicit resume fallback: locate an Agent ID from any parent session in this project. */
export function findPersistedAgentRecord(
  agentDir: string,
  parentCwd: string,
  agentId: string,
): { record: PersistedAgentRecord; storePath: string } | undefined {
  const projectDir = join(agentDir, "subagent-sessions", projectStoreKey(parentCwd));
  if (!existsSync(projectDir)) return undefined;
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((file) => file.endsWith(".json"));
  } catch {
    return undefined;
  }
  for (const file of files) {
    const storePath = join(projectDir, file);
    const record = new AgentSessionStore(storePath).list().find((candidate) => candidate.id === agentId);
    if (record) return { record, storePath };
  }
  return undefined;
}
