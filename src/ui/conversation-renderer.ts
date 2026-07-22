import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "./agent-widget.js";

const MAX_MESSAGES = 1000;
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_PROJECTED_TEXT_CHARS = 512 * 1024;
const COLLAPSE_LINES = 6;
const COLLAPSE_BYTES = 1200;
const DEFAULT_OUTPUT_CHARS = 8 * 1024;
const EXPANDED_OUTPUT_CHARS = 32 * 1024;
const DEFAULT_OUTPUT_LINES = 80;
const EXPANDED_OUTPUT_LINES = 300;
const ARGUMENT_CHARS = 8 * 1024;
const ARGUMENT_MAX_DEPTH = 12;
const ARGUMENT_MAX_NODES = 128;
const ARGUMENT_STRING_CHARS = 3 * 1024;
const MAX_CONTENT_PARTS = 256;
const MAX_RENDER_LINES = 2000;
const MAX_BLOCK_LINES = 800;

type UnknownRecord = Record<string, unknown>;

type ConversationItem =
  | { kind: "user"; parts: ContentPart[] }
  | { kind: "assistant"; parts: AssistantPart[]; error?: string }
  | { kind: "tool"; call: UnknownRecord; result?: UnknownRecord; standalone?: boolean }
  | { kind: "bash"; message: UnknownRecord }
  | { kind: "custom"; label: string; parts: ContentPart[] }
  | { kind: "meta"; label: string; summary: string };

type ContentPart = { kind: "text"; text: string } | { kind: "image"; mime: string; size?: number };
type AssistantPart = ContentPart | { kind: "thinking"; text: string } | { kind: "tool"; call: UnknownRecord; result?: UnknownRecord };

export type ConversationTurn = { number?: number; items: ConversationItem[] };

export type ConversationProjection = {
  turns: ConversationTurn[];
  omittedMessages: number;
};

export type ConversationRenderOptions = {
  width: number;
  expanded: boolean;
  running: boolean;
  theme: Theme;
  liveActivity?: string;
};

function recordOf(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" ? value as UnknownRecord : undefined;
}

function stringField(value: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return undefined;
}

function numberField(value: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key] as number;
  }
  return undefined;
}

function toolId(value: UnknownRecord): string | undefined {
  return stringField(value, "id", "toolCallId", "toolUseId");
}

