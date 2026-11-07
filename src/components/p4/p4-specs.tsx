import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, DownloadIcon, GitBranchIcon, InfoIcon, LoaderCircleIcon, LockKeyholeIcon, PencilIcon, PlusIcon, RefreshCwIcon, TagIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { P4GetRevisionDialog } from "@/components/p4/p4-get-revision-dialog";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4LabelFiles, P4LabelTagPreview, P4LabelTagRequest, P4Spec, P4SpecEdit, P4SpecKind, P4SpecPage } from "@/types/p4-specs";

export function P4Specs() {
  const { t } = useTranslation();
  const p4 = useP4();
  const [kind, setKind] = useState<P4SpecKind>("label");
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<{ key: string; value: P4SpecPage } | null>(null);
  const [error, setError] = useState<{ key: string; value: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<P4Spec | "new" | null>(null);
  const owner = mine ? p4.connection?.user ?? "" : "";
  const key = JSON.stringify([kind, query, owner, attempt]);
  const items = page?.key === key ? page.value.items : null;
  const shownError = error?.key === key ? error.value : null;
  const reload = () => setAttempt(value => value + 1);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void p4.specs.list(kind, query, owner).then(value => {
        if (live) setPage({ key, value });
      }).catch((caught: unknown) => {
        if (live) setError({ key, value: p4DisplayError(errorMessage(caught)) });
      });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [p4.specs, kind, query, owner, key]);

  function switchKind(next: P4SpecKind) { setKind(next); setSelected(null); setQuery(""); }
  const Icon = kind === "label" ? TagIcon : GitBranchIcon;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
      <SegmentedControl label={t("p4.specs.title")} value={kind} onChange={switchKind} disabled={p4.busy} options={[{value:"label",label:t("p4.specs.labels")},{value:"branch",label:t("p4.specs.branches")}]} />
      <Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t("p4.specs.filter")} placeholder={t("p4.specs.filter")} className="h-7 max-w-60 font-mono text-xs" />
      <Label className="ml-1 text-xs text-muted-foreground"><Checkbox checked={mine} onCheckedChange={value => setMine(value === true)} />{t("p4.specs.mine")}</Label>
      <div className="ml-auto flex gap-1">
        <HoverTip label={t("p4.refresh")}><Button variant="ghost" size="icon-xs" aria-label={t("p4.refresh")} disabled={p4.busy} onClick={reload}><RefreshCwIcon /></Button></HoverTip>
        <Button variant="outline" size="sm" disabled={p4.busy} onClick={() => setEditing("new")}><PlusIcon />{t(kind === "label" ? "p4.specs.newLabel" : "p4.specs.newBranch")}</Button>
      </div>
    </div>
    {shownError ? <p role="alert" className="border-b p-3 text-xs text-destructive">{shownError}</p> : null}
    {page?.key === key && page.value.truncated ? <p className="border-b px-3 py-2 text-xs text-muted-foreground">{t("p4.specs.listLimit")}</p> : null}
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="p4-spec-list" defaultSize="36%" minSize="25%">
        <div className="absolute inset-0 overflow-auto p-1" role="list" aria-label={t(kind === "label" ? "p4.specs.labels" : "p4.specs.branches")}>
          {items ? items.length ? items.map(item => <button key={item.name} type="button" aria-pressed={selected === item.name} onClick={() => setSelected(item.name)} className={cn("flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left hover:bg-muted/60", selected === item.name && "bg-muted")}>
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs" title={item.name}>{item.name}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.description.trim() || item.owner}</span></span>
          </button>) : <p className="p-6 text-center text-xs text-muted-foreground">{t("p4.specs.noMatches")}</p> : !shownError ? <Loading /> : null}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-spec-detail" defaultSize="64%" minSize="35%">
        {selected ? <SpecInspector key={`${kind}:${selected}:${attempt}`} kind={kind} name={selected} onEdit={setEditing} onDeleted={() => {setSelected(null); reload();}} /> : <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">{t("p4.specs.select")}</div>}
      </ResizablePanel>
    </ResizablePanelGroup>
    {editing ? <SpecEditor kind={kind} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={value => {setEditing(null); setSelected(value.name); setQuery(""); reload();}} /> : null}
  </div>;
}

