import { useEffect, useRef, useState } from "react";
import { LinkIcon, LoaderCircleIcon, PencilIcon, PlusIcon, RefreshCwIcon, UnlinkIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4FixPage, P4FixPreview, P4FixRequest } from "@/types/p4-jobs";

export function P4JobFixes({ job = "", change = "", onChanged }: {job?: string; change?: string; onChanged?: () => void}) {
  const { t } = useTranslation();
  const { jobs, busy } = useP4();
  const [page, setPage] = useState<{key: string; value: P4FixPage} | null>(null);
  const [error, setError] = useState<{key: string; value: string} | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<P4FixRequest | null>(null);
  const key = JSON.stringify([job, change, attempt]);
  const shown = page?.key === key ? page.value : null;
  const shownError = error?.key === key ? error.value : null;
  useEffect(() => {
    let live = true;
    void jobs.fixes(job, change).then(value => {if (live) setPage({key, value});}).catch((caught: unknown) => {if (live) setError({key, value: p4DisplayError(errorMessage(caught))});});
    return () => {live = false;};
  }, [job, change, jobs, key]);
  return <div className="overflow-hidden rounded-lg border">
    <div className="flex items-center gap-1 border-b bg-muted/20 px-3 py-2"><h3 className="mr-auto flex items-center gap-2 text-xs font-medium"><LinkIcon className="size-3.5" />{t(job ? "p4.jobs.changelists" : "p4.jobs.linkedJobs")}</h3><HoverTip label={t("p4.refresh")}><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={t("p4.refresh")} onClick={() => setAttempt(value => value + 1)}><RefreshCwIcon /></Button></HoverTip><Button variant="outline" size="xs" disabled={busy} onClick={() => setEditing({job, change, status: "", remove: false})}><PlusIcon />{t(job ? "p4.jobs.linkChange" : "p4.jobs.link")}</Button></div>
    {shown ? <>{shown.items.length ? shown.items.map(fix => <div key={`${fix.job}:${fix.change}`} className="flex min-w-0 items-center gap-2 border-b px-3 py-2 text-xs last:border-0"><code className="min-w-0 flex-1 truncate" title={job ? fix.change : fix.job}>{job ? `#${fix.change}` : fix.job}</code><span className="truncate text-muted-foreground">{fix.status === "same" ? t("p4.jobs.keepStatus") : fix.status}</span><HoverTip label={t("p4.jobs.editFix")}><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={t("p4.jobs.editFix")} onClick={() => setEditing({...fix, remove: false})}><PencilIcon /></Button></HoverTip><HoverTip label={t("p4.jobs.unlink")}><Button variant="ghost" size="icon-xs" disabled={busy} aria-label={t("p4.jobs.unlink")} onClick={() => setEditing({...fix, remove: true})}><UnlinkIcon /></Button></HoverTip></div>) : <p className="p-5 text-center text-xs text-muted-foreground">{t("p4.jobs.noFixes")}</p>}{shown.truncated ? <p className="border-t p-3 text-xs text-muted-foreground">{t("p4.jobs.fixLimit")}</p> : null}</> : !shownError ? <p role="status" className="p-5 text-center text-xs text-muted-foreground">{t("p4.loading")}</p> : null}
    {shownError ? <p role="alert" className="p-3 text-xs text-destructive">{shownError}</p> : null}
    {editing ? <P4JobFixDialog request={editing} onClose={() => setEditing(null)} onChanged={() => {setEditing(null); setAttempt(value => value + 1); onChanged?.();}} /> : null}
  </div>;
}

export function P4ChangeJobsDialog({ change, onClose }: {change: string; onClose: () => void}) {
  const { t } = useTranslation();
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{t("p4.jobs.linkedJobs")}</DialogTitle><DialogDescription className="font-mono">#{change}</DialogDescription></DialogHeader><div className="max-h-[60vh] overflow-auto"><P4JobFixes change={change} /></div></DialogContent></Dialog>;
}

