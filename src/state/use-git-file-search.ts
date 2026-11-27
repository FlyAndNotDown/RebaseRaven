import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage, gitApi, isCancelled } from "@/lib/git";
import type { FileSearch } from "@/types/git";

type Index = Awaited<ReturnType<typeof gitApi.openFileSearch>>;
type View = { key: string; result: FileSearch; next?: () => void };

export function useGitFileSearch(repoPath: string, query: string) {
  const term = query.trim();
  const active = Boolean(term && repoPath);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<View | null>(null);
  const index = useRef<Promise<Index> | null>(null);
  const generation = useRef(0);
  const key = JSON.stringify([repoPath, term, revision]);
  const invalidate = useCallback(() => {
    if (active) setRevision(value => value + 1);
  }, [active, setRevision]);

  useEffect(() => {
    if (!active) return;
    window.addEventListener("focus", invalidate);
    return () => {
      window.removeEventListener("focus", invalidate);
      const old = index.current;
      index.current = null;
      void old?.then(handle => handle.close()).catch(() => {});
    };
  }, [repoPath, active, revision, invalidate]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    let busy = false;
    const token = ++generation.current;
    let hits: FileSearch["hits"] = [];
    async function next() {
      if (!live || busy) return;
      busy = true;
      setView(previous => previous?.key === key ? { ...previous, next: undefined } : previous);
      const resource = index.current ??= gitApi.openFileSearch(repoPath);
      try {
        const handle = await resource;
        if (!live) return;
        const page = await handle.page(term, token);
        if (!live) return;
        hits = hits.concat(page.hits);
        setView({ key, result: { ...page, hits }, next: page.truncated ? next : undefined });
      } catch (error) {
        if (!live) return;
        if (index.current === resource) {
          index.current = null;
          void resource.then(handle => handle.close()).catch(() => {});
        }
        if (!isCancelled(error)) toast.error(errorMessage(error));
        setView({ key, result: { hits, truncated: false } });
      } finally { busy = false; }
    }
    const timer = window.setTimeout(next, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [active, repoPath, term, key]);
  const current = active && view?.key === key ? view : null;
  return { active, searching: active && !current, result: current?.result, next: current?.next, invalidate };
}
