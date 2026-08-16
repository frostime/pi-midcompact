export function buildSessionContext(entries, leafId, byId = new Map(entries.map(e => [e.id, e]))) {
  const branch = [];
  let current = leafId ? byId.get(leafId) : undefined;
  while (current) {
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  branch.reverse();
  return { messages: branch.filter(e => e.type === "message").map(e => structuredClone(e.message)) };
}