/** Remove terminal control sequences and every C0/C1 control except line/tab layout. */
export function sanitizeTerminalText(value: string): string {
  return value
    // OSC (including OSC 52 clipboard writes), in both ESC and C1 forms.
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
    // CSI, in both ESC and C1 forms.
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    // Other two-byte/multibyte ESC sequences, then remaining controls.
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Sanitize metadata that must occupy exactly one terminal line. */
export function sanitizeSingleLineText(value: string): string {
  // Replace layout characters before the general sanitizer removes some of them,
  // so injected fields cannot concatenate words or escape their row.
  return sanitizeTerminalText(value.replace(/[\t\n\r\v\f\u0085\u2028\u2029]+/g, " "))
    .replace(/ +/g, " ");
}

const sanitizeText = sanitizeTerminalText;

function boundedText(value: string): string {
  if (value.length <= MAX_MESSAGE_CHARS) return sanitizeText(value);
  return `${sanitizeText(value.slice(0, MAX_MESSAGE_CHARS))}\n[message truncated]`;
}

function imagePart(value: UnknownRecord): ContentPart | undefined {
  if (value.type !== "image" && value.type !== "image_url") return undefined;
  const source = recordOf(value.source) ?? recordOf(value.image_url);
  const mime = stringField(value, "mimeType", "mime", "media_type")
    ?? (source ? stringField(source, "mimeType", "mime", "media_type") : undefined)
    ?? "image";
  const explicit = numberField(value, "size", "sizeBytes", "bytes")
    ?? (source ? numberField(source, "size", "sizeBytes", "bytes") : undefined);
  const data = stringField(value, "data") ?? (source ? stringField(source, "data", "url") : undefined);
  let encodedLength: number | undefined;
  if (data && !data.startsWith("http://") && !data.startsWith("https://")) {
    const marker = data.startsWith("data:") ? data.indexOf("base64,") : -1;
    encodedLength = marker >= 0 ? data.length - marker - 7 : data.length;
  }
  const size = explicit ?? (encodedLength === undefined ? undefined : Math.floor((encodedLength * 3) / 4));
  return { kind: "image", mime: sanitizeSingleLineText(mime.slice(0, 200)), size };
}

function contentParts(content: unknown): ContentPart[] {
  if (typeof content === "string") return content.trim() ? [{ kind: "text", text: boundedText(content) }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (let index = 0; index < Math.min(content.length, MAX_CONTENT_PARTS); index++) {
    const block = recordOf(content[index]);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push({ kind: "text", text: boundedText(block.text) });
      continue;
    }
    const image = imagePart(block);
    if (image) parts.push(image);
  }
  return parts;
}

function resultText(result: UnknownRecord): string {
  const content = result.content;
  if (typeof content === "string") return boundedText(content);
  if (Array.isArray(content)) {
    let remaining = MAX_MESSAGE_CHARS;
    const texts: string[] = [];
    for (let index = 0; index < Math.min(content.length, MAX_CONTENT_PARTS) && remaining > 0; index++) {
      const block = recordOf(content[index]);
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      const taken = boundedText(block.text).slice(0, remaining);
      texts.push(taken);
      remaining -= taken.length + 1;
    }
    if (texts.length > 0) return texts.join("\n");
  }
  return typeof result.output === "string" ? boundedText(result.output) : "";
}

function customParts(message: UnknownRecord): { label: string; parts: ContentPart[] } | undefined {
  if (message.display === false) return undefined;
  const type = stringField(message, "type", "role") ?? "";
  if (!["custom", "customMessage", "custom_message"].includes(type)) return undefined;
  const customType = typeof message.customType === "string" ? sanitizeSingleLineText(message.customType.slice(0, 200)) : "";
  const parts = contentParts(message.content);
  if (parts.length === 0 && typeof message.text === "string") parts.push({ kind: "text", text: boundedText(message.text) });
  if (parts.length === 0 && customType) parts.push({ kind: "text", text: customType });
  return { label: "CUSTOM", parts };
}

function summarizeMeta(message: UnknownRecord): { label: string; summary: string } | undefined {
  if (message.display === false) return undefined;
  const role = stringField(message, "role") ?? "";
  const type = stringField(message, "type") ?? role;
  if (!["branchSummary", "branch_summary", "compaction", "compactionSummary", "compaction_summary"].includes(type)) return undefined;
  const label = type.toLowerCase().includes("branch") ? "BRANCH SUMMARY" : "COMPACTION";
  const raw = stringField(message, "summary", "text") ?? (typeof message.content === "string" ? message.content : undefined);
  const metadata = numberField(message, "tokensBefore") !== undefined ? `${numberField(message, "tokensBefore")} tokens before` : "metadata entry";
  return { label, summary: boundedText(raw?.trim() || metadata).slice(0, 1000) };
}

/** Pure, bounded projection from Pi's public session messages into execution-flow turns. */
export function projectConversation(messages: readonly unknown[]): ConversationProjection {
  const omittedMessages = Math.max(0, messages.length - MAX_MESSAGES);
  const source = messages.slice(-MAX_MESSAGES);
  const matchedResults = new Map<UnknownRecord, UnknownRecord>();
  const pairedResults = new Set<UnknownRecord>();
  const pendingCalls = new Map<string, UnknownRecord[]>();
  for (const raw of source) {
    const message = recordOf(raw);
    if (message?.role === "toolResult") {
      const id = toolId(message);
      const call = id ? pendingCalls.get(id)?.shift() : undefined;
      if (call) {
        matchedResults.set(call, message);
        pairedResults.add(message);
      }
      continue;
    }
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let blockIndex = 0; blockIndex < Math.min(message.content.length, MAX_CONTENT_PARTS); blockIndex++) {
      const block = recordOf(message.content[blockIndex]);
      if (block?.type !== "toolCall") continue;
      const id = toolId(block);
      if (!id) continue;
      const queue = pendingCalls.get(id) ?? [];
      queue.push(block);
      pendingCalls.set(id, queue);
    }
  }
  let remainingTextChars = MAX_PROJECTED_TEXT_CHARS;
  const takeText = (value: string): string => {
    if (remainingTextChars <= 0) return "";
    const bounded = boundedText(value);
    const taken = bounded.slice(0, remainingTextChars);
    remainingTextChars -= taken.length;
    return taken;
  };
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;
  let turnNumber = 0;
  const target = (): ConversationTurn => {
    if (!current) {
      current = { items: [] };
      turns.push(current);
    }
    return current;
  };

  for (const raw of source) {
    const message = recordOf(raw);
    if (!message) continue;
    if (message.role === "user") {
      const parts = contentParts(message.content).flatMap((part): ContentPart[] => {
        if (part.kind === "image") return [part];
        const taken = takeText(part.text);
        return taken ? [{ kind: "text", text: taken }] : [];
      });
      if (parts.length === 0) continue;
      current = { number: ++turnNumber, items: [{ kind: "user", parts }] };
      turns.push(current);
      continue;
    }
    if (message.role === "assistant") {
      const parts: AssistantPart[] = [];
      if (Array.isArray(message.content)) {
        for (let blockIndex = 0; blockIndex < Math.min(message.content.length, MAX_CONTENT_PARTS); blockIndex++) {
          const block = recordOf(message.content[blockIndex]);
          if (!block) continue;
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            const taken = takeText(block.text);
            if (taken) parts.push({ kind: "text", text: taken });
          } else if ((block.type === "thinking" || block.type === "reasoning") && typeof block.thinking === "string") {
            const taken = takeText(block.thinking);
            if (taken) parts.push({ kind: "thinking", text: taken });
          } else if ((block.type === "thinking" || block.type === "reasoning") && typeof block.text === "string") {
            const taken = takeText(block.text);
            if (taken) parts.push({ kind: "thinking", text: taken });
          } else if (block.type === "toolCall") {
            parts.push({ kind: "tool", call: block, result: matchedResults.get(block) });
          } else {
            const image = imagePart(block);
            if (image) parts.push(image);
          }
        }
      } else if (typeof message.content === "string" && message.content.trim()) {
        const taken = takeText(message.content);
        if (taken) parts.push({ kind: "text", text: taken });
      }
      const error = message.stopReason === "error" || typeof message.errorMessage === "string"
        ? boundedText(stringField(message, "errorMessage") ?? "Provider response failed")
        : undefined;
      if (parts.length > 0 || error) target().items.push({ kind: "assistant", parts, error });
      continue;
    }
    if (message.role === "toolResult") {
      if (!pairedResults.has(message)) target().items.push({ kind: "tool", call: message, result: message, standalone: true });
      continue;
    }
    if (message.role === "bashExecution") {
      target().items.push({ kind: "bash", message });
      continue;
    }
    const custom = customParts(message);
    if (custom) {
      const parts = custom.parts.flatMap((part): ContentPart[] => {
        if (part.kind === "image") return [part];
        const taken = takeText(part.text);
        return taken ? [{ kind: "text", text: taken }] : [];
      });
      if (parts.length > 0) target().items.push({ kind: "custom", label: custom.label, parts });
      continue;
    }
    const meta = summarizeMeta(message);
    if (meta) target().items.push({ kind: "meta", ...meta });
  }
  return { turns: turns.filter((turn) => turn.items.length > 0), omittedMessages };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function hasOwnEntry(value: UnknownRecord): boolean {
  for (const key in value) {
    if (Object.hasOwn(value, key)) return true;
  }
  return false;
}

