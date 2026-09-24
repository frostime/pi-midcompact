import type { Atom, LocateQuery, MessageLike, MessageRef, SessionEntryLike, ToolProtocolStatus } from "./types.js";
import { aggregateMetrics, measureMessage } from "./content-metrics.js";
import { approxTokens, excerptAround, mapEntryIds, messageKey, renderMessage, toolCalls, truncateMiddle } from "./messages.js";

export function buildAtoms(messages: MessageLike[], branch: readonly SessionEntryLike[]): Atom[] {
  const entryIds = mapEntryIds(messages, branch);
  const refs: MessageRef[] = messages.map((message, index) => ({
    message,
    key: messageKey(message),
    entryId: entryIds[index],
  }));
  const protocolLocations = indexToolProtocol(refs);
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
        const toolProtocol = classifyToolExchange(calls, seen, i, j, protocolLocations);
        const atom = makeAtom(
          atoms.length,
          "tool_exchange",
          chunk,
          toolProtocol !== "ambiguous" && chunk.every(hasEntry),
          toolProtocol === "closed",
        );
        atoms.push({ ...atom, toolProtocol });
        i = j;
        continue;
      }
      atoms.push(makeAtom(atoms.length, "assistant", [current], hasEntry(current), true));
      i += 1;
      continue;
    }

    if (message.role === "toolResult") {
      const atom = makeAtom(atoms.length, "orphan_tool_result", [current], false, false);
      atoms.push({ ...atom, toolProtocol: "orphan" });
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
  return !atom.compressible || atom.kind === "compressed";
}

interface ToolProtocolLocations {
  callIndexesById: Map<string, number[]>;
  resultIndexesById: Map<string, number[]>;
}

function indexToolProtocol(refs: readonly MessageRef[]): ToolProtocolLocations {
  const callIndexesById = new Map<string, number[]>();
  const resultIndexesById = new Map<string, number[]>();

  refs.forEach((ref, index) => {
    for (const call of toolCalls(ref.message)) appendLocation(callIndexesById, call.id, index);
    if (ref.message.role === "toolResult" && ref.message.toolCallId) {
      appendLocation(resultIndexesById, ref.message.toolCallId, index);
    }
  });
  return { callIndexesById, resultIndexesById };
}

function appendLocation(locations: Map<string, number[]>, id: string, index: number): void {
  const indexes = locations.get(id) ?? [];
  indexes.push(index);
  locations.set(id, indexes);
}

function classifyToolExchange(
  calls: readonly { id: string }[],
  seen: ReadonlySet<string>,
  assistantIndex: number,
  endIndex: number,
  locations: ToolProtocolLocations,
): Exclude<ToolProtocolStatus, "orphan"> {
  const expectedIds = calls.map((call) => call.id);
  const expected = new Set(expectedIds);
  const hasUniqueCalls = expected.size === expectedIds.length
    && expectedIds.every((id) => locations.callIndexesById.get(id)?.length === 1);
  const hasOnlyLocalResults = expectedIds.every((id) => {
    const resultIndexes = locations.resultIndexesById.get(id) ?? [];
    return resultIndexes.length <= 1
      && resultIndexes.every((index) => index > assistantIndex && index < endIndex);
  });

  if (!hasUniqueCalls || !hasOnlyLocalResults) return "ambiguous";
  return seen.size === expected.size ? "closed" : "abandoned";
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
    preview: truncateMiddle(fullText, 700),
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

export const MAX_LOCATE_MATCHES = 3;

export interface LocatedAtoms {
  atoms: Atom[];
  totalMatches: number;
}

export function locateAtomMatches(atoms: Atom[], query: LocateQuery): LocatedAtoms {
  if (query.ref) {
    const atom = atoms.find((candidate) => candidate.ref === query.ref);
    return { atoms: atom ? [atom] : [], totalMatches: atom ? 1 : 0 };
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
  const totalMatches = matches.length;
  const limit = Math.max(1, Math.min(query.limit ?? MAX_LOCATE_MATCHES, MAX_LOCATE_MATCHES));
  return { atoms: matches.slice(0, limit), totalMatches };
}

export function locateAtoms(atoms: Atom[], query: LocateQuery): Atom[] {
  return locateAtomMatches(atoms, query).atoms;
}

function matchesSource(atom: Atom, source: NonNullable<LocateQuery["source"]>): boolean {
  if (source === "any") return true;
  if (source === "user") return atom.roles.includes("user");
  if (source === "assistant") return atom.roles.includes("assistant");
  if (source === "tool_result") return atom.roles.includes("toolResult");
  if (source === "tool_call") return atom.toolNames.length > 0 && atom.roles.includes("assistant");
  return false;
}

export function formatLocatedAtom(atom: Atom, detail: "brief" | "full" = "brief", pattern?: string): string {
  const protocol = atom.toolProtocol ? toolProtocolLabel(atom.toolProtocol) : atom.protocolClosed ? "closed" : "open";
  const flags = [atom.kind, atom.compressible ? "compressible" : "protected", protocol].join(", ");
  const text = detail === "full"
    ? atom.fullText.length <= 12_000 ? atom.fullText : truncateMiddle(atom.fullText, 12_000)
    : pattern
      ? excerptAround(atom.fullText, pattern, 700)
      : atom.preview;
  return [
    `${atom.ref} | position ${atom.index + 1} | ${flags}`,
    atom.toolNames.length ? `tools: ${atom.toolNames.join(", ")}` : "",
    text,
  ].filter(Boolean).join("\n");
}

function toolProtocolLabel(status: ToolProtocolStatus): string {
  if (status === "closed") return "closed tool protocol";
  if (status === "abandoned") return "abandoned exchange";
  if (status === "ambiguous") return "ambiguous tool protocol";
  return "orphan result";
}
