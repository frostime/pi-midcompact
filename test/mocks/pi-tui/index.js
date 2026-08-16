export const Key = {
  escape: "escape", enter: "enter", right: "right", left: "left", up: "up", down: "down",
  pageUp: "pageUp", pageDown: "pageDown", home: "home", end: "end"
};
export function matchesKey(data, key) { return data === key; }
export function truncateToWidth(text, width, ellipsis = "…") {
  if (text.length <= width) return text;
  return text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
}
export function wrapTextWithAnsi(text, width) {
  if (!text) return [""];
  const out = [];
  for (const raw of text.split("\n")) {
    if (!raw.length) { out.push(""); continue; }
    for (let i = 0; i < raw.length; i += Math.max(1, width)) out.push(raw.slice(i, i + Math.max(1, width)));
  }
  return out;
}
export class Text {
  constructor(text = "") { this.text = text; }
  render() { return String(this.text).split("\n"); }
  invalidate() {}
}
export class Box {
  constructor() { this.children = []; }
  addChild(child) { this.children.push(child); }
  render(width) { return this.children.flatMap(c => c.render(width)); }
  invalidate() { for (const c of this.children) c.invalidate?.(); }
}