function mechanicalPreview(call: UnknownRecord): string {
  const input = recordOf(call.input) ?? recordOf(call.arguments) ?? call;
  for (const key of ["path", "command", "pattern", "url", "query", "file", "target"]) {
    const value = input[key];
    if (typeof value === "string") {
      const preview = sanitizeSingleLineText(value.slice(0, 1000)).trim().slice(0, 180);
      if (preview) return preview;
    }
  }
  return "";
}

function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringBudget = ARGUMENT_CHARS;
  let truncated = false;
  const marker = (reason = "[Truncated]"): string => {
    truncated = true;
    return reason;
  };
  const normalize = (input: unknown, depth: number): unknown => {
    if (++nodes > ARGUMENT_MAX_NODES) return marker();
    if (depth > ARGUMENT_MAX_DEPTH) return marker("[Max depth]");
    if (typeof input === "string") {
      const allowance = Math.max(0, Math.min(ARGUMENT_STRING_CHARS, stringBudget));
      if (input.length <= allowance) {
        stringBudget -= input.length;
        return input;
      }
      stringBudget -= allowance;
      return `${input.slice(0, allowance)}${marker()}`;
    }
    if (typeof input === "number") return Number.isFinite(input) ? input : String(input);
    if (typeof input === "bigint") return `${input.toString()}n`;
    if (typeof input === "boolean" || input === null || input === undefined) return input ?? null;
    if (typeof input !== "object") return String(input).slice(0, 100);
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) {
      const result: unknown[] = [];
      const limit = Math.min(input.length, ARGUMENT_MAX_NODES - nodes);
      for (let index = 0; index < limit && nodes < ARGUMENT_MAX_NODES; index++) result.push(normalize(input[index], depth + 1));
      if (limit < input.length) result.push(marker(`[Truncated ${input.length - limit} items]`));
      return result;
    }
    // Collect at most a bounded prefix before sorting; never Object.keys/entries a huge object.
    const keys: Array<{ original: string; safe: string }> = [];
    const keyLimit = Math.max(0, ARGUMENT_MAX_NODES - nodes);
    let hasMore = false;
    for (const key in input as UnknownRecord) {
      if (!Object.hasOwn(input, key)) continue;
      if (keys.length >= keyLimit) {
        hasMore = true;
        break;
      }
      const allowance = Math.max(0, Math.min(200, stringBudget));
      keys.push({ original: key, safe: key.length > allowance ? `${key.slice(0, allowance)}${marker()}` : key });
      stringBudget -= Math.min(key.length, allowance);
    }
    keys.sort((a, b) => a.safe.localeCompare(b.safe));
    const result: UnknownRecord = {};
    for (const key of keys) {
      if (nodes >= ARGUMENT_MAX_NODES) break;
      result[key.safe] = normalize((input as UnknownRecord)[key.original], depth + 1);
    }
    if (hasMore) result["[Truncated properties]"] = true;
    return result;
  };
  try {
    const json = JSON.stringify(normalize(value, 0), null, 2) ?? "null";
    const clipped = json.length > ARGUMENT_CHARS ? json.slice(0, ARGUMENT_CHARS) : json;
    return truncated || clipped.length < json.length ? `${clipped}\n[arguments truncated]` : clipped;
  } catch {
    return "[arguments unavailable]";
  }
}

