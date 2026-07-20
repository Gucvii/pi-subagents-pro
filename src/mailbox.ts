import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { AgentSessionStore } from "./agent-session-store.js";
import type { AgentLineage, MailboxMessage, SessionPersistence } from "./types.js";

export const MAILBOX_TOOL_NAME = "mailbox";
export const MAILBOX_TARGET_REJECTED = "Mailbox target is unavailable or not authorized.";
export const MAILBOX_MAX_MESSAGE_BYTES = 16 * 1024;
export const MAILBOX_DEFAULT_RECEIVE_LIMIT = 20;
export const MAILBOX_MAX_RECEIVE_LIMIT = 100;
export const MAILBOX_MAX_ACK_IDS = 100;
export const MAILBOX_MAX_ID_LENGTH = 128;

export const mailboxToolParameters = Type.Object({
  operation: Type.Union([
    Type.Object({
      kind: Type.Literal("send"),
      to_agent_id: Type.String({ minLength: 1, maxLength: MAILBOX_MAX_ID_LENGTH, description: "Direct parent or direct child Agent ID." }),
      message: Type.String({ maxLength: MAILBOX_MAX_MESSAGE_BYTES, description: "Message to enqueue (maximum 16 KiB UTF-8)." }),
    }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("receive"),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAILBOX_MAX_RECEIVE_LIMIT, description: "Maximum unacknowledged messages to return (default 20, maximum 100)." })),
    }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("ack"),
      message_ids: Type.Array(Type.String({ minLength: 1, maxLength: MAILBOX_MAX_ID_LENGTH }), {
        minItems: 1,
        maxItems: MAILBOX_MAX_ACK_IDS,
        description: "Message IDs to acknowledge (maximum 100).",
      }),
    }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });

export type MailboxParticipant = {
  lineage: AgentLineage;
  persistence: SessionPersistence;
  storePath?: string;
};

type MailboxRegistry = {
  participants: Map<string, MailboxParticipant>;
  memoryMessages: MailboxMessage[];
  participantIssues: Map<string, string>;
};

const MAILBOX_REGISTRY_KEY = Symbol.for("pi-subagents:mailbox-registry");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
const existingRegistry = globalRegistry[MAILBOX_REGISTRY_KEY];
if (
  existingRegistry !== undefined
  && (
    existingRegistry === null
    || typeof existingRegistry !== "object"
    || !((existingRegistry as Partial<MailboxRegistry>).participants instanceof Map)
    || !Array.isArray((existingRegistry as Partial<MailboxRegistry>).memoryMessages)
  )
) {
  throw new Error("Invalid process mailbox registry");
}
const mailboxRegistry: MailboxRegistry = existingRegistry as MailboxRegistry | undefined
  ?? { participants: new Map<string, MailboxParticipant>(), memoryMessages: [], participantIssues: new Map<string, string>() };
// Backward-compatible with a registry created by an earlier dynamic module copy.
mailboxRegistry.participantIssues ??= new Map<string, string>();
if (existingRegistry === undefined) globalRegistry[MAILBOX_REGISTRY_KEY] = mailboxRegistry;

function cloneMessage(message: MailboxMessage): MailboxMessage {
  return { ...message };
}

function sameLineage(left: AgentLineage, right: AgentLineage): boolean {
  return left.agentId === right.agentId
    && left.parentAgentId === right.parentAgentId
    && left.rootAgentId === right.rootAgentId
    && left.depth === right.depth
    && left.maxTreeLevels === right.maxTreeLevels;
}

function isDirectRelation(caller: AgentLineage, target: AgentLineage): boolean {
  if (caller.rootAgentId !== target.rootAgentId || Math.abs(caller.depth - target.depth) !== 1) return false;
  return target.parentAgentId === caller.agentId || caller.parentAgentId === target.agentId;
}

function childOfRelation(caller: MailboxParticipant, target: MailboxParticipant): MailboxParticipant {
  return caller.lineage.depth > target.lineage.depth ? caller : target;
}

