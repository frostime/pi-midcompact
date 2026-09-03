import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { removeDraftRange, replaceDraftRanges, updateDraftRange } from "../src/plan.js";
import { expandSelection } from "../src/selection.js";
import { draftTelemetry } from "../src/telemetry.js";
import {
  startReviewWebUiServer,
  type ReviewWebUiServerHandle,
} from "../src/review-webui.js";
import type { SelectionSpan } from "../src/types.js";
import {
  PREVIEW_FIXTURE_NAMES,
  createReviewWebUiFixture,
  type ReviewWebUiFixture,
  type PreviewFixtureName,
} from "./review-webui-fixtures.js";

const SOURCE_DIRECTORY = new URL("../src/", import.meta.url);
const HTML_FILENAME = "review-webui.html";
const HTML_PATH = new URL(HTML_FILENAME, SOURCE_DIRECTORY);
const DEFAULT_PORT = 4173;

interface FixtureHost {
  fixture: ReviewWebUiFixture;
  server: ReviewWebUiServerHandle;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const routerUrl = `http://127.0.0.1:${args.port}/`;
  const reloadUrl = `${routerUrl}events`;
  const reload = createReloadChannel();
  const fixtureHosts: FixtureHost[] = [];
  let router: RouterServer | undefined;

  try {
    for (const name of PREVIEW_FIXTURE_NAMES) {
      fixtureHosts.push(await startFixtureHost(name, reloadUrl, routerUrl));
    }
    router = await startRouterServer(args.port, fixtureHosts, reload);
  } catch (error) {
    reload.close();
    await Promise.allSettled([
      ...fixtureHosts.map((host) => host.server.close()),
      ...(router ? [router.close()] : []),
    ]);
    throw error;
  }

  let reloadTimer: NodeJS.Timeout | undefined;
  const htmlWatcher = watch(SOURCE_DIRECTORY, (_event, filename) => {
    if (String(filename) !== HTML_FILENAME) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload.broadcast(), 60);
  });

  console.log(`Midcompact Web UI fixture router: ${router.url}`);
  console.log(`${fixtureHosts.length} isolated in-memory fixtures are ready.`);
  console.log("HTML changes reload automatically; TypeScript changes restart through tsx watch.");
  if (args.open) openBrowser(router.url);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    htmlWatcher.close();
    if (reloadTimer) clearTimeout(reloadTimer);
    reload.close();
    await Promise.all([
      ...fixtureHosts.map((host) => host.server.close()),
      router.close(),
    ]);
  };

  try {
    await Promise.race([
      waitForSignal(),
      router.closed,
      ...fixtureHosts.map((host) => host.server.closed),
    ]);
  } finally {
    await stop();
  }
}

async function startFixtureHost(name: PreviewFixtureName, reloadUrl: string, routerUrl: string): Promise<FixtureHost> {
  const fixture = createReviewWebUiFixture(name);
  const memory = { draft: fixture.draft };
  const server = await startReviewWebUiServer(
    fixture.atoms,
    () => ({
      draft: memory.draft,
      telemetry: draftTelemetry(fixture.transaction, memory.draft),
    }),
    {
      applySelection: (spans: SelectionSpan[], keepRefs: string[]) => {
        const normalized = expandSelection(fixture.atoms, { spans, keepRefs });
        memory.draft = replaceDraftRanges(memory.draft, fixture.atoms, normalized.spans);
      },
      editSummary: (id: string, summary: string) => {
        memory.draft = updateDraftRange(memory.draft, id, { summary });
      },
      editTopic: (id: string, topic: string) => {
        memory.draft = updateDraftRange(memory.draft, id, { topic });
      },
      remove: (id: string) => {
        memory.draft = removeDraftRange(memory.draft, id);
      },
    },
    fixture.view,
    {
      lifecycle: "persistent",
      htmlTemplate: () => injectReloadClient(readFileSync(HTML_PATH, "utf8"), reloadUrl, routerUrl),
    },
  );
  return { fixture, server };
}

interface PreviewArguments {
  port: number;
  open: boolean;
}

