import { useEffect, useRef, useState } from "react";
import { GitBranchIcon, LoaderCircleIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { P4Diff } from "@/components/p4/p4-diff";
import { P4StreamSpecDialog } from "@/components/p4/p4-stream-spec-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { p4ComparisonDiff } from "@/lib/p4-comparison";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { FileDiff } from "@/types/git";
import type { P4StreamDiffRequest, P4StreamWork, P4StreamWorkPreview, P4StreamWorkRequest } from "@/types/p4-stream-specs";

const selectClass = "h-8 min-w-0 rounded-md border border-input bg-input/30 px-2 text-xs disabled:opacity-50";

export function P4StreamWorkDialog({ onClose, restore, removeShelf, onNavigate }: {onClose: () => void; restore?: string; removeShelf?: string; onNavigate?: () => void}) {
  const { t } = useTranslation();
  const p4 = useP4();
  const { streamSpecs } = p4;
  const [work, setWork] = useState<P4StreamWork | null>(null);
  const [preview, setPreview] = useState<P4StreamWorkPreview | null>(null);
  const [action, setAction] = useState<P4StreamWorkRequest["action"] | null>(removeShelf ? "deleteShelf" : restore ? "unshelve" : null);
  const [change, setChange] = useState("default");
  const [mode, setMode] = useState<string | null>(removeShelf ?? restore ?? null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const running = useRef(false);
  const live = useRef(true);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    let active = true;
    void streamSpecs.work().then(value => {if (active) {setWork(value); setError(null);}}).catch((caught: unknown) => {if (active) setError(p4DisplayError(errorMessage(caught)));});
    return () => {active = false;};
  }, [streamSpecs, attempt]);
  const operation = action ?? (work?.opened ? "move" : "open");
  const operationMode = mode ?? (operation === "parentview" ? work?.spec.parentView === "noinherit" ? "inherit" : "noinherit" : ["unshelve", "deleteShelf"].includes(operation) ? "" : "merge");
  const request: P4StreamWorkRequest = {action: operation, change, mode: operationMode};
  const key = JSON.stringify(request);
  const approved = preview && JSON.stringify(preview.request) === key ? preview : null;
  const blocked = busy || p4.busy;
  const convertible = work && ["mainline", "development", "release"].includes(work.spec.kind);
  const operations: P4StreamWorkRequest["action"][] = [...(work?.opened ? ["move" as const, "revert" as const, ...(work.unresolved ? ["resolve" as const] : [])] : ["open" as const, ...(convertible ? ["parentview" as const] : [])]), "unshelve", "deleteShelf"];
  const valid = Boolean(work && (operation !== "move" || change !== work.opened?.change) && (operation !== "parentview" || operationMode !== work.spec.parentView) && (operation !== "deleteShelf" || /^[1-9]\d*$/.test(operationMode)) && (operation !== "unshelve" || /^[1-9]\d*$/.test(operationMode) && (!work.opened || work.opened.change === change)));
  function invalidate() {setPreview(null); setConfirmation(""); setError(null);}
  function reload() {invalidate(); setWork(null); setAction(null); setMode(null); setAttempt(value => value + 1);}
  async function run() {
    if (blocked || running.current || !valid || !work || approved && ["revert", "deleteShelf"].includes(operation) && confirmation !== work.spec.path) return;
    running.current = true; setBusy(true); setError(null);
    try {
      if (approved) {
        const value = await streamSpecs.applyWork(approved.request, approved.fingerprint);
        if (live.current) {setWork(value); setPreview(null); setAction(null); setMode(null); setConfirmation("");}
      } else {
        const value = await streamSpecs.previewWork(request);
        if (live.current) {setWork(value.work); setPreview(value);}
      }
    } catch (caught) {
      if (live.current) {
        setPreview(null); setConfirmation(""); setError(p4DisplayError(errorMessage(caught)));
        if (approved) void streamSpecs.work().then(value => {
          if (live.current) {
            setWork(value);
            if (!value.opened && ["move", "revert", "resolve"].includes(operation) || value.opened && ["open", "parentview"].includes(operation) || operation === "resolve" && !value.unresolved) {setAction(null); setMode(null);}
          }
        }).catch(() => {});
      }
    }
    finally {running.current = false; if (live.current) setBusy(false);}
  }
  let diff = work?.diff ?? null;
  let diffError: string | null = null;
  if (approved && work && (approved.convertedText || operation === "resolve")) {
    try {diff = p4ComparisonDiff({kind:"text", path:work.spec.path, before:operation === "deleteShelf" ? approved.convertedText! : work.currentText, after:operation === "deleteShelf" ? "" : approved.convertedText ?? work.headText});}
    catch (caught) {diffError = p4DisplayError(errorMessage(caught));}
  }
  return <Dialog open onOpenChange={open => {if (!open && !busy) onClose();}}><DialogContent className="flex h-[min(760px,85vh)] max-h-[85vh] flex-col gap-3 sm:max-w-5xl" showCloseButton={!busy}>
    <DialogHeader><DialogTitle className="flex items-center gap-2"><GitBranchIcon className="size-4 text-muted-foreground" />{t("p4.streamWork.title")}</DialogTitle><DialogDescription className="break-all font-mono text-xs">{work?.spec.path ?? p4.connection?.stream ?? ""}</DialogDescription></DialogHeader>
    {work ? <>
      <div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-xs text-muted-foreground">{work.opened ? t("p4.streamWork.privateChange", {change: work.opened.change === "default" ? t("p4.defaultChange") : `#${work.opened.change}`}) : t("p4.streamWork.publicRevision", {change:work.headChange})}</span><HoverTip label={t("p4.refresh")}><Button variant="ghost" size="icon-xs" aria-label={t("p4.refresh")} disabled={blocked} onClick={reload}><RefreshCwIcon /></Button></HoverTip><Button variant="outline" size="sm" disabled={blocked || !work.opened} onClick={() => setEditing(true)}><PencilIcon />{t("p4.streamWork.edit")}</Button></div>
      {work.unresolved ? <p role="alert" className="text-xs text-destructive">{t("p4.streamWork.unresolved")}</p> : null}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/10 p-3">
        <div className="grid min-w-40 gap-1.5"><Label htmlFor="p4-stream-operation">{t("p4.streamWork.operation")}</Label><select id="p4-stream-operation" value={operation} disabled={blocked} className={selectClass} onChange={event => {invalidate(); setAction(event.target.value as P4StreamWorkRequest["action"]); setMode(null);}}>{operations.map(value => <option key={value} value={value}>{t(`p4.streamWork.actions.${value}`)}</option>)}</select></div>
        {["open", "move", "parentview", "unshelve"].includes(operation) ? <div className="grid min-w-40 flex-1 gap-1.5"><Label htmlFor="p4-stream-change">{t("p4.jobs.changelist")}</Label><select id="p4-stream-change" value={change} disabled={blocked} className={selectClass} onChange={event => {invalidate(); setChange(event.target.value);}}>{p4.pending.map(item => <option key={item.id} value={item.id}>{item.id === "default" ? t("p4.defaultChange") : `#${item.id} · ${item.description.split("\n")[0]}`}</option>)}</select></div> : null}
        {["unshelve", "deleteShelf"].includes(operation) ? <div className="grid min-w-28 gap-1.5"><Label htmlFor="p4-stream-shelf">{t("p4.streamWork.shelf")}</Label><Input id="p4-stream-shelf" value={operationMode} disabled={blocked} className="h-8 font-mono text-xs" onChange={event => {invalidate(); setMode(event.target.value);}} /></div> : null}
        {operation === "parentview" || operation === "resolve" ? <div className="grid min-w-40 gap-1.5"><Label htmlFor="p4-stream-mode">{t(operation === "parentview" ? "p4.streamSpec.parentView" : "p4.streamWork.resolveMethod")}</Label><select id="p4-stream-mode" value={operationMode} disabled={blocked} className={selectClass} onChange={event => {invalidate(); setMode(event.target.value);}}>{(operation === "parentview" ? ["inherit", "noinherit"] : ["safe", "merge", "yours", "theirs"]).map(value => <option key={value} value={value}>{t(`p4.streamWork.modes.${value}`)}</option>)}</select></div> : null}
        <Button variant="outline" size="sm" disabled={blocked || !valid} onClick={() => {if (approved) invalidate(); else void run();}}>{busy && !approved ? <LoaderCircleIcon className="animate-spin" /> : null}{t(approved ? "p4.streamWork.back" : "p4-operations.preview")}</Button>
      </div>
      {approved ? <div className="grid shrink-0 gap-2"><p className="text-xs text-muted-foreground">{t(`p4.streamWork.effects.${operation}`)}</p>{["revert", "deleteShelf"].includes(operation) ? <div className="grid gap-1.5"><Label htmlFor="p4-stream-revert">{t(operation === "deleteShelf" ? "p4.streamWork.confirmDeleteShelf" : "p4.streamWork.confirmRevert")}</Label><Input id="p4-stream-revert" value={confirmation} disabled={blocked} className="h-8 font-mono text-xs" onChange={event => setConfirmation(event.target.value)} /></div> : null}</div> : null}
      <div className="relative flex min-h-32 flex-1 flex-col overflow-hidden rounded-lg border">{approved && ["resolve", "unshelve"].includes(operation) ? <p className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">{t(operation === "resolve" ? "p4.streamWork.resolveComparison" : "p4.streamWork.shelfComparison", {change:operation === "resolve" ? work.headChange : operationMode})}</p> : null}<div className="relative min-h-0 flex-1"><P4Diff diff={diff} loading={false} empty={t(work.opened ? "p4.streamWork.noChanges" : "p4.streamWork.openHint")} /></div></div>
      {approved?.output ? <pre className="max-h-24 shrink-0 overflow-auto rounded border bg-muted/10 p-2 font-mono text-[11px] text-muted-foreground">{approved.output}</pre> : null}
    </> : !error ? <div role="status" className="flex flex-1 items-center justify-center text-muted-foreground"><LoaderCircleIcon className="size-5 animate-spin" /></div> : null}
    {error || diffError ? <p role="alert" className="shrink-0 whitespace-pre-wrap text-xs text-destructive">{error ?? diffError}</p> : null}
    <DialogFooter className="shrink-0">{error ? <Button variant="ghost" disabled={blocked} onClick={reload}>{t("common.retry")}</Button> : null}{work?.opened ? <Button variant="ghost" className="mr-auto" disabled={blocked} onClick={() => {p4.selectChange(work.opened!.change); p4.setView("pending"); p4.setShelvesOpen(false); (onNavigate ?? onClose)();}}>{t("p4.streamWork.showPending")}</Button> : null}<Button variant="outline" disabled={busy} onClick={onClose}>{t("common.close")}</Button>{approved ? <Button variant={["revert", "deleteShelf"].includes(operation) ? "destructive" : "default"} disabled={blocked || Boolean(diffError) || ["revert", "deleteShelf"].includes(operation) && confirmation !== work?.spec.path} onClick={() => void run()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : null}{t(`p4.streamWork.actions.${operation}`)}</Button> : null}</DialogFooter>
    {editing && work ? <P4StreamSpecDialog target={{mode:"edit", path:work.spec.path}} onClose={() => setEditing(false)} onChanged={() => {setEditing(false); reload();}} /> : null}
  </DialogContent></Dialog>;
}

export function P4StreamDiffDialog({ target, onClose }: {target: P4StreamDiffRequest; onClose: () => void}) {
  const { t } = useTranslation();
  const { streamSpecs } = useP4();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [removing, setRemoving] = useState(false);
  const p4 = useP4();
  useEffect(() => {
    let live = true;
    void streamSpecs.changeDiff(target).then(value => {if (live) setDiff(value);}).catch((caught: unknown) => {if (live) setError(p4DisplayError(errorMessage(caught)));});
    return () => {live = false;};
  }, [streamSpecs, target, attempt]);
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}><DialogContent className="flex h-[min(700px,85vh)] flex-col sm:max-w-5xl"><DialogHeader><DialogTitle>{t("p4.streamWork.title")}</DialogTitle><DialogDescription className="break-all font-mono text-xs">{target.path} · #{target.change}</DialogDescription></DialogHeader><div className="relative min-h-32 flex-1 overflow-hidden rounded-lg border"><P4Diff diff={diff} loading={!diff && !error} empty={t("p4.streamWork.noChanges")} /></div>{error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}<DialogFooter>{error ? <Button variant="ghost" onClick={() => {setError(null); setDiff(null); setAttempt(value => value + 1);}}>{t("common.retry")}</Button> : null}{target.kind === "shelf" && p4.connection?.stream === target.path ? <><Button variant="ghost" disabled={p4.busy} onClick={() => setRemoving(true)}>{t("p4.streamWork.actions.deleteShelf")}</Button><Button variant="outline" disabled={p4.busy} onClick={() => setRestoring(true)}>{t("p4.streamWork.actions.unshelve")}</Button></> : null}<Button variant="outline" onClick={onClose}>{t("common.close")}</Button></DialogFooter>{restoring || removing ? <P4StreamWorkDialog restore={restoring ? target.change : undefined} removeShelf={removing ? target.change : undefined} onClose={() => {setRestoring(false); setRemoving(false);}} onNavigate={onClose} /> : null}</DialogContent></Dialog>;
}
