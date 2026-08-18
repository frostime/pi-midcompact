import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, ".test-dist/node_modules/@earendil-works");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(root, "test/mocks/pi-ai"), resolve(target, "pi-ai"), { recursive: true });
await cp(resolve(root, "test/mocks/pi-coding-agent"), resolve(target, "pi-coding-agent"), { recursive: true });
await cp(resolve(root, "test/mocks/pi-tui"), resolve(target, "pi-tui"), { recursive: true });

// Copy non-TS assets that the extension loads at runtime (e.g. HTML templates)
// into the test output tree so imports relative to the compiled JS resolve.
await cp(resolve(root, "src/review-webui.html"), resolve(root, ".test-dist/src/review-webui.html"));