function safeWrap(text: string, width: number): string[] {
  if (!text) return [];
  const safe = boundedText(text);
  try {
    return wrapTextWithAnsi(safe, Math.max(1, width)).slice(0, MAX_BLOCK_LINES);
  } catch {
    return safe.split("\n").flatMap((line) => {
      if (!line) return [""];
      const chunks: string[] = [];
      for (let index = 0; index < line.length; index += Math.max(1, width)) chunks.push(line.slice(index, index + Math.max(1, width)));
      return chunks;
    }).slice(0, MAX_BLOCK_LINES);
  }
}

function markdownLines(text: string, width: number, theme: Theme): string[] {
  try {
    return new Markdown(boundedText(text), 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) }).render(Math.max(1, width)).slice(0, MAX_BLOCK_LINES);
  } catch {
    return safeWrap(text, width);
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function logicalLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function formatLineCount(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function renderImage(part: Extract<ContentPart, { kind: "image" }>, theme: Theme): string {
  return theme.fg("muted", `[image ${sanitizeSingleLineText(part.mime)}${part.size === undefined ? "" : ` · ${formatBytes(part.size)}`}]`);
}

function resultImages(result: UnknownRecord): Extract<ContentPart, { kind: "image" }>[] {
  if (!Array.isArray(result.content)) return [];
  const images: Extract<ContentPart, { kind: "image" }>[] = [];
  for (let index = 0; index < Math.min(result.content.length, MAX_CONTENT_PARTS); index++) {
    const block = recordOf(result.content[index]);
    const image = block ? imagePart(block) : undefined;
    if (image?.kind === "image") images.push(image);
  }
  return images;
}

function prefixed(lines: string[], prefix: string, theme: Theme): string[] {
  return lines.map((line) => theme.fg("dim", prefix) + line);
}

function renderTool(call: UnknownRecord, result: UnknownRecord | undefined, standalone: boolean, options: ConversationRenderOptions): string[] {
  const { expanded, running, theme, width } = options;
  const rawName = (standalone ? stringField(result ?? call, "toolName", "name") : stringField(call, "name", "toolName")) ?? "unknown";
  const name = sanitizeSingleLineText(rawName.slice(0, 1000)).slice(0, 200);
  const preview = standalone ? "unmatched result" : mechanicalPreview(call);
  const isError = result?.isError === true || result?.error === true;
  const state = result ? (isError ? "error" : "success") : running ? "running" : "muted";
  const icon = state === "success" ? "✓" : state === "error" ? "✗" : state === "running" ? "◌" : "○";
  const color = state === "success" ? "success" : state === "error" ? "error" : state === "running" ? "warning" : "dim";
  const duration = numberField(result ?? call, "durationMs", "duration_ms", "duration");
  const header = `${theme.fg("dim", "├─")} ${theme.bold(theme.fg("accent", name.toUpperCase()))}${preview ? `  ${theme.fg("muted", preview)}` : ""}  ${theme.fg(color, icon)}${duration === undefined ? "" : ` ${theme.fg("dim", `${Math.round(duration)}ms`)}`}`;
  const lines = [header];

  if (expanded && !standalone) {
    const args = recordOf(call.input) ?? recordOf(call.arguments);
    if (args && hasOwnEntry(args)) {
      lines.push(theme.fg("dim", "│  arguments"));
      lines.push(...prefixed(safeWrap(canonicalJson(args), Math.max(1, width - 3)), "│  ", theme));
    }
  }
  if (!result) return lines;
  const output = resultText(result);
  const images = resultImages(result);
  if (!output.trim()) {
    lines.push(...images.map((image) => theme.fg("dim", "│  ") + renderImage(image, theme)));
    return lines;
  }
  const rawLines = logicalLines(output);
  const bytes = utf8Bytes(output);
  const longSuccess = !isError && (rawLines.length > COLLAPSE_LINES || bytes > COLLAPSE_BYTES);
  if (longSuccess && !expanded) {
    lines.push(theme.fg("dim", `│  [collapsed] ${formatLineCount(rawLines.length)} · ${formatBytes(bytes)}`));
  }
  const charLimit = expanded ? EXPANDED_OUTPUT_CHARS : DEFAULT_OUTPUT_CHARS;
  const lineLimit = expanded ? EXPANDED_OUTPUT_LINES : DEFAULT_OUTPUT_LINES;
  const clippedChars = output.slice(0, charLimit);
  const clippedLines = clippedChars.split("\n").slice(0, lineLimit);
  const truncated = clippedChars.length < output.length || clippedLines.length < clippedChars.split("\n").length;
  const outputColor = isError ? "error" : "muted";
  const wrapped = clippedLines
    .flatMap((line) => safeWrap(line, Math.max(1, width - 3)))
    .slice(0, MAX_BLOCK_LINES);
  lines.push(...wrapped.map((line) => theme.fg("dim", "│  ") + theme.fg(outputColor, line)));
  if (truncated) lines.push(theme.fg("error", "│  [truncated at viewer safety limit]"));
  lines.push(...images.map((image) => theme.fg("dim", "│  ") + renderImage(image, theme)));
  return lines;
}

/** Render a projection with only public Pi TUI/theme APIs. Every returned line is width-clamped. */
export function renderConversation(projection: ConversationProjection, options: ConversationRenderOptions): string[] {
  const { width, expanded, theme } = options;
  if (width <= 0) return [];
  const lines: string[] = [];
  if (projection.omittedMessages > 0) lines.push(theme.fg("dim", `[${projection.omittedMessages} older messages omitted for viewer safety]`));
  conversation: for (const turn of projection.turns) {
    if (turn.number !== undefined) {
      if (lines.length > 0) lines.push("");
      lines.push(theme.fg("dim", `── Turn ${turn.number}`));
    }
    let assistantLaneRendered = false;
    for (const item of turn.items) {
      if (item.kind === "user") {
        lines.push(theme.bold(theme.fg("accent", "USER")));
        for (const part of item.parts) {
          if (part.kind === "image") lines.push(renderImage(part, theme));
          else lines.push(...safeWrap(part.text, width).map((line) => theme.fg("userMessageText", line)));
        }
      } else if (item.kind === "assistant") {
        if (!assistantLaneRendered) {
          lines.push(theme.bold(theme.fg("accent", "ASSISTANT")));
          assistantLaneRendered = true;
        }
        for (const part of item.parts) {
          if (part.kind === "text") lines.push(...markdownLines(part.text, width, theme));
          else if (part.kind === "image") lines.push(renderImage(part, theme));
          else if (part.kind === "thinking") {
            const lineCount = logicalLines(part.text).length;
            const count = `${formatLineCount(lineCount)} · ${part.text.length} chars`;
            lines.push(theme.fg("dim", `├─ THINKING  ${count}${expanded ? "" : "  [collapsed]"}`));
            if (expanded) lines.push(...prefixed(safeWrap(part.text, Math.max(1, width - 3)), "│  ", theme));
          } else {
            lines.push(...renderTool(part.call, part.result, false, options));
          }
        }
        if (item.error) {
          lines.push(theme.bold(theme.fg("error", "└─ PROVIDER ERROR")));
          lines.push(...prefixed(safeWrap(item.error, Math.max(1, width - 3)), "   ", theme).map((line) => theme.fg("error", line)));
        }
      } else if (item.kind === "tool") {
        lines.push(...renderTool(item.call, item.result, item.standalone === true, options));
      } else if (item.kind === "custom") {
        const safeLabel = sanitizeSingleLineText(item.label);
        const label = `${safeLabel} · `;
        let labelUsed = false;
        for (const part of item.parts) {
          if (part.kind === "image") {
            if (!labelUsed) lines.push(theme.fg("dim", safeLabel));
            lines.push(renderImage(part, theme));
            labelUsed = true;
            continue;
          }
          const wrapped = safeWrap(part.text, Math.max(1, width - (labelUsed ? 0 : label.length)));
          if (!labelUsed) lines.push(theme.fg("dim", label) + (wrapped.shift() ?? ""));
          lines.push(...wrapped.map((line) => theme.fg("muted", line)));
          labelUsed = true;
        }
      } else if (item.kind === "bash") {
        const result: UnknownRecord = {
          content: item.message.output,
          isError: item.message.cancelled === true || (typeof item.message.exitCode === "number" && item.message.exitCode !== 0),
          durationMs: item.message.durationMs,
          toolName: "bash",
        };
        lines.push(...renderTool({ name: "bash", input: { command: item.message.command } }, result, false, options));
      } else {
        const label = `${sanitizeSingleLineText(item.label)} · `;
        const summaryLines = safeWrap(item.summary, Math.max(1, width - label.length));
        lines.push(theme.fg("dim", label) + (summaryLines.shift() ?? ""));
        lines.push(...summaryLines.map((line) => theme.fg("dim", `  ${line}`)));
      }
      if (lines.length >= MAX_RENDER_LINES) break conversation;
    }
  }
  const safetyTruncated = lines.length >= MAX_RENDER_LINES;
  if (safetyTruncated) {
    lines.length = MAX_RENDER_LINES - 1;
    lines.push(theme.fg("error", "[conversation truncated at viewer safety limit]"));
  }
  if (!safetyTruncated && options.running && options.liveActivity) {
    if (lines.length > 0) lines.push("");
    lines.push(theme.fg("dim", "└─ ") + theme.fg("accent", "◌ ") + theme.fg("muted", sanitizeSingleLineText(options.liveActivity.slice(0, MAX_MESSAGE_CHARS))));
  }
  if (lines.length === 0) lines.push(theme.fg("dim", "(waiting for first message...)"));
  return lines.map((line) => truncateToWidth(line, width));
}
