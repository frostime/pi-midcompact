import http from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { TOKEN_ESTIMATE, charClassCounts } from "./content-metrics.js";
import type { Atom, DraftPlan, DraftTelemetry, SelectionSpan } from "./types.js";

const HTML_TEMPLATE = readFileSync(new URL("review-webui.html", import.meta.url), "utf8");

export type ReviewWebUiView = "review" | "selection";

export interface ReviewState {
  view: ReviewWebUiView;
  /** Char-class token-cost assumption table shared with the page (see content-metrics). */
  est: {
    readonly narrowTokPerChar: readonly [number, number];
    readonly wideTokPerChar: readonly [number, number];
    readonly imageTok: readonly [number, number];
  };
  atoms: Array<{
    ref: string;
    index: number;
    groupRef: string;
    groupLabel: string;
    kind: string;
    preview: string;
    contentChars: number;
    imageCount: number;
    imagePayloadBytes: number;
    compressible: boolean;
    protocolClosed: boolean;
    toolNames: string[];
    roles: string[];
    compressedBlockId?: string;
    owningRangeId?: string;
    isRangeStart?: boolean;
    isRangeEnd?: boolean;
    /** Char-class counts over the atom's full text; display-level estimation input. */
    narrowChars: number;
    wideChars: number;
  }>;
  draft: {
    revision: number;
    ranges: Array<{
      id: string;
      startRef: string;
      endRef: string;
      topic?: string;
      summary: string;
      originalContentChars: number;
      originalImageCount: number;
      originalImagePayloadBytes: number;
      replacementContentChars: number;
      atomCount: number;
    }>;
  };
  telemetry: DraftTelemetry;
}

export interface ReviewWebUiCallbacks {
  applySelection?(spans: SelectionSpan[], keepRefs: string[]): void;
  editSummary(draftId: string, summary: string): void;
  editTopic(draftId: string, topic: string): void;
  remove(draftId: string): void;
}

export interface ReviewWebUiRuntimeOptions {
  /** Test seam; production opens the system browser. */
  openBrowser?: (url: string) => void;
  /** Release the UI when no page establishes its liveness stream. */
  livenessConnectTimeoutMs?: number;
  /** Server-originated keepalive interval for detecting a disappeared page. */
  livenessPingIntervalMs?: number;
}

function owningRange(atomIndex: number, ranges: DraftPlan["ranges"]) {
  return ranges.find((range) => atomIndex >= range.startIndex && atomIndex <= range.endIndex);
}

function groupMeta(atoms: readonly Atom[]): Map<number, { ref: string; label: string }> {
  let groupNumber = 0;
  let seenUser = false;
  const result = new Map<number, { ref: string; label: string }>();
  atoms.forEach((atom, index) => {
    if (atom.kind === "user") {
      groupNumber += 1;
      seenUser = true;
    }
    const ref = seenUser ? `g${String(groupNumber).padStart(4, "0")}` : "g0000";
    const label = seenUser && atom.kind === "user" ? firstLine(atom.preview, 72) : seenUser ? `group ${ref}` : "context before first user message";
    result.set(index, { ref, label });
  });
  return result;
}

