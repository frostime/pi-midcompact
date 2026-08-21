import type { MessageLike, SessionEntryLike } from "./types.js";

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) out[key] = sortValue(input[key]);
  return out;
}

function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function messageKey(message: MessageLike): string {
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
  return `${message.role}:${timestamp}:${fnv1a64(stableStringify(message))}`;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") out.push(part.text);
    else if (part.type === "thinking" && typeof part.thinking === "string") out.push(part.thinking);
    else if (part.type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "tool";
      const args = "arguments" in part ? part.arguments : {};
      out.push(`${name}(${safeJson(args)})`);
    } else if (part.type === "image") {
      // Image parts must not be silently dropped from rendered text; surface a
      // placeholder so locate, preview and recall visibly account for them.
      // Full image facts (payload bytes, dimensions) come from content-metrics.
      const mime = typeof part.mimeType === "string" ? part.mimeType : "unknown";
      out.push(`[image: ${mime}]`);
    }
  }
  return out.join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

export function messageText(message: MessageLike): string {
  if (message.role === "toolResult") {
    const name = message.toolName ?? "tool";
    return `tool_result ${name}: ${contentText(message.content)}`;
  }
  const pieces = [contentText(message.content)];
  if (typeof message.command === "string") pieces.push(`$ ${message.command}`);
  if (typeof message.output === "string") pieces.push(message.output);
  if (typeof message.summary === "string") pieces.push(message.summary);
  return pieces.filter(Boolean).join("\n");
}

export function toolCalls(message: MessageLike): Array<{ id: string; name: string; arguments?: unknown }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; name: string; arguments?: unknown }> = [];
  for (const raw of message.content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    if (part.type !== "toolCall") continue;
    if (typeof part.id !== "string" || typeof part.name !== "string") continue;
    calls.push({ id: part.id, name: part.name, arguments: part.arguments });
  }
  return calls;
}

export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function mapEntryIds(messages: MessageLike[], branch: readonly SessionEntryLike[]): Array<string | undefined> {
  const queues = new Map<string, string[]>();
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message) continue;
    const key = messageKey(entry.message);
    const queue = queues.get(key) ?? [];
    queue.push(entry.id);
    queues.set(key, queue);
  }
  return messages.map((message) => {
    const queue = queues.get(messageKey(message));
    return queue?.shift();
  });
}

export function renderMessage(message: MessageLike): string {
  if (message.role === "user") return `User: ${messageText(message)}`;
  if (message.role === "assistant") return `Assistant: ${messageText(message)}`;
  if (message.role === "toolResult") return `Tool result (${message.toolName ?? "tool"}): ${contentText(message.content)}`;
  if (message.role === "bashExecution") return `Bash: ${message.command ?? ""}\n${message.output ?? ""}`;
  if (message.role === "custom") return `Custom: ${messageText(message)}`;
  return `${message.role}: ${messageText(message)}`;
}
