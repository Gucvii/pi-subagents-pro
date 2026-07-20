import { createHash } from "node:crypto";
import { closeSync, constants, openSync, statSync } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, PersistedAgentRecord } from "./types.js";

export const ENTRY_TYPES = [
  "user_message",
  "assistant_message",
  "tool_result",
  "compaction",
  "custom",
  "other",
  "error",
] as const;
export const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;
export const ENTRY_REF_LENGTH = 26;

const READ_CHUNK_BYTES = 64 * 1024;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type InspectionEntryType = (typeof ENTRY_TYPES)[number];
export type InspectionRecord = AgentRecord | PersistedAgentRecord;
export type InspectionActivity = { activeTools: Map<string, string>; lastActivityAt?: number };
export type EntrySelection =
  | { kind: "tail"; limit?: number; types?: InspectionEntryType[] }
  | { kind: "after"; cursor: string; limit?: number; types?: InspectionEntryType[] };

export type InspectionDiagnostic = {
  code: "missing" | "permission" | "not_file" | "malformed" | "line_too_large" | "unreadable" | "stale_cursor" | "entry_not_found" | "session_unavailable";
  message: string;
  line?: number;
};

export type EntryMetadata = {
  ref: string;
  type: Exclude<InspectionEntryType, "error">;
  role?: string;
  timestamp: string;
  content_bytes: number;
  content_types?: string[];
  tool_names?: string[];
  tool_name?: string;
  is_error?: boolean;
  tokens_before?: number;
  from_hook?: boolean;
};

type RawEntry = Record<string, unknown> & { id: string; timestamp: string };
type Source =
  | { kind: "live"; sessionId: string; entries: SessionEntry[] }
  | { kind: "durable"; sessionFile: string };
type ScanResult = {
  sessionId: string;
  entries: EntryMetadata[];
  hasMore: boolean;
  nextCursor: string | null;
};
type RawLine = { bytes: Buffer; line?: number };
type Header = { sessionId: string; fileSize: number };

class InspectionFailure extends Error {
  constructor(readonly diagnostic: InspectionDiagnostic) {
    super(diagnostic.message);
  }
}

function makeRef(sessionId: string, entryId: string): string {
  const digest = createHash("sha256").update(sessionId).update("\0").update(entryId).digest("hex").slice(0, 24);
  return `e_${digest}`;
}

function validRef(ref: string): boolean {
  return ref.length === ENTRY_REF_LENGTH && /^e_[a-f0-9]{24}$/.test(ref);
}

function asRawEntry(value: unknown): RawEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && entry.id.length > 0 && typeof entry.timestamp === "string"
    ? entry as RawEntry
    : undefined;
}

function messageOf(entry: RawEntry): Record<string, unknown> | undefined {
  return entry.type === "message" && entry.message && typeof entry.message === "object"
    ? entry.message as Record<string, unknown>
    : undefined;
}

function isErrorEntry(entry: RawEntry): boolean {
  const message = messageOf(entry);
  if (!message) return false;
  if (message.role === "toolResult") return message.isError === true;
  return message.role === "assistant" && (message.stopReason === "error" || typeof message.errorMessage === "string");
}

function primaryType(entry: RawEntry): Exclude<InspectionEntryType, "error"> {
  const role = messageOf(entry)?.role;
  if (role === "user") return "user_message";
  if (role === "assistant") return "assistant_message";
  if (role === "toolResult") return "tool_result";
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "custom" || entry.type === "custom_message") return "custom";
  return "other";
}

function matchesTypes(entry: RawEntry, types?: InspectionEntryType[]): boolean {
  if (!types || types.length === 0) return true;
  return types.includes(primaryType(entry)) || (types.includes("error") && isErrorEntry(entry));
}

function contentBytes(entry: RawEntry): number {
  const message = messageOf(entry);
  let content: unknown;
  if (message) content = message.content;
  else if (entry.type === "compaction" || entry.type === "branch_summary") content = entry.summary;
  else if (entry.type === "custom_message") content = entry.content;
  else if (entry.type === "custom") content = entry.data;
  if (content === undefined) return 0;
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  try {
    const serialized = JSON.stringify(content);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  } catch {
    return 0;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const type = (item as Record<string, unknown>).type;
    return typeof type === "string" ? [type] : [];
  }))];
  return result.length > 0 ? result : undefined;
}

