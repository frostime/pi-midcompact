// Pure selection core. A requested span may cross KEEP/protected atoms; this
// module subtracts those nodes and returns sorted, non-overlapping ordinary
// spans that contain no protected atom. It does not create summaries, append
// session entries, or know whether the caller is TUI, Web, or Agent.

import { isProtectedAtom } from "./atoms.js";
import type { Atom, OrdinarySpan, SelectionSpan } from "./types.js";

export interface SelectionInput {
  /** Requested spans. May cross KEEP/protected atoms. */
  spans: SelectionSpan[];
  /** Atom refs marked KEEP inside the spans. */
  keepRefs: string[];
}

export interface SelectionResult {
  spans: OrdinarySpan[];
}

export class SelectionError extends Error {}

function refIndex(atoms: readonly Atom[], ref: string): number {
  const idx = atoms.findIndex((atom) => atom.ref === ref);
  if (idx < 0) throw new SelectionError(`Unknown atom ref ${ref}.`);
  return idx;
}

/**
 * Expand a requested selection into ordinary spans.
 *
 * - Rejects unknown refs, reversed or empty spans.
 * - Rejects a requested span that consists entirely of protected atoms
 *   (compressing a protected atom directly is not allowed).
 * - Subtracts KEEP and protected atoms from each span, splitting it into
 *   contiguous ordinary fragments.
 * - Merges adjacent fragments across spans and drops empty ones.
 * - Output is sorted by start index, non-overlapping, and contains no
 *   protected atom.
 */
export function expandSelection(atoms: readonly Atom[], input: SelectionInput): SelectionResult {
  if (input.spans.length === 0) return { spans: [] };

  const keepSet = new Set(input.keepRefs);

  // Resolve and normalize requested spans to [start,end] inclusive index ranges.
  const requested: Array<{ start: number; end: number }> = [];
  for (const span of input.spans) {
    const start = refIndex(atoms, span.startRef);
    const end = refIndex(atoms, span.endRef);
    if (start > end) throw new SelectionError(`Span ${span.startRef}→${span.endRef} is reversed.`);
    requested.push({ start, end });
  }
  requested.sort((a, b) => a.start - b.start);

  const ordinaryIndices: number[] = [];
  for (const range of requested) {
    let anyProtected = false;
    let anyOrdinary = false;
    for (let i = range.start; i <= range.end; i += 1) {
      const atom = atoms[i];
      if (!atom) continue;
      if (isProtectedAtom(atom)) {
        anyProtected = true;
        continue;
      }
      if (keepSet.has(atom.ref)) continue;
      ordinaryIndices.push(i);
      anyOrdinary = true;
    }
    if (!anyOrdinary && anyProtected) {
      const ref = atoms[range.start]!.ref;
      throw new SelectionError(`Cannot compress protected atom ${ref}; split around it or drop it.`);
    }
  }

  // Group ordinary indices into contiguous runs.
  ordinaryIndices.sort((a, b) => a - b);
  const runs: Array<{ start: number; end: number }> = [];
  for (const idx of ordinaryIndices) {
    const last = runs[runs.length - 1];
    if (last && idx === last.end + 1) {
      last.end = idx;
    } else {
      runs.push({ start: idx, end: idx });
    }
  }

  const spans: OrdinarySpan[] = runs.map((run) => ({
    startRef: atoms[run.start]!.ref,
    endRef: atoms[run.end]!.ref,
    startIndex: run.start,
    endIndex: run.end,
  }));
  return { spans };
}