function assertMessageSize(message: string): void {
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes > MAILBOX_MAX_MESSAGE_BYTES) {
    throw new Error(`Mailbox message exceeds the ${MAILBOX_MAX_MESSAGE_BYTES}-byte UTF-8 limit.`);
  }
}

function assertReceiveLimit(limit: number | undefined): number {
  const resolved = limit ?? MAILBOX_DEFAULT_RECEIVE_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAILBOX_MAX_RECEIVE_LIMIT) {
    throw new Error(`Mailbox receive limit must be an integer from 1 to ${MAILBOX_MAX_RECEIVE_LIMIT}.`);
  }
  return resolved;
}

function assertAckIds(messageIds: string[]): void {
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > MAILBOX_MAX_ACK_IDS) {
    throw new Error(`Mailbox acknowledgement requires 1 to ${MAILBOX_MAX_ACK_IDS} message IDs.`);
  }
  if (messageIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > MAILBOX_MAX_ID_LENGTH)) {
    throw new Error(`Mailbox message IDs must be non-empty and at most ${MAILBOX_MAX_ID_LENGTH} characters.`);
  }
}

export class MailboxService {
  constructor(private readonly getStore: (path: string) => AgentSessionStore = (path) => new AgentSessionStore(path)) {}

  hasParticipant(agentId: string): boolean {
    return mailboxRegistry.participants.has(agentId);
  }

  registerParticipant(participant: MailboxParticipant): void {
    const existing = mailboxRegistry.participants.get(participant.lineage.agentId);
    if (existing && !sameLineage(existing.lineage, participant.lineage)) {
      throw new Error(`Conflicting mailbox lineage for Agent "${participant.lineage.agentId}"`);
    }
    mailboxRegistry.participants.set(participant.lineage.agentId, {
      ...participant,
      persistence: existing?.persistence ?? participant.persistence,
      storePath: existing?.storePath ?? participant.storePath,
      lineage: { ...participant.lineage },
    });
    mailboxRegistry.participantIssues.delete(participant.lineage.agentId);
  }

  /** Remove only the matching canonical identity; stale callers cannot unregister a replacement. */
  unregisterParticipant(lineage: AgentLineage): boolean {
    const existing = mailboxRegistry.participants.get(lineage.agentId);
    if (!existing || !sameLineage(existing.lineage, lineage)) return false;
    mailboxRegistry.participants.delete(lineage.agentId);
    mailboxRegistry.participantIssues.delete(lineage.agentId);
    mailboxRegistry.memoryMessages = mailboxRegistry.memoryMessages.filter(
      (message) => message.from_agent_id !== lineage.agentId && message.to_agent_id !== lineage.agentId,
    );
    return true;
  }

  /** Release process-only registry state for one root tree; durable files are never touched. */
  unregisterRootTree(rootAgentId: string): number {
    const ids = new Set<string>();
    for (const [id, participant] of mailboxRegistry.participants) {
      if (participant.lineage.rootAgentId === rootAgentId) ids.add(id);
    }
    for (const id of ids) {
      mailboxRegistry.participants.delete(id);
      mailboxRegistry.participantIssues.delete(id);
    }
    mailboxRegistry.memoryMessages = mailboxRegistry.memoryMessages.filter(
      (message) => !ids.has(message.from_agent_id) && !ids.has(message.to_agent_id),
    );
    return ids.size;
  }

  setParticipantIssue(lineage: AgentLineage, message: string): void {
    this.canonicalCaller(lineage);
    mailboxRegistry.participantIssues.set(lineage.agentId, message);
  }