function parseArguments(argv: string[]): PreviewArguments {
  let port = DEFAULT_PORT;
  let open = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--no-open") open = false;
    else if (arg === "--port") port = Number(argv[++index]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else throw new Error(`Unknown argument "${arg}". Use only --port or --no-open.`);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  return { port, open };
}

interface ReloadChannel {
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  broadcast(): void;
  close(): void;
}

function createReloadChannel(): ReloadChannel {
  const clients = new Set<http.ServerResponse>();
  const bootId = randomBytes(8).toString("hex");
  return {
    handle: (req, res) => {
      if (req.url !== "/events") return false;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "access-control-allow-origin": "*",
        connection: "keep-alive",
      });
      clients.add(res);
      res.write(`event: hello\ndata: ${bootId}\n\n`);
      req.on("close", () => clients.delete(res));
      return true;
    },
    broadcast: () => {
      for (const client of clients) client.write(`event: reload\ndata: ${Date.now()}\n\n`);
    },
    close: () => {
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

interface RouterServer {
  url: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

async function startRouterServer(port: number, fixtures: FixtureHost[], reload: ReloadChannel): Promise<RouterServer> {
  const routerUrl = `http://127.0.0.1:${port}/`;
  const html = fixtureRouterHtml(fixtures, `${routerUrl}events`, routerUrl);
  const server = http.createServer((req, res) => {
    if (reload.handle(req, res)) return;
    if (req.url === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (req.url !== "/") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-store",
    });
    res.end(html);
  });
  await listen(server, port);

  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  server.once("close", resolveClosed);
  server.once("error", rejectClosed);
  let closing = false;

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    closed,
    close: () => {
      if (!closing) {
        closing = true;
        server.close((error) => error ? rejectClosed(error) : resolveClosed());
      }
      return closed;
    },
  };
}

function fixtureRouterHtml(fixtures: FixtureHost[], reloadUrl: string, routerUrl: string): string {
  const links = fixtures.map(({ fixture, server }) => `
    <a class="fixture" href="${escapeHtml(server.url)}" target="_blank" rel="noopener">
      <span class="fixture-name">${escapeHtml(fixture.name)}</span>
      <span class="fixture-view">${escapeHtml(fixture.view)}</span>
      <span class="fixture-description">${escapeHtml(fixture.description)}</span>
    </a>`).join("");
  return injectReloadClient(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Midcompact Web UI Fixtures</title>
<style>
  :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f4f4f5; color: #18181b; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #f4f4f5; }
  main { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
  header { margin-bottom: 24px; }
  h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: 0; }
  p { margin: 0; color: #71717a; font-size: 14px; }
  nav { display: grid; gap: 8px; }
  .fixture { display: grid; grid-template-columns: minmax(150px, auto) 80px 1fr; gap: 16px; align-items: center; min-height: 68px; padding: 14px 16px; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; color: inherit; text-decoration: none; }
  .fixture:hover { border-color: #18181b; background: #fafafa; }
  .fixture-name { font: 600 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
  .fixture-view { color: #52525b; font-size: 12px; text-transform: uppercase; }
  .fixture-description { color: #52525b; font-size: 13px; line-height: 1.45; }
  @media (prefers-color-scheme: dark) {
    :root, body { background: #18181b; color: #f4f4f5; }
    p { color: #a1a1aa; }
    .fixture { background: #27272a; border-color: #3f3f46; }
    .fixture:hover { background: #303033; border-color: #d4d4d8; }
    .fixture-view, .fixture-description { color: #a1a1aa; }
  }
  @media (max-width: 620px) {
    main { padding: 28px 0; }
    .fixture { grid-template-columns: 1fr auto; gap: 6px 12px; }
    .fixture-description { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Midcompact Web UI Fixtures</h1>
    <p>Open an isolated in-memory scenario. Each fixture keeps its own draft state.</p>
  </header>
  <nav aria-label="Available fixtures">${links}
  </nav>
</main>
</body>
</html>`, reloadUrl, routerUrl);
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function injectReloadClient(html: string, reloadUrl: string, restartUrl: string): string {
  const script = `<script>
(() => {
  const source = new EventSource(${JSON.stringify(reloadUrl)});
  const key = 'midcompact:dev-server';
  source.addEventListener('hello', event => {
    const previous = sessionStorage.getItem(key);
    sessionStorage.setItem(key, event.data);
    if (previous && previous !== event.data) location.replace(${JSON.stringify(restartUrl)});
  });
  source.addEventListener('reload', () => location.reload());
})();
</script>`;
  return html.replace("</body>", `${script}\n</body>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, () => { /* best-effort */ });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