function metadata(entry: RawEntry, sessionId: string): EntryMetadata {
  const message = messageOf(entry);
  const result: EntryMetadata = {
    ref: makeRef(sessionId, entry.id),
    type: primaryType(entry),
    timestamp: entry.timestamp,
    content_bytes: contentBytes(entry),
  };
  if (message && typeof message.role === "string") result.role = message.role;
  if (message?.role === "assistant") {
    result.content_types = stringArray(message.content);
    const names = Array.isArray(message.content)
      ? [...new Set(message.content.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const block = item as Record<string, unknown>;
          if (block.type !== "toolCall") return [];
          const name = typeof block.name === "string" ? block.name : block.toolName;
          return typeof name === "string" ? [name] : [];
        }))]
      : [];
    if (names.length > 0) result.tool_names = names;
  }
  if (message?.role === "toolResult") {
    if (typeof message.toolName === "string") result.tool_name = message.toolName;
    result.is_error = message.isError === true;
  }
  if (entry.type === "compaction") {
    if (typeof entry.tokensBefore === "number") result.tokens_before = entry.tokensBefore;
    if (typeof entry.fromHook === "boolean") result.from_hook = entry.fromHook;
  }
  if (isErrorEntry(entry)) result.is_error = true;
  return result;
}

function terminalErrorRef(entry: RawEntry, sessionId: string): string | null | undefined {
  const message = messageOf(entry);
  if (!message) return undefined;
  if (message.role === "assistant") return isErrorEntry(entry) ? makeRef(sessionId, entry.id) : null;
  if (message.role === "toolResult" && message.isError === true) return makeRef(sessionId, entry.id);
  return undefined;
}

/** Return the newest canonical entry ref without exposing its raw entry ID. */
export async function findLatestAgentEntryRef(record: InspectionRecord): Promise<string | undefined> {
  const source = sourceFor(record);
  if ("code" in source) throw new InspectionFailure(source);
  if (source.kind === "live") {
    const entry = asRawEntry(source.entries.at(-1));
    return entry ? makeRef(source.sessionId, entry.id) : undefined;
  }
  const found = await withDurable(source.sessionFile, async (handle, header) => {
    for await (const line of reverseLines(handle, header.fileSize)) {
      if (line.bytes.length === 0) continue;
      const parsed = parseLine(line) as Record<string, unknown>;
      if (parsed?.type === "session") break;
      const entry = asRawEntry(parsed);
      if (!entry) throw new InspectionFailure({ code: "malformed", message: "Session entry is missing id or timestamp." });
      return makeRef(header.sessionId, entry.id);
    }
    return undefined;
  });
  if (found && typeof found === "object" && "code" in found) throw new InspectionFailure(found);
  return typeof found === "string" ? found : undefined;
}

/**
 * Find the terminal canonical error entry without returning its body or raw ID.
 * When afterRef is supplied, only entries added after that invocation boundary
 * are eligible; a missing boundary fails closed instead of reusing an old error.
 */
export async function findLastAgentErrorRef(record: InspectionRecord, afterRef?: string): Promise<string | undefined> {
  const source = sourceFor(record);
  if ("code" in source) return undefined;

  const scan = async (entries: AsyncIterable<RawEntry>, sessionId: string): Promise<string | undefined> => {
    let candidate: string | undefined;
    let terminalSeen = false;
    for await (const entry of entries) {
      const entryRef = makeRef(sessionId, entry.id);
      if (afterRef && entryRef === afterRef) return candidate;
      if (terminalSeen) continue;
      const ref = terminalErrorRef(entry, sessionId);
      if (ref === null) terminalSeen = true;
      else if (ref !== undefined) candidate ??= ref;
      if (!afterRef && ref !== undefined) return ref ?? undefined;
    }
    return afterRef ? undefined : candidate;
  };

  if (source.kind === "live") {
    const liveSource = source;
    async function* liveEntries(): AsyncIterable<RawEntry> {
      for (let index = liveSource.entries.length - 1; index >= 0; index--) {
        const entry = asRawEntry(liveSource.entries[index]);
        if (!entry) return;
        yield entry;
      }
    }
    return scan(liveEntries(), source.sessionId);
  }

  const found = await withDurable(source.sessionFile, async (handle, header) => {
    async function* durableEntries(): AsyncIterable<RawEntry> {
      for await (const line of reverseLines(handle, header.fileSize)) {
        if (line.bytes.length === 0) continue;
        const parsed = parseLine(line) as Record<string, unknown>;
        if (parsed?.type === "session") break;
        const entry = asRawEntry(parsed);
        if (!entry) throw new InspectionFailure({ code: "malformed", message: "Session entry is missing id or timestamp." });
        yield entry;
      }
    }
    return scan(durableEntries(), header.sessionId);
  });
  return typeof found === "string" ? found : undefined;
}

