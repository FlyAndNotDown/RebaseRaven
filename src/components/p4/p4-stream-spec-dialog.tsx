import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, InfoIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { p4DisplayError, P4_STREAM_SPEC_STALE } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4StreamKind, P4StreamSetup, P4StreamSpec, P4StreamSpecEdit } from "@/types/p4-stream-specs";

export type StreamSpecTarget = {mode:"new"; parent:string} | {mode:"edit" | "delete"; path:string};
const kinds: P4StreamKind[] = ["mainline", "development", "release", "virtual", "task", "sparsedev", "sparserel"];
const requiresInheritance = (kind: P4StreamKind) => ["virtual", "task", "sparsedev", "sparserel"].includes(kind);

export function P4StreamSpecDialog({target, onClose, onChanged}: {
  target: StreamSpecTarget;
  onClose: () => void;
  onChanged: (spec: P4StreamSpec | null) => void;
}) {
  const {t} = useTranslation();
  const {streamSpecs, busy: workspaceBusy} = useP4();
  const creating = target.mode === "new";
  const deleting = target.mode === "delete";
  const path = target.mode === "new" ? null : target.path;
  const [setup, setSetup] = useState<P4StreamSetup>(() => ({path: "", kind: target.mode === "new" && !target.parent ? "mainline" : "development", parent: target.mode === "new" && target.parent ? target.parent : "none", parentView: null}));
  const [loaded, setLoaded] = useState<P4StreamSpec | null>(null);
  const [edit, setEdit] = useState<P4StreamSpecEdit | null>(null);
  const [tab, setTab] = useState<"general" | "mapping">("general");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  const running = useRef(false);
  const live = useRef(true);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    if (path === null) return;
    let active = true;
    void streamSpecs.read(path).then(value => {
      if (active) {setLoaded(value); setEdit(value); setError(null);}
    }).catch((caught: unknown) => {if (active) setError(p4DisplayError(errorMessage(caught)));});
    return () => {active = false;};
  }, [path, streamSpecs, attempt]);
  const blocked = busy || workspaceBusy;
  const fieldBlocked = (field: string) => blocked || Boolean(loaded?.opened && !loaded.editableFields?.includes(field));
  function change<K extends keyof P4StreamSpecEdit>(field: K, value: P4StreamSpecEdit[K]) {
    setEdit(current => current ? {...current, [field]: value} : current); if (!stale) setError(null);
  }
  function changeKind(kind: P4StreamKind) {
    if (edit) setEdit(current => current ? {...current, kind, parent: kind === "mainline" ? "none" : current.parent === "none" ? "" : current.parent, options: {...current.options, ...(kind === "virtual" ? {toParent: false, fromParent: false} : {})}} : current);
    else setSetup(current => ({...current, kind, parent: kind === "mainline" ? "none" : current.parent === "none" ? "" : current.parent, parentView: requiresInheritance(kind) ? "inherit" : current.parentView}));
    if (!stale) setError(null);
  }
  async function reload() {
    if (!path || blocked || running.current) return;
    running.current = true; setBusy(true);
    try {
      const value = await streamSpecs.read(path);
      if (live.current) {setLoaded(value); setEdit(value); setConfirmation(""); setStale(false); setError(null);}
    } catch (caught) {if (live.current) setError(p4DisplayError(errorMessage(caught)));}
    finally {running.current = false; if (live.current) setBusy(false);}
  }
  async function apply() {
    if (blocked || running.current || stale) return;
    running.current = true; setBusy(true); setError(null);
    try {
      if (deleting && loaded) {
        if (confirmation !== loaded.path) return;
        await streamSpecs.remove(loaded.path, loaded.fingerprint);
        if (live.current) onChanged(null);
      } else if (edit) {
        const clean = (lines: string[]) => lines.map(line => line.trim()).filter(Boolean);
        const saved = await streamSpecs.save({...edit, paths: clean(edit.paths), remapped: clean(edit.remapped), ignored: clean(edit.ignored)}, creating ? null : loaded?.fingerprint ?? null);
        if (live.current) onChanged(saved);
      } else if (creating) {
        const value = await streamSpecs.template({...setup, path: setup.path.trim(), parent: setup.parent.trim()});
        if (live.current) {setLoaded(value); setEdit(value);}
      }
    } catch (caught) {if (live.current) {setError(p4DisplayError(errorMessage(caught))); setStale(errorMessage(caught) === P4_STREAM_SPEC_STALE);}}
    finally {running.current = false; if (live.current) setBusy(false);}
  }
  const valid = deleting ? Boolean(loaded && confirmation === loaded.path) : edit ? Boolean(edit.name.trim() && edit.owner.trim() && edit.paths.some(line => line.trim())) : Boolean(creating && setup.path.trim() && (setup.kind === "mainline" || setup.parent.startsWith("//")));
  return <Dialog open onOpenChange={open => {if (!open && !busy) onClose();}}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{t(deleting ? "p4.streamSpec.delete" : creating ? "p4.streamSpec.create" : loaded?.opened ? "p4.streamWork.edit" : "p4.streamSpec.edit")}</DialogTitle><DialogDescription className={loaded ? "break-all font-mono text-xs" : undefined}>{loaded?.path ?? t("p4.streamSpec.setupHint")}{loaded?.opened ? <span className="mt-1 block font-sans">{t("p4.streamWork.privateHint")}</span> : null}</DialogDescription></DialogHeader>
      {deleting ? loaded ? <div className="grid gap-3 py-1"><p className="text-sm text-muted-foreground">{t("p4.streamSpec.deleteHint")}</p><Label htmlFor="p4-delete-stream">{t("p4.streamSpec.path")}</Label><Input id="p4-delete-stream" value={confirmation} disabled={blocked} className="font-mono text-xs" onChange={event => setConfirmation(event.target.value)} /></div> : !error ? <Loading /> : null : edit ? <>
        <SegmentedControl label={t("p4.streamSpec.section")} value={tab} onChange={setTab} options={[{value:"general", label:t("p4.workspaceSettings.general")}, {value:"mapping", label:t("p4.workspaceSettings.mapping")}]} />
        <div className="grid min-h-0 gap-4 overflow-auto py-1">
          {tab === "general" ? <>
            <div className="grid grid-cols-2 gap-3"><Field id="p4-stream-name" label={t("p4.specs.name")}><Input id="p4-stream-name" value={edit.name} disabled={fieldBlocked("Name")} onChange={event => change("name", event.target.value)} /></Field><Field id="p4-stream-owner" label={t("p4.specs.owner")}><Input id="p4-stream-owner" value={edit.owner} disabled={fieldBlocked("Owner")} className="font-mono text-xs" onChange={event => change("owner", event.target.value)} /></Field></div>
            <KindField value={edit.kind} onChange={changeKind} disabled={fieldBlocked("Type")} inherits={edit.parentView !== "noinherit"} />
            <Field id="p4-stream-parent" label={t("p4.streamSpec.parent")}><Input id="p4-stream-parent" value={edit.kind === "mainline" ? "none" : edit.parent} readOnly={edit.kind === "mainline"} disabled={fieldBlocked("Parent")} className="font-mono text-xs" onChange={event => change("parent", event.target.value)} /></Field>
            {edit.parentView ? <div className="flex items-center gap-2 text-xs"><span className="text-muted-foreground">{t("p4.streamSpec.parentView")}</span><code>{edit.parentView}</code><HoverTip label={t("p4.streamSpec.parentViewHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div> : null}
            <Field id="p4-stream-description" label={t("p4.specs.description")}><Textarea id="p4-stream-description" value={edit.description} disabled={fieldBlocked("Description")} onChange={event => change("description", event.target.value)} className="h-20 min-h-20 resize-none text-sm [field-sizing:fixed]" /></Field>
            <div className="grid rounded-lg border px-3">{(["locked", "ownerSubmit", "toParent", "fromParent", "mergeAny"] as const).map(option => <div key={option} className="flex min-h-10 items-center gap-2 border-b last:border-0"><Label className="flex flex-1 items-center gap-2 text-xs"><Checkbox checked={edit.options[option]} disabled={fieldBlocked("Options") || (option === "toParent" || option === "fromParent") && (edit.kind === "virtual" || edit.kind === "mainline")} onCheckedChange={checked => change("options", {...edit.options, [option]: checked === true})} />{t(`p4.streamSpec.options.${option}`)}</Label><HoverTip label={t(`p4.streamSpec.hints.${option}`)}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div>)}</div>
          </> : (["paths", "remapped", "ignored"] as const).map(field => <Field key={field} id={`p4-stream-${field}`} label={t(`p4.streamSpec.${field}`)} hint={t(`p4.streamSpec.hints.${field}`)}><Textarea id={`p4-stream-${field}`} value={edit[field].join("\n")} disabled={fieldBlocked(field === "paths" ? "Paths" : field === "remapped" ? "Remapped" : "Ignored")} spellCheck={false} className="h-28 min-h-28 resize-none whitespace-pre font-mono text-xs [field-sizing:fixed]" onChange={event => change(field, event.target.value.split("\n"))} /></Field>)}
        </div>
      </> : creating ? <div className="grid min-h-0 gap-4 overflow-auto py-1">
        <Field id="p4-new-stream-path" label={t("p4.streamSpec.path")}><Input id="p4-new-stream-path" value={setup.path} disabled={blocked} placeholder={t("p4.streamSpec.pathPlaceholder")} className="font-mono text-xs" onChange={event => {setSetup(current => ({...current, path:event.target.value})); setError(null);}} /></Field>
        <KindField value={setup.kind} onChange={changeKind} disabled={blocked} inherits />
        {setup.kind !== "mainline" ? <Field id="p4-new-stream-parent" label={t("p4.streamSpec.parent")}><Input id="p4-new-stream-parent" value={setup.parent} disabled={blocked} className="font-mono text-xs" onChange={event => {setSetup(current => ({...current, parent:event.target.value})); setError(null);}} /></Field> : null}
        <div className="flex items-center gap-3"><Label className="mr-auto">{t("p4.streamSpec.parentView")}</Label><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={blocked || requiresInheritance(setup.kind)}>{t(`p4.streamSpec.views.${setup.parentView ?? "server"}`)}<ChevronDownIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{([null, "inherit", "noinherit"] as const).map(view => <DropdownMenuItem key={view ?? "server"} onClick={() => setSetup(current => ({...current, parentView:view}))}>{t(`p4.streamSpec.views.${view ?? "server"}`)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>
      </div> : !error ? <Loading /> : null}
      {error ? <div className="grid gap-2"><p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>{stale && !creating ? <Button variant="outline" size="sm" className="justify-self-start" disabled={blocked} onClick={() => void reload()}>{t(deleting ? "p4.streamSpec.reload" : "p4.streamSpec.discardReload")}</Button> : null}</div> : null}
      <DialogFooter>{!creating && !loaded && error ? <Button variant="ghost" className="mr-auto" onClick={() => {setError(null); setAttempt(value => value + 1);}}>{t("common.retry")}</Button> : creating && edit ? <Button variant="ghost" className="mr-auto" disabled={blocked} onClick={() => {setEdit(null); setLoaded(null); setError(null);}}>{t("p4.streamSpec.back")}</Button> : null}<Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button variant={deleting ? "destructive" : "default"} disabled={blocked || stale || !valid} onClick={() => void apply()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : null}{t(deleting ? "p4.streamSpec.delete" : edit ? "p4.save" : "p4.streamSpec.continue")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function Field({id, label, hint, children}: {id: string; label: string; hint?: string; children: ReactNode}) {
  return <div className="grid gap-2"><div className="flex items-center gap-2"><Label htmlFor={id}>{label}</Label>{hint ? <HoverTip label={hint}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip> : null}</div>{children}</div>;
}
function KindField({value, onChange, disabled, inherits}: {value: P4StreamKind; onChange: (kind: P4StreamKind) => void; disabled: boolean; inherits: boolean}) {
  const {t} = useTranslation();
  return <div className="flex items-center gap-3"><Label className="mr-auto">{t("p4.streamSpec.type")}</Label><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={disabled}>{t(`p4.streamSpec.kinds.${value}`)}<ChevronDownIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{kinds.map(kind => <DropdownMenuItem key={kind} disabled={!inherits && requiresInheritance(kind)} onClick={() => onChange(kind)}>{t(`p4.streamSpec.kinds.${kind}`)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>;
}
function Loading() {return <div role="status" className="flex h-40 items-center justify-center text-muted-foreground"><LoaderCircleIcon className="size-5 animate-spin" /></div>;}
