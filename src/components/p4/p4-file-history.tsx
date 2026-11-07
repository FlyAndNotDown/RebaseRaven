import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { AuthorName, ExactTime, RevisionDot } from "@/components/revision-meta";
import { ChangeBadge } from "@/components/p4/change-badge";
import { P4Blame } from "@/components/p4/p4-blame";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { P4Diff } from "@/components/p4/p4-diff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HoverTip } from "@/components/ui/tooltip";
import { HistorySkeleton } from "@/components/skeletons";
import { changeSummary, depotBase } from "@/lib/p4";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4CompareRequest, P4FileVersion, P4HistoryCursor, P4Revision } from "@/types/p4";
import type { FileDiff } from "@/types/git";

const revisionVersion = (revision: P4Revision, number = revision.rev): P4FileVersion => ({ kind: "revision", depotPath: revision.depotPath, revision: number });
const previous = (revision: P4Revision) => (BigInt(revision.rev) - 1n).toString();
const validVersion = (value: P4FileVersion) => value.kind === "workspace" || /^\d+$/.test(value.revision);

export function P4FileHistory({ path }: { path: string }) {
  const { t } = useTranslation();
  const { filelog, revisionDiff, compareFiles, selectSubmitted, setView } = useP4();
  const [mode, setMode] = useState<"diff" | "blame">("diff");
  const [revisions, setRevisions] = useState<P4Revision[] | null>(null);
  const [next, setNext] = useState<P4HistoryCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<P4Revision | null>(null);
  const [base, setBase] = useState<P4FileVersion>({ kind: "revision", depotPath: "", revision: "0" });
  const [head, setHead] = useState<P4FileVersion>({ kind: "revision", depotPath: "", revision: "" });
  const [applied, setApplied] = useState<P4CompareRequest | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const mounted = useRef(false);
  const loadingRef = useRef(false);
  const diffToken = useRef(0);
  const { viewportRef, start, end, before, after } = useWindowedRows(revisions?.length ?? 0, 32);

  const showRevision = useCallback(async (revision: P4Revision) => {
    const token = ++diffToken.current;
    const range = { path, base: revisionVersion(revision, previous(revision)), head: revisionVersion(revision) };
    setSelected(revision); setBase(range.base); setHead(range.head); setApplied(range);
    setDiff(null); setDiffError(null); setDiffLoading(true);
    try {
      const value = await revisionDiff(revision.depotPath, revision.rev);
      if (mounted.current && token === diffToken.current) setDiff(value);
    } catch (caught) { if (mounted.current && token === diffToken.current) setDiffError(p4DisplayError(errorMessage(caught))); }
    finally { if (mounted.current && token === diffToken.current) setDiffLoading(false); }
  }, [revisionDiff, path]);

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

  function edit(side: "base" | "head", version: P4FileVersion) {
    ++diffToken.current; setDiffLoading(false); setDiff(null); setDiffError(null); setApplied(null);
    if (side === "base") setBase(version); else setHead(version);
  }

  async function compare() {
    if (!selected || !validVersion(base) || !validVersion(head)) return;
    const request = { path, base, head }, token = ++diffToken.current;
    setApplied(request); setDiff(null); setDiffError(null); setDiffLoading(true);
    try {
      const value = await compareFiles(request);
      if (mounted.current && token === diffToken.current) setDiff(value);
    } catch (caught) { if (mounted.current && token === diffToken.current) setDiffError(p4DisplayError(errorMessage(caught))); }
    finally { if (mounted.current && token === diffToken.current) setDiffLoading(false); }
  }

  function openChange(change: string) { setView("submitted"); void selectSubmitted(change); }
  function label(value: P4FileVersion) {
    return value.kind === "workspace" ? t("p4.workspaceFile") : `#${value.revision}${applied?.base.kind === "revision" && applied.head.kind === "revision" && applied.base.depotPath !== applied.head.depotPath ? ` · ${depotBase(value.depotPath)}` : ""}`;
  }

  return <ResizablePanelGroup orientation="vertical" className="min-h-0 min-w-0 flex-1">
    <ResizablePanel id="p4-file-history" defaultSize="34%" minSize="16%">
      <div className="absolute inset-0 flex min-h-0 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground"><span>{t("p4.history.revisions")}</span><span className="tabular-nums">{revisions?.length ?? 0}</span><span className="ml-auto truncate">{t("p4.history.selectionHint")}</span></div>
        <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto p-1" onScroll={(event) => { const node = event.currentTarget; if (next && !error && node.scrollTop + node.clientHeight >= node.scrollHeight - 100) void load(next); }}>
          {loading && !revisions ? <HistorySkeleton fill label={t("p4.loadingHistory")} /> : revisions?.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{t("p4.noRevisions")}</p> : <>
            <div aria-hidden style={{ height: before }} />
            {revisions?.slice(start, end).map((revision) => <ContextMenu key={`${revision.depotPath}#${revision.rev}`}><ContextMenuTrigger asChild>
              <button type="button" title={revision.depotPath} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted/70", selected?.rev === revision.rev && selected.depotPath === revision.depotPath && "bg-muted")} onClick={(event) => { if (event.shiftKey) edit("base", revisionVersion(revision)); else void showRevision(revision); }}>
                <RevisionDot /><span className="w-10 shrink-0 font-mono text-xs">#{revision.rev}</span><ChangeBadge id={revision.change} /><span className="min-w-0 flex-1 truncate text-xs">{changeSummary(revision.description) || t("p4.noDescription")}</span><AuthorName name={revision.user} /><ExactTime time={revision.time} />
              </button></ContextMenuTrigger><ContextMenuContent>
                <ContextMenuItem onClick={() => edit("base", revisionVersion(revision))}>{t("p4.history.setBase")}</ContextMenuItem>
                <ContextMenuItem onClick={() => edit("head", revisionVersion(revision))}>{t("p4.history.setHead")}</ContextMenuItem>
                <ContextMenuSeparator /><ContextMenuItem onClick={() => openChange(revision.change)}><ExternalLinkIcon />{t("p4.history.openChange")}</ContextMenuItem>
              </ContextMenuContent></ContextMenu>)}
            <div aria-hidden style={{ height: after }} />
          </>}
          {error ? <p role="alert" className="break-words p-2 text-xs text-destructive">{error}</p> : null}
          {next || error ? <Button variant="ghost" size="sm" className="w-full" disabled={loading} onClick={() => void load(revisions ? next : null)}>{loading ? <LoaderCircleIcon className="animate-spin" /> : null}{t(error ? "common.retry" : "p4.history.loadMore")}</Button> : null}
        </div>
      </div>
    </ResizablePanel>
    <ResizableHandle />
    <ResizablePanel id="p4-file-diff" defaultSize="66%" minSize="24%">
      <div className="absolute inset-0 flex min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-2">
          <SegmentedControl label={t("p4.history.view")} value={mode} onChange={setMode} options={[{value:"diff",label:t("p4.history.diff")},{value:"blame",label:t("p4.history.blame")}]} />
          {mode === "diff" ? <>
          <VersionPicker label={t("p4.history.base")} value={base} fallback={selected ? revisionVersion(selected, previous(selected)) : base} disabled={!selected} onChange={(value) => edit("base", value)} />
          <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <VersionPicker label={t("p4.history.head")} value={head} fallback={selected ? revisionVersion(selected) : head} disabled={!selected} onChange={(value) => edit("head", value)} />
          <Button size="xs" variant="outline" className="ml-auto" disabled={!selected || !validVersion(base) || !validVersion(head) || diffLoading} onClick={() => void compare()}>{diffLoading ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4.history.compare")}</Button></> : null}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {mode === "blame" && selected ? <P4Blame revision={selected} openChange={openChange} /> : diffError ? <p role="alert" className="p-3 text-xs text-destructive">{diffError}</p> : <P4Diff diff={diff} loading={diffLoading || (loading && !revisions)} empty={t(selected ? "p4.history.compareHint" : "p4.noRevisionToShow")} imageSource={applied ? {kind:"compare", request:applied} : undefined} captions={applied ? [label(applied.base), label(applied.head)] : undefined} />}
        </div>
      </div>
    </ResizablePanel>
  </ResizablePanelGroup>;
}

function VersionPicker({ label, value, fallback, disabled, onChange }: { label: string; value: P4FileVersion; fallback: P4FileVersion; disabled: boolean; onChange: (value: P4FileVersion) => void }) {
  const { t } = useTranslation();
  return <div className="flex min-w-0 items-center gap-1">
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="xs" disabled={disabled} aria-label={label}><span>{label}</span><ChevronDownIcon className="size-3" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent><DropdownMenuItem onClick={() => onChange(value.kind === "revision" ? value : fallback)}><span className="min-w-4">{value.kind === "revision" ? <CheckIcon className="size-3.5" /> : null}</span>{t("p4.history.revision")}</DropdownMenuItem><DropdownMenuItem onClick={() => onChange({ kind: "workspace" })}><span className="min-w-4">{value.kind === "workspace" ? <CheckIcon className="size-3.5" /> : null}</span>{t("p4.workspaceFile")}</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
    {value.kind === "revision" ? <HoverTip label={value.depotPath}><Input className="h-7 w-20 font-mono text-xs" aria-label={t("p4.history.revisionInput", { side: label })} value={value.revision} inputMode="numeric" maxLength={10} disabled={disabled} onChange={(event) => onChange({ ...value, revision: event.target.value })} /></HoverTip> : <span className="truncate text-xs text-muted-foreground">{t("p4.workspaceFile")}</span>}
  </div>;
}