function sourceFor(record: InspectionRecord): Source | InspectionDiagnostic {
  if ("session" in record && record.session?.sessionManager) {
    const manager = record.session.sessionManager;
    return { kind: "live", sessionId: manager.getSessionId(), entries: manager.getEntries() };
  }
  if (record.invocation?.sessionPersistence === "memory") {
    return { code: "session_unavailable", message: "Memory Agent session is no longer available in this Pi process." };
  }
  if (!record.sessionFile) {
    return { code: "session_unavailable", message: "Agent metadata has no durable session file reference." };
  }
  return { kind: "durable", sessionFile: record.sessionFile };
}

function fileAvailability(record: InspectionRecord): "available" | "missing" | "unavailable" | "none" {
  if (record.invocation?.sessionPersistence === "memory") return "none";
  const path = record.sessionFile ?? ("session" in record ? record.session?.sessionFile : undefined);
  if (!path) return "unavailable";
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return "unavailable";
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    return "available";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : "unavailable";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ioDiagnostic(error: unknown): InspectionDiagnostic {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    code: code === "ENOENT" ? "missing" : code === "EACCES" || code === "EPERM" ? "permission" : "unreadable",
    message: code === "ENOENT"
      ? "Session file is missing."
      : code === "EACCES" || code === "EPERM"
        ? "Session file permission was denied."
        : "Session file could not be read.",
  };
}

function decodeLine(line: RawLine): string {
  try {
    return STRICT_UTF8.decode(line.bytes);
  } catch {
    throw new InspectionFailure({ code: "malformed", message: "Session JSONL contains invalid UTF-8.", line: line.line });
  }
}

function parseLine(line: RawLine): unknown {
  const text = decodeLine(line);
  try {
    return JSON.parse(text);
  } catch {
    throw new InspectionFailure({ code: "malformed", message: "Invalid JSONL entry.", line: line.line });
  }
}

function stripCr(bytes: Buffer): Buffer {
  return bytes.at(-1) === 0x0d ? bytes.subarray(0, bytes.length - 1) : bytes;
}

async function readHeader(handle: FileHandle): Promise<Header> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new InspectionFailure({ code: "not_file", message: "Session path is not a regular file." });
  if (stat.size === 0) throw new InspectionFailure({ code: "malformed", message: "Session JSONL is empty." });
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  while (position < stat.size) {
    const size = Math.min(READ_CHUNK_BYTES, stat.size - position);
    const chunk = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(chunk, 0, size, position);
    if (bytesRead === 0) break;
    const bytes = chunk.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    const part = newline < 0 ? bytes : bytes.subarray(0, newline);
    total += part.length;
    if (total > MAX_JSONL_LINE_BYTES) {
      throw new InspectionFailure({ code: "line_too_large", message: `Session JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes.`, line: 1 });
    }
    chunks.push(part);
    if (newline >= 0) {
      const parsed = parseLine({ bytes: stripCr(Buffer.concat(chunks, total)), line: 1 }) as Record<string, unknown>;
      if (parsed?.type !== "session" || typeof parsed.id !== "string" || parsed.id.length === 0) {
        throw new InspectionFailure({ code: "malformed", message: "Invalid or missing session header.", line: 1 });
      }
      return { sessionId: parsed.id, fileSize: stat.size };
    }
    position += bytesRead;
  }
  throw new InspectionFailure({ code: "malformed", message: "Session JSONL has a partial final line.", line: 1 });
}

async function* forwardLines(handle: FileHandle, fileSize: number): AsyncGenerator<RawLine> {
  let position = 0;
  let lineNumber = 1;
  let chunks: Buffer[] = [];
  let lineBytes = 0;
  while (position < fileSize) {
    const size = Math.min(READ_CHUNK_BYTES, fileSize - position);
    const chunk = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(chunk, 0, size, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const bytes = chunk.subarray(0, bytesRead);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(start, end);
      lineBytes += part.length;
      if (lineBytes > MAX_JSONL_LINE_BYTES) {
        throw new InspectionFailure({ code: "line_too_large", message: `Session JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes.`, line: lineNumber });
      }
      chunks.push(part);
      if (newline < 0) break;
      yield { bytes: stripCr(Buffer.concat(chunks, lineBytes)), line: lineNumber };
      lineNumber++;
      chunks = [];
      lineBytes = 0;
      start = newline + 1;
    }
  }
  if (lineBytes > 0) {
    throw new InspectionFailure({ code: "malformed", message: "Session JSONL has a partial final line.", line: lineNumber });
  }
}

