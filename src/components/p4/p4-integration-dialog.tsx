import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, GitMergeIcon, InfoIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { P4IntegrationFiles } from "@/components/p4/p4-integration-files";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4IntegrationInitial, P4IntegrationPreview, P4IntegrationRequest } from "@/types/p4-integration";
import type { P4SpecPage } from "@/types/p4-specs";

export function P4IntegrationDialog({initial,onClose}: {initial:P4IntegrationInitial;onClose:()=>void}) {
  const {t} = useTranslation();
  const p4 = useP4();
  const [method,setMethod] = useState<P4IntegrationRequest["method"]>(initial.branch ? "branch" : "paths");
  const [source,setSource] = useState(initial.source ?? "");
  const [target,setTarget] = useState(initial.target ?? `//${p4.connection?.client ?? ""}/...`);
  const [branch,setBranch] = useState(initial.branch ?? "");
  const [reverse,setReverse] = useState(false);
  const [force,setForce] = useState(false);
  const [changeId,setChangeId] = useState(p4.selectedChange);
  const [limited,setLimited] = useState(false);
  const [rangeKind,setRangeKind] = useState<"revision"|"changelist">("changelist");
  const [from,setFrom] = useState("");
  const [to,setTo] = useState("");
  const [branchQuery,setBranchQuery] = useState("");
  const [branches,setBranches] = useState<{query:string;value:P4SpecPage}|null>(null);
  const [branchError,setBranchError] = useState<{query:string;value:string}|null>(null);
  const [preview,setPreview] = useState<{key:string;value:P4IntegrationPreview}|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState<"preview"|"apply"|null>(null);
  const [applyFailed,setApplyFailed] = useState(false);
  const running = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {
    if (method !== "branch") return;
    let live = true;
    const timer = window.setTimeout(() => {
      void p4.specs.list("branch",branchQuery,"").then(value => {if (live) setBranches({query:branchQuery,value});}).catch((caught:unknown) => {if (live) setBranchError({query:branchQuery,value:p4DisplayError(errorMessage(caught))});});
    },200);
    return () => {live = false; window.clearTimeout(timer);};
  }, [p4.specs,method,branchQuery]);
  const request:P4IntegrationRequest = {method,source,target,branch,reverse,force,changeId,range:limited ? {kind:rangeKind,from,to} : null};
  const key = JSON.stringify([p4.connection,request]);
  const blocked = Boolean(busy) || p4.busy;
  const positive = (value:string) => /^[1-9]\d*$/.test(value);
  const validRange = !limited || (positive(from) && positive(to) && BigInt(from) <= BigInt(to));
  const valid = target.startsWith("//") && (method === "paths" ? source.startsWith("//") : Boolean(branch)) && validRange;
  const approved = preview?.key === key && preview.value.files.length > 0;
  function edit(update:()=>void) {setPreview(null); setError(null); setApplyFailed(false); update();}
  async function run(apply:boolean) {
    if (running.current || blocked || !valid || (apply && !approved)) return;
    running.current = true; setBusy(apply ? "apply" : "preview"); setError(null);
    try {
      if (apply && preview) {await p4.applyIntegration(request,preview.value); onClose();}
      else {setPreview(null); const value=await p4.previewIntegration(request); if (mounted.current) setPreview({key,value});}
    } catch (caught) {if (mounted.current) {setPreview(null); setError(p4DisplayError(errorMessage(caught))); setApplyFailed(apply);}}
    finally {running.current = false; if (mounted.current) setBusy(null);}
  }
  const matches = branches?.query === branchQuery ? branches.value : null;
  return <Dialog open onOpenChange={open => {if (!open && busy !== "apply") onClose();}}><DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl" showCloseButton={busy !== "apply"}>
    <DialogHeader><DialogTitle>{t("p4.integration.title")}</DialogTitle><DialogDescription className="font-mono text-xs">{p4.connection?.client}</DialogDescription></DialogHeader>
    <SegmentedControl label={t("p4.integration.method")} value={method} disabled={blocked} onChange={value => edit(() => setMethod(value))} options={[{value:"paths",label:t("p4.integration.paths")},{value:"branch",label:t("p4.specs.branches")}]} />
    <div className="grid min-h-0 gap-3 overflow-auto py-1">
      {method === "paths" ? <div className="grid gap-2"><Label htmlFor="p4-integration-source">{t("p4.streams.source")}</Label><Input id="p4-integration-source" value={source} disabled={blocked} placeholder={t("p4.integration.sourcePlaceholder")} className="font-mono text-xs" onChange={event => edit(() => setSource(event.target.value))} /></div> : <div className="grid gap-2"><Label>{t("p4.integration.mapping")}</Label><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" disabled={blocked} className="w-full justify-between font-mono text-xs" aria-label={t("p4.integration.mapping")}><span className="truncate">{branch || t("p4.integration.chooseMapping")}</span><ChevronDownIcon /></Button></DropdownMenuTrigger><DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width)" align="start"><div className="p-1" onKeyDown={event => event.stopPropagation()}><Input aria-label={t("p4.specs.filter")} placeholder={t("p4.specs.filter")} value={branchQuery} onChange={event => setBranchQuery(event.target.value)} className="h-7 font-mono text-xs" /></div><div className="max-h-48 overflow-auto">{matches ? matches.items.map(item => <DropdownMenuItem key={item.name} onClick={() => edit(() => setBranch(item.name))}><span className="truncate font-mono text-xs">{item.name}</span></DropdownMenuItem>) : null}{branchError?.query === branchQuery ? <p className="p-3 text-xs text-destructive">{branchError.value}</p> : !matches ? <p className="p-3 text-xs text-muted-foreground">{t("p4.streams.loading")}</p> : !matches.items.length ? <p className="p-3 text-xs text-muted-foreground">{t("p4.specs.noMatches")}</p> : matches.truncated ? <p className="p-3 text-xs text-muted-foreground">{t("p4.specs.listLimit")}</p> : null}</div></DropdownMenuContent></DropdownMenu><Label className="text-xs"><Checkbox checked={reverse} disabled={blocked} onCheckedChange={value => edit(() => setReverse(value === true))} />{t("p4.integration.reverse")}</Label></div>}
      <div className="grid gap-2"><Label htmlFor="p4-integration-target">{t("p4.integration.target")}</Label><Input id="p4-integration-target" value={target} disabled={blocked} className="font-mono text-xs" onChange={event => edit(() => setTarget(event.target.value))} /></div>
      <div className="flex items-center justify-between gap-3"><Label>{t("p4-operations.pendingChange")}</Label><P4ChangeSelect value={changeId} onChange={value => edit(() => setChangeId(value))} disabled={blocked} /></div>
      <div className="grid gap-2 rounded-md border p-3"><Label className="text-xs"><Checkbox checked={limited} disabled={blocked} onCheckedChange={value => edit(() => setLimited(value === true))} />{t("p4.integration.limitRange")}</Label>{limited ? <div className="flex items-center gap-2"><SegmentedControl label={t("p4.integration.rangeKind")} value={rangeKind} disabled={blocked} onChange={value => edit(() => setRangeKind(value))} options={[{value:"changelist",label:t("p4.changelist")},{value:"revision",label:t("p4.revision")}]} /><Input value={from} aria-label={t("p4.integration.from")} disabled={blocked} className="h-7 font-mono text-xs" onChange={event => edit(() => setFrom(event.target.value))} /><span className="text-xs text-muted-foreground">–</span><Input value={to} aria-label={t("p4.integration.to")} disabled={blocked} className="h-7 font-mono text-xs" onChange={event => edit(() => setTo(event.target.value))} /></div> : null}<div className="flex items-center gap-2"><Label className="text-xs"><Checkbox checked={force} disabled={blocked} onCheckedChange={value => edit(() => setForce(value === true))} />{t("p4.integration.force")}</Label><HoverTip label={t("p4.integration.forceHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div></div>
      <P4IntegrationFiles root={p4.connection?.root ?? ""} files={preview?.key === key ? preview.value.files : []} previewed={preview?.key === key} loading={busy === "preview"} />
    </div>
    {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter>{applyFailed ? <Button variant="ghost" className="mr-auto" disabled={blocked} onClick={() => {onClose(); p4.setView("pending");}}>{t("p4.integration.reviewPending")}</Button> : null}<Button variant="outline" disabled={busy === "apply"} onClick={onClose}>{t("common.cancel")}</Button><Button variant="outline" disabled={blocked || !valid} onClick={() => void run(false)}>{busy === "preview" ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4-operations.preview")}</Button><Button disabled={blocked || !approved} onClick={() => void run(true)}>{busy === "apply" ? <LoaderCircleIcon className="animate-spin" /> : <GitMergeIcon />}{t("p4.integration.apply")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
