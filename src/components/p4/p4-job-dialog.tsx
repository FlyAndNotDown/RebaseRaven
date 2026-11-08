import { useEffect, useRef, useState } from "react";
import { InfoIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { p4DisplayError, P4_JOB_STALE } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4Job, P4JobField } from "@/types/p4-jobs";

export function P4JobDialog({ mode, name, onClose, onChanged }: {
  mode: "new" | "edit" | "delete"; name: string | null; onClose: () => void; onChanged: (job: P4Job | null) => void;
}) {
  const { t } = useTranslation();
  const { jobs, busy: workspaceBusy } = useP4();
  const [loaded, setLoaded] = useState<P4Job | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const running = useRef(false);
  const live = useRef(true);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    let active = true;
    void jobs.read(mode === "new" ? null : name).then(job => {
      if (active) {setLoaded(job); setValues(Object.fromEntries(job.fields.map(field => [field.name, field.value]))); setError(null);}
    }).catch((caught: unknown) => {if (active) setError(p4DisplayError(errorMessage(caught)));});
    return () => {active = false;};
  }, [jobs, mode, name, attempt]);
  const deleting = mode === "delete";
  const blocked = busy || workspaceBusy;
  const valid = loaded && (deleting ? confirmation === loaded.name : loaded.fields.every(field => field.readOnly || !field.required || values[field.name]?.trim()));
  function reload() {setLoaded(null); setError(null); setStale(false); setConfirmation(""); setAttempt(value => value + 1);}
  async function save() {
    if (!loaded || !valid || blocked || running.current || stale) return;
    running.current = true; setBusy(true); setError(null);
    try {
      if (deleting) {await jobs.remove(loaded.name, loaded.fingerprint); if (live.current) onChanged(null);}
      else {
        const edit = {name: mode === "new" ? values.Job.trim() : loaded.name, values: Object.fromEntries(loaded.fields.filter(field => field.code !== 101 && !field.readOnly).map(field => [field.name, values[field.name] ?? ""])), schemaFingerprint: loaded.schemaFingerprint};
        const job = await jobs.save(edit, mode === "new" ? null : loaded.fingerprint);
        if (live.current) onChanged(job);
      }
    } catch (caught) {if (live.current) {setError(p4DisplayError(errorMessage(caught))); setStale(errorMessage(caught) === P4_JOB_STALE);}}
    finally {running.current = false; if (live.current) setBusy(false);}
  }
  return <Dialog open onOpenChange={open => {if (!open && !busy) onClose();}}><DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl" showCloseButton={!busy}>
    <DialogHeader><DialogTitle>{t(deleting ? "p4.jobs.delete" : mode === "new" ? "p4.jobs.create" : "p4.jobs.edit")}</DialogTitle><DialogDescription>{deleting ? t("p4.jobs.deleteHint") : t("p4.jobs.formHint")}</DialogDescription></DialogHeader>
    {loaded ? deleting ? <div className="grid gap-2"><Label htmlFor="p4-delete-job">{loaded.name}</Label><Input id="p4-delete-job" value={confirmation} disabled={blocked} className="font-mono text-xs" onChange={event => setConfirmation(event.target.value)} /></div> : <div className="grid min-h-0 gap-4 overflow-auto py-1">{loaded.fields.map(field => <JobField key={field.code} field={field} value={values[field.name] ?? ""} disabled={blocked} onChange={value => {setValues(current => ({...current, [field.name]: value})); if (!stale) setError(null);}} />)}</div> : !error ? <div role="status" className="flex h-32 items-center justify-center text-muted-foreground"><LoaderCircleIcon className="size-5 animate-spin" /></div> : null}
    {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter>{stale || !loaded && error ? <Button variant="ghost" className="mr-auto" disabled={blocked} onClick={reload}>{t(stale ? "p4.jobs.discardReload" : "common.retry")}</Button> : null}<Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button variant={deleting ? "destructive" : "default"} disabled={blocked || stale || !valid} onClick={() => void save()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : null}{t(deleting ? "p4.jobs.delete" : "p4.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function JobField({ field, value, disabled, onChange }: {field: P4JobField; value: string; disabled: boolean; onChange: (value: string) => void}) {
  const { t } = useTranslation();
  const id = `p4-job-field-${field.code}`;
  const multiline = field.kind === "text" || field.kind === "bulk";
  return <div className="grid gap-2"><div className="flex items-center gap-2"><Label htmlFor={id}>{field.name}{field.required && !field.readOnly ? <span className="text-muted-foreground">*</span> : null}</Label>{field.hint ? <HoverTip label={field.hint}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip> : null}{field.readOnly ? <span className="ml-auto text-[10px] text-muted-foreground">{t("p4.jobs.readOnly")}</span> : null}</div>
    {field.kind === "select" && !field.readOnly ? <select id={id} className="h-8 rounded-md border border-input bg-input/30 px-2 text-xs disabled:opacity-50" value={value} disabled={disabled} required={field.required} onChange={event => onChange(event.target.value)}>{!field.required || !value ? <option value="" disabled={field.required}>—</option> : null}{value && !field.choices.includes(value) ? <option value={value} disabled>{value}</option> : null}{field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}</select> : multiline ? <Textarea id={id} value={value} readOnly={field.readOnly} disabled={disabled} onChange={event => onChange(event.target.value)} className="h-28 min-h-28 resize-none text-sm [field-sizing:fixed]" /> : <Input id={id} value={value} readOnly={field.readOnly} disabled={disabled} required={field.required} onChange={event => onChange(event.target.value)} className="font-mono text-xs" />}
  </div>;
}
