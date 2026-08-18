import http from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { Atom, DraftPlan, DraftTelemetry } from "./types.js";

const HTML_TEMPLATE = readFileSync(new URL("review-webui.html", import.meta.url), "utf8");

export interface ReviewState {
  atoms: Array<{
    ref: string;
    index: number;
    kind: string;
    preview: string;
    approxTokens: number;
    compressible: boolean;
    protocolClosed: boolean;
    toolNames: string[];
    roles: string[];
    compressedBlockId?: string;
    owningRangeId?: string;
    isRangeStart?: boolean;
    isRangeEnd?: boolean;
  }>;
  draft: {
    revision: number;
    ranges: Array<{
      id: string;
      startRef: string;
      endRef: string;
      topic?: string;
      summary: string;
      originalApproxTokens: number;
      compressedApproxTokens: number;
      atomCount: number;
    }>;
  };
  telemetry: DraftTelemetry;
}

export interface ReviewWebUiCallbacks {
  editSummary(draftId: string, summary: string): void;
  editTopic(draftId: string, topic: string): void;
  remove(draftId: string): void;
}



function owningRange(atomIndex: number, ranges: DraftPlan["ranges"]) {
  return ranges.find((r) => atomIndex >= r.startIndex && atomIndex <= r.endIndex);
}

export function serializeReviewState(atoms: Atom[], draft: DraftPlan, telemetry: DraftTelemetry): ReviewState {
  return {
    atoms: atoms.map((atom) => {
      const owner = owningRange(atom.index, draft.ranges);
      return {
        ref: atom.ref,
        index: atom.index,
        kind: atom.kind,
        preview: atom.preview,
        approxTokens: atom.approxTokens,
        compressible: atom.compressible,
        protocolClosed: atom.protocolClosed,
        toolNames: atom.toolNames,
        roles: atom.roles,
        compressedBlockId: atom.compressedBlockId,
        owningRangeId: owner?.id,
        isRangeStart: owner?.startIndex === atom.index,
        isRangeEnd: owner?.endIndex === atom.index,
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
        originalApproxTokens: range.originalApproxTokens,
        compressedApproxTokens: range.compressedApproxTokens,
        atomCount: range.endIndex - range.startIndex + 1,
      })),
    },
    telemetry,
  };
}

/**
 * Start a local HTTP server hosting the midcompact review page. Resolves when
 * the user closes the review (POST /api/close) or the server errors out.
 *
 * Edits are applied via callbacks that the caller wires to the same draft
 * mutation + append-entry path used by the TUI, so both surfaces stay consistent.
 */
export async function showReviewWebUi(
  ctx: ExtensionCommandContext,
  atoms: Atom[],
  getLatest: () => { draft: DraftPlan; telemetry: DraftTelemetry },
  callbacks: ReviewWebUiCallbacks,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      const sendJson = (code: number, body: unknown) => {
        const payload = JSON.stringify(body);
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      };
      const sendHtml = (html: string) => {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(html),
        });
        res.end(html);
      };

      const readBody = async (): Promise<string> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return Buffer.concat(chunks).toString("utf8");
      };

      try {
        if (req.method === "GET" && path === "/") {
          const { draft, telemetry } = getLatest();
          const stateJson = JSON.stringify(serializeReviewState(atoms, draft, telemetry)).replace(/</g, "\\u003c");
          // NOTE: function replacer — a string replacement would interpret `$&` / `$'` in the payload.
          sendHtml(HTML_TEMPLATE.replace("<!--MIDCOMPACT_STATE-->", () => stateJson));
          return;
        }
        if (req.method === "GET" && path === "/api/state") {
          const { draft, telemetry } = getLatest();
          sendJson(200, serializeReviewState(atoms, draft, telemetry));
          return;
        }
        if (req.method === "POST" && path === "/api/close") {
          sendJson(200, { ok: true });
          server.close();
          resolve();
          return;
        }
        const editMatch = path.match(/^\/api\/range\/([^/]+)\/(edit-summary|edit-topic|remove)$/);
        if (req.method === "POST" && editMatch) {
          const [, draftId, op] = editMatch;
          const current = getLatest().draft;
          const range = current.ranges.find((r) => r.id === draftId);
          if (!range) {
            sendJson(404, { error: `Unknown range ${draftId}` });
            return;
          }
          if (op === "remove") {
            callbacks.remove(draftId);
            const { draft, telemetry } = getLatest();
            sendJson(200, serializeReviewState(atoms, draft, telemetry));
            return;
          }
          readBody().then((raw) => {
            try {
              const parsed = JSON.parse(raw) as { value?: string };
              const value = typeof parsed.value === "string" ? parsed.value : "";
              if (op === "edit-summary") {
                if (!value.trim()) {
                  sendJson(400, { error: "summary must not be empty" });
                  return;
                }
                callbacks.editSummary(draftId, value.trim());
              } else {
                callbacks.editTopic(draftId, value.trim());
              }
              const { draft, telemetry } = getLatest();
              sendJson(200, serializeReviewState(atoms, draft, telemetry));
            } catch (err) {
              sendJson(400, { error: err instanceof Error ? err.message : String(err) });
            }
          });
          return;
        }
        sendJson(404, { error: "not found" });
      } catch (err) {
        sendJson(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.on("error", reject);
    // Bind loopback only; random port assigned by the OS.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      const token = randomBytes(3).toString("hex");
      ctx.ui.notify(`Midcompact review-webui ready: ${url} (token ${token})`, "info");
      tryOpenBrowser(url);
    });
  });
}

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* best-effort; ignore failures */ });
}