function SpecInspector({kind, name, onEdit, onDeleted}: {kind:P4SpecKind; name:string; onEdit:(spec:P4Spec)=>void; onDeleted:()=>void}) {
  const { t } = useTranslation();
  const p4 = useP4();
  const [spec, setSpec] = useState<P4Spec | null>(null);
  const [files, setFiles] = useState<P4LabelFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tagging, setTagging] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let live = true;
    void p4.specs.read(kind, name).then(value => {if (live) setSpec(value);}).catch((caught:unknown) => {if (live) setError(p4DisplayError(errorMessage(caught)));});
    if (kind === "label") void p4.specs.files(name).then(value => {if (live) setFiles(value);}).catch((caught:unknown) => {if (live) setError(p4DisplayError(errorMessage(caught)));});
    return () => {live = false;};
  }, [p4.specs,kind,name,attempt]);
  return <div className="absolute inset-0 overflow-auto p-5">
    {spec ? <div className="mx-auto grid max-w-2xl gap-5">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><h2 className="flex items-center gap-2 break-all font-mono text-base font-medium">{spec.name}{spec.locked ? <HoverTip label={t("p4.specs.locked")}><LockKeyholeIcon className="size-3.5 shrink-0 text-muted-foreground" /></HoverTip> : null}</h2><p className="mt-1 text-xs text-muted-foreground">{spec.owner}</p></div><HoverTip label={t("p4.specs.edit")}><Button variant="outline" size="icon-sm" aria-label={t("p4.specs.edit")} disabled={p4.busy} onClick={() => onEdit(spec)}><PencilIcon /></Button></HoverTip><HoverTip label={t("p4.specs.delete")}><Button variant="ghost" size="icon-sm" aria-label={t("p4.specs.delete")} disabled={p4.busy} onClick={() => setDeleting(true)}><Trash2Icon /></Button></HoverTip></div>
      <p className="whitespace-pre-wrap break-words text-sm">{spec.description}</p>
      {spec.revision ? <div className="flex items-center gap-2 text-xs"><span className="text-muted-foreground">{t("p4.specs.autoRevision")}</span><code className="rounded border px-2 py-1">{spec.revision}</code></div> : null}
      <div className="overflow-hidden rounded-lg border"><p className="border-b bg-muted/20 px-3 py-2 text-xs font-medium">{t("p4.specs.view")}</p><pre className="overflow-auto p-3 font-mono text-xs leading-relaxed">{spec.view.join("\n")}</pre></div>
      {kind === "label" ? <>
        <div className="flex gap-2"><Button variant="outline" size="sm" disabled={p4.busy} onClick={() => setSyncing(true)}><DownloadIcon />{t("p4.specs.sync")}</Button><HoverTip label={t(spec.revision ? "p4.specs.autoHint" : spec.locked ? "p4.specs.lockHint" : "p4.specs.tagHint")}><span><Button variant="outline" size="sm" disabled={p4.busy || spec.locked || Boolean(spec.revision)} onClick={() => setTagging(true)}><TagIcon />{t("p4.specs.tag")}</Button></span></HoverTip></div>
        <div className="overflow-hidden rounded-lg border"><p className="flex items-center border-b bg-muted/20 px-3 py-2 text-xs font-medium">{t("p4.specs.files")}<span className="ml-auto text-muted-foreground tabular-nums">{files?.files.length ?? ""}</span></p>{files ? <>{files.files.length ? files.files.map(file => <div key={file.depotPath} className="flex items-center gap-3 border-b px-3 py-2 text-xs last:border-0"><code className="min-w-0 flex-1 truncate" title={file.depotPath}>{file.depotPath}</code><code className="shrink-0 text-muted-foreground">#{file.revision}</code><span className="w-16 truncate text-right text-muted-foreground">{file.fileType}</span></div>) : <p className="p-5 text-center text-xs text-muted-foreground">{t("p4.specs.noFiles")}</p>}{files.truncated ? <p className="border-t p-3 text-xs text-muted-foreground">{t("p4.specs.filesLimit")}</p> : null}</> : !error ? <Loading /> : null}</div>
      </> : null}
    </div> : !error ? <Loading /> : null}
    {error ? <div className="mt-4 grid gap-3"><p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p><Button variant="outline" size="sm" className="justify-self-start" onClick={() => {setError(null); setAttempt(value => value + 1);}}>{t("common.retry")}</Button></div> : null}
    {spec && deleting ? <DeleteSpec spec={spec} onClose={() => setDeleting(false)} onDeleted={onDeleted} /> : null}
    {spec && tagging ? <TagLabel spec={spec} onClose={() => setTagging(false)} onApplied={() => {setTagging(false); setAttempt(value => value + 1);}} /> : null}
    {spec && syncing && p4.connection ? <P4GetRevisionDialog target={{path:p4.connection.root,recursive:true,label:spec.name}} onClose={() => setSyncing(false)} /> : null}
  </div>;
}

function SpecEditor({kind, initial, onClose, onSaved}: {kind:P4SpecKind; initial:P4Spec|null; onClose:()=>void; onSaved:(spec:P4Spec)=>void}) {
  const { t } = useTranslation();
  const p4 = useP4();
  const [edit, setEdit] = useState<P4SpecEdit>(initial ?? {kind,name:"",owner:p4.connection?.user ?? "",description:"",view:[kind === "label" ? `${p4.connection?.stream ?? "/"}/...` : ""],locked:false,revision:""});
  const [error, setError] = useState<string|null>(null);
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const blocked = saving || p4.busy;
  function change<K extends keyof P4SpecEdit>(key:K, value:P4SpecEdit[K]) {setEdit(current => ({...current,[key]:value})); setError(null);}
  async function save() {
    if (running.current || blocked) return;
    running.current = true; setSaving(true); setError(null);
    try {onSaved(await p4.specs.save({...edit,view:edit.view.map(line => line.trim()).filter(Boolean)},initial?.fingerprint ?? null));}
    catch (caught) {setError(p4DisplayError(errorMessage(caught)));}
    finally {running.current = false; setSaving(false);}
  }
  return <Dialog open onOpenChange={open => {if (!open && !saving) onClose();}}><DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl" showCloseButton={!saving}>
    <DialogHeader><DialogTitle>{t(initial ? "p4.specs.edit" : kind === "label" ? "p4.specs.newLabel" : "p4.specs.newBranch")}</DialogTitle><DialogDescription>{t(kind === "label" ? "p4.specs.labelDescription" : "p4.specs.branchDescription")}</DialogDescription></DialogHeader>
    <div className="grid min-h-0 gap-4 overflow-auto py-1">
      <div className="grid grid-cols-2 gap-3"><div className="grid gap-2"><Label htmlFor="p4-spec-name">{t("p4.specs.name")}</Label><Input id="p4-spec-name" value={edit.name} readOnly={Boolean(initial)} disabled={blocked} className="font-mono text-xs" onChange={event => change("name",event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="p4-spec-owner">{t("p4.specs.owner")}</Label><Input id="p4-spec-owner" value={edit.owner} disabled={blocked} className="font-mono text-xs" onChange={event => change("owner",event.target.value)} /></div></div>
      <div className="grid gap-2"><Label htmlFor="p4-spec-description">{t("p4.specs.description")}</Label><Textarea id="p4-spec-description" value={edit.description} disabled={blocked} onChange={event => change("description",event.target.value)} className="h-20 min-h-20 resize-none text-sm [field-sizing:fixed]" /></div>
      <div className="grid gap-2"><Label htmlFor="p4-spec-view">{t("p4.specs.view")}</Label><Textarea id="p4-spec-view" value={edit.view.join("\n")} disabled={blocked} onChange={event => change("view",event.target.value.split("\n"))} placeholder={t(kind === "label" ? "p4.specs.labelViewPlaceholder" : "p4.specs.branchViewPlaceholder")} spellCheck={false} className="h-32 min-h-32 resize-none whitespace-pre font-mono text-xs [field-sizing:fixed]" /></div>
      {kind === "label" ? <div className="grid gap-2"><div className="flex items-center gap-2"><Label htmlFor="p4-spec-revision">{t("p4.specs.autoRevision")}</Label><HoverTip label={t("p4.specs.autoHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div><Input id="p4-spec-revision" value={edit.revision} disabled={blocked} className="font-mono text-xs" placeholder={t("p4.specs.revisionPlaceholder")} onChange={event => change("revision",event.target.value)} /></div> : null}
      <Label className="text-xs"><Checkbox checked={edit.locked} disabled={blocked} onCheckedChange={value => change("locked",value === true)} />{t("p4.specs.locked")}</Label>
    </div>
    {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter><Button variant="outline" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button><Button disabled={blocked || !edit.name.trim() || !edit.owner.trim() || !edit.description.trim() || !edit.view.some(line => line.trim())} onClick={() => void save()}>{saving ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function DeleteSpec({spec,onClose,onDeleted}: {spec:P4Spec;onClose:()=>void;onDeleted:()=>void}) {
  const {t} = useTranslation();
  const p4 = useP4();
  const [name,setName] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const running = useRef(false);
  async function remove() {
    if (running.current || p4.busy || name !== spec.name) return;
    running.current = true; setBusy(true); setError(null);
    try {await p4.specs.remove(spec.kind,spec.name,spec.fingerprint); onDeleted();}
    catch (caught) {setError(p4DisplayError(errorMessage(caught)));}
    finally {running.current = false; setBusy(false);}
  }
  return <Dialog open onOpenChange={open => {if (!open && !busy) onClose();}}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>{t("p4.specs.delete")}</DialogTitle><DialogDescription>{t("p4.specs.deleteHint",{name:spec.name})}</DialogDescription></DialogHeader><Input value={name} disabled={busy} className="font-mono text-xs" aria-label={t("p4.specs.confirmName")} onChange={event => setName(event.target.value)} />{error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}<DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button variant="destructive" disabled={busy || p4.busy || name !== spec.name} onClick={() => void remove()}>{t("p4.specs.delete")}</Button></DialogFooter></DialogContent></Dialog>;
}

function TagLabel({spec,onClose,onApplied}: {spec:P4Spec;onClose:()=>void;onApplied:()=>void}) {
  const {t} = useTranslation();
  const p4 = useP4();
  const [request,setRequest] = useState<P4LabelTagRequest>({name:spec.name,paths:[`//${p4.connection?.client ?? ""}/...`],mode:"workspace",value:"",remove:false});
  const [preview,setPreview] = useState<{key:string;value:P4LabelTagPreview}|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState<"preview"|"apply"|null>(null);
  const running = useRef(false);
  const key = JSON.stringify(request);
  const blocked = Boolean(busy) || p4.busy;
  function change<K extends keyof P4LabelTagRequest>(field:K,value:P4LabelTagRequest[K]) {setRequest(current => ({...current,[field]:value})); setPreview(null); setError(null);}
  async function run(apply:boolean) {
    if (running.current || blocked) return;
    running.current = true; setBusy(apply ? "apply" : "preview"); setError(null);
    try {
      if (apply) {if (preview?.key !== key) return; await p4.specs.applyTag(request,preview.value.fingerprint); onApplied();}
      else setPreview({key,value:await p4.specs.previewTag(request)});
    } catch (caught) {setPreview(null); setError(p4DisplayError(errorMessage(caught)));}
    finally {running.current = false; setBusy(null);}
  }
  return <Dialog open onOpenChange={open => {if (!open && busy !== "apply") onClose();}}><DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl" showCloseButton={busy !== "apply"}>
    <DialogHeader><DialogTitle>{t("p4.specs.tag")}</DialogTitle><DialogDescription className="font-mono text-xs">{spec.name}</DialogDescription></DialogHeader>
    <div className="grid gap-3">
      <div className="grid gap-2"><Label htmlFor="p4-tag-paths">{t("p4.specs.paths")}</Label><Textarea id="p4-tag-paths" value={request.paths.join("\n")} disabled={blocked} spellCheck={false} onChange={event => change("paths",event.target.value.split("\n"))} className="h-20 min-h-20 resize-none font-mono text-xs [field-sizing:fixed]" /></div>
      <div className="flex items-center gap-2"><Label className="mr-auto text-xs">{t("p4.specs.source")}</Label><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={blocked || request.remove}>{t(`p4.specs.sources.${request.mode}`)}<ChevronDownIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{(["workspace","latest","changelist","revision"] as const).map(mode => <DropdownMenuItem key={mode} onClick={() => change("mode",mode)}>{t(`p4.specs.sources.${mode}`)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>{!request.remove && (request.mode === "revision" || request.mode === "changelist") ? <Input value={request.value} aria-label={t("p4.specs.sourceValue")} disabled={blocked} className="h-7 w-28 font-mono text-xs" onChange={event => change("value",event.target.value)} /> : null}</div>
      <Label className="text-xs"><Checkbox checked={request.remove} disabled={blocked} onCheckedChange={value => change("remove",value === true)} />{t("p4.specs.removeTags")}</Label>
    </div>
    <div className="min-h-24 overflow-auto rounded-md border bg-muted/10 p-3"><pre className="max-h-[30vh] whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">{preview?.key === key ? preview.value.output || t("p4-operations.noChanges") : t("p4-operations.previewRequired")}</pre></div>
    {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter><Button variant="outline" disabled={busy === "apply"} onClick={onClose}>{t("common.cancel")}</Button><Button variant="outline" disabled={blocked || !request.paths.some(Boolean)} onClick={() => void run(false)}>{busy === "preview" ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4-operations.preview")}</Button><Button disabled={blocked || preview?.key !== key || !preview.value.output.trim()} onClick={() => void run(true)}>{busy === "apply" ? <LoaderCircleIcon className="animate-spin" /> : <TagIcon />}{t("p4.specs.applyTags")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function Loading() {return <div role="status" className="flex min-h-32 items-center justify-center"><LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" /></div>;}
