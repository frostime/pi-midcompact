// Sole owner of message content statistics. Factual char/image counts are the
// authority; the only token conversion allowed is the explicitly scoped,
// display-level estimator at the bottom of this file (web UI presentation
// only — it never gates decisions, commits, or range validity). Image base64
// never contributes to text char counts.

import type { ContentMetrics, ImageFact, MessageLike } from "./types.js";

/** Count Unicode code points of a string. */
export function codePointCount(text: string): number {
  let count = 0;
  // for..of iterates by code point, not UTF-16 code unit.
  for (const _ of text) count += 1;
  return count;
}

/** Decode a base64 string into a Uint8Array without depending on Node Buffer. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Best-effort pixel dimension read from decoded image bytes. Returns undefined on failure. */
export function readImageDimensions(bytes: Uint8Array): { width?: number; height?: number } {
  if (bytes.length < 8) return {};
  // PNG: 89 50 4E 47 0D 0A 1A 0A; width/height are big-endian at offsets 16/20.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 24) return {};
    const view = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
    return { width: view.getUint32(0), height: view.getUint32(4) };
  }
  // GIF: 47 49 46 38; width/height little-endian at offsets 6/8.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
  }
  // JPEG: scan SOF0 (0xFFC0) segment for dimensions.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === undefined) break;
      // SOF0..SOF15 carry dimensions; skip DHT (0xC4) and the reserved JPG marker (0xC8).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
        const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
        const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
        return { width, height };
      }
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      i += 2 + len;
      continue;
    }
    return {};
  }
  // WebP: RIFF....WEBP; VP8/VP8L/VP8X variants.
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunk = (bytes[12]! << 16) | (bytes[13]! << 8) | bytes[14]!;
    if (chunk === 0x56503820) { // "VP8 "
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 0x56503858) { // "VP8X"
      const w = 1 + (view.getUint32(24, true) >>> 0);
      return { width: w & 0xffffff, height: view.getUint32(27, true) & 0xffffff };
    }
    return {};
  }
  return {};
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

