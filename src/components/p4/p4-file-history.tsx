import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { AuthorName, ExactTime, RevisionDot } from "@/components/revision-meta";
import { ChangeBadge } from "@/components/p4/change-badge";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HistorySkeleton } from "@/components/skeletons";
import { changeSummary } from "@/lib/p4";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4HistoryCursor, P4Revision } from "@/types/p4";
import type { FileDiff } from "@/types/git";

export function P4FileHistory({ path }: { path: string }) {
  const { t } = useTranslation();
  const { filelog, revisionDiff } = useP4();
  const [revisions, setRevisions] = useState<P4Revision[] | null>(null);
  const [next, setNext] = useState<P4HistoryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<P4Revision | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const mounted = useRef(false);
  const loadingRef = useRef(false);
  const diffToken = useRef(0);

  const showRevision = useCallback(async (revision: P4Revision) => {
    const token = ++diffToken.current;
    setSelected(revision); setDiff(null); setDiffError(null); setDiffLoading(true);
    try {
      const value = await revisionDiff(revision.depotPath, revision.rev);
      if (mounted.current && token === diffToken.current) setDiff(value);
    } catch (caught) { if (mounted.current && token === diffToken.current) setDiffError(p4DisplayError(errorMessage(caught))); }
    finally { if (mounted.current && token === diffToken.current) setDiffLoading(false); }
  }, [revisionDiff]);

  const load = useCallback(async (cursor: P4HistoryCursor | null) => {
    if (!mounted.current || loadingRef.current) return;
    loadingRef.current = true; setLoading(true); setError(null);
    try {
      const page = await filelog(path, cursor);
      if (!mounted.current) return;
      setRevisions((current) => cursor && current ? [...current, ...page.revisions.filter((revision) => !current.some((old) => old.rev === revision.rev && old.depotPath === revision.depotPath))] : page.revisions);
      setNext(page.next);
      if (!cursor && page.revisions[0]) void showRevision(page.revisions[0]);
    } catch (caught) { if (mounted.current) setError(p4DisplayError(errorMessage(caught))); }
    finally { loadingRef.current = false; if (mounted.current) setLoading(false); }
  }, [filelog, path, showRevision]);

  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(() => { if (mounted.current) void load(null); });
    return () => { mounted.current = false; };
  }, [load]);

  return <ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0 flex-1">
    <ResizablePanel id="p4-file-history" defaultSize="34%" minSize="16%">
      <div className="absolute inset-0 flex min-h-0 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground"><span>{t("p4.history.revisions")}</span><span className="tabular-nums">{revisions?.length ?? 0}</span></div>
        <div className="min-h-0 flex-1 overflow-auto p-1" onScroll={(event) => { const node = event.currentTarget; if (next && !error && node.scrollTop + node.clientHeight >= node.scrollHeight - 100) void load(next); }}>
          {loading && !revisions ? <HistorySkeleton fill label={t("p4.loadingHistory")} /> : revisions?.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{t("p4.noRevisions")}</p> : revisions?.map((revision) => <button key={`${revision.depotPath}#${revision.rev}`} type="button" title={revision.depotPath} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted/70", selected?.rev === revision.rev && selected.depotPath === revision.depotPath && "bg-muted")} onClick={() => void showRevision(revision)}>
            <RevisionDot /><span className="w-10 shrink-0 font-mono text-xs">#{revision.rev}</span><ChangeBadge id={revision.change} /><span className="min-w-0 flex-1 truncate text-xs">{changeSummary(revision.description) || t("p4.noDescription")}</span><AuthorName name={revision.user} /><ExactTime time={revision.time} />
          </button>)}
          {error ? <p role="alert" className="break-words p-2 text-xs text-destructive">{error}</p> : null}
          {next || error ? <Button variant="ghost" size="sm" className="w-full" disabled={loading} onClick={() => void load(revisions ? next : null)}>{loading ? <LoaderCircleIcon className="animate-spin" /> : null}{t(error ? "common.retry" : "p4.history.loadMore")}</Button> : null}
        </div>
      </div>
    </ResizablePanel>
    <ResizableHandle />
    <ResizablePanel id="p4-file-diff" defaultSize="66%" minSize="24%">
      {diffError ? <p role="alert" className="p-3 text-xs text-destructive">{diffError}</p> : <P4Diff diff={diff} loading={diffLoading || (loading && !revisions)} empty={t("p4.noRevisionToShow")} />}
    </ResizablePanel>
  </ResizablePanelGroup>;
}
