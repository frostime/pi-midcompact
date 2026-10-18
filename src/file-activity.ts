// Historical call index only: never inspect the filesystem or infer success.
import { toolCalls } from "./messages.js";
import type { Atom, FileActivity } from "./types.js";

export function extractFileActivity(atoms: readonly Atom[]): FileActivity {
  const readPaths = new Set<string>();
  const writePaths = new Set<string>();

  function record(name: string, args: unknown): void {
    if (!args || typeof args !== "object") return;
    const path = (args as Record<string, unknown>).path;
    if (typeof path !== "string" || path.length === 0) return;
    if (name === "read") readPaths.add(path);
    else if (name === "write" || name === "edit") writePaths.add(path);
  }

  for (const atom of atoms) {
    for (const { message } of atom.messages) {
      for (const call of toolCalls(message)) record(call.name, call.arguments);
      if (message.role === "toolResult") {
        for (const call of message.nestedCalls?.calls ?? []) record(call.name, call.arguments);
      }
    }
  }
  return { readPaths: [...readPaths].sort(), writePaths: [...writePaths].sort() };
}

export function isFileActivity(value: unknown): value is FileActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Record<string, unknown>;
  return Array.isArray(activity.readPaths) && activity.readPaths.every((path) => typeof path === "string")
    && Array.isArray(activity.writePaths) && activity.writePaths.every((path) => typeof path === "string");
}

export function formatFileActivity(activity?: FileActivity): string {
  if (!activity || (!activity.readPaths.length && !activity.writePaths.length)) return "";
  const lines = [
    "### File activity (automatic; recorded calls, not verified outcomes)",
    "Only read/write/edit and recorded nested calls; not a complete file audit. Paths are JSON strings.",
  ];
  if (activity.readPaths.length) {
    lines.push("Read calls:", ...activity.readPaths.map((path) => `- ${JSON.stringify(path)}`));
  }
  if (activity.writePaths.length) {
    lines.push("Write/edit calls:", ...activity.writePaths.map((path) => `- ${JSON.stringify(path)}`));
  }
  return lines.join("\n");
}
