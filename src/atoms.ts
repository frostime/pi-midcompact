import type { Atom, LocateQuery, MessageLike, MessageRef, SessionEntryLike } from "./types.js";
import { aggregateMetrics, measureMessage } from "./content-metrics.js";
import { approxTokens, mapEntryIds, messageKey, renderMessage, toolCalls, truncate } from "./messages.js";

export function buildAtoms(messages: MessageLike[], branch: readonly SessionEntryLike[]): Atom[] {
  const entryIds = mapEntryIds(messages, branch);
  const refs: MessageRef[] = messages.map((message, index) => ({
    message,
    key: messageKey(message),
    entryId: entryIds[index],
  }));
  const atoms: Atom[] = [];
  let i = 0;
  while (i < refs.length) {
    const current = refs[i]!;
    const message = current.message;

    if (message.role === "custom" && message.customType === "midcompact-summary") {
      atoms.push(makeAtom(atoms.length, "compressed", [current], false, true, blockIdFromSummary(message)));
      i += 1;
      continue;
    }

    if (message.role === "assistant") {
      const calls = toolCalls(message);
      if (calls.length > 0) {
        const expected = new Set(calls.map((call) => call.id));
        const chunk: MessageRef[] = [current];
        const seen = new Set<string>();
        let j = i + 1;
        while (j < refs.length) {
          const next = refs[j]!;
          if (next.message.role !== "toolResult") break;
          if (!next.message.toolCallId || !expected.has(next.message.toolCallId)) break;
          chunk.push(next);
          seen.add(next.message.toolCallId);
          j += 1;
          if (seen.size === expected.size) break;
        }
        const closed = seen.size === expected.size;
        atoms.push(makeAtom(atoms.length, "tool_exchange", chunk, closed && chunk.every(hasEntry), closed));
        i = j;
        continue;
      }
      atoms.push(makeAtom(atoms.length, "assistant", [current], hasEntry(current), true));
      i += 1;
      continue;
    }

    if (message.role === "toolResult") {
      atoms.push(makeAtom(atoms.length, "orphan_tool_result", [current], false, false));
      i += 1;
      continue;
    }

    if (message.role === "user") {
      atoms.push(makeAtom(atoms.length, "user", [current], hasEntry(current), true));
      i += 1;
      continue;
    }

    if (message.role === "bashExecution") {
      atoms.push(makeAtom(atoms.length, "bash", [current], hasEntry(current), true));
      i += 1;
      continue;
    }

    atoms.push(makeAtom(atoms.length, message.role === "custom" ? "custom" : "other", [current], false, true));
    i += 1;
  }
  return atoms;
}

/** A protected atom cannot be part of any compressible range. */
export function isProtectedAtom(atom: Atom): boolean {
  return !atom.compressible || !atom.protocolClosed || atom.kind === "compressed";
}

function hasEntry(ref: MessageRef): boolean {
  return typeof ref.entryId === "string" && ref.entryId.length > 0;
}

function blockIdFromSummary(message: MessageLike): string | undefined {
  if (!message.details || typeof message.details !== "object") return undefined;
  const id = (message.details as Record<string, unknown>).blockId;
  return typeof id === "string" ? id : undefined;
}

function makeAtom(
  index: number,
  kind: Atom["kind"],
  messages: MessageRef[],
  compressible: boolean,
  protocolClosed: boolean,
  compressedBlockId?: string,
): Atom {
  const fullText = messages.map((ref) => renderMessage(ref.message)).join("\n\n");
  const toolNames = new Set<string>();
  const roles = new Set<string>();
  for (const ref of messages) {
    roles.add(ref.message.role);
    for (const call of toolCalls(ref.message)) toolNames.add(call.name);
    if (ref.message.role === "toolResult" && ref.message.toolName) toolNames.add(ref.message.toolName);
  }
  return {
    ref: `a${String(index + 1).padStart(4, "0")}`,
    index,
    kind,
    messages,
    entryIds: messages.flatMap((ref) => (ref.entryId ? [ref.entryId] : [])),
    messageKeys: messages.map((ref) => ref.key),
    preview: truncate(fullText, 700),
    fullText,
    metrics: aggregateMetrics(messages.map((ref) => measureMessage(ref.message))),
    approxTokens: approxTokens(fullText),
    compressible,
    protocolClosed,
    toolNames: [...toolNames],
    roles: [...roles],
    compressedBlockId,
  };
}

export function locateAtoms(atoms: Atom[], query: LocateQuery): Atom[] {
  if (query.ref) {
    const atom = atoms.find((candidate) => candidate.ref === query.ref);
    return atom ? [atom] : [];
  }
  const pattern = query.pattern?.toLocaleLowerCase();
  const toolName = query.toolName?.toLocaleLowerCase();
  const source = query.source ?? "any";
  let matches = atoms.filter((atom) => {
    if (!matchesSource(atom, source)) return false;
    if (toolName && !atom.toolNames.some((name) => name.toLocaleLowerCase() === toolName)) return false;
    if (pattern && !atom.fullText.toLocaleLowerCase().includes(pattern)) return false;
    return Boolean(pattern || toolName || source !== "any");
  });
  if ((query.direction ?? "oldest") === "newest") matches = matches.reverse();
  return matches.slice(0, Math.max(1, Math.min(query.limit ?? 5, 20)));
}

function matchesSource(atom: Atom, source: NonNullable<LocateQuery["source"]>): boolean {
  if (source === "any") return true;
  if (source === "user") return atom.roles.includes("user");
  if (source === "assistant") return atom.roles.includes("assistant");
  if (source === "tool_result") return atom.roles.includes("toolResult");
  if (source === "tool_call") return atom.toolNames.length > 0 && atom.roles.includes("assistant");
  return false;
}

export function formatLocatedAtom(atom: Atom, detail: "brief" | "full" = "brief"): string {
  const flags = [atom.kind, atom.compressible ? "compressible" : "protected", atom.protocolClosed ? "closed" : "open"].join(", ");
  const text = detail === "full" ? truncate(atom.fullText, 12_000) : atom.preview;
  return [
    `${atom.ref} | position ${atom.index + 1} | ${flags}`,
    atom.toolNames.length ? `tools: ${atom.toolNames.join(", ")}` : "",
    text,
  ].filter(Boolean).join("\n");
}
