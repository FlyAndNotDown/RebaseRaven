import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRightLeftIcon, ChevronDownIcon, GitBranchIcon, InfoIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import { P4MappingsEditor } from "@/components/p4/p4-mappings-editor";
import type { P4WorkspaceEdit, P4WorkspaceSettings } from "@/types/p4";

function draft(value: P4WorkspaceEdit): P4WorkspaceEdit {
  return {root:value.root, lineEnd:value.lineEnd, view:value.view, limitView:value.limitView};
}

export function P4WorkspaceDialog() {
  const { t } = useTranslation();
  const p4 = useP4();
  const { workspaceSettings, saveWorkspace } = p4;
  const [loaded, setLoaded] = useState<P4WorkspaceSettings | null>(null);
  const [edit, setEdit] = useState<P4WorkspaceEdit | null>(null);
  const [tab, setTab] = useState<"general" | "mapping">("general");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  const running = useRef(false);
  const live = useRef(true);
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useEffect(() => {
    let active = true;
    void workspaceSettings().then((value) => { if (active) { setLoaded(value); setEdit(draft(value)); setStale(false); setError(null); } }).catch((caught: unknown) => { if (active) setError(p4DisplayError(errorMessage(caught))); });
    return () => { active = false; };
  }, [workspaceSettings, attempt]);
  const blocked = saving || p4.busy;
  const dirty = loaded && edit && JSON.stringify(edit) !== JSON.stringify(draft(loaded));
  function change<K extends keyof P4WorkspaceEdit>(key: K, value: P4WorkspaceEdit[K]) { setEdit((current) => current ? {...current, [key]:value} : current); if (!stale) setError(null); }
  async function browse() {
    const picked = await open({directory:true,multiple:false,title:t("p4.workspaceFolder"),defaultPath:edit?.root || undefined});
    if (typeof picked === "string") change("root", picked);
  }
  async function save() {
    if (!edit || !loaded || blocked || stale || running.current) return;
    running.current = true; setSaving(true); setError(null);
    const clean = (lines: string[]) => lines.filter(line => line.trim());
    try {
      await saveWorkspace({...edit, view:clean(edit.view), limitView:clean(edit.limitView)}, loaded.fingerprint);
      if (live.current) p4.setWorkspaceOpen(false);
    } catch (caught) {
      if (live.current) {setError(p4DisplayError(errorMessage(caught))); setStale(errorMessage(caught) === "The workspace changed. Reload it before saving.");}
    } finally {running.current = false; if (live.current) setSaving(false);}
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) p4.setWorkspaceOpen(false); }}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!saving}>
      <DialogHeader><DialogTitle>{t("p4.editWorkspace")}</DialogTitle><DialogDescription className="font-mono text-xs">{p4.connection?.client}</DialogDescription></DialogHeader>
      {edit && loaded ? <>
        <SegmentedControl label={t("p4.workspaceSettings.section")} value={tab} onChange={setTab} options={[{value:"general",label:t("p4.workspaceSettings.general")},{value:"mapping",label:t("p4.workspaceSettings.mapping")}]} />
        <div className="min-h-0 overflow-auto py-1">
          {tab === "general" ? <div className="grid gap-4">
            {loaded.stream ? <div className="grid gap-2"><Label>{t("p4.switchStream.current")}</Label><div className="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5"><GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono text-xs" title={loaded.stream}>{loaded.stream}</span><HoverTip label={dirty ? t("p4.workspaceSettings.saveBeforeSwitch") : t("p4.switchStream.title")}><span className="shrink-0"><Button variant="ghost" size="xs" disabled={blocked || Boolean(dirty)} onClick={() => {p4.setWorkspaceOpen(false); p4.switchStream();}}><ArrowRightLeftIcon />{t("p4.switchStream.title")}</Button></span></HoverTip></div></div> : null}
            <div className="grid gap-2"><div className="flex items-center gap-2"><Label htmlFor="edit-p4-root">{t("p4.folder")}</Label><HoverTip label={t("p4.workspaceSettings.rootHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div><div className="flex gap-2"><Input id="edit-p4-root" value={edit.root} disabled={blocked} className="font-mono text-xs" onChange={(event) => change("root",event.target.value)} /><Button variant="outline" disabled={blocked} onClick={() => void browse()}>{t("p4.browse")}</Button></div></div>
            <div className="grid grid-cols-[1fr_auto] items-center gap-3"><Label>{t("p4.workspaceSettings.lineEnd")}</Label><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" disabled={blocked}>{t(`p4.workspaceSettings.lineEnds.${edit.lineEnd}`)}<ChevronDownIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{(["local","unix","win","share","mac"] as const).map((value) => <DropdownMenuItem key={value} onClick={() => change("lineEnd",value)}>{t(`p4.workspaceSettings.lineEnds.${value}`)}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>
          </div> : <div className="grid gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t(loaded.stream ? "p4.workspaceSettings.overrides" : "p4.classicClient")}</span>
              <HoverTip label={t(loaded.stream ? "p4.workspaceSettings.overrideHint" : "p4.workspaceSettings.mappingHint")}><InfoIcon className="size-3.5" /></HoverTip>
            </div>
            {loaded.stream && !loaded.limitViewSupported ? <p className="text-xs text-muted-foreground">{t("p4.workspaceSettings.unsupportedOverrides")}</p>
              : <P4MappingsEditor key={loaded.stream ? "overrides" : "view"} client={p4.connection?.client ?? ""} overrides={Boolean(loaded.stream)} value={loaded.stream ? edit.limitView : edit.view} disabled={blocked || stale} onChange={lines => change(loaded.stream ? "limitView" : "view", lines)} />}
          </div>}
        </div>
      </> : !error ? <div role="status" className="flex h-40 items-center justify-center text-muted-foreground"><LoaderCircleIcon className="size-5 animate-spin" /></div> : null}
      {error ? <div className="grid gap-2"><p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p>{stale ? <Button className="justify-self-start" size="sm" variant="outline" disabled={blocked} onClick={() => {setLoaded(null); setEdit(null); setError(null); setAttempt(value => value + 1);}}>{t("p4.workspaceSettings.reload")}</Button> : null}</div> : null}
      <DialogFooter>{!loaded && error ? <Button variant="ghost" className="mr-auto" onClick={() => {setError(null);setAttempt((value) => value + 1);}}>{t("common.retry")}</Button> : null}<Button variant="outline" disabled={saving} onClick={() => p4.setWorkspaceOpen(false)}>{t("common.cancel")}</Button><Button disabled={blocked || stale || !dirty || !edit?.root.trim()} onClick={() => void save()}>{saving ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4.save")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
