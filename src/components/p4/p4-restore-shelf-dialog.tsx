import { useEffect, useRef, useState } from "react";
import { ArchiveRestoreIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { p4ActionStatus } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4Changelist, P4OperationPreview, P4UnshelveRequest } from "@/types/p4";

interface RestoreDestination {
  initialTarget?: string;
  initialFiles?: string[];
  onClose: () => void;
}

export function PendingRestoreShelfDialog({ id, cached, ...destination }: RestoreDestination & { id: string; cached?: P4Changelist }) {
  const { t } = useTranslation();
  const { shelfDetail } = useP4();
  const [detail, setDetail] = useState(cached);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (detail) return;
    let active = true;
    void shelfDetail(id).then(value => { if (active) setDetail(value); })
      .catch((caught: unknown) => { if (active) setError(p4DisplayError(caught)); });
    return () => { active = false; };
  }, [id, detail, shelfDetail, attempt]);
  if (detail) return <RestoreShelfDialog detail={detail} {...destination} />;
  return <Dialog open onOpenChange={open => { if (!open) destination.onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t("p4.shelves.restoreTitle", {id})}</DialogTitle>
      <DialogDescription>{t("p4.shelves.hint")}</DialogDescription></DialogHeader>
    {error ? <><p role="alert" className="text-xs text-destructive">{error}</p>
      <DialogFooter><Button variant="outline" onClick={() => { setError(""); setAttempt(value => value + 1); }}>{t("common.retry")}</Button></DialogFooter></>
      : <p role="status" className="text-sm text-muted-foreground">{t("p4.loading")}</p>}
  </DialogContent></Dialog>;
}

export function RestoreShelfDialog({ detail, initialTarget, initialFiles, onClose }: RestoreDestination & { detail: P4Changelist }) {
  const { t } = useTranslation();
  const { connection, selectedChange, previewUnshelve, restoreShelf, busy: workspaceBusy } = useP4();
  const [picked, setPicked] = useState(() => new Set(initialFiles ?? detail.files.map(entry => entry.depotPath)));
  const [target, setTarget] = useState(initialTarget ?? selectedChange);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState<"preview" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; value: P4OperationPreview } | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const blocked = busy !== null || workspaceBusy;
  const request: P4UnshelveRequest = { changeId: detail.id, target, files: detail.files.filter(entry => picked.has(entry.depotPath)).map(entry => entry.depotPath), stream: stream.trim() };
  const key = JSON.stringify([connection, request]);
  function edit(update: () => void) { setPreview(null); setError(null); update(); }

  async function inspect() {
    if (!picked.size || blocked || running.current) return;
    running.current = true; setBusy("preview"); setError(null); setPreview(null);
    try { const value = await previewUnshelve(request); if (mounted.current) setPreview({ key, value }); }
    catch (caught) { if (mounted.current) setError(p4DisplayError(caught)); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  async function restore() {
    if (!preview || preview.key !== key || blocked || running.current) return;
    running.current = true; setBusy("restore"); setError(null);
    try { await restoreShelf(request, preview.value); if (mounted.current) onClose(); }
    catch (caught) { if (mounted.current) { setError(p4DisplayError(caught)); setPreview(null); } }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t("p4.shelves.restoreTitle", { id: detail.id })}</DialogTitle><DialogDescription>{t("p4.shelves.hint")}</DialogDescription></DialogHeader>
    <div className="grid min-h-0 gap-3 overflow-auto">
      <div className="grid grid-cols-2 items-start gap-3">
        <div className="grid min-w-0 gap-1.5">
          <span className="text-xs font-medium">{t(connection?.stream ? "p4.streams.target" : "p4.workspace")}</span>
          <p className="flex min-h-8 items-center break-all font-mono text-xs">{connection?.stream || connection?.client}</p>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <span className="text-xs font-medium">{t("p4-operations.pendingChange")}</span>
          <P4ChangeSelect value={target} onChange={value => edit(() => setTarget(value))} disabled={blocked} />
        </div>
      </div>
      <details className="text-xs">
        <summary className="w-fit cursor-pointer text-muted-foreground">{t("p4.shelves.mapping")}{stream.trim() && ` · ${stream.trim()}`}</summary>
        <Label htmlFor="shelf-stream-mapping" className="my-2 text-xs">{t("p4.shelves.mappingHint")}</Label>
        <Input id="shelf-stream-mapping" placeholder="//depot/child" value={stream} disabled={blocked}
          onChange={event => edit(() => {
            setStream(event.target.value);
            if (event.target.value.trim()) setPicked(new Set(detail.files.map(entry => entry.depotPath)));
          })} className="h-8 font-mono text-xs" />
      </details>
      <div className="overflow-hidden rounded-md border"><Label className="flex min-h-8 items-center gap-2 border-b bg-muted/20 px-3 text-xs"><Checkbox checked={picked.size === detail.files.length ? true : picked.size ? "indeterminate" : false} disabled={blocked || Boolean(stream.trim())} onCheckedChange={checked => edit(() => setPicked(new Set(checked === true ? detail.files.map(entry => entry.depotPath) : [])))} />{t("p4.shelves.selected", { count: picked.size, total: detail.files.length })}</Label><div className="max-h-[30vh] overflow-auto">{detail.files.map(entry => <Label key={entry.depotPath} className="flex min-h-8 gap-2 px-3 py-1 hover:bg-muted/50"><Checkbox aria-label={entry.depotPath} checked={picked.has(entry.depotPath)} disabled={blocked || Boolean(stream.trim())} onCheckedChange={checked => edit(() => setPicked(current => {const next = new Set(current); if (checked === true) next.add(entry.depotPath); else next.delete(entry.depotPath); return next;}))} /><FileStatusIcon status={p4ActionStatus(entry.action)} /><span className="min-w-0 truncate font-mono text-[11px]" title={entry.depotPath}>{entry.depotPath}</span></Label>)}</div></div>
      {preview ? <pre className="max-h-[20vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/20 p-2 font-mono text-[11px]">{preview.value.output}</pre> : null}
    </div>
    {error ? <p role="alert" className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter><Button variant="outline" disabled={Boolean(busy)} onClick={onClose}>{t("common.cancel")}</Button><Button variant="outline" disabled={blocked || !picked.size} onClick={() => void inspect()}>{busy === "preview" ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4-operations.preview")}</Button><Button disabled={blocked || !preview || preview.key !== key} onClick={() => void restore()}>{busy === "restore" ? <LoaderCircleIcon className="animate-spin" /> : <ArchiveRestoreIcon />}{t("p4.shelves.restore", { count: picked.size })}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
