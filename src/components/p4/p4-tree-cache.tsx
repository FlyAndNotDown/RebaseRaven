import { createContext, useContext, useState, type ReactNode } from "react";
import type { FileTreeEntry } from "@/components/file-tree";
import type { P4Connection } from "@/types/p4";

export type P4TreeEntry = FileTreeEntry & { ruleIgnored: boolean; p4Status: string };
type Snapshot = { entries: Record<string, P4TreeEntry[]>; open: string[]; epoch: number };
type Trees = Record<"workspace" | "depot", WeakMap<P4Connection, Snapshot>>;

// P4 sessions retain their connection object across view changes and replace it on
// reconnect or stream switch. Closing a tab releases its cache along with its session.
const TreeCache = createContext<Trees | null>(null);

export function P4TreeCacheProvider({children}: {children: ReactNode}) {
  const [cache] = useState<Trees>(() => ({workspace: new WeakMap(), depot: new WeakMap()}));
  return <TreeCache.Provider value={cache}>{children}</TreeCache.Provider>;
}

export function useTreeCache(mode: keyof Trees) {
  return useContext(TreeCache)?.[mode];
}