interface PartLike {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
  id?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Measure the content parts of a message (its `content` field). Image parts are
 * recorded as ImageFacts and never contribute to contentChars.
 */
export function measureContentParts(content: unknown, startIndex = 0): ContentMetrics {
  if (typeof content === "string") {
    return { contentChars: codePointCount(content), imageCount: 0, images: [] };
  }
  if (!Array.isArray(content)) return { contentChars: 0, imageCount: 0, images: [] };

  let contentChars = 0;
  const images: ImageFact[] = [];
  let imageIndex = 0;

  for (const raw of content) {
    if (!isObject(raw)) continue;
    const part = raw as PartLike;
    if (part.type === "text" && typeof part.text === "string") {
      contentChars += codePointCount(part.text);
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      contentChars += codePointCount(part.thinking);
    } else if (part.type === "toolCall") {
      if (typeof part.name === "string") contentChars += codePointCount(part.name);
      // Normalized arguments representation; id is metadata and not counted.
      contentChars += codePointCount(safeJson(part.arguments));
    } else if (part.type === "image") {
      const mimeType = typeof part.mimeType === "string" ? part.mimeType : "application/octet-stream";
      const data = typeof part.data === "string" ? part.data : "";
      let payloadBytes = 0;
      let dimensions: { width?: number; height?: number } = {};
      if (data.length > 0) {
        try {
          const bytes = decodeBase64(data);
          payloadBytes = bytes.length;
          dimensions = readImageDimensions(bytes);
        } catch {
          payloadBytes = 0;
        }
      }
      images.push({
        index: startIndex + imageIndex,
        mimeType,
        payloadBytes,
        ...(dimensions.width !== undefined ? { width: dimensions.width } : {}),
        ...(dimensions.height !== undefined ? { height: dimensions.height } : {}),
      });
      imageIndex += 1;
    }
  }

  return { contentChars, imageCount: images.length, images };
}

/**
 * Measure a single message, including role-specific content fields
 * (bash command/output, custom summary). Image payload bytes are never added to
 * contentChars.
 */
export function measureMessage(message: MessageLike): ContentMetrics {
  const base = measureContentParts(message.content);
  let contentChars = base.contentChars;
  const images = [...base.images];

  if (message.role === "bashExecution") {
    if (typeof message.command === "string") contentChars += codePointCount(message.command);
    if (typeof message.output === "string") contentChars += codePointCount(message.output);
  }
  if (message.role === "custom" && typeof message.summary === "string") {
    contentChars += codePointCount(message.summary);
  }

  return { contentChars, imageCount: images.length, images };
}

/** Re-index images sequentially across the aggregated list. */
export function aggregateMetrics(parts: readonly ContentMetrics[]): ContentMetrics {
  let contentChars = 0;
  let imageCount = 0;
  const images: ImageFact[] = [];
  for (const part of parts) {
    contentChars += part.contentChars;
    imageCount += part.imageCount;
    for (const image of part.images) {
      images.push({ ...image, index: images.length });
    }
  }
  return { contentChars, imageCount, images };
}

// ---- Display-level token estimation (web UI presentation only) ----
//
// The web UI shows a projected post-commit usage band. Because the consumer
// model is provider-dependent, tokens are estimated from char classes with a
// documented assumption table instead of a real tokenizer: the [low, high]
// pairs express published tokenizer spread and are propagated as a band, never
// collapsed into a single authoritative number. The band is derived from the
// content mix of the atoms involved (ASCII-heavy content lands near the tight
// end, CJK-heavy near the wide end). Nothing here feeds commit gating, range
// validation, or any decision.

/** Per-char-class token-cost assumptions: [low, high] tokens per char. */
export const TOKEN_ESTIMATE = {
  /** ASCII/code: roughly 3.3–4.5 chars per token across common tokenizers. */
  narrowTokPerChar: [0.22, 0.3],
  /** Non-ASCII scripts (CJK, kana, hangul, emoji, …): the dominant spread. */
  wideTokPerChar: [0.5, 1.0],
  /** Images: provider- and resolution-dependent flat allowance. */
  imageTok: [700, 1600],
} as const;

/** Char classes the estimator distinguishes. */
export interface CharMix {
  /** ASCII code points. */
  narrowChars: number;
  /** Everything non-ASCII (counted conservatively at the wide rate). */
  wideChars: number;
}

// Classification is deliberately coarse: ASCII is estimated at the narrow
// rate; every non-ASCII code point (CJK, kana, hangul, emoji, Cyrillic, …) is
// counted at the wide rate, which is the conservative side for CJK-heavy
// content and keeps the table honest without per-script modeling.

/** Split a text into narrow (ASCII) and wide (everything else) code points. */
export function charClassCounts(text: string): CharMix {
  let narrowChars = 0;
  let wideChars = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) {
      narrowChars += 1;
      continue;
    }
    wideChars += 1;
  }
  return { narrowChars, wideChars };
}

export interface TokenEstimate {
  point: number;
  low: number;
  high: number;
}

/** Estimate tokens for a char mix plus images, as a propagated band. */
export function estimateTokens(mix: CharMix, imageCount: number): TokenEstimate {
  const [aLo, aHi] = TOKEN_ESTIMATE.narrowTokPerChar;
  const [cLo, cHi] = TOKEN_ESTIMATE.wideTokPerChar;
  const [iLo, iHi] = TOKEN_ESTIMATE.imageTok;
  const mid = (lo: number, hi: number) => (lo + hi) / 2;
  return {
    point: Math.round(mix.narrowChars * mid(aLo, aHi)
      + mix.wideChars * mid(cLo, cHi)
      + imageCount * mid(iLo, iHi)),
    low: Math.round(mix.narrowChars * aLo + mix.wideChars * cLo + imageCount * iLo),
    high: Math.round(mix.narrowChars * aHi + mix.wideChars * cHi + imageCount * iHi),
  };
}