async function* reverseLines(handle: FileHandle, fileSize: number): AsyncGenerator<RawLine> {
  if (fileSize === 0) throw new InspectionFailure({ code: "malformed", message: "Session JSONL is empty." });
  const last = Buffer.allocUnsafe(1);
  await handle.read(last, 0, 1, fileSize - 1);
  if (last[0] !== 0x0a) {
    throw new InspectionFailure({ code: "malformed", message: "Session JSONL has a partial final line." });
  }
  let position = fileSize - 1;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  while (position > 0) {
    const start = Math.max(0, position - READ_CHUNK_BYTES);
    const block = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await handle.read(block, 0, block.length, start);
    if (bytesRead !== block.length) throw new InspectionFailure({ code: "unreadable", message: "Session file could not be read." });
    let end = block.length;
    for (let index = block.lastIndexOf(0x0a); index >= 0; index = block.lastIndexOf(0x0a, index - 1)) {
      const part = block.subarray(index + 1, end);
      const lineBytes = part.length + pendingBytes;
      if (lineBytes > MAX_JSONL_LINE_BYTES) {
        throw new InspectionFailure({ code: "line_too_large", message: `Session JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes.` });
      }
      const line = pending.length === 0 ? part : Buffer.concat([part, ...pending], lineBytes);
      yield { bytes: stripCr(line) };
      pending = [];
      pendingBytes = 0;
      end = index;
    }
    if (end > 0) {
      const prefix = block.subarray(0, end);
      pending.unshift(prefix);
      pendingBytes += prefix.length;
      if (pendingBytes > MAX_JSONL_LINE_BYTES) {
        throw new InspectionFailure({ code: "line_too_large", message: `Session JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes.` });
      }
    }
    position = start;
  }
  if (pendingBytes > 0) yield { bytes: stripCr(Buffer.concat(pending, pendingBytes)), line: 1 };
}

