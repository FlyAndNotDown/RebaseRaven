import { createContext, useContext, useState, type ReactNode } from "react";
import type { FileTreeEntry } from "@/components/file-tree";
import type { P4Connection } from "@/types/p4";

export type P4TreeEntry = FileTreeEntry & { ruleIgnored: boolean; p4Status: string };
type Snapshot = { entries: Record<string, P4TreeEntry[]>; open: string[]; epoch: number };
type Trees = Partial<Record<"workspace" | "depot", Snapshot>>;

// P4 sessions retain their connection object across view changes and replace it on
// reconnect or stream switch. Closing a tab releases its cache along with its session.
const TreeCache = createContext<WeakMap<P4Connection, Trees> | null>(null);

export function P4TreeCacheProvider({children}: {children: ReactNode}) {
  const [cache] = useState(() => new WeakMap<P4Connection, Trees>());
  return <TreeCache.Provider value={cache}>{children}</TreeCache.Provider>;
}

export function useTreeCache(connection: P4Connection | null) {
  const cache = useContext(TreeCache);
  if (!cache || !connection) return null;
  let trees = cache.get(connection);
  if (!trees) {
    trees = {};
    cache.set(connection, trees);
  }
  return trees;
}