export function P4JobFixDialog({ request, onClose, onChanged }: {request: P4FixRequest; onClose: () => void; onChanged: () => void}) {
  const { t } = useTranslation();
  const { jobs, busy: workspaceBusy } = useP4();
  const [edit, setEdit] = useState(request);
  const [choices, setChoices] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<P4FixPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const live = useRef(true);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    let active = true;
    void jobs.read(request.job || null).then(job => {if (active) {setChoices(job.fields.find(field => field.code === 102)?.choices ?? []); setError(null);}})
      .catch((caught: unknown) => {if (active) setError(p4DisplayError(errorMessage(caught)));});
    return () => {active = false;};
  }, [jobs, request.job, attempt]);
  const blocked = busy || workspaceBusy;
  function change<K extends keyof P4FixRequest>(field: K, value: P4FixRequest[K]) {setEdit(current => ({...current, [field]: value})); setPreview(null); setError(null);}
  async function apply() {
    if (blocked || running.current || choices === null || !edit.job.trim() || !/^[1-9]\d*$/.test(edit.change.trim())) return;
    running.current = true; setBusy(true); setError(null);
    try {
      if (preview) {await jobs.applyFix(preview.request, preview.fingerprint); if (live.current) onChanged();}
      else {const value = await jobs.previewFix({...edit, job: edit.job.trim(), change: edit.change.trim()}); if (live.current) setPreview(value);}
    } catch (caught) {if (live.current) {setPreview(null); setError(p4DisplayError(errorMessage(caught)));}}
    finally {running.current = false; if (live.current) setBusy(false);}
  }
  const shownStatus = (status: string) => status === "same" ? t("p4.jobs.keepStatus") : status || "—";
  return <Dialog open onOpenChange={open => {if (!open && !busy) onClose();}}><DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t(request.remove ? "p4.jobs.unlink" : request.job && !request.change ? "p4.jobs.linkChange" : "p4.jobs.link")}</DialogTitle><DialogDescription>{t(request.remove ? "p4.jobs.unlinkHint" : "p4.jobs.fixHint")}</DialogDescription></DialogHeader>
    <div className="grid grid-cols-2 gap-3"><div className="grid gap-2"><Label htmlFor="p4-fix-job">{t("p4.jobs.job")}</Label><Input id="p4-fix-job" value={edit.job} disabled={blocked} readOnly={Boolean(request.job)} className="font-mono text-xs" onChange={event => change("job", event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="p4-fix-change">{t("p4.jobs.changelist")}</Label><Input id="p4-fix-change" value={edit.change} disabled={blocked} readOnly={Boolean(request.change)} className="font-mono text-xs" onChange={event => change("change", event.target.value)} /></div></div>
    {!request.remove ? <div className="grid gap-2"><Label htmlFor="p4-fix-status">{t("p4.jobs.fixStatus")}</Label><select id="p4-fix-status" value={edit.status} disabled={blocked || choices === null} onChange={event => change("status", event.target.value)} className="h-8 rounded-md border border-input bg-input/30 px-2 text-xs disabled:opacity-50"><option value="">{t("p4.jobs.defaultStatus")}</option><option value="same">{t("p4.jobs.keepStatus")}</option>{choices?.filter(value => value !== "same").map(value => <option key={value} value={value}>{value}</option>)}</select></div> : null}
    {preview ? <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-xs"><div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{t("p4.jobs.currentStatus")}</span><span>{shownStatus(preview.currentStatus)}</span></div>{!request.remove ? <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{t("p4.jobs.fixStatus")}</span><span>{shownStatus(preview.fixStatus)}</span></div> : null}{preview.existingStatus && !request.remove ? <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{t("p4.jobs.previousFixStatus")}</span><span>{shownStatus(preview.existingStatus)}</span></div> : null}<p className="border-t pt-3 text-muted-foreground">{t(request.remove ? "p4.jobs.unlinkHint" : preview.fixStatus === "same" ? "p4.jobs.applyKeepStatus" : preview.changeStatus === "submitted" ? "p4.jobs.applyNow" : "p4.jobs.applyOnSubmit")}</p></div> : null}
    {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter>{choices === null && error ? <Button variant="ghost" className="mr-auto" disabled={blocked} onClick={() => {setError(null); setAttempt(value => value + 1);}}>{t("common.retry")}</Button> : null}<Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button variant={preview && request.remove ? "destructive" : "default"} disabled={blocked || choices === null || !edit.job.trim() || !/^[1-9]\d*$/.test(edit.change.trim())} onClick={() => void apply()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : null}{t(preview ? request.remove ? "p4.jobs.unlink" : "p4.jobs.confirmLink" : "p4.jobs.previewFix")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
