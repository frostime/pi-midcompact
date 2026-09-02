// Behavioral DOM-stub smoke for src/review-webui.html (throwaway, tmp/).
// Upgraded from the render-only stub: can dispatch clicks on captured
// listeners, verifying R1 (ghead toggle), A2 (projected filters), F2 (pbar
// toggle), A4 (collapse seed) without a browser.
import { readFileSync } from "node:fs";

const SRC = new URL("../../../src/review-webui.html", import.meta.url);
const html = readFileSync(SRC, "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function makeEl() {
  const store = { value: "", checked: false, hidden: false, textContent: "", innerHTML: "", className: "" };
  const classes = new Set();
  const attrs = {};
  const listeners = {};
  const el = {
    dataset: {}, style: {},
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (n) => (classes.has(n) ? classes.delete(n) : classes.add(n)),
      contains: (n) => classes.has(n),
    },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    dispatch(type, target) { (listeners[type] ?? []).forEach((fn) => fn({ target, key: "" })); },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute: () => null,
    scrollIntoView() {}, focus() {},
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
  return new Proxy(el, {
    get(t, k) {
      if (k === "_listeners") return listeners;
      if (k === "_attrs") return attrs;
      if (k in store) return store[k];
      return t[k];
    },
    set(t, k, v) { if (k in store) { store[k] = v; return true; } t[k] = v; return true; },
  });
}

const ATOMS = [
  { ref: "a0001", index: 0, groupRef: "g0001", groupLabel: "phase", kind: "user", preview: "hello world", contentChars: 11, imageCount: 0, compressible: true, protocolClosed: true, toolNames: [], roles: [], narrowChars: 11, wideChars: 0, owningRangeId: "d1" },
  { ref: "a0002", index: 1, groupRef: "g0001", groupLabel: "phase", kind: "tool_exchange", preview: "read x", contentChars: 30000, imageCount: 2, compressible: true, protocolClosed: true, toolNames: ["read"], roles: [], narrowChars: 30000, wideChars: 0, owningRangeId: "d1" },
  { ref: "a0003", index: 2, groupRef: "g0001", groupLabel: "phase", kind: "tool_exchange", preview: "locked", contentChars: 500, imageCount: 0, compressible: false, protocolClosed: false, toolNames: [], roles: [], narrowChars: 500, wideChars: 0 },
  { ref: "a0004", index: 3, groupRef: "g0002", groupLabel: "phase two", kind: "assistant", preview: "more work", contentChars: 2000, imageCount: 0, compressible: true, protocolClosed: true, toolNames: [], roles: [], narrowChars: 2000, wideChars: 0, owningRangeId: "d2" },
];
const RANGES = [
  { id: "d1", startRef: "a0001", endRef: "a0002", topic: "t1", summary: "s1", originalContentChars: 30011, originalImageCount: 2, originalImagePayloadBytes: 10, replacementContentChars: 100, atomCount: 2 },
  { id: "d2", startRef: "a0004", endRef: "a0004", topic: "t2", summary: "", originalContentChars: 2000, originalImageCount: 0, originalImagePayloadBytes: 0, replacementContentChars: 0, atomCount: 1 },
];
const STATE = JSON.stringify({
  view: "REPLACE_VIEW", est: { narrowTokPerChar: [0.22, 0.3], wideTokPerChar: [0.5, 1.0], imageTok: [700, 1600] },
  atoms: ATOMS,
  draft: { revision: 3, ranges: RANGES },
  telemetry: { anchorUsage: { tokens: 160000, contextWindow: 200000, percent: 80 } },
});

function boot(view) {
  const els = {};
  const rawBtn = makeEl(); rawBtn.dataset.mode = "raw";
  const projBtn = makeEl(); projBtn.dataset.mode = "proj";
  const allBtn = makeEl(); allBtn.dataset.filter = "all";
  const compressedBtn = makeEl(); compressedBtn.dataset.filter = "range";
  const keptBtn = makeEl(); keptBtn.dataset.filter = "keep";
  const document = {
    getElementById: (id) => {
      els[id] ??= makeEl();
      if (id === "state") els[id].textContent = STATE.replace("REPLACE_VIEW", view);
      return els[id];
    },
    querySelector: () => makeEl(),
    querySelectorAll: (sel) => {
      if (sel === "#mode-seg [data-mode]") return [rawBtn, projBtn];
      if (sel === "#policy-seg [data-filter]") return [allBtn, compressedBtn, keptBtn];
      return [];
    },
    addEventListener() {},
    body: { classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, innerHTML: "" },
    documentElement: { getAttribute: () => "dark", setAttribute() {} },
  };
  const src = script;
  new Function("document", "EventSource", "sessionStorage", "localStorage", "navigator", "window", "fetch", src)(
    document,
    class { constructor() {} close() {} },
    { getItem: () => null, setItem() {} },
    { getItem: () => null, setItem() {} },
    { sendBeacon: () => true },
    { addEventListener() {} },
    async () => ({ ok: true, json: async () => ({}) }),
  );
  return { els, rawBtn, projBtn, allBtn, compressedBtn, keptBtn };
}

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok:", msg); };

