import { useEffect, useState } from "react";
import { errorMessage, isCancelled } from "@/lib/git";
import { normalizeRepoPath } from "@/lib/format";
import { p4Api } from "@/lib/p4";
import { notifyP4Error } from "@/lib/p4-output-notice";
import type { P4Connection, P4DirEntry, P4FileSearch } from "@/types/p4";

type SearchView = {
  key: string;
  result: P4FileSearch | null;
  next?: () => void;
};

export function useWorkspaceSearch(connection: P4Connection | null, query: string) {
  const needle = query.trim();
  const key = connection && needle ? JSON.stringify([connection, needle]) : "";
  const [view, setView] = useState<SearchView | null>(null);
  useEffect(() => {
    if (!key) return;
    const [target, term] = JSON.parse(key) as [P4Connection, string];
    let live = true;
    let cursor: Awaited<ReturnType<typeof p4Api.openWorkspaceSearch>> | undefined;
    const seen = new Map<string, P4DirEntry>();
    let busy = false;
    function close() {
      if (cursor) void cursor.close().catch(() => {});
      cursor = undefined;
    }
    function fail(error: unknown) {
      close();
      if (!live) return;
      if (!isCancelled(error)) notifyP4Error(errorMessage(error));
      setView({ key, result: { hits: [...seen.values()], truncated: false, scope: "" } });
    }
    function merge(page: P4FileSearch, final: boolean) {
      if (!live) return;
      const rows = final ? seen : new Map(seen);
      for (const hit of page.hits) {
        const path = normalizeRepoPath(hit.path);
        const prior = rows.get(path);
        // A versioned descendant on any page keeps its container visible.
        rows.set(path, prior?.dir && !prior.ignored ? { ...hit, ignored: false } : hit);
      }
      setView({ key, result: { ...page, hits: [...rows.values()] }, next: final && page.truncated ? next : undefined });
    }
    async function next() {
      if (busy || !cursor || !live) return;
      busy = true;
      setView(current => current?.key === key ? { ...current, next: undefined } : current);
      try {
        const page = await cursor.page(names => merge(names, false));
        merge(page, true);
        if (!page.truncated) close();
      } catch (error) { fail(error); }
      finally { busy = false; }
    }
    const timer = window.setTimeout(async () => {
      try {
        cursor = await p4Api.openWorkspaceSearch(target, term);
        if (live) await next();
        else close();
      } catch (error) { fail(error); }
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
      close();
      setView(current => current?.key === key ? null : current);
    };
  }, [key]);
  const current = key && view?.key === key ? view : null;
  return { active: Boolean(key), searching: Boolean(key && !current?.result), result: current?.result, next: current?.next };
}
