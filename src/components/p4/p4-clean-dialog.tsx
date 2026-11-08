import { useCallback, useEffect, useRef, useState } from "react";
import { BrushCleaningIcon, InfoIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { relativeToRoot } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4CleanPreview, P4CleanRequest } from "@/types/p4";

export function P4CleanDialog({scope,onClose}: {scope:string;onClose:()=>void}) {
  const {t}=useTranslation();
  const p4=useP4();
  const [request,setRequest]=useState<P4CleanRequest>({scope,restoreModified:true,restoreMissing:true,removeUntracked:true,includeIgnored:false});
  const requestRef=useRef(request);
  const [preview,setPreview]=useState<P4CleanPreview|null>(null);
  const review=useRef<{request:P4CleanRequest;preview:P4CleanPreview}|null>(null);
  const [picked,setPicked]=useState<Set<string>>(()=>new Set());
  const [loading,setLoading]=useState(true);
  const [applying,setApplying]=useState(false);
  const [confirm,setConfirm]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const mounted=useRef(false),applyingRef=useRef(false);
  const pendingScan=useRef<symbol|null>(null);
  const hasActions=request.restoreModified || request.restoreMissing || request.removeUntracked;
  const blocked=loading || applying || p4.busy;
  const {previewClean,applyClean}=p4;
  const scan=useCallback(async()=>{
    if (!mounted.current || pendingScan.current || applyingRef.current) return;
    const token=Symbol();pendingScan.current=token;const target=requestRef.current;
    review.current=null;setLoading(true);setError(null);setPreview(null);setPicked(new Set());setConfirm(false);
    try {
      const result=await previewClean(target);
      if (mounted.current && pendingScan.current===token) {
        review.current={request:target,preview:result};setPreview(result);setPicked(new Set(result.files.map(file=>file.path)));
      }
    } catch(error) {if(mounted.current && pendingScan.current===token)setError(p4DisplayError(errorMessage(error)));}
    finally {if(pendingScan.current===token){pendingScan.current=null;if(mounted.current)setLoading(false);}}
  },[previewClean]);
  useEffect(()=>{mounted.current=true;void Promise.resolve().then(scan);return()=>{mounted.current=false;pendingScan.current=null;review.current=null;};},[scan]);
  function change(key: Exclude<keyof P4CleanRequest,"scope">,value:boolean) {
    if(pendingScan.current || applyingRef.current || p4.busy || confirm)return;
    const next={...requestRef.current,[key]:value};requestRef.current=next;review.current=null;
    setRequest(next);setPreview(null);setPicked(new Set());setError(null);
  }
  async function apply() {
    const current=review.current;
    if(!confirm || !current || current.preview!==preview || pendingScan.current || applyingRef.current || p4.busy || !picked.size)return;
    applyingRef.current=true;setApplying(true);setError(null);
    try {await applyClean(current.request,[...picked],current.preview.fingerprint);if(mounted.current)onClose();}
    catch(error){if(mounted.current){review.current=null;setPreview(null);setPicked(new Set());setConfirm(false);setError(p4DisplayError(errorMessage(error)));}}
    finally{applyingRef.current=false;if(mounted.current)setApplying(false);}
  }
  const selected=preview?.files.filter(file=>picked.has(file.path)) ?? [];
  const removed=selected.filter(file=>file.action==="removeUntracked").length;
  const canApply=!blocked && preview!==null && picked.size>0;
  return <Dialog open onOpenChange={open=>{if(!open && !applying)onClose();}}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!applying}>
      <DialogHeader><DialogTitle>{t(confirm ? "p4.clean.confirmTitle" : "p4.clean.title")}</DialogTitle><DialogDescription className="truncate font-mono text-xs" title={scope}>{relativeToRoot(p4.connection?.root ?? "",scope) || p4.connection?.client}</DialogDescription></DialogHeader>
      {!confirm ? <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {(["restoreModified","restoreMissing","removeUntracked","includeIgnored"] as const).map(key=><label key={key} className="flex items-center gap-2 text-xs"><Checkbox checked={request[key]} disabled={blocked} onCheckedChange={value=>change(key,value===true)}/>{t(`p4.clean.options.${key}`)}{key==="includeIgnored" ? <HoverTip label={t("p4.clean.ignoreHint")}><InfoIcon className="size-3 text-muted-foreground"/></HoverTip> : null}</label>)}
      </div> : <p className="text-sm">{t("p4.clean.summary",{restore:selected.length-removed,remove:removed})}</p>}
      {!confirm ? <div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs"><Checkbox aria-label={t("p4.clean.selectAll")} checked={picked.size>0 && picked.size===preview?.files.length ? true : picked.size>0 ? "indeterminate" : false} disabled={blocked || !preview?.files.length} onCheckedChange={value=>setPicked(new Set(value ? preview?.files.map(file=>file.path) : []))}/>{t("p4.reconcileReview.selected",{count:picked.size,total:preview?.files.length ?? 0})}</label><Button variant="ghost" size="xs" disabled={blocked || !hasActions} onClick={()=>void scan()}><RefreshCwIcon/>{t("p4.clean.preview")}</Button></div> : null}
      <div className="min-h-24 overflow-auto rounded-md border">
        {loading ? <div role="status" className="flex h-36 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin"/>{t("p4.clean.scanning")}</div> : preview?.files.length ? (confirm ? selected : preview.files).map(file=><label key={file.path} className="flex min-h-9 items-center gap-3 border-b px-3 py-2 text-xs last:border-0 hover:bg-muted/50">
          {!confirm ? <Checkbox aria-label={relativeToRoot(p4.connection?.root ?? "",file.path)} checked={picked.has(file.path)} disabled={blocked} onCheckedChange={value=>setPicked(current=>{const next=new Set(current);if(value)next.add(file.path);else next.delete(file.path);return next;})}/> : null}
          <span className="w-28 shrink-0 text-muted-foreground">{t(`p4.clean.actions.${file.action}`)}</span><span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{relativeToRoot(p4.connection?.root ?? "",file.path)}</span>{file.revision ? <HoverTip label={t("p4.clean.haveHint")}><span className="shrink-0 font-mono text-muted-foreground">#{file.revision}</span></HoverTip> : null}
        </label>) : <p role="status" className="p-8 text-center text-sm text-muted-foreground">{t(preview ? "p4.clean.empty" : "p4.clean.scanAgain")}</p>}
      </div>
      <p className="text-xs text-muted-foreground">{t(confirm ? "p4.clean.confirmHint" : "p4.clean.hint")}</p>
      {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
      <DialogFooter>
        {confirm ? <Button variant="ghost" disabled={applying} onClick={()=>setConfirm(false)}>{t("p4.clean.back")}</Button> : null}
        <Button variant="outline" disabled={applying} onClick={onClose}>{t("common.cancel")}</Button>
        {confirm ? <Button variant="destructive" disabled={!canApply} onClick={()=>void apply()}>{applying ? <LoaderCircleIcon className="animate-spin"/> : <BrushCleaningIcon/>}{t("p4.clean.apply",{count:picked.size})}</Button> : <Button disabled={!canApply} onClick={()=>{if(review.current?.preview===preview)setConfirm(true);}}><BrushCleaningIcon/>{t("p4.clean.review",{count:picked.size})}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