  send(caller: AgentLineage, toAgentId: string, message: string): MailboxMessage {
    const callerParticipant = this.canonicalCaller(caller);
    const target = mailboxRegistry.participants.get(toAgentId);
    if (!target || !isDirectRelation(callerParticipant.lineage, target.lineage)) {
      throw new Error(MAILBOX_TARGET_REJECTED);
    }
    assertMessageSize(message);

    const child = childOfRelation(callerParticipant, target);
    const created: MailboxMessage = {
      message_id: randomUUID(),
      from_agent_id: callerParticipant.lineage.agentId,
      to_agent_id: toAgentId,
      message,
      created_at: new Date().toISOString(),
    };
    if (child.persistence === "durable") {
      if (!child.storePath) throw new Error("Mailbox durable store is unavailable.");
      this.getStore(child.storePath).sendMailboxMessage(created);
    } else {
      mailboxRegistry.memoryMessages.push(created);
    }
    return cloneMessage(created);
  }

  receive(caller: AgentLineage, limit?: number): MailboxMessage[] {
    const canonical = this.canonicalCaller(caller).lineage;
    this.assertParticipantHealthy(canonical.agentId);
    const resolvedLimit = assertReceiveLimit(limit);
    const sources = this.relatedSources(canonical);
    const messages: MailboxMessage[] = [];
    if (sources.memory) {
      messages.push(...mailboxRegistry.memoryMessages.filter((item) =>
        item.to_agent_id === canonical.agentId && item.acknowledged_at === undefined));
    }
    for (const path of sources.storePaths) {
      messages.push(...this.getStore(path).receiveMailboxMessages(canonical.agentId));
    }
    messages.sort((left, right) => left.created_at.localeCompare(right.created_at));
    return messages.slice(0, resolvedLimit).map(cloneMessage);
  }

  ack(caller: AgentLineage, messageIds: string[]): number {
    const canonical = this.canonicalCaller(caller).lineage;
    this.assertParticipantHealthy(canonical.agentId);
    assertAckIds(messageIds);
    const ids = new Set(messageIds);
    const sources = this.relatedSources(canonical);
    let matched = 0;
    if (sources.memory) {
      const acknowledgedAt = new Date().toISOString();
      for (const message of mailboxRegistry.memoryMessages) {
        if (message.to_agent_id !== canonical.agentId || !ids.has(message.message_id)) continue;
        matched++;
        message.acknowledged_at ??= acknowledgedAt;
      }
    }
    for (const path of sources.storePaths) {
      matched += this.getStore(path).ackMailboxMessages(canonical.agentId, messageIds);
    }
    return matched;
  }

  private assertParticipantHealthy(agentId: string): void {
    const issue = mailboxRegistry.participantIssues.get(agentId);
    if (issue) throw new Error(issue);
  }

  private canonicalCaller(caller: AgentLineage): MailboxParticipant {
    const participant = mailboxRegistry.participants.get(caller.agentId);
    if (!participant || !sameLineage(participant.lineage, caller)) {
      throw new Error("Mailbox identity is unavailable for this session.");
    }
    return participant;
  }

  private relatedSources(caller: AgentLineage): { memory: boolean; storePaths: Set<string> } {
    let memory = false;
    const storePaths = new Set<string>();
    const callerParticipant = mailboxRegistry.participants.get(caller.agentId)!;
    // A restored durable child can read/ack its own edge even before its historical
    // parent session is active in this process.
    if (caller.depth > 0 && callerParticipant.persistence === "durable" && callerParticipant.storePath) {
      storePaths.add(callerParticipant.storePath);
    }
    for (const participant of mailboxRegistry.participants.values()) {
      if (!isDirectRelation(caller, participant.lineage)) continue;
      const child = childOfRelation(callerParticipant, participant);
      if (child.persistence === "memory") memory = true;
      else if (child.storePath) storePaths.add(child.storePath);
    }
    return { memory, storePaths };
  }
}

export function formatMailboxMessage(message: MailboxMessage): string {
  return [
    `message_id: ${message.message_id}`,
    `from_agent_id: ${message.from_agent_id}`,
    `to_agent_id: ${message.to_agent_id}`,
    `created_at: ${message.created_at}`,
    `message: ${message.message}`,
  ].join("\n");
}
