import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ArrowDownIcon, ArrowRightLeftIcon, ChevronDownIcon, ChevronRightIcon, GitBranchIcon, GitMergeIcon, LoaderCircleIcon, LocateFixedIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/ui/tooltip";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/git";
import { depotBase } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { streamRelation, streamRows } from "@/lib/p4-stream-tree";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { useP4 } from "@/state/p4-context";
import type { P4StreamOption } from "@/types/p4";

export function P4Streams() {
  const { t } = useTranslation();
  const p4=useP4();const {listStreams}=p4;
  const [streams,setStreams]=useState<P4StreamOption[]|null>(null);
  const [query,setQuery]=useState("");const [picked,setPicked]=useState<string|null>(null);
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  const [loading,setLoading]=useState(true);const [error,setError]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{let active=true;void listStreams().then((value)=>{if(active){setStreams(value);setError(null);}}).catch((caught:unknown)=>{if(active)setError(p4DisplayError(errorMessage(caught)));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[listStreams,attempt]);
  const rows=useMemo(()=>streamRows(streams??[],query,collapsed),[streams,query,collapsed]);
  const current=streams?.find(stream=>stream.path===p4.connection?.stream);
  const selected=streams?.find(stream=>stream.path===(picked??current?.path))??current??streams?.[0];
  const parent=streams?.find(stream=>stream.path===selected?.parent);
  const children=streams?.filter(stream=>stream.parent===selected?.path)??[];
  const relation=selected?streamRelation(current,selected):"other";
  const canMerge=Boolean(current&&current.kind!=="virtual"&&(relation==="parent"||relation==="current")&&current.parent?.startsWith("//"));
  const canCopy=Boolean(current&&current.kind!=="virtual"&&selected?.kind!=="virtual"&&relation==="child");
  const blocked=loading||p4.busy;
  const focusPath=rows.some(row=>row.stream.path===selected?.path)?selected?.path:rows[0]?.stream.path;
  const {viewportRef,viewport,start,end,before,after}=useWindowedRows(rows.length,40);
  useEffect(()=>{
    if(picked||query||!current)return;
    const index=rows.findIndex(row=>row.stream.path===current.path);
    if(viewport&&index>=0)viewport.scrollTo({top:Math.max(0,index*40-120)});
  },[rows,current,picked,query,viewport]);
  function navigate(event:KeyboardEvent<HTMLButtonElement>, index:number) {
    const row=rows[index];let next=index;
    if(event.key==="ArrowDown")next=Math.min(rows.length-1,index+1);
    else if(event.key==="ArrowUp")next=Math.max(0,index-1);
    else if(event.key==="Home")next=0;
    else if(event.key==="End")next=rows.length-1;
    else if(event.key==="ArrowRight"&&row.children){if(collapsed.has(row.stream.path)&&!query){toggle(row.stream.path);}else if(rows[index+1]?.depth>row.depth)next=index+1;}
    else if(event.key==="ArrowLeft"){if(row.children&&!collapsed.has(row.stream.path)&&!query){toggle(row.stream.path);}else{const parent=rows.findIndex(item=>item.stream.path===row.stream.parent);if(parent>=0)next=parent;}}
    else return;
    event.preventDefault();event.stopPropagation();
    const path=rows[next].stream.path;setPicked(path);
    if(viewport){if(next*40<viewport.scrollTop)viewport.scrollTo({top:next*40});else if((next+1)*40>viewport.scrollTop+viewport.clientHeight)viewport.scrollTo({top:(next+1)*40-viewport.clientHeight});}
    requestAnimationFrame(()=>viewport?.querySelector<HTMLButtonElement>(`[data-stream-path="${CSS.escape(path)}"]`)?.focus());
  }
  function locate(){setQuery("");setCollapsed(new Set());setPicked(null);}
  function toggle(path:string){setCollapsed(old=>{const next=new Set(old);if(next.has(path))next.delete(path);else next.add(path);return next;});}
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3"><span className="text-xs font-medium">{t("p4.streamTree.title")}</span><span className="text-xs text-muted-foreground tabular-nums">{streams?.length??0}</span><Input aria-label={t("p4.filterStreams")} placeholder={t("p4.filterStreams")} value={query} onChange={event=>setQuery(event.target.value)} className="ml-2 h-7 max-w-72 font-mono text-xs"/><div className="ml-auto flex gap-1"><HoverTip label={t("p4.streamTree.locate")}><Button variant="ghost" size="icon-xs" disabled={!current} aria-label={t("p4.streamTree.locate")} onClick={locate}><LocateFixedIcon/></Button></HoverTip><HoverTip label={t("p4.refresh")}><Button variant="ghost" size="icon-xs" disabled={blocked} aria-label={t("p4.refresh")} onClick={()=>{setLoading(true);setError(null);setAttempt(value=>value+1);}}><RefreshCwIcon className={loading?"animate-spin":""}/></Button></HoverTip></div></div>
    {error?<p role="alert" className="shrink-0 border-b p-3 text-xs text-destructive">{error}</p>:null}
    {streams&&streams.length>=2000?<p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{t("p4.streamTree.limit")}</p>:null}
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="p4-stream-tree" defaultSize="54%" minSize="30%"><div ref={viewportRef} className="absolute inset-0 overflow-auto p-1" role="tree" aria-label={t("p4.streamTree.title")}>{!streams&&loading?<div className="flex h-full items-center justify-center"><LoaderCircleIcon className="size-5 animate-spin text-muted-foreground"/></div>:!rows.length?<p className="p-6 text-center text-xs text-muted-foreground">{t("p4.noMatchingStreams")}</p>:<><div aria-hidden style={{height:before}}/>{rows.slice(start,end).map((row,offset)=><div key={row.stream.path} role="treeitem" aria-level={row.depth+1} aria-selected={selected?.path===row.stream.path} aria-expanded={row.children?Boolean(query)||!collapsed.has(row.stream.path):undefined} className={cn("flex h-10 items-center gap-2 rounded-md pr-2 hover:bg-muted/60",selected?.path===row.stream.path&&"bg-muted")} style={{paddingLeft:8+Math.min(row.depth,16)*18}}>{row.children?<Button variant="ghost" size="icon-xs" className="size-5 shrink-0" tabIndex={-1} aria-label={t(collapsed.has(row.stream.path)?"p4.streamTree.expand":"p4.streamTree.collapse",{stream:row.stream.path})} disabled={Boolean(query)} onClick={()=>toggle(row.stream.path)}>{collapsed.has(row.stream.path)&&!query?<ChevronRightIcon/>:<ChevronDownIcon/>}</Button>:<span className="size-5 shrink-0"/>}<span className="h-full shrink-0 border-l border-border/80"/><button type="button" data-stream-path={row.stream.path} tabIndex={row.stream.path===focusPath?0:-1} onKeyDown={event=>navigate(event,start+offset)} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left" title={row.stream.path} onClick={()=>setPicked(row.stream.path)}><GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground"/><span className="min-w-0 flex-1 truncate font-mono text-xs">{row.stream.path}</span><StreamKind kind={row.stream.kind}/>{row.stream.path===current?.path?<span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-label={t("p4.streamTree.current")}/>:null}</button></div>)}<div aria-hidden style={{height:after}}/></>}</div></ResizablePanel>
      <ResizableHandle/>
      <ResizablePanel id="p4-stream-inspector" defaultSize="46%" minSize="28%"><div className="absolute inset-0 overflow-auto p-5">{selected?<div className="mx-auto grid max-w-lg gap-5">
        <div className="space-y-2"><div className="flex items-center gap-2"><h2 className="min-w-0 truncate text-base font-medium">{depotBase(selected.path)}</h2><StreamKind kind={selected.kind}/></div><p className="break-all font-mono text-xs text-muted-foreground">{selected.path}</p>{relation==="current"?<span className="inline-flex rounded border px-2 py-0.5 text-[11px]">{t("p4.streamTree.workspace",{client:p4.connection?.client})}</span>:null}</div>
        <div className="grid gap-2 rounded-lg border bg-muted/10 p-3">
          <LabelText>{t("p4.streamTree.parent")}</LabelText>{parent?<StreamNode stream={parent} onSelect={setPicked}/>:<p className="break-all px-2 py-1 font-mono text-xs text-muted-foreground">{selected.parent?.startsWith("//")?selected.parent:t("p4.streamTree.noParent")}</p>}
          {parent?<ArrowDownIcon className="ml-4 size-4 text-muted-foreground"/>:null}<StreamNode stream={selected} active onSelect={setPicked}/>
          <LabelText>{t("p4.streamTree.children",{count:children.length})}</LabelText>{children.length?<div className="ml-4 grid gap-1 border-l pl-3">{children.map(child=><StreamNode key={child.path} stream={child} onSelect={setPicked}/>)}</div>:<p className="px-2 py-1 text-xs text-muted-foreground">{t("p4.streamTree.noChildren")}</p>}
        </div>
        <div className="grid gap-2"><Button variant="outline" className="justify-start" disabled={blocked||!current||relation==="current"} onClick={()=>p4.switchStream(selected.path)}><ArrowRightLeftIcon/>{t("p4.switchStream.title")}</Button>{canMerge?<Button variant="outline" className="justify-start" disabled={blocked} onClick={()=>p4.openStreamIntegration("merge",current!.parent!)}><GitMergeIcon/>{t("p4.streamTree.merge")}</Button>:null}{canCopy?<Button variant="outline" className="justify-start" disabled={blocked} onClick={()=>p4.openStreamIntegration("copy",selected.path)}><GitMergeIcon/>{t("p4.streamTree.copy")}</Button>:null}</div>
      </div>:<p className="p-6 text-xs text-muted-foreground">{t("p4.streamTree.select")}</p>}</div></ResizablePanel>
    </ResizablePanelGroup>
  </div>;
}
function StreamKind({kind}:{kind:string}){const {t}=useTranslation();const known=["mainline","development","release","virtual","task"].includes(kind);return <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-[10px] text-muted-foreground">{known?t(`p4.streamTree.kinds.${kind}`):kind}</span>;}
function StreamNode({stream,active,onSelect}:{stream:P4StreamOption;active?:boolean;onSelect:(path:string)=>void}){return <button type="button" onClick={()=>onSelect(stream.path)} title={stream.path} className={cn("flex min-h-9 min-w-0 items-center gap-2 rounded-md border px-2 text-left hover:bg-muted",active&&"border-foreground/25 bg-muted/50")}><GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground"/><span className="min-w-0 flex-1 truncate font-mono text-xs">{depotBase(stream.path)}</span><StreamKind kind={stream.kind}/></button>;}
function LabelText({children}:{children:React.ReactNode}){return <p className="px-2 text-[11px] text-muted-foreground">{children}</p>;}
