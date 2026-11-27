import { useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestoreIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { PathLabel } from "@/components/path-label";
import { ShelfFilePath } from "./p4-path-labels";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { p4ActionStatus, sharedDepotDirectory } from "@/lib/p4";
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
  const directory = useMemo(() => sharedDepotDirectory(detail.files), [detail.files]);
  const [picked, setPicked] = useState(() => {
    const initial = initialFiles && new Set(initialFiles);
    return new Set(detail.files.map(entry => entry.depotPath).filter(path => !initial || initial.has(path)));
  });
  const [target, setTarget] = useState(initialTarget ?? selectedChange);
  const [stream, setStream] = useState("");
  const [busy, setBusy] = useState<"preview" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<P4OperationPreview | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const blocked = busy !== null || workspaceBusy;
  const override = stream.trim();
  function edit(update: () => void) { setPreview(null); setError(null); update(); }

  async function run(action: "preview" | "restore") {
    if (!picked.size || blocked || running.current) return;
    running.current = true; setBusy(action); setError(null);
    const request: P4UnshelveRequest = { changeId: detail.id, target, files: [...picked], stream: override };
    try {
      if (action === "preview") {
        const value = await previewUnshelve(request);
        if (mounted.current) setPreview(value);
      } else {
        await restoreShelf(request, preview ?? undefined);
        if (mounted.current) onClose();
      }
    } catch (caught) {
      if (mounted.current) setError(p4DisplayError(caught));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t("p4.shelves.restoreTitle", { id: detail.id })}</DialogTitle><DialogDescription>{t("p4.shelves.hint")}</DialogDescription></DialogHeader>
    <div className="grid min-h-0 min-w-0 grid-cols-1 gap-3 overflow-y-auto">
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid min-w-0 gap-1.5">
          <span className="text-xs font-medium">{t(connection?.stream ? "p4.streams.target" : "p4.workspace")}</span>
          <div className="flex min-h-8 min-w-0 items-center">
            <PathLabel path={connection?.stream || connection?.client || ""} className="text-xs" />
          </div>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <span className="text-xs font-medium">{t("p4-operations.pendingChange")}</span>
          <P4ChangeSelect value={target} onChange={value => edit(() => setTarget(value))} disabled={blocked} />
        </div>
      </div>
      <details className="group min-w-0 text-xs">
        <summary className="flex w-fit max-w-full cursor-pointer items-center gap-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-3 shrink-0 group-open:rotate-90" />
          <span className="shrink-0">{t("p4.shelves.mapping")}</span>
          {override && <PathLabel path={override} />}
        </summary>
        <Label htmlFor="shelf-stream-mapping" className="my-2 text-xs">{t("p4.shelves.mappingHint")}</Label>
        <Input id="shelf-stream-mapping" placeholder="//depot/child" value={stream} disabled={blocked}
          onChange={event => edit(() => {
            setStream(event.target.value);
            if (event.target.value.trim()) setPicked(new Set(detail.files.map(entry => entry.depotPath)));
          })} className="h-8 font-mono text-xs" />
      </details>
      <div className="overflow-hidden rounded-md border">
        <div className="flex min-h-8 items-center gap-3 border-b bg-muted/20 px-3">
          <Label className="shrink-0 text-xs">
            <Checkbox checked={picked.size > 0 && (picked.size === detail.files.length || "indeterminate")} disabled={blocked || !!override}
              onCheckedChange={checked => edit(() => setPicked(new Set(checked === true ? detail.files.map(entry => entry.depotPath) : [])))} />
            {t("p4.shelves.selected", { count: picked.size, total: detail.files.length })}
          </Label>
          {directory && <PathLabel path={directory} className="ml-auto text-[11px] text-muted-foreground" />}
        </div>
        <div className="max-h-[30vh] overflow-y-auto">
          {detail.files.map(entry => <Label key={entry.depotPath} className="min-h-8 px-3 py-1 font-normal hover:bg-muted/50">
            <Checkbox aria-label={entry.depotPath} checked={picked.has(entry.depotPath)} disabled={blocked || !!override}
              onCheckedChange={checked => edit(() => setPicked(current => {
                const next = new Set(current);
                if (checked === true) next.add(entry.depotPath);
                else next.delete(entry.depotPath);
                return next;
              }))} />
            <FileStatusIcon status={p4ActionStatus(entry.action)} />
            <ShelfFilePath path={entry.depotPath} directory={directory} />
          </Label>)}
        </div>
      </div>
      {preview && !error ? <pre className="max-h-[20vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/20 p-2 font-mono text-[11px]">{preview.output}</pre> : null}
    </div>
    {error ? <p role="alert" className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter>
      <Button variant="ghost" className="sm:mr-auto" disabled={blocked || !picked.size} onClick={() => void run("preview")}>
        {busy === "preview" && <LoaderCircleIcon className="animate-spin" />}{t("p4-operations.preview")}
      </Button>
      <Button variant="outline" disabled={Boolean(busy)} onClick={onClose}>{t("common.cancel")}</Button>
      <Button disabled={blocked || !picked.size} onClick={() => void run("restore")}>
        {busy === "restore" ? <LoaderCircleIcon className="animate-spin" /> : <ArchiveRestoreIcon />}{t("p4.shelves.restore", { count: picked.size })}
      </Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}
