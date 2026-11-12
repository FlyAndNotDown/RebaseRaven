import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { AuthorName, ExactTime, RevisionDot } from "@/components/revision-meta";
import { ChangeBadge } from "@/components/p4/change-badge";
import { P4Blame } from "@/components/p4/p4-blame";
import { P4ChangeFiles } from "@/components/p4/p4-change-files";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { P4Diff } from "@/components/p4/p4-diff";
import { P4GetRevisionDialog, type P4RevisionTarget } from "@/components/p4/p4-get-revision-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HistorySkeleton } from "@/components/skeletons";
import { changeSummary } from "@/lib/p4";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4Changelist, P4File, P4HistoryCursor, P4Revision } from "@/types/p4";
import type { FileDiff } from "@/types/git";

export function P4FileHistory({ path }: { path: string }) {
  const { t } = useTranslation();
  const { filelog, revisionDiff, describeSubmitted, selectSubmitted, setView } = useP4();
  const [mode, setMode] = useState<"diff" | "blame">("diff");
  const [revisions, setRevisions] = useState<P4Revision[] | null>(null);
  const [next, setNext] = useState<P4HistoryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<P4Revision | null>(null);
  const [detail, setDetail] = useState<P4Changelist | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [loadedDiff, setLoadedDiff] = useState<{ key: string; diff: FileDiff | null; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revisionTarget, setRevisionTarget] = useState<P4RevisionTarget | null>(null);
  const mounted = useRef(false);
  const loadingRef = useRef(false);
  const detailToken = useRef(0);
  const { viewportRef, start, end, before, after } = useWindowedRows(revisions?.length ?? 0, 32);

  const showRevision = useCallback(async (revision: P4Revision) => {
    const token = ++detailToken.current;
    setSelected(revision); setPicked(revision.depotPath); setDetail(null); setDetailError(null); setDetailLoading(true);
    try {
      const value = await describeSubmitted(revision.change);
      if (mounted.current && token === detailToken.current) setDetail(value);
    } catch (caught) { if (mounted.current && token === detailToken.current) setDetailError(p4DisplayError(errorMessage(caught))); }
    finally { if (mounted.current && token === detailToken.current) setDetailLoading(false); }
  }, [describeSubmitted]);

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

  const focusDetail = detail?.files.find(file => file.depotPath === selected?.depotPath);
  const focus: P4File | null = selected ? { depotPath: selected.depotPath, localPath: focusDetail?.localPath ?? "", rev: selected.rev, action: selected.action, shelved: false, binary: focusDetail?.binary ?? false, status: focusDetail?.status ?? "", detail: focusDetail?.detail ?? "" } : null;
  const files = focus ? [focus, ...(detail?.files.filter(file => file.depotPath !== focus.depotPath) ?? [])] : [];
  const change: P4Changelist | null = selected ? { ...(detail ?? { id: selected.change, user: selected.user, client: "", status: "submitted", description: selected.description, time: selected.time, shelved: false }), files } : null;
  const file = files.find(item => item.depotPath === picked) ?? focus;
  const diffPath = file?.depotPath ?? "", diffRev = file?.rev ?? "";
  const diffKey = diffPath && diffRev ? `${diffPath}\0${diffRev}` : "";
  const currentDiff = loadedDiff?.key === diffKey ? loadedDiff : null;
  const diff = currentDiff?.diff ?? null;
  const diffLoading = Boolean(diffKey && !currentDiff);

  useEffect(() => {
    if (!diffPath || !diffRev) return;
    let live = true;
    void revisionDiff(diffPath, diffRev)
      .then(value => { if (live) setLoadedDiff({ key: diffKey, diff: value }); })
      .catch((caught: unknown) => { if (live) setLoadedDiff({ key: diffKey, diff: null, error: p4DisplayError(errorMessage(caught)) }); });
    return () => { live = false; };
  }, [diffKey, diffPath, diffRev, revisionDiff, attempt]);

  function openChange(change: string) { setView("submitted"); void selectSubmitted(change); }

  return <><ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0 flex-1">
    <ResizablePanel id="p4-file-history" defaultSize="48%" minSize="22%" maxSize="75%">
      <div className="absolute inset-0 flex min-h-0 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground"><span>{t("p4.history.revisions")}</span><span className="tabular-nums">{revisions?.length ?? 0}</span></div>
        <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto p-1" onScroll={(event) => { const node = event.currentTarget; if (next && !error && node.scrollTop + node.clientHeight >= node.scrollHeight - 100) void load(next); }}>
          {loading && !revisions ? <HistorySkeleton fill label={t("p4.loadingHistory")} /> : revisions?.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{t("p4.noRevisions")}</p> : <>
            <div aria-hidden style={{ height: before }} />
            {revisions?.slice(start, end).map((revision, index) => <ContextMenu key={`${revision.depotPath}#${revision.rev}`}><ContextMenuTrigger asChild>
              <button type="button" title={revision.depotPath} aria-pressed={selected?.rev === revision.rev && selected.depotPath === revision.depotPath} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted/70", selected?.rev === revision.rev && selected.depotPath === revision.depotPath && "bg-muted")} onClick={() => void showRevision(revision)}>
                <RevisionDot before={start + index > 0} after={start + index < revisions.length - 1 || !!next} /><span className="w-10 shrink-0 font-mono text-xs">#{revision.rev}</span><ChangeBadge id={revision.change} /><span className="min-w-0 flex-1 truncate text-xs">{changeSummary(revision.description) || t("p4.noDescription")}</span><AuthorName vcs="perforce" name={revision.user} /><ExactTime time={revision.time} />
              </button></ContextMenuTrigger><ContextMenuContent>
                <ContextMenuItem onClick={() => setRevisionTarget({path:revision.depotPath,recursive:false,revision:revision.rev})}><DownloadIcon />{t("p4.getRevision")}</ContextMenuItem>
                <ContextMenuSeparator /><ContextMenuItem onClick={() => openChange(revision.change)}><ExternalLinkIcon />{t("p4.history.openChange")}</ContextMenuItem>
              </ContextMenuContent></ContextMenu>)}
            <div aria-hidden style={{ height: after }} />
          </>}
          {error ? <p role="alert" className="break-words p-2 text-xs text-destructive">{error}</p> : null}
          {next || error ? <Button variant="ghost" size="sm" className="w-full" disabled={loading} onClick={() => void load(revisions ? next : null)}>{loading ? <LoaderCircleIcon className="animate-spin" /> : null}{t(error ? "common.retry" : "p4.history.loadMore")}</Button> : null}
        </div>
      </div>
    </ResizablePanel>
    <ResizableHandle withHandle />
    <ResizablePanel id="p4-file-detail" defaultSize="52%" minSize="25%">
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0">
        <ResizablePanel id="p4-file-change-files" defaultSize="34%" minSize="20%" maxSize="55%">
          <div className="absolute inset-0 flex min-h-0 flex-col">
            {detailError ? <div role="alert" className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-destructive"><span className="min-w-0 flex-1 break-words">{detailError}</span><Button size="xs" variant="outline" onClick={() => { if (selected) void showRevision(selected); }}>{t("common.retry")}</Button></div> : null}
            <div className="relative min-h-0 flex-1"><P4ChangeFiles detail={change} file={file?.depotPath ?? null} loading={detailLoading} binaryPath={diff?.binary ? diff.path : undefined} onSelect={setPicked} /></div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="p4-file-diff" defaultSize="66%" minSize="30%">
          <div className="absolute inset-0 flex min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center border-b px-2"><SegmentedControl label={t("p4.history.view")} value={mode} onChange={setMode} options={[{value:"diff",label:t("p4.history.diff")},{value:"blame",label:t("p4.history.blame")}]} /></div>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {mode === "blame" && selected && file ? <P4Blame revision={{...selected, depotPath:file.depotPath, rev:file.rev}} openChange={openChange} /> : currentDiff?.error ? <div role="alert" className="p-3 text-xs text-destructive"><p>{currentDiff.error}</p><Button size="xs" variant="outline" className="mt-2" onClick={() => {setLoadedDiff(null);setAttempt(value => value + 1);}}>{t("common.retry")}</Button></div> : <P4Diff diff={diff} loading={diffLoading || (loading && !revisions)} empty={t("p4.noRevisionToShow")} fileSource={file ? {kind:"revision",path:file.depotPath,revision:file.rev} : undefined} />}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </ResizablePanel>
  </ResizablePanelGroup>{revisionTarget ? <P4GetRevisionDialog target={revisionTarget} onClose={() => setRevisionTarget(null)} /> : null}</>;
}
