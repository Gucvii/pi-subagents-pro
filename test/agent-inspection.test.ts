import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { inspectAgentRecord, MAX_JSONL_LINE_BYTES, readAgentEntry } from "../src/agent-inspection.js";
import type { AgentRecord } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const userEntry = {
  type: "message",
  id: "u1",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: "TOP SECRET USER BODY", timestamp: 1 },
} as unknown as SessionEntry;
const assistantEntry = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-01-01T00:00:01.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "TOP SECRET ASSISTANT BODY" },
      { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/secret" } },
    ],
    stopReason: "toolUse",
    timestamp: 2,
  },
} as unknown as SessionEntry;
const errorEntry = {
  type: "message",
  id: "t1",
  parentId: "a1",
  timestamp: "2026-01-01T00:00:02.000Z",
  message: { role: "toolResult", toolName: "read", toolCallId: "tc1", content: "TOP SECRET TOOL ERROR", isError: true, timestamp: 3 },
} as unknown as SessionEntry;

function record(entries: SessionEntry[], overrides: Partial<AgentRecord> = {}, sessionId = "session-live-1"): AgentRecord {
  const sessionManager = {
    getSessionId: () => sessionId,
    getEntries: () => entries,
  };
  return {
    id: "agent-1",
    type: "Explore",
    description: "inspect me",
    status: "running",
    result: undefined,
    error: undefined,
    toolUses: 1,
    startedAt: Date.now() - 100,
    parentCwd: "/repo",
    session: { sessionManager } as unknown as AgentSession,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    invocation: { sessionPersistence: "memory" },
    lineage: { agentId: "agent-1", parentAgentId: "root", rootAgentId: "root", depth: 1, maxTreeLevels: 3 },
    ...overrides,
  };
}

function durableRecord(sessionFile: string): AgentRecord {
  return record([], {
    session: undefined,
    sessionFile,
    status: "completed",
    result: "RESULT MUST NOT LEAK",
    invocation: { sessionPersistence: "durable" },
  });
}

function tempPath(name = "session.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-inspection-"));
  dirs.push(dir);
  return join(dir, name);
}

