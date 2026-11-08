import { useEffect, useRef, useState } from "react";
import { InfoIcon, LoaderCircleIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { formatBytes, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { HoverTip } from "@/components/ui/tooltip";
import { createExclusiveAction, createLatestRequest } from "@/lib/async-scope";
import { gitApi } from "@/lib/git";
import { lfsError } from "@/lib/lfs";
import { useActivities, useGitPick } from "@/state/git-context";
import type { LfsAction, LfsPattern, LfsState } from "@/types/lfs";

export function LfsDialog({open, onOpenChange}: {open:boolean; onOpenChange:(open:boolean)=>void}) {
  const {snapshot}=useGitPick(["snapshot"]);
  const path=snapshot?.repo.path;
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && path ? <LfsSession key={path} repoPath={path} onClose={()=>onOpenChange(false)} /> : null}</Dialog>;
}

export function LfsSession({repoPath,onClose}: {repoPath:string;onClose:()=>void}) {
  const {t}=useTranslation();
  const {changeLfs,activeTabId}=useGitPick(["changeLfs","activeTabId"]);
  const activities=useActivities();
  const [request]=useState(createLatestRequest), [mutation]=useState(createExclusiveAction);
  const [state,setState]=useState<LfsState|null>(null), [loading,setLoading]=useState(true), [busy,setBusy]=useState(false), [cancelling,setCancelling]=useState(false);
  const [error,setError]=useState(""), [report,setReport]=useState(""), [attempt,setAttempt]=useState(0);
  const [pane,setPane]=useState("files"), [query,setQuery]=useState(""), [remote,setRemote]=useState("");
  const [include,setInclude]=useState(""),[exclude,setExclude]=useState(""),[recent,setRecent]=useState(false);
  const [pattern,setPattern]=useState(""),[literal,setLiteral]=useState(false),[lockable,setLockable]=useState(false),[removing,setRemoving]=useState<LfsPattern|null>(null);
  const live=useRef(false),cancelLoad=useRef<(()=>void)|null>(null);
  function receive(value:LfsState) {
    setState(value); setRemoving(null);
    setRemote(previous=>value.remotes.includes(previous) ? previous : value.remotes.includes("origin") ? "origin" : value.remotes[0] ?? "");
  }
  useEffect(()=>{
    live.current=true;
    const cancel=request.run(()=>gitApi.lfsState(repoPath),value=>{receive(value);setLoading(false);},caught=>{setError(lfsError(caught));setLoading(false);});
    cancelLoad.current=cancel;
    return ()=>{live.current=false;cancel();};
  },[repoPath,request,attempt]);
  const ownerBusy=activities.some(activity=>activity.tabId===activeTabId), cancellable=activities.find(activity=>activity.tabId===activeTabId && activity.cancellable);
  const blocked=loading || busy || ownerBusy;
  const available=Boolean(state?.version);
  function reload(){if(blocked || mutation.busy)return;setLoading(true);setError("");setReport("");setAttempt(value=>value+1);}
  function run(action:LfsAction){
    if(!state || blocked || !available)return;
    void mutation.run(async()=>{
      cancelLoad.current?.();setBusy(true);setCancelling(false);setError("");setReport("");
      try {
        const result=await changeLfs(repoPath,action,state.fingerprint);
        if(!live.current)return;
        if(result){receive(result.state);setReport(result.report || t("git.lfs.completed"));if(action.kind==="track")setPattern("");}
        else {setError(t("git.lfs.failed"));const value=await gitApi.lfsState(repoPath);if(live.current)receive(value);}
      }catch(caught){if(live.current)setError(lfsError(caught));}
      finally{if(live.current)setBusy(false);}
    });
  }
  async function cancel(){
    if(!cancellable || cancelling)return;setCancelling(true);
    try{if(!await gitApi.cancelActivity(cancellable.id) && live.current)setCancelling(false);}
    catch(caught){if(live.current){setCancelling(false);setError(lfsError(caught));}}
  }
  const files=state?.files.filter(file=>file.name.toLowerCase().includes(query.toLowerCase())) ?? [];
  const patterns=state?.patterns.filter(rule=>rule.tracked || rule.lockable) ?? [];
  return <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl" showCloseButton={!busy} onEscapeKeyDown={event=>{if(mutation.busy)event.preventDefault();}} onInteractOutside={event=>{if(mutation.busy)event.preventDefault();}}>
    <DialogHeader><DialogTitle>{t("git.lfs.title")}</DialogTitle><DialogDescription>{t("git.lfs.description")}</DialogDescription></DialogHeader>
    <div className="grid min-h-0 gap-4 overflow-auto py-1">
      {loading ? <div role="status" className="flex h-24 items-center justify-center"><LoaderCircleIcon className="size-5 animate-spin" /></div> : state ? <>
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{state.version?.split(" ")[0] ?? t("git.lfs.unavailable")}</Badge>{available ? <Badge variant="outline">{t(state.filtersConfigured ? "git.lfs.configured" : "git.lfs.unconfigured")}</Badge> : null}<Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={t("common.refresh")} disabled={blocked} onClick={reload}><RefreshCwIcon /></Button>{available ? <HoverTip label={t("git.lfs.setupHint")}><Button variant="outline" size="xs" disabled={blocked} onClick={()=>run({kind:"install"})}>{t("git.lfs.setup")}</Button></HoverTip> : null}</div>
        {!available ? <div className="grid gap-3 rounded-lg border p-4"><p className="text-sm">{t("git.lfs.missing")}</p><Button variant="outline" className="justify-self-start" onClick={()=>void gitApi.openExternalUrl("https://git-lfs.com/").catch(caught=>setError(lfsError(caught)))}>{t("git.lfs.installGuide")}</Button></div> : <>
          <SegmentedControl label={t("git.lfs.sections")} value={pane} onChange={setPane} disabled={busy} options={[{value:"files",label:t("git.lfs.files")},{value:"rules",label:t("git.lfs.rules")}]} />
          {pane==="files" ? <>
            <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t("git.lfs.fileCount",{count:state.files.length})}</Badge><Badge variant="outline">{formatBytes(state.files.reduce((size,file)=>size+file.size,0))}</Badge><HoverTip label={t("git.lfs.checkoutHint")}><Button variant="outline" size="xs" className="ml-auto" disabled={blocked || !state.files.length} onClick={()=>run({kind:"checkout"})}>{t("git.lfs.checkout")}</Button></HoverTip></div>
            <Input value={query} onChange={event=>setQuery(event.target.value)} placeholder={t("git.lfs.search")} aria-label={t("git.lfs.search")} className="h-8 text-xs" />
            <div className="max-h-48 overflow-auto rounded-lg border">{files.length ? files.slice(0,200).map(file=><div key={`${file.name}:${file.oid}`} className="flex items-center gap-3 border-b px-3 py-2 last:border-0"><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs" title={file.name}>{file.name}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground" title={file.oid}>{file.oid.slice(0,12)} · {formatBytes(file.size)}</p></div><Badge variant="outline" className="shrink-0 text-[10px]">{t(file.modified ? "git.lfs.modified" : file.checkout ? "git.lfs.inWorktree" : file.downloaded ? "git.lfs.cached" : "git.lfs.notCached")}</Badge></div>) : <p className="p-4 text-xs text-muted-foreground">{t(query ? "git.lfs.noMatches" : "git.lfs.noFiles")}</p>}</div>
            {files.length>200 ? <p className="text-xs text-muted-foreground">{t("git.lfs.sample",{count:200,total:files.length})}</p> : null}
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="grid gap-2"><Label htmlFor="lfs-remote">{t("git.lfs.remote")}</Label><select id="lfs-remote" value={remote} disabled={blocked || !state.remotes.length} onChange={event=>setRemote(event.target.value)} className="h-8 rounded-md border border-input bg-input/30 px-2 text-xs disabled:opacity-50">{state.remotes.length ? state.remotes.map(name=><option key={name} value={name}>{name}</option>) : <option value="">{t("git.lfs.noRemote")}</option>}</select></div>
              <div className="grid gap-3 sm:grid-cols-2"><FilterField id="lfs-include" label={t("git.lfs.include")} value={include} onChange={setInclude} disabled={blocked} /><FilterField id="lfs-exclude" label={t("git.lfs.exclude")} value={exclude} onChange={setExclude} disabled={blocked} /></div>
              <div className="flex items-center gap-2"><Label className="text-xs"><Checkbox checked={recent} disabled={blocked} onCheckedChange={value=>setRecent(value===true)} />{t("git.lfs.recent")}</Label><HoverTip label={t("git.lfs.filterHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div>
              <div className="flex flex-wrap gap-2"><HoverTip label={t("git.lfs.fetchHint")}><Button variant="outline" size="sm" disabled={blocked || !remote} onClick={()=>run({kind:"fetch",remote,include,exclude,recent})}>{t("git.lfs.fetch")}</Button></HoverTip><HoverTip label={t("git.lfs.pullHint")}><Button size="sm" disabled={blocked || !remote} onClick={()=>run({kind:"pull",remote,include,exclude})}>{t("git.lfs.pull")}</Button></HoverTip><HoverTip label={t("git.lfs.pushHint")}><Button variant="ghost" size="sm" className="sm:ml-auto" disabled={blocked || !remote || !state.files.length} onClick={()=>run({kind:"push",remote})}>{t("git.lfs.push")}</Button></HoverTip></div>
            </div>
          </> : <>
            <div className="grid gap-3 rounded-lg border p-3"><div className="grid gap-2"><div className="flex items-center gap-2"><Label htmlFor="lfs-pattern">{t("git.lfs.pattern")}</Label><HoverTip label={t("git.lfs.trackHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div><Input id="lfs-pattern" value={pattern} disabled={blocked} onChange={event=>setPattern(event.target.value)} placeholder={t("git.lfs.patternPlaceholder")} className="font-mono text-xs" /></div><div className="flex flex-wrap items-center gap-4"><Label className="text-xs"><Checkbox checked={literal} disabled={blocked} onCheckedChange={value=>setLiteral(value===true)} />{t("git.lfs.literal")}</Label><HoverTip label={t("git.lfs.lockableHint")}><Label className="text-xs"><Checkbox checked={lockable} disabled={blocked} onCheckedChange={value=>setLockable(value===true)} />{t("git.lfs.lockable")}</Label></HoverTip><Button size="sm" className="ml-auto" disabled={blocked || !pattern.trim()} onClick={()=>run({kind:"track",pattern,literal,lockable})}>{t("git.lfs.track")}</Button></div></div>
            <div className="max-h-64 overflow-auto rounded-lg border">{patterns.length ? patterns.map(rule=><div key={`${rule.source}:${rule.pattern}`} className="grid gap-2 border-b px-3 py-2 last:border-0"><div className="flex items-center gap-2"><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs" title={rule.pattern}>{rule.pattern}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={rule.source}>{rule.source}</p></div>{rule.lockable ? <Badge variant="outline" className="text-[10px]">{t("git.lfs.lockable")}</Badge> : null}<HoverTip label={t(rule.editable ? "git.lfs.untrackHint" : "git.lfs.inheritedHint")}><span><Button variant="ghost" size="icon-xs" disabled={blocked || !rule.editable} aria-label={t("git.lfs.removeNamed",{pattern:rule.pattern})} onClick={()=>setRemoving(rule)}><Trash2Icon /></Button></span></HoverTip></div>{removing?.source===rule.source && removing.pattern===rule.pattern ? <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 p-2"><p className="mr-auto text-xs">{t("git.lfs.removeConfirm")}</p><Button variant="ghost" size="xs" disabled={blocked} onClick={()=>setRemoving(null)}>{t("common.cancel")}</Button><Button variant="destructive" size="xs" disabled={blocked} onClick={()=>run({kind:"untrack",pattern:rule.pattern,source:rule.source})}>{t("git.lfs.remove")}</Button></div> : null}</div>) : <p className="p-4 text-xs text-muted-foreground">{t("git.lfs.noRules")}</p>}</div>
          </>}
        </>}
      </> : null}
      {report ? <pre role="status" className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/10 p-3 font-mono text-xs leading-relaxed">{report}</pre> : null}
      {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    </div>
    <DialogFooter>{busy ? <Button variant="outline" className="sm:mr-auto" disabled={!cancellable || cancelling} onClick={()=>void cancel()}>{t(cancelling ? "git.sparse.cancelling" : "git.sparse.cancel")}</Button> : !state && error ? <Button variant="ghost" className="sm:mr-auto" onClick={reload}>{t("common.retry")}</Button> : null}<Button variant="outline" disabled={busy} onClick={onClose}>{t("common.close")}</Button></DialogFooter>
  </DialogContent>;
}

function FilterField({id,label,value,onChange,disabled}:{id:string;label:string;value:string;onChange:(value:string)=>void;disabled:boolean}){
  const {t}=useTranslation();
  return <div className="grid gap-2"><Label htmlFor={id} className="text-xs">{label}</Label><Input id={id} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)} placeholder={t("git.lfs.configuredFilter")} className="h-8 font-mono text-xs" /></div>;
}