// ---- review view ----
const { els, rawBtn, projBtn, allBtn, compressedBtn, keptBtn } = boot("review");
const strip = els["strip"].innerHTML, tl = els["timeline"].innerHTML, ed = els["editor"].innerHTML;
assert(strip.includes("after commit") && strip.includes("(est. ±"), "T1 decision strip + pbar rendered");
assert(tl.includes('data-group-key="d1"') && tl.includes("KEEP"), "T1 raw timeline has range group + KEEP group");
const hiddenCount = (tl.match(/class="gbody" hidden/g) || []).length;
assert(hiddenCount === 1 && tl.indexOf('data-group-key="d2"') < tl.indexOf('class="gbody" hidden'), "T5/A4 seed: d2 (unselected) starts collapsed, d1 open");

// close dialog: pending-only draft must still open the warning dialog (must-fix #1)
els["close"].dispatch("click", makeEl());
assert(els["close-dialog"].classList.contains("show") && els["close-warn"].hidden === false, "close dialog opens on pending-only draft with warning");
els["close-stay"].dispatch("click", makeEl());
assert(!els["close-dialog"].classList.contains("show"), "Stay hides close dialog");

// R1: clicking the KEEP ghead toggles gbody visibility
const gbody = makeEl(); gbody.hidden = false;
const groupStub = makeEl(); groupStub.querySelector = (sel) => (sel === ".gbody" ? gbody : null);
const ghead = makeEl(); ghead.dataset.toggle = "keep-0";
ghead.closest = (sel) => (sel === "[data-toggle]" ? ghead : sel === ".chev" ? null : sel === ".group" ? groupStub : null);
els["timeline"].dispatch("click", ghead);
assert(gbody.hidden === true && ghead._attrs["aria-expanded"] === "false", "R1 first ghead click collapses gbody");
els["timeline"].dispatch("click", ghead);
assert(gbody.hidden === false && ghead._attrs["aria-expanded"] === "true", "R1 second ghead click expands gbody");

// A2: projected mode applies policy + query
projBtn.dispatch("click", projBtn);
assert(els["timeline"].innerHTML.includes("pcard") && els["tl-stat"].textContent.includes("projected"), "A2 projected shows summary card");
assert(els["timeline"].innerHTML.includes("KEEP"), "A2 projected + policy=all keeps KEEP group");
compressedBtn.dispatch("click", compressedBtn);
assert(!els["timeline"].innerHTML.includes("KEEP") && els["timeline"].innerHTML.includes("pcard"), "A2 projected + policy=range hides KEEP group");
allBtn.dispatch("click", allBtn);
keptBtn.dispatch("click", keptBtn);
assert(!els["timeline"].innerHTML.includes("pcard") && els["timeline"].innerHTML.includes("KEEP"), "A2 projected + policy=keep shows only KEEP");
allBtn.dispatch("click", allBtn);
rawBtn.dispatch("click", rawBtn);
compressedBtn.dispatch("click", compressedBtn);
assert(!els["timeline"].innerHTML.includes("KEEP") && els["timeline"].innerHTML.includes('data-group-key="d1"'), "A2 raw + policy=range hides KEEP, keeps range");
allBtn.dispatch("click", allBtn);
assert(els["timeline"].innerHTML.includes("KEEP"), "A2 raw + policy=all restores KEEP");

// F2: clicking the projection bar toggles Raw/Projected
const pbarTarget = makeEl();
pbarTarget.closest = (sel) => (sel === "[data-toggle-mode]" ? pbarTarget : null);
els["strip"].dispatch("click", pbarTarget);
assert(els["timeline"].innerHTML.includes("pcard"), "F2 pbar click switches to Projected");
els["strip"].dispatch("click", pbarTarget);
assert(!els["timeline"].innerHTML.includes("pcard") && els["timeline"].innerHTML.includes("KEEP"), "F2 pbar click switches back to Raw");

// ---- selection view ----
const sel = boot("selection");
assert(sel.els["timeline"].innerHTML.length > 0 && sel.els["editor"].innerHTML.includes("Save selection"), "selection view renders");
assert(sel.els["saved-badge"].hidden === false && sel.els["saved-badge"].textContent.includes("Saved · v"), "F2/saved chip shows on selection with saved draft");
assert(els["saved-badge"].hidden === true, "saved chip hidden in review view");

// tool/role tags restored on raw atom rows
assert(els["timeline"].innerHTML.includes("tag tool read"), "F3/tool tags render on atom rows");

// dead-session: keyboard locked too (controls disabled on markDead)
assert(html.includes("querySelectorAll('input, textarea, button, select')"), "dead session disables form controls");

// mobile srow grid override present
assert(html.includes(".atom.srow .mark { grid-column: 1 / -1; }"), "mobile srow grid override present");

// F1: strengthened selected-atom styling present in CSS
assert(html.includes("outline: 2px solid var(--sel-border)") && html.includes("box-shadow: inset 3px 0 0 var(--sel-border)"), "F1 selected-atom styling strengthened");

console.log("ALL SMOKE CHECKS PASSED");
