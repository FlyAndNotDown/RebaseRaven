import { ChoiceSelect } from "@/components/ui/choice-select";
import { t, useTranslation } from "@/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileIcon, FolderIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/ui/tooltip";
import { P4RevisionPicker } from "@/components/p4/p4-revision-picker";
import { p4Api, relativeToRoot } from "@/lib/p4";
import { errorMessage } from "@/lib/git";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4RevisionMode, P4RevisionPath } from "@/types/p4";

type RevisionKind = Exclude<P4RevisionMode, "latest" | "beforeChangelist">;
export type P4RevisionTarget = { path: string; recursive: boolean; label?: string; revision?: string } | { changeId: string; revision?: string };

export function P4GetRevisionDialog({ target, onClose }: { target: P4RevisionTarget; onClose: () => void }) {
  useTranslation();
  const group = useId();
  const { connection, getRevision, busy: workspaceBusy } = useP4();
  const path = "path" in target ? target.path : null;
  const recursive = "recursive" in target && target.recursive;
  const changeId = "changeId" in target ? target.changeId : null;
  const label = "label" in target ? target.label : undefined;
  const [targets, setTargets] = useState<P4RevisionPath[]>(path ? [{path,recursive}] : []);
  const [scopeLoading, setScopeLoading] = useState(Boolean(changeId));
  const [scopeError, setScopeError] = useState<string|null>(null);
  const [scopeAttempt, setScopeAttempt] = useState(0);
  const [latest, setLatest] = useState(!changeId && !label && !target.revision);
  const [kind, setKind] = useState<RevisionKind>(label ? "label" : changeId ? "changelist" : "revision");
  const [value, setValue] = useState(label ?? target.revision ?? changeId ?? "");
  const [before, setBefore] = useState(false);
  const [force, setForce] = useState(false);
  const [safe, setSafe] = useState(false);
  const [filesOnly, setFilesOnly] = useState(false);
  const [removeMissing, setRemoveMissing] = useState(true);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState<"preview" | "sync" | null>(null);
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [folder, setFolder] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const running = useRef(false);
  const kinds: {id:RevisionKind; label:string; placeholder:string}[] = [
    {id:"revision",label:t("p4.revision"),placeholder:t("p4.enterRevisionNumber")},
    {id:"changelist",label:t("p4.changelist"),placeholder:t("p4.enterChangelistNumber")},
    {id:"datetime",label:t("p4.dateTime"),placeholder:"yyyy/mm/dd:hh:mm:ss"},
    {id:"label",label:t("p4.label"),placeholder:t("p4.enterLabel")},
    {id:"workspace",label:t("p4.workspace"),placeholder:t("p4.enterWorkspace")},
  ];
  useEffect(() => {
    if (!changeId || !connection) return;
    let live = true;
    void p4Api.revisionTargets(connection, changeId).then(paths => {
      if (live) {setTargets(paths.map(path => ({path,recursive:false})));setScopeError(null);}
    }).catch(caught => {if (live) setScopeError(errorMessage(caught));}).finally(() => {if (live) setScopeLoading(false);});
    return () => {live = false;};
  }, [changeId, connection, scopeAttempt]);
  const blocked = busy !== null || workspaceBusy || scopeLoading;
  const invalid = !targets.length || (!latest && (!value.trim() || (["revision","changelist"].includes(kind) && !/^[1-9]\d*$/.test(value.trim()))));
  const canBrowse = kind === "changelist" || kind === "label" || kind === "workspace";
  function invalidate() {setPreview("");}
  function addPaths(paths:string[]) {
    const entries = paths.map(path => ({path:path.trim(), recursive:folder})).filter(item => item.path);
    setTargets(current => [...current,...entries.filter(item => !current.some(old => old.path === item.path && old.recursive === item.recursive))]);
    setNewPath("");invalidate();
  }
  async function browsePaths() {
    try {
      const selected = await open({multiple:true,directory:folder,defaultPath:connection?.root,title:t("p4.addRevisionTarget")});
      if (selected) addPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (caught) {toast.error(errorMessage(caught));}
  }
  async function run(previewing:boolean) {
    if (running.current || blocked || invalid) return;
    running.current = true;setBusy(previewing ? "preview" : "sync");invalidate();
    try {
      const output = await getRevision({paths:[],targets,mode:latest ? "latest" : kind === "changelist" && before ? "beforeChangelist" : kind,value:latest ? "" : value.trim(),force,safe,changelistFilesOnly:!latest && kind === "changelist" && !before && filesOnly,removeNotInLabel:latest || kind !== "label" || removeMissing,preview:previewing});
      if (output === null) return;
      if (previewing) setPreview(output.trim() || t("p4.upToDate"));else onClose();
    } catch { /* The operation reports errors. */ }
    finally {running.current=false;setBusy(null);}
  }
  return <Dialog open onOpenChange={open => {if (!open && !running.current) onClose();}}>
    <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{t("p4.getRevision")}</DialogTitle><DialogDescription className="sr-only">{t("p4.revisionTargets")}</DialogDescription></DialogHeader>
      <div className="grid gap-4">
        <section className="grid gap-2">
          <div className="flex items-center justify-between"><h3 className="text-xs font-medium">{t("p4.revisionTargets")}</h3><Button variant="ghost" size="xs" disabled={blocked} onClick={() => setAdding(value => !value)}><PlusIcon />{t("common.add")}</Button></div>
          <div className="max-h-36 overflow-auto rounded-lg border">
            {targets.map((item,index) => <div key={`${item.path}:${item.recursive}`} className="flex h-9 items-center gap-2 px-2 text-xs">{item.recursive ? <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />}<span title={item.path} className="min-w-0 flex-1 truncate font-mono">{connection ? relativeToRoot(connection.root,item.path) || item.path : item.path}{item.recursive ? "/..." : ""}</span><HoverTip label={t("common.remove")}><Button variant="ghost" size="icon-xs" disabled={blocked} aria-label={t("common.remove")} onClick={() => {setTargets(current => current.filter((_,position) => index !== position));invalidate();}}><Trash2Icon /></Button></HoverTip></div>)}
            {scopeLoading ? <p role="status" className="p-3 text-xs text-muted-foreground">{t("p4.revisionTargetsLoading")}</p> : scopeError ? <div className="grid gap-2 p-3"><p role="alert" className="text-xs text-destructive">{scopeError}</p><Button variant="outline" size="sm" onClick={() => {setScopeLoading(true);setScopeAttempt(value => value+1);}}>{t("common.retry")}</Button></div> : !targets.length ? <p className="p-3 text-xs text-muted-foreground">{t("p4.emptyRevisionTargets")}</p> : null}
          </div>
          {adding ? <div className="flex flex-wrap gap-2"><ChoiceSelect aria-label={t("p4.targetPath")} className="w-28" value={folder ? "folder" : "file"} disabled={blocked} onValueChange={value => setFolder(value === "folder")} options={[{value:"file",label:t("p4.targetFile")},{value:"folder",label:t("p4.targetFolder")}]} /><Input autoFocus value={newPath} aria-label={t("p4.targetPath")} placeholder="//depot/path" className="min-w-40 flex-1 font-mono" disabled={blocked} onChange={event => setNewPath(event.target.value)} onKeyDown={event => {if (event.key === "Enter") {event.preventDefault();addPaths([newPath]);}}} /><Button size="sm" variant="outline" disabled={blocked} onClick={() => void browsePaths()}>{t("p4.browse")}</Button><Button size="sm" disabled={blocked || !newPath.trim()} onClick={() => addPaths([newPath])}>{t("common.add")}</Button></div> : null}
        </section>
        <fieldset className="grid gap-3" disabled={blocked}>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name={group} className="size-3.5 accent-foreground" checked={latest} onChange={() => {setLatest(true);invalidate();}} />{t("p4.getLatestRevision")}</label>
          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={group} className="size-3.5 accent-foreground" checked={!latest} onChange={() => {setLatest(false);invalidate();}} />{t("p4.specifyRevisionUsing")}</label>
            <div className="flex flex-wrap gap-2 pl-5">
              <ChoiceSelect aria-label={t("p4.revisionType")} className="w-36" value={kind} disabled={latest || blocked} onValueChange={next => {setKind(next);setValue("");setBefore(false);invalidate();}} options={kinds.map(item => ({value:item.id,label:item.label}))} />
              {kind === "changelist" ? <ChoiceSelect aria-label={t("p4.atChangelist")} className="w-40" value={before ? "before" : "at"} disabled={latest || blocked} onValueChange={next => {setBefore(next === "before");invalidate();}} options={[{value:"at",label:t("p4.atChangelist")},{value:"before",label:t("p4.beforeChangelist")}]} /> : null}
              <Input value={value} disabled={latest || blocked} placeholder={kinds.find(item => item.id === kind)?.placeholder} aria-label={t("p4.revision")} spellCheck={false} className="min-w-32 flex-1 font-mono" onChange={event => {setValue(event.target.value);invalidate();}} />
              {canBrowse ? <Button size="sm" variant="outline" disabled={latest || blocked} onClick={() => setBrowsing(true)}>{t("p4.browse")}</Button> : null}
            </div>
          </div>
          <div className="grid gap-2 border-t pt-3">
            <h3 className="text-xs font-medium">{t("p4.options")}</h3>
            <Option checked={force} disabled={blocked} onCheckedChange={checked => {setForce(checked);if (checked) setSafe(false);invalidate();}} label={t("p4.forceOverwrite")} tip={t("p4.replaceTheFileEvenWhenYouAlreadyHaveThatRevision")} />
            <Option checked={safe} disabled={blocked} onCheckedChange={checked => {setSafe(checked);if (checked) setForce(false);invalidate();}} label={t("p4.safeUpdate")} tip={t("p4.keepFilesChangedWithoutBeingCheckedOut")} />
            {!latest && kind === "changelist" && !before ? <Option checked={filesOnly} disabled={blocked} onCheckedChange={checked => {setFilesOnly(checked);invalidate();}} label={t("p4.changelistFilesOnly")} tip={t("p4.getRevisionsOnlyForFilesListedInThisChangelist")} /> : null}
            {!latest && kind === "label" ? <Option checked={removeMissing} disabled={blocked} onCheckedChange={checked => {setRemoveMissing(checked);invalidate();}} label={t("p4.removeFilesMissingFromLabel")} tip={t("p4.removeWorkspaceFilesThatAreAbsentFromThisLabel")} /> : null}
          </div>
        </fieldset>
        {preview ? <pre role="status" tabIndex={0} className="max-h-44 overflow-auto rounded-lg border bg-background/40 p-3 font-mono text-[11px] whitespace-pre-wrap">{preview}</pre> : null}
      </div>
      <DialogFooter className="sm:justify-between"><Button variant="outline" disabled={blocked || invalid} onClick={() => void run(true)}>{busy === "preview" ? <Loader2Icon className="animate-spin" /> : null}{t("p4.preview")}</Button><div className="flex gap-2"><Button variant="outline" disabled={busy !== null} onClick={onClose}>{t("p4.cancel")}</Button><Button disabled={blocked || invalid} onClick={() => void run(false)}>{busy === "sync" ? <Loader2Icon className="animate-spin" /> : null}{t("p4.getRevision")}</Button></div></DialogFooter>
      {browsing && canBrowse ? <P4RevisionPicker kind={kind} onSelect={value => {setValue(value);invalidate();}} onClose={() => setBrowsing(false)} /> : null}
    </DialogContent>
  </Dialog>;
}

function Option({
  checked,
  disabled,
  onCheckedChange,
  label,
  tip,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  tip: string;
}) {
  useTranslation();
  return (
    <label className={cn("flex items-start gap-2 text-xs leading-snug", disabled && "opacity-50")}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        className="mt-0.5"
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <HoverTip label={tip}><span>{label}</span></HoverTip>
    </label>
  );
}