function writeSession(entries: SessionEntry[], sessionId = "session-durable-1"): string {
  const path = tempPath();
  const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" };
  writeFileSync(path, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return path;
}

function refs(output: Record<string, unknown>): string[] {
  return (output.entries as Array<{ ref: string }>).map((entry) => entry.ref);
}

describe("inspectAgentRecord", () => {
  it("returns a small body-free status with an opaque digest cursor", async () => {
    const output = await inspectAgentRecord(
      record([userEntry, assistantEntry]),
      { activeTools: new Map([["read_1", "read"]]), lastActivityAt: Date.now() - 10 },
    );
    const serialized = JSON.stringify(output);

    expect(output).toMatchObject({
      status: "running",
      current_tools: ["read"],
      result_available: false,
      error_available: false,
      persistence: "memory",
      resumable: true,
      session_file: "none",
    });
    expect(output.cursor).toMatch(/^e_[a-f0-9]{24}$/);
    expect(serialized).not.toContain("a1");
    expect(serialized).not.toContain("TOP SECRET");
    expect(Buffer.byteLength(serialized)).toBeLessThan(300);
  });

  it("binds digest refs to the full session ID and never accepts entry-ID composition", async () => {
    const first = record([userEntry], {}, "branch-original");
    const clone = record([userEntry], {}, "branch-clone");
    const firstInspect = await inspectAgentRecord(first, undefined, { kind: "tail", limit: 1 });
    const cloneInspect = await inspectAgentRecord(clone, undefined, { kind: "tail", limit: 1 });
    const firstRef = refs(firstInspect)[0];

    expect(firstRef).not.toContain("u1");
    expect(refs(cloneInspect)[0]).not.toBe(firstRef);
    expect((await inspectAgentRecord(clone, undefined, { kind: "after", cursor: firstRef })).entries_error)
      .toMatchObject({ code: "stale_cursor" });
    expect((await readAgentEntry(clone, firstRef)).error).toMatchObject({ code: "entry_not_found" });
    expect((await readAgentEntry(first, `${firstRef}00`)).error).toMatchObject({ code: "entry_not_found" });
  });

  it("returns bounded metadata, reverse-tail filters, and no locator-bearing compaction metadata", async () => {
    const compaction = {
      type: "compaction",
      id: "c1",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "SECRET SUMMARY",
      tokensBefore: 123,
      firstKeptEntryId: "u1",
      fromHook: true,
    } as unknown as SessionEntry;
    const output = await inspectAgentRecord(record([userEntry, assistantEntry, errorEntry, compaction]), undefined, {
      kind: "tail",
      limit: 2,
      types: ["assistant_message", "error", "compaction"],
    });
    const serialized = JSON.stringify(output);

    expect(output.entries).toEqual([
      expect.objectContaining({ type: "tool_result", is_error: true }),
      expect.objectContaining({ type: "compaction", tokens_before: 123, from_hook: true }),
    ]);
    expect(output).toMatchObject({ older_entries_omitted: true });
    expect(serialized).not.toContain("first_kept");
    expect(serialized).not.toContain("firstKept");
    expect(serialized).not.toContain("TOP SECRET");
    expect(serialized).not.toContain("SECRET SUMMARY");
  });

  it("implements after has_more and advances across non-matching physical entries at EOF", async () => {
    const live = record([userEntry, assistantEntry, errorEntry]);
    const all = await inspectAgentRecord(live, undefined, { kind: "tail", limit: 3 });
    const allRefs = refs(all);
    const firstPage = await inspectAgentRecord(live, undefined, { kind: "after", cursor: allRefs[0], limit: 1 });
    expect(firstPage).toMatchObject({ has_more: true, cursor: allRefs[1] });
    expect(refs(firstPage)).toEqual([allRefs[1]]);

    const filtered = await inspectAgentRecord(live, undefined, {
      kind: "after",
      cursor: allRefs[0],
      limit: 5,
      types: ["assistant_message"],
    });
    expect(refs(filtered)).toEqual([allRefs[1]]);
    expect(filtered).toMatchObject({ has_more: false, cursor: allRefs[2] });
    const again = await inspectAgentRecord(live, undefined, {
      kind: "after",
      cursor: filtered.cursor as string,
      limit: 5,
      types: ["assistant_message"],
    });
    expect(again.entries).toEqual([]);
  });

  it("advances to the last physical entry before an unreturned sparse-filter match", async () => {
    const skipped1 = { ...errorEntry, id: "skip-1", message: { ...(errorEntry as any).message, isError: false } } as SessionEntry;
    const skipped2 = { ...errorEntry, id: "skip-2", message: { ...(errorEntry as any).message, isError: false } } as SessionEntry;
    const assistant2 = { ...assistantEntry, id: "a2" } as SessionEntry;
    const live = record([userEntry, assistantEntry, skipped1, skipped2, assistant2]);
    const all = await inspectAgentRecord(live, undefined, { kind: "tail", limit: 5 });
    const allRefs = refs(all);
    const page = await inspectAgentRecord(live, undefined, {
      kind: "after",
      cursor: allRefs[0],
      limit: 1,
      types: ["assistant_message"],
    });
    expect(refs(page)).toEqual([allRefs[1]]);
    expect(page).toMatchObject({ has_more: true, cursor: allRefs[3] });
    const next = await inspectAgentRecord(live, undefined, {
      kind: "after",
      cursor: page.cursor as string,
      limit: 1,
      types: ["assistant_message"],
    });
    expect(refs(next)).toEqual([allRefs[4]]);
  });

  it("keeps live and durable filter/pagination semantics aligned", async () => {
    const sessionId = "same-session";
    const entries = [userEntry, assistantEntry, errorEntry];
    const live = record(entries, {}, sessionId);
    const durable = durableRecord(writeSession(entries, sessionId));
    const liveTail = await inspectAgentRecord(live, undefined, { kind: "tail", limit: 1, types: ["error"] });
    const durableTail = await inspectAgentRecord(durable, undefined, { kind: "tail", limit: 1, types: ["error"] });
    expect(durableTail).toMatchObject({
      entries: liveTail.entries,
      older_entries_omitted: liveTail.older_entries_omitted,
      cursor: liveTail.cursor,
    });

    const cursor = (await inspectAgentRecord(live, undefined, { kind: "tail", limit: 3 })).entries as Array<{ ref: string }>;
    const selection = { kind: "after" as const, cursor: cursor[0].ref, limit: 1, types: ["assistant_message" as const] };
    const liveAfter = await inspectAgentRecord(live, undefined, selection);
    const durableAfter = await inspectAgentRecord(durable, undefined, selection);
    expect(durableAfter).toMatchObject({
      entries: liveAfter.entries,
      has_more: liveAfter.has_more,
      cursor: liveAfter.cursor,
    });
  });

  it("bare durable inspection reads only header and newest entry, not malformed history", async () => {
    const path = writeSession([userEntry]);
    const header = JSON.stringify({ type: "session", version: 3, id: "bounded", timestamp: "now", cwd: "/repo" });
    writeFileSync(path, `${header}\n{old malformed history}\n${JSON.stringify(errorEntry)}\n`, "utf8");
    const output = await inspectAgentRecord(durableRecord(path), undefined);
    expect(output.cursor).toMatch(/^e_[a-f0-9]{24}$/);
    expect(output.cursor_error).toBeUndefined();
  });

  it("distinguishes missing, invalid UTF-8, oversized lines, and partial final JSONL", async () => {
    const missing = tempPath("missing.jsonl");
    const missingOutput = await inspectAgentRecord(durableRecord(missing), undefined);
    expect(missingOutput).toMatchObject({ session_file: "missing", resumable: false, cursor_error: { code: "missing" } });

    const header = Buffer.from(`${JSON.stringify({ type: "session", id: "broken" })}\n`);
    const invalidUtf8 = tempPath("invalid.jsonl");
    writeFileSync(invalidUtf8, Buffer.concat([header, Buffer.from([0x7b, 0xff, 0x7d, 0x0a])]));
    expect((await inspectAgentRecord(durableRecord(invalidUtf8), undefined, { kind: "tail", limit: 1 })).entries_error)
      .toMatchObject({ code: "malformed" });

    const oversized = tempPath("oversized.jsonl");
    writeFileSync(oversized, Buffer.concat([header, Buffer.alloc(MAX_JSONL_LINE_BYTES + 1, 0x61), Buffer.from("\n")]));
    expect((await inspectAgentRecord(durableRecord(oversized), undefined, { kind: "tail", limit: 1 })).entries_error)
      .toMatchObject({ code: "line_too_large" });

    const partial = tempPath("partial.jsonl");
    writeFileSync(partial, Buffer.concat([header, Buffer.from('{"type":')]));
    expect((await inspectAgentRecord(durableRecord(partial), undefined, { kind: "tail", limit: 1 })).entries_error)
      .toMatchObject({ code: "malformed", message: expect.stringContaining("partial final line") });

    const directory = mkdtempSync(join(tmpdir(), "agent-inspection-directory-"));
    dirs.push(directory);
    expect((await inspectAgentRecord(durableRecord(directory), undefined)).cursor_error)
      .toMatchObject({ code: "not_file" });
  });

  it.runIf(typeof process.getuid === "function" && process.getuid() !== 0)("reports permission denial without modifying the file", async () => {
    const path = writeSession([userEntry]);
    chmodSync(path, 0o000);
    try {
      const output = await inspectAgentRecord(durableRecord(path), undefined);
      expect(output.cursor_error).toMatchObject({ code: "permission" });
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

describe("readAgentEntry", () => {
  it("reassembles exact live UTF-8 bytes across pages and handles continuation offsets and progress", async () => {
    const unicodeEntry = {
      ...userEntry,
      id: "unicode-private-id",
      message: { role: "user", content: "A¢你😀﻿Z", timestamp: 1 },
    } as unknown as SessionEntry;
    const live = record([unicodeEntry]);
    const inspected = await inspectAgentRecord(live, undefined, { kind: "tail", limit: 1 });
    const ref = refs(inspected)[0];
    const full = await readAgentEntry(live, ref, 0, 16000);
    const expected = Buffer.from(JSON.stringify(unicodeEntry), "utf8");
    const pieces: Buffer[] = [];
    let offset = 0;
    while (offset < expected.length) {
      let page = await readAgentEntry(live, ref, offset, 2);
      if (page.minimum_bytes_for_progress) {
        page = await readAgentEntry(live, ref, offset, page.minimum_bytes_for_progress as number);
      }
      pieces.push(Buffer.from(page.json as string, "utf8"));
      const next = (page.range as { end: number }).end;
      expect(next).toBeGreaterThan(offset);
      offset = next;
    }
    expect(Buffer.concat(pieces)).toEqual(expected);
    expect(full).toMatchObject({ total_bytes: expected.length, truncated: false });

    const fourByteStart = expected.indexOf(Buffer.from("😀"));
    const continuation = await readAgentEntry(live, ref, fourByteStart + 2, 4);
    expect(continuation).toMatchObject({ range: { start: fourByteStart + 4 } });
    const stalled = await readAgentEntry(live, ref, fourByteStart, 3);
    expect(stalled).toMatchObject({ json: "", next_offset: fourByteStart, minimum_bytes_for_progress: 4 });
    const bomStart = expected.indexOf(Buffer.from("﻿"));
    const bomPage = await readAgentEntry(live, ref, bomStart, 3);
    expect(bomPage).toMatchObject({ json: "﻿", range: { start: bomStart, end: bomStart + 3 } });
  });

  it("returns exact validated durable entry bytes only and rejects branch refs", async () => {
    const sessionId = "durable-exact";
    const path = writeSession([userEntry, assistantEntry], sessionId);
    const durable = durableRecord(path);
    const inspected = await inspectAgentRecord(durable, undefined, { kind: "tail", limit: 2 });
    const ref = refs(inspected)[0];
    const output = await readAgentEntry(durable, ref, 0, 16000);
    const expected = Buffer.from(JSON.stringify(userEntry), "utf8");

    expect(Buffer.from(output.json as string, "utf8")).toEqual(expected);
    expect(output).toMatchObject({ ref, total_bytes: expected.length, range: { start: 0, end: expected.length }, truncated: false });
    expect(JSON.stringify(output)).not.toContain("TOP SECRET ASSISTANT BODY");
    const branch = durableRecord(writeSession([userEntry], "durable-branch"));
    expect((await readAgentEntry(branch, ref)).error).toMatchObject({ code: "entry_not_found" });
  });

  it("rejects malformed and overlong refs before scanning", async () => {
    const durable = durableRecord(writeSession([userEntry]));
    expect((await readAgentEntry(durable, "e_not-hex")).error).toMatchObject({ code: "entry_not_found" });
    expect((await readAgentEntry(durable, `e_${"a".repeat(200)}`)).error).toMatchObject({ code: "entry_not_found" });
  });
});
