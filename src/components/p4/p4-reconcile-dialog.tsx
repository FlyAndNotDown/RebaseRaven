import { useCallback, useEffect, useRef, useState } from "react";
import { ListChecksIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { relativeToRoot } from "@/lib/p4";
import { useP4 } from "@/state/p4-context";
import type { P4ReconcilePreview } from "@/types/p4";

export function P4ReconcileDialog({ scope, onClose }: { scope?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { connection, previewReconcile, applyReconcile, busy: workspaceBusy, selectedChange } = useP4();
  const [preview, setPreview] = useState<P4ReconcilePreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [change, setChange] = useState(selectedChange);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const running = useRef(false);

  const scan = useCallback(async () => {
    await Promise.resolve();
    if (!mounted.current) return;
    if (running.current) return;
    running.current = true;
    setLoading(true); setError(null); setPreview(null); setPicked(new Set());
    try {
      const next = await previewReconcile(scope);
      if (mounted.current) { setPreview(next); setPicked(new Set(next.files.map((file) => file.path))); }
    } catch (caught) { if (mounted.current) setError(p4DisplayError(errorMessage(caught))); }
    finally { running.current = false; if (mounted.current) setLoading(false); }
  }, [previewReconcile, scope]);

  useEffect(() => { mounted.current = true; void Promise.resolve().then(() => { if (mounted.current) void scan(); }); return () => { mounted.current = false; }; }, [scan]);

  async function apply() {
    if (!preview || picked.size === 0 || running.current || workspaceBusy) return;
    running.current = true; setApplying(true); setError(null);
    try {
      await applyReconcile([...picked], change, preview.fingerprint, scope);
      if (mounted.current) onClose();
    } catch (caught) {
      if (mounted.current) { setError(p4DisplayError(errorMessage(caught))); setPreview(null); setPicked(new Set()); }
    } finally { running.current = false; if (mounted.current) setApplying(false); }
  }

  const blocked = loading || applying || workspaceBusy;
  return <Dialog open onOpenChange={(open) => { if (!open && !applying) onClose(); }}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!applying}>
      <DialogHeader><DialogTitle>{t("p4.reconcileReview.title")}</DialogTitle><DialogDescription className="truncate font-mono text-xs" title={scope}>{scope ? relativeToRoot(connection?.root ?? "", scope) || connection?.client : connection?.client}</DialogDescription></DialogHeader>
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-2 text-xs"><Checkbox checked={picked.size > 0 && picked.size === preview?.files.length ? true : picked.size > 0 ? "indeterminate" : false} disabled={blocked || !preview?.files.length} onCheckedChange={(checked) => setPicked(new Set(checked ? preview?.files.map((file) => file.path) : []))} />{t("p4.reconcileReview.selected", { count: picked.size, total: preview?.files.length ?? 0 })}</Label>
        <Button variant="ghost" size="xs" disabled={blocked} onClick={() => void scan()}><RefreshCwIcon />{t("p4.refresh")}</Button>
      </div>
      <div className="min-h-32 overflow-auto rounded-md border">
        {loading ? <div role="status" className="flex h-36 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />{t("p4.reconcileReview.scanning")}</div>
          : preview?.files.length ? preview.files.map((file) => <label key={file.path} className="flex min-h-9 cursor-pointer items-center gap-3 border-b px-3 py-2 text-xs last:border-0 hover:bg-muted/50">
            <Checkbox checked={picked.has(file.path)} disabled={blocked} onCheckedChange={(checked) => setPicked((current) => { const next = new Set(current); if (checked) next.add(file.path); else next.delete(file.path); return next; })} />
            <span className="w-14 shrink-0 text-muted-foreground">{t(`p4.reconcileReview.${file.action}`)}</span>
            <span className="min-w-0 truncate font-mono" title={file.path}>{relativeToRoot(connection?.root ?? "", file.path) || file.path}</span>
          </label>) : <p role="status" className="p-8 text-center text-sm text-muted-foreground">{t(error ? "p4.reconcileReview.scanAgain" : "p4.reconcileReview.empty")}</p>}
      </div>
      <div className="flex items-center justify-between gap-3"><Label>{t("p4-operations.pendingChange")}</Label><P4ChangeSelect value={change} onChange={setChange} disabled={blocked} /></div>
      <p className="text-xs text-muted-foreground">{t("p4.reconcileReview.hint")}</p>
      {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
      <DialogFooter><Button variant="outline" disabled={applying} onClick={onClose}>{t("common.cancel")}</Button><Button disabled={blocked || !preview || picked.size === 0} onClick={() => void apply()}>{applying ? <LoaderCircleIcon className="animate-spin" /> : <ListChecksIcon />}{t("p4.reconcileReview.apply", { count: picked.size })}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
