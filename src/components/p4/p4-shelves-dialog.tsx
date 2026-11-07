import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveRestoreIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { ChangeBadge } from "@/components/p4/change-badge";
import { P4Diff } from "@/components/p4/p4-diff";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/git";
import { changeSummary, p4ActionStatus } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { FileDiff } from "@/types/git";
import type { P4ChangePage, P4Changelist, P4OperationPreview, P4UnshelveRequest } from "@/types/p4";

export function P4ShelvesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { connection, listShelves, shelfDetail, shelfDiff, previewUnshelve, restoreShelf, busy: workspaceBusy, selectedChange } = useP4();
  const [user, setUser] = useState("");
  const [number, setNumber] = useState("");
  const [page, setPage] = useState<P4ChangePage | null>(null);
  const [detail, setDetail] = useState<P4Changelist | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [target, setTarget] = useState(selectedChange);
  const [stream, setStream] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<"preview" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; value: P4OperationPreview } | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const filter = useRef("");
  const running = useRef(false);
  const request: P4UnshelveRequest = { changeId: detail?.id ?? "", target, files: detail?.files.filter((entry) => picked.has(entry.depotPath)).map((entry) => entry.depotPath) ?? [], stream: stream.trim() };
  const key = JSON.stringify([connection, request]);
  const blocked = busy !== null || workspaceBusy;

  const load = useCallback(async (owner: string, before: number | null) => {
    const token = ++generation.current;
    ++detailGeneration.current;
    setLoading(true); setError(null); setPreview(null);
    if (!before) { setPage(null); setDetail(null); setFile(null); }
    try {
      const next = await listShelves(owner, before);
      if (mounted.current && token === generation.current) {
        filter.current = owner;
        setPage((old) => before && old ? { ...next, changes: [...old.changes, ...next.changes.filter((item) => !old.changes.some((previous) => item.id === previous.id))] } : next);
      }
    } catch (caught) { if (mounted.current && token === generation.current) setError(p4DisplayError(errorMessage(caught))); }
    finally { if (mounted.current && token === generation.current) setLoading(false); }
  }, [listShelves]);

  useEffect(() => { mounted.current = true; void load("", null); return () => { mounted.current = false; ++generation.current; ++detailGeneration.current; }; }, [load]);

  async function select(id: string, direct = false) {
    const token = ++detailGeneration.current;
    setDetailLoading(true); setError(null); setPreview(null); setDetail(null); setFile(null); setPicked(new Set()); setStream("");
    try {
      const next = await shelfDetail(id);
      if (!mounted.current || token !== detailGeneration.current) return;
      setDetail(next); setPicked(new Set(next.files.map((entry) => entry.depotPath))); setFile(next.files[0]?.depotPath ?? null);
      if (direct) setPage((old) => ({ changes: [next, ...(old?.changes.filter((entry) => entry.id !== next.id) ?? [])], hasMore: old?.hasMore ?? false, scannedThrough: old?.scannedThrough ?? null }));
    } catch (caught) { if (mounted.current && token === detailGeneration.current) setError(p4DisplayError(errorMessage(caught))); }
    finally { if (mounted.current && token === detailGeneration.current) setDetailLoading(false); }
  }

  useEffect(() => {
    if (!detail || !file) { setDiff(null); return; }
    let live = true;
    setDiff(null); setDiffLoading(true);
    void shelfDiff(file, detail.id).then((next) => { if (live) setDiff(next); })
      .catch((caught: unknown) => { if (live) setError(p4DisplayError(errorMessage(caught))); })
      .finally(() => { if (live) setDiffLoading(false); });
    return () => { live = false; };
  }, [file, detail, shelfDiff]);

  function edit(update: () => void) { setPreview(null); setError(null); update(); }

  async function inspect() {
    if (!detail || !picked.size || blocked || running.current) return;
    running.current = true; setBusy("preview"); setError(null); setPreview(null);
    try { const value = await previewUnshelve(request); if (mounted.current) setPreview({ key, value }); }
    catch (caught) { if (mounted.current) setError(p4DisplayError(errorMessage(caught))); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  async function restore() {
    if (!preview || preview.key !== key || blocked || running.current) return;
    running.current = true; setBusy("restore"); setError(null);
    try { await restoreShelf(request, preview.value); onClose(); }
    catch (caught) { if (mounted.current) { setError(p4DisplayError(errorMessage(caught))); setPreview(null); } }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && busy !== "restore") onClose(); }}>
    <DialogContent className="flex h-[min(52rem,90vh)] flex-col sm:max-w-[min(74rem,95vw)]" showCloseButton={busy !== "restore"}>
      <DialogHeader><DialogTitle>{t("p4.shelves.title")}</DialogTitle><DialogDescription>{t("p4.shelves.description")}</DialogDescription></DialogHeader>
      <form className="flex shrink-0 gap-2" onSubmit={(event) => { event.preventDefault(); if (number.trim()) { ++generation.current; setLoading(false); void select(number.trim(), true); } else void load(user.trim(), null); }}>
        <Input aria-label={t("p4.shelves.user")} placeholder={t("p4.shelves.user")} value={user} onChange={(event) => setUser(event.target.value)} disabled={blocked} className="h-8 flex-1" />
        <Input aria-label={t("p4.shelves.number")} placeholder={t("p4.shelves.number")} inputMode="numeric" value={number} onChange={(event) => setNumber(event.target.value)} disabled={blocked} className="h-8 w-44" />
        <Button type="submit" size="sm" variant="outline" disabled={blocked || detailLoading || (number.trim() !== "" && !/^[1-9]\d*$/.test(number.trim()))}><SearchIcon />{t("p4.shelves.search")}</Button>
      </form>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,28%)_minmax(0,1fr)] overflow-hidden rounded-md border">
        <div className="min-h-0 overflow-auto border-r p-1">
          {page?.changes.map((entry) => <button key={entry.id} type="button" disabled={blocked || detailLoading} onClick={() => void select(entry.id)} className={cn("grid w-full gap-1 rounded-md px-2 py-2 text-left hover:bg-muted/70 disabled:opacity-50", detail?.id === entry.id && "bg-muted")}>
            <div className="flex items-center gap-2"><ChangeBadge id={entry.id} /><span className="truncate text-xs text-muted-foreground">{entry.user}</span></div>
            <span className="truncate text-xs">{changeSummary(entry.description)}</span><span className="truncate font-mono text-[11px] text-muted-foreground">{entry.client}</span>
          </button>)}
          {loading ? <p role="status" className="p-5 text-center text-xs text-muted-foreground">{t("p4.shelves.loading")}</p> : !page?.changes.length ? <p role="status" className="p-5 text-center text-xs text-muted-foreground">{t("p4.shelves.empty")}</p> : null}
          {page?.hasMore ? <Button variant="ghost" size="sm" className="w-full" disabled={blocked || loading || detailLoading} onClick={() => void load(filter.current, page.scannedThrough)}>{t("p4.shelves.more")}</Button> : null}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          {detailLoading ? <p role="status" className="p-6 text-sm text-muted-foreground">{t("p4.shelves.loading")}</p> : detail ? <>
            <div className="shrink-0 space-y-1 border-b px-3 py-2"><p className="truncate text-sm font-medium">{changeSummary(detail.description)}</p><p className="truncate font-mono text-[11px] text-muted-foreground">{detail.user} · {detail.client}</p></div>
            <div className="max-h-[19vh] shrink-0 overflow-auto border-b">
              <Label className="flex min-h-8 items-center gap-2 px-3 text-xs"><Checkbox checked={picked.size === detail.files.length ? true : picked.size ? "indeterminate" : false} disabled={blocked || Boolean(stream.trim())} onCheckedChange={(checked) => edit(() => setPicked(new Set(checked ? detail.files.map((entry) => entry.depotPath) : [])))} />{t("p4.shelves.selected", { count: picked.size, total: detail.files.length })}</Label>
              {detail.files.map((entry) => <div key={entry.depotPath} className={cn("flex items-center gap-2 px-3 py-1 text-xs hover:bg-muted/50", file === entry.depotPath && "bg-muted/60")}>
                <Checkbox aria-label={entry.depotPath} checked={picked.has(entry.depotPath)} disabled={blocked || Boolean(stream.trim())} onCheckedChange={(checked) => edit(() => setPicked((current) => { const next = new Set(current); if (checked) next.add(entry.depotPath); else next.delete(entry.depotPath); return next; }))} />
                <FileStatusIcon status={p4ActionStatus(entry.action)} /><button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-[11px]" title={entry.depotPath} onClick={() => setFile(entry.depotPath)}>{entry.depotPath}</button>
              </div>)}
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col"><P4Diff diff={diff} loading={diffLoading} empty={t("p4.noTextDifferences")} /></div>
          </> : <p className="p-8 text-center text-sm text-muted-foreground">{t("p4.shelves.select")}</p>}
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-[1fr_1fr] gap-3">
        <div className="grid gap-1.5"><Label className="text-xs">{t("p4-operations.pendingChange")}</Label><P4ChangeSelect value={target} onChange={(value) => edit(() => setTarget(value))} disabled={blocked} /></div>
        <div className="grid gap-1.5"><Label htmlFor="shelf-stream-mapping" className="text-xs">{t("p4.shelves.mapping")}</Label><Input id="shelf-stream-mapping" placeholder="//depot/child" value={stream} disabled={blocked || !detail} onChange={(event) => edit(() => { setStream(event.target.value); if (event.target.value.trim() && detail) setPicked(new Set(detail.files.map((entry) => entry.depotPath))); })} className="h-8 font-mono text-xs" /></div>
      </div>
      {preview ? <pre className="max-h-[13vh] shrink-0 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/20 p-2 font-mono text-[11px]">{preview.value.output}</pre> : null}
      <p className="shrink-0 text-xs text-muted-foreground">{t(stream.trim() ? "p4.shelves.mappingHint" : "p4.shelves.hint")}</p>
      {error ? <p role="alert" className="max-h-20 shrink-0 overflow-auto whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
      <DialogFooter className="shrink-0"><Button variant="outline" disabled={busy === "restore"} onClick={onClose}>{t("common.cancel")}</Button><Button variant="outline" disabled={blocked || !detail || !picked.size} onClick={() => void inspect()}>{busy === "preview" ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4-operations.preview")}</Button><Button disabled={blocked || !preview || preview.key !== key} onClick={() => void restore()}>{busy === "restore" ? <LoaderCircleIcon className="animate-spin" /> : <ArchiveRestoreIcon />}{t("p4.shelves.restore", { count: picked.size })}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