async function withDurable<T>(sessionFile: string, action: (handle: FileHandle, header: Header) => Promise<T>): Promise<T | InspectionDiagnostic> {
  let handle: FileHandle | undefined;
  try {
    if (!(await stat(sessionFile)).isFile()) {
      throw new InspectionFailure({ code: "not_file", message: "Session path is not a regular file." });
    }
    handle = await open(sessionFile, constants.O_RDONLY | constants.O_NONBLOCK);
    const header = await readHeader(handle);
    return await action(handle, header);
  } catch (error) {
    return error instanceof InspectionFailure ? error.diagnostic : ioDiagnostic(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function rawEntry(line: RawLine): RawEntry {
  const entry = asRawEntry(parseLine(line));
  if (!entry) throw new InspectionFailure({ code: "malformed", message: "Session entry is missing id or timestamp.", line: line.line });
  return entry;
}

async function lastDurableCursor(sessionFile: string): Promise<{ sessionId: string; cursor: string | null } | InspectionDiagnostic> {
  return withDurable(sessionFile, async (handle, header) => {
    for await (const line of reverseLines(handle, header.fileSize)) {
      if (line.bytes.length === 0) continue;
      const parsed = parseLine(line) as Record<string, unknown>;
      if (parsed?.type === "session") continue;
      const entry = asRawEntry(parsed);
      if (!entry) throw new InspectionFailure({ code: "malformed", message: "Session entry is missing id or timestamp." });
      return { sessionId: header.sessionId, cursor: makeRef(header.sessionId, entry.id) };
    }
    return { sessionId: header.sessionId, cursor: null };
  });
}

async function scanDurable(sessionFile: string, selection: EntrySelection): Promise<ScanResult | InspectionDiagnostic> {
  return withDurable(sessionFile, async (handle, header) => {
    const limit = selection.limit ?? 1;
    if (selection.kind === "tail") {
      const reversed: EntryMetadata[] = [];
      let newestPhysical: string | null = null;
      for await (const line of reverseLines(handle, header.fileSize)) {
        if (line.bytes.length === 0) continue;
        const parsed = parseLine(line) as Record<string, unknown>;
        if (parsed?.type === "session") break;
        const entry = asRawEntry(parsed);
        if (!entry) throw new InspectionFailure({ code: "malformed", message: "Session entry is missing id or timestamp." });
        newestPhysical ??= makeRef(header.sessionId, entry.id);
        if (!matchesTypes(entry, selection.types)) continue;
        reversed.push(metadata(entry, header.sessionId));
        if (reversed.length === limit + 1) break;
      }
      const hasMore = reversed.length > limit;
      if (hasMore) reversed.pop();
      return { sessionId: header.sessionId, entries: reversed.reverse(), hasMore, nextCursor: newestPhysical };
    }

    if (!validRef(selection.cursor)) {
      return { code: "stale_cursor", message: "Invalid or stale Agent entry cursor." } as InspectionDiagnostic;
    }
    let found = false;
    let lastPhysical = selection.cursor;
    const entries: EntryMetadata[] = [];
    for await (const line of forwardLines(handle, header.fileSize)) {
      if (line.line === 1 || line.bytes.length === 0) continue;
      const entry = rawEntry(line);
      const ref = makeRef(header.sessionId, entry.id);
      if (!found) {
        if (ref === selection.cursor) found = true;
        continue;
      }
      const previousPhysical = lastPhysical;
      lastPhysical = ref;
      if (!matchesTypes(entry, selection.types)) continue;
      if (entries.length === limit) {
        return { sessionId: header.sessionId, entries, hasMore: true, nextCursor: previousPhysical };
      }
      entries.push(metadata(entry, header.sessionId));
    }
    if (!found) return { code: "stale_cursor", message: "Cursor entry no longer exists in this Agent session." } as InspectionDiagnostic;
    return { sessionId: header.sessionId, entries, hasMore: false, nextCursor: lastPhysical };
  });
}

function scanLive(source: Extract<Source, { kind: "live" }>, selection: EntrySelection): ScanResult | InspectionDiagnostic {
  const limit = selection.limit ?? 1;
  if (selection.kind === "tail") {
    const matches: EntryMetadata[] = [];
    for (let index = source.entries.length - 1; index >= 0 && matches.length < limit + 1; index--) {
      const entry = asRawEntry(source.entries[index]);
      if (!entry) return { code: "malformed", message: "Live session entry is missing id or timestamp." };
      if (!matchesTypes(entry, selection.types)) continue;
      matches.push(metadata(entry, source.sessionId));
    }
    const hasMore = matches.length > limit;
    if (hasMore) matches.pop();
    const last = asRawEntry(source.entries.at(-1));
    return {
      sessionId: source.sessionId,
      entries: matches.reverse(),
      hasMore,
      nextCursor: last ? makeRef(source.sessionId, last.id) : null,
    };
  }
  if (!validRef(selection.cursor)) return { code: "stale_cursor", message: "Invalid or stale Agent entry cursor." };
  let cursorIndex = -1;
  for (let index = 0; index < source.entries.length; index++) {
    const entry = asRawEntry(source.entries[index]);
    if (!entry) return { code: "malformed", message: "Live session entry is missing id or timestamp." };
    if (makeRef(source.sessionId, entry.id) === selection.cursor) {
      cursorIndex = index;
      break;
    }
  }
  if (cursorIndex < 0) return { code: "stale_cursor", message: "Cursor entry no longer exists in this Agent session." };
  const entries: EntryMetadata[] = [];
  let lastPhysical = selection.cursor;
  for (let index = cursorIndex + 1; index < source.entries.length; index++) {
    const entry = asRawEntry(source.entries[index]);
    if (!entry) return { code: "malformed", message: "Live session entry is missing id or timestamp." };
    const ref = makeRef(source.sessionId, entry.id);
    const previousPhysical = lastPhysical;
    lastPhysical = ref;
    if (!matchesTypes(entry, selection.types)) continue;
    if (entries.length === limit) {
      return { sessionId: source.sessionId, entries, hasMore: true, nextCursor: previousPhysical };
    }
    entries.push(metadata(entry, source.sessionId));
  }
  return { sessionId: source.sessionId, entries, hasMore: false, nextCursor: lastPhysical };
}

async function scanSource(source: Source, selection: EntrySelection): Promise<ScanResult | InspectionDiagnostic> {
  return source.kind === "live" ? scanLive(source, selection) : scanDurable(source.sessionFile, selection);
}

export async function inspectAgentRecord(
  record: InspectionRecord,
  activity: InspectionActivity | undefined,
  selection?: EntrySelection,
): Promise<Record<string, unknown>> {
  const persistence = record.invocation?.sessionPersistence ?? "durable";
  const source = sourceFor(record);
  let cursor: string | null = null;
  let cursorError: InspectionDiagnostic | undefined;
  if ("code" in source) {
    cursorError = source;
  } else if (source.kind === "live") {
    const lastValue = source.entries.at(-1);
    const last = asRawEntry(lastValue);
    if (lastValue && !last) cursorError = { code: "malformed", message: "Live session entry is missing id or timestamp." };
    else cursor = last ? makeRef(source.sessionId, last.id) : null;
  } else if (!selection) {
    const last = await lastDurableCursor(source.sessionFile);
    if ("code" in last) cursorError = last;
    else cursor = last.cursor;
  }
  const sessionFile = fileAvailability(record);
  const output: Record<string, unknown> = {
    status: record.status,
    ...(activity && activity.activeTools.size > 0 && { current_tools: [...new Set(activity.activeTools.values())] }),
    ...(activity?.lastActivityAt !== undefined && { activity_age_ms: Math.max(0, Date.now() - activity.lastActivityAt) }),
    result_available: record.result !== undefined,
    error_available: record.error !== undefined,
    ...(record.status === "error" && record.errorRef && { error_ref: record.errorRef }),
    persistence,
    resumable: Boolean(("session" in record && record.session) || (persistence === "durable" && sessionFile === "available")),
    session_file: sessionFile,
    cursor,
    ...(cursorError && { cursor_error: cursorError }),
  };
  if (!selection) return output;
  if ("code" in source) return { ...output, entries_error: source };
  const scanned = await scanSource(source, selection);
  if ("code" in scanned) return { ...output, entries_error: scanned };
  return {
    ...output,
    cursor: scanned.nextCursor,
    entries: scanned.entries,
    ...(selection.kind === "tail"
      ? { older_entries_omitted: scanned.hasMore }
      : { has_more: scanned.hasMore }),
  };
}

function utf8Range(bytes: Buffer, offset: number, maxBytes: number): { json: string; start: number; end: number; requiredBytes?: number } {
  let start = Math.min(offset, bytes.length);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.min(start + maxBytes, bytes.length);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  let requiredBytes: number | undefined;
  if (end === start && start < bytes.length) {
    let boundary = start + 1;
    while (boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) boundary++;
    requiredBytes = boundary - start;
  }
  return { json: STRICT_UTF8.decode(bytes.subarray(start, end)), start, end, requiredBytes };
}

export async function readAgentEntry(
  record: InspectionRecord,
  ref: string,
  offset = 0,
  maxBytes = 4000,
): Promise<Record<string, unknown>> {
  if (!validRef(ref)) return { error: { code: "entry_not_found", message: "Invalid Agent entry ref." } };
  const source = sourceFor(record);
  if ("code" in source) return { error: source };
  let raw: Buffer | undefined;
  if (source.kind === "live") {
    for (const candidate of source.entries) {
      const entry = asRawEntry(candidate);
      if (!entry) return { error: { code: "malformed", message: "Live session entry is missing id or timestamp." } };
      if (makeRef(source.sessionId, entry.id) !== ref) continue;
      try {
        raw = Buffer.from(JSON.stringify(candidate), "utf8");
      } catch {
        return { error: { code: "malformed", message: "Agent entry cannot be serialized as canonical JSON." } };
      }
      break;
    }
  } else {
    const found = await findDurableEntry(source.sessionFile, ref);
    if ("code" in found) return { error: found };
    raw = found.raw;
  }
  if (!raw) return { error: { code: "entry_not_found", message: "Entry ref was not found in this Agent session." } };
  const range = utf8Range(raw, offset, maxBytes);
  return {
    ref,
    total_bytes: raw.length,
    range: { start: range.start, end: range.end },
    json: range.json,
    truncated: range.end < raw.length,
    ...(range.end < raw.length && { next_offset: range.end }),
    ...(range.requiredBytes !== undefined && { minimum_bytes_for_progress: range.requiredBytes }),
  };
}

async function findDurableEntry(
  sessionFile: string,
  ref: string,
): Promise<{ raw: Buffer; sessionId: string } | InspectionDiagnostic> {
  return withDurable(sessionFile, async (handle, header) => {
    for await (const line of forwardLines(handle, header.fileSize)) {
      if (line.line === 1 || line.bytes.length === 0) continue;
      const entry = rawEntry(line);
      if (makeRef(header.sessionId, entry.id) === ref) return { raw: line.bytes, sessionId: header.sessionId };
    }
    return { code: "entry_not_found", message: "Entry ref was not found in this Agent session." } as InspectionDiagnostic;
  });
}