function firstLine(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}...`;
}

export function serializeReviewState(
  atoms: Atom[],
  draft: DraftPlan,
  telemetry: DraftTelemetry,
  view: ReviewWebUiView = "review",
): ReviewState {
  const groups = groupMeta(atoms);
  return {
    view,
    est: TOKEN_ESTIMATE,
    atoms: atoms.map((atom) => {
      const owner = owningRange(atom.index, draft.ranges);
      const group = groups.get(atom.index)!;
      const mix = charClassCounts(atom.fullText);
      return {
        ref: atom.ref,
        index: atom.index,
        groupRef: group.ref,
        groupLabel: group.label,
        kind: atom.kind,
        preview: atom.preview,
        contentChars: atom.metrics.contentChars,
        imageCount: atom.metrics.imageCount,
        imagePayloadBytes: atom.metrics.images.reduce((sum, image) => sum + image.payloadBytes, 0),
        compressible: atom.compressible,
        protocolClosed: atom.protocolClosed,
        toolNames: atom.toolNames,
        roles: atom.roles,
        compressedBlockId: atom.compressedBlockId,
        owningRangeId: owner?.id,
        isRangeStart: owner?.startIndex === atom.index,
        isRangeEnd: owner?.endIndex === atom.index,
        narrowChars: mix.narrowChars,
        wideChars: mix.wideChars,
      };
    }),
    draft: {
      revision: draft.revision,
      ranges: draft.ranges.map((range) => ({
        id: range.id,
        startRef: range.startRef,
        endRef: range.endRef,
        topic: range.topic,
        summary: range.summary,
        originalContentChars: range.originalContentChars,
        originalImageCount: range.originalImageCount,
        originalImagePayloadBytes: range.originalImagePayloadBytes,
        replacementContentChars: range.replacementContentChars,
        atomCount: range.endIndex - range.startIndex + 1,
      })),
    },
    telemetry,
  };
}

/** Serve the shared Review/Selection workbench over loopback HTTP. */
export async function showReviewWebUi(
  ctx: ExtensionCommandContext,
  atoms: Atom[],
  getLatest: () => { draft: DraftPlan; telemetry: DraftTelemetry },
  callbacks: ReviewWebUiCallbacks,
  view: ReviewWebUiView = "review",
  runtime: ReviewWebUiRuntimeOptions = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const connectTimeoutMs = runtime.livenessConnectTimeoutMs ?? 30_000;
    const pingIntervalMs = runtime.livenessPingIntervalMs ?? 10_000;
    let settled = false;
    let closing = false;
    let livenessResponse: http.ServerResponse | undefined;
    let connectTimer: NodeJS.Timeout | undefined;
    let pingTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (pingTimer) clearInterval(pingTimer);
      connectTimer = undefined;
      pingTimer = undefined;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const sendJson = (code: number, body: unknown) => {
        const payload = JSON.stringify(body);
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
      };
      const sendHtml = (html: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
        res.end(html);
      };
      const readBody = async (): Promise<string> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks).toString("utf8");
      };
      const currentState = () => {
        const latest = getLatest();
        return serializeReviewState(atoms, latest.draft, latest.telemetry, view);
      };

      try {
        if (req.method === "GET" && path === "/api/liveness") {
          if (livenessResponse && !livenessResponse.writableEnded) livenessResponse.end();
          livenessResponse = res;
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          if (pingTimer) clearInterval(pingTimer);
          pingTimer = setInterval(() => {
            if (!res.writableEnded) res.write(": keepalive\n\n");
          }, pingIntervalMs);
          req.on("close", () => {
            if (livenessResponse === res) {
              livenessResponse = undefined;
              closeServer();
            }
          });
          return;
        }
        if (req.method === "GET" && path === "/") {
          const stateJson = JSON.stringify(currentState()).replace(/</g, "\\u003c");
          sendHtml(HTML_TEMPLATE.replace("<!--MIDCOMPACT_STATE-->", () => stateJson));
          return;
        }
        if (req.method === "GET" && path === "/api/state") {
          sendJson(200, currentState());
          return;
        }
        const atomMatch = path.match(/^\/api\/atom\/([^/]+)$/);
        if (req.method === "GET" && atomMatch) {
          const atom = atoms.find((a) => a.ref === decodeURIComponent(atomMatch[1]!));
          if (!atom) {
            sendJson(404, { error: `Unknown atom ${atomMatch[1]}` });
            return;
          }
          sendJson(200, {
            ref: atom.ref,
            kind: atom.kind,
            contentChars: atom.metrics.contentChars,
            imageCount: atom.metrics.imageCount,
            fullText: atom.fullText,
          });
          return;
        }
        if (req.method === "POST" && path === "/api/close") {
          sendJson(200, { ok: true });
          closeServer();
          return;
        }
        if (req.method === "POST" && path === "/api/selection") {
          if (view !== "selection" || !callbacks.applySelection) {
            sendJson(409, { error: "Selection is not available in this view." });
            return;
          }
          const parsed = JSON.parse(await readBody()) as { spans?: SelectionSpan[]; keepRefs?: string[] };
          if (!Array.isArray(parsed.spans) || !Array.isArray(parsed.keepRefs)) {
            sendJson(400, { error: "Selection requires spans and keepRefs arrays." });
            return;
          }
          callbacks.applySelection(parsed.spans, parsed.keepRefs);
          sendJson(200, currentState());
          return;
        }
        const editMatch = path.match(/^\/api\/range\/([^/]+)\/(edit-summary|edit-topic|remove)$/);
        if (req.method === "POST" && editMatch) {
          const [, draftId, operation] = editMatch;
          if (view === "selection" && operation !== "remove") {
            sendJson(409, { error: "Summary and topic editing belong to Review." });
            return;
          }
          const current = getLatest().draft;
          if (!current.ranges.some((range) => range.id === draftId)) {
            sendJson(404, { error: `Unknown range ${draftId}` });
            return;
          }
          if (operation === "remove") {
            callbacks.remove(draftId);
            sendJson(200, currentState());
            return;
          }
          const parsed = JSON.parse(await readBody()) as { value?: string };
          const value = typeof parsed.value === "string" ? parsed.value.trim() : "";
          if (operation === "edit-summary") {
            if (!value) {
              sendJson(400, { error: "summary must not be empty" });
              return;
            }
            callbacks.editSummary(draftId, value);
          } else callbacks.editTopic(draftId, value);
          sendJson(200, currentState());
          return;
        }
        sendJson(404, { error: "not found" });
      } catch (error) {
        sendJson(400, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    const closeServer = () => {
      if (closing || settled) return;
      closing = true;
      clearTimers();
      if (livenessResponse && !livenessResponse.writableEnded) livenessResponse.end();
      livenessResponse = undefined;
      server.close(finish);
    };

    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}/?view=${view}`;
      const token = randomBytes(3).toString("hex");
      ctx.ui.notify(`Midcompact ${view} webui ready: ${url} (token ${token})`, "info");
      connectTimer = setTimeout(closeServer, connectTimeoutMs);
      (runtime.openBrowser ?? tryOpenBrowser)(url);
    });
  });
}

function tryOpenBrowser(url: string): void {
  const command = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, () => { /* best-effort */ });
}
