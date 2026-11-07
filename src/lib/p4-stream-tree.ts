import type { P4StreamOption } from "@/types/p4";

export interface P4StreamRow { stream: P4StreamOption; depth: number; children: number }

/** Keep ancestor context while filtering and render incomplete server listings safely. */
export function streamRows(streams: P4StreamOption[], query: string, collapsed: ReadonlySet<string>): P4StreamRow[] {
  const byPath = new Map(streams.map((stream) => [stream.path, stream]));
  const children = new Map<string, P4StreamOption[]>();
  const sorted = [...byPath.values()].sort((a,b) => Number(b.kind === "mainline") - Number(a.kind === "mainline") || a.path.localeCompare(b.path));
  for (const stream of sorted) {
    if (stream.parent && stream.parent !== stream.path && byPath.has(stream.parent)) {
      const siblings = children.get(stream.parent) ?? []; siblings.push(stream); children.set(stream.parent,siblings);
    }
  }
  const needle = query.trim().toLowerCase();
  const visible = new Set<string>();
  if (needle) for (const stream of sorted) {
    if (!`${stream.path} ${stream.kind}`.toLowerCase().includes(needle)) continue;
    let node:P4StreamOption|undefined = stream;
    const chain = new Set<string>();
    while (node && !chain.has(node.path)) { chain.add(node.path); visible.add(node.path); node = byPath.get(node.parent ?? ""); }
  }
  const rows:P4StreamRow[] = [], seen = new Set<string>();
  function visit(start:P4StreamOption) {
    const stack = [{stream:start,depth:0}];
    while (stack.length) {
      const item = stack.pop()!;
      if (seen.has(item.stream.path) || (needle && !visible.has(item.stream.path))) continue;
      seen.add(item.stream.path);
      const descendants = children.get(item.stream.path) ?? [];
      rows.push({...item,children:descendants.length});
      if (!needle && collapsed.has(item.stream.path)) {
        const hidden = [...descendants];
        while(hidden.length) {const node=hidden.pop()!;if(seen.has(node.path))continue;seen.add(node.path);hidden.push(...children.get(node.path) ?? []);}
      } else for (const child of [...descendants].reverse()) stack.push({stream:child,depth:item.depth+1});
    }
  }
  for (const stream of sorted) if (!stream.parent || !byPath.has(stream.parent) || stream.parent === stream.path) visit(stream);
  // Cycles cannot be created by Perforce, but an incomplete or malformed listing must stay usable.
  for (const stream of sorted) if (!seen.has(stream.path)) visit(stream);
  return rows;
}

export function streamRelation(current:P4StreamOption|undefined, selected:P4StreamOption): "current"|"parent"|"child"|"other" {
  if (selected.path === current?.path) return "current";
  if (selected.path === current?.parent) return "parent";
  if (selected.parent === current?.path && current) return "child";
  return "other";
}
