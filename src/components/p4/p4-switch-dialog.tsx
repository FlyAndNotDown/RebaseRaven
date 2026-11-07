import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, CheckIcon, InfoIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { P4StreamSelect } from "@/components/p4/p4-stream-select";
import { ChangeBadge } from "@/components/p4/change-badge";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { relativeToRoot } from "@/lib/p4";
import { useP4 } from "@/state/p4-context";
import type { P4StreamOption, P4SwitchOutcome, P4SwitchPreview, P4SwitchRequest } from "@/types/p4";

export function P4SwitchDialog({ initialTarget, onClose }: { initialTarget: string; onClose: () => void }) {
  const { t } = useTranslation();
  const p4 = useP4(); const {listStreams} = p4;
  const [streams,setStreams] = useState<P4StreamOption[] | null>(null);
  const [target,setTarget] = useState(initialTarget);
  const [shelve,setShelve] = useState(true);
  const [preview,setPreview] = useState<{key:string;value:P4SwitchPreview} | null>(null);
  const [busy,setBusy] = useState<"preview" | "apply" | null>(null);
  const [error,setError] = useState<string | null>(null);
  const [attempt,setAttempt] = useState(0);
  const running = useRef(false), mounted = useRef(false);
  const request:P4SwitchRequest={target,shelve},key=JSON.stringify([p4.connection,target]);
  const approved=preview?.key===key ? preview.value : null;
  const blocked=Boolean(busy)||p4.busy;
  useEffect(() => {
    mounted.current=true;
    void listStreams().then((value) => {if(mounted.current)setStreams(value);}).catch((caught:unknown) => {if(mounted.current)setError(p4DisplayError(errorMessage(caught)));});
    return () => {mounted.current=false;};
  },[listStreams,attempt]);
  async function inspect() {
    if(running.current||blocked||!target)return;
    running.current=true;setBusy("preview");setError(null);setPreview(null);
    try {const value=await p4.previewSwitch(request);if(mounted.current)setPreview({key,value});}
    catch(caught){if(mounted.current)setError(p4DisplayError(errorMessage(caught)));}
    finally{running.current=false;if(mounted.current)setBusy(null);}
  }
  async function apply(){
    if(!approved||blocked||running.current)return;
    running.current=true;setBusy("apply");setError(null);
    try{await p4.applySwitch(request,approved.fingerprint);}
    catch(caught){if(mounted.current){setError(p4DisplayError(errorMessage(caught)));setPreview(null);}}
    finally{running.current=false;if(mounted.current)setBusy(null);}
  }
  return <Dialog open onOpenChange={(open) => {if(!open&&busy!=="apply")onClose();}}><DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl" showCloseButton={busy!=="apply"}>
    <DialogHeader><DialogTitle>{t("p4.switchStream.title")}</DialogTitle><DialogDescription className="font-mono text-xs">{p4.connection?.client}</DialogDescription></DialogHeader>
    <div className="grid shrink-0 gap-2 rounded-lg border p-3"><Label className="text-xs text-muted-foreground">{t("p4.switchStream.current")}</Label><span className="truncate font-mono text-xs">{p4.connection?.stream}</span><ArrowDownIcon className="size-4 text-muted-foreground" /><Label className="text-xs text-muted-foreground">{t("p4.switchStream.target")}</Label><P4StreamSelect streams={streams?.filter((stream) => stream.path!==p4.connection?.stream) ?? null} value={target} onChange={(value) => {setTarget(value);setPreview(null);setError(null);}} disabled={blocked} label={t("p4.switchStream.target")} /></div>
    {approved ? <div className="min-h-0 space-y-3 overflow-auto">
      <div className="rounded-lg border"><div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">{t("p4.switchStream.changes",{count:approved.changes.length})}<HoverTip label={t("p4.switchStream.backupHint")}><InfoIcon className="ml-auto size-3.5 text-muted-foreground" /></HoverTip></div>{approved.changes.length ? <><div className="max-h-36 overflow-auto">{approved.changes.slice(0,100).map((file) => <div key={file.path} className="flex items-center gap-2 px-3 py-1 text-xs"><span className="w-20 shrink-0 text-muted-foreground">{file.action}</span><span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{relativeToRoot(p4.connection?.root??"",file.path)}</span>{file.change ? <ChangeBadge id={file.change} /> : <span className="text-muted-foreground">{t("p4.switchStream.offline")}</span>}</div>)}{approved.changes.length>100 ? <p className="px-3 py-1 text-xs text-muted-foreground">{t("p4.switchStream.more",{count:approved.changes.length-100})}</p> : null}</div><Label className="flex items-center gap-2 border-t px-3 py-2 text-xs"><Checkbox disabled={blocked} checked={shelve} onCheckedChange={(checked) => {setShelve(checked===true);setError(null);}} />{t("p4.switchStream.shelve")}</Label></> : <p className="px-3 py-3 text-xs text-muted-foreground">{t("p4.switchStream.clean")}</p>}</div>
      <div className="grid gap-2"><div className="flex items-center gap-2"><Label className="text-xs">{t("p4.switchStream.scope")}</Label><HoverTip label={t("p4.switchStream.scopeHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div><Textarea aria-label={t("p4.switchStream.scope")} readOnly value={approved.view.join("\n")} className="h-20 min-h-20 resize-none whitespace-pre font-mono text-xs [field-sizing:fixed]" />{approved.limitView.length ? <><Label className="text-xs">{t("p4.switchStream.limitView")}</Label><Textarea readOnly value={approved.limitView.join("\n")} className="h-16 min-h-16 font-mono text-xs [field-sizing:fixed]" /></> : null}</div>
      {approved.unresolved ? <p role="alert" className="text-xs text-destructive">{t("p4.switchStream.unresolved")}</p> : !shelve&&approved.changes.length ? <p className="text-xs text-muted-foreground">{t("p4.switchStream.finishChanges")}</p> : null}
    </div> : <p role="status" className="flex min-h-16 items-center justify-center gap-2 text-xs text-muted-foreground">{busy==="preview" ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}{t(busy==="preview"?"p4-operations.previewing":"p4-operations.previewRequired")}</p>}
    {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    <DialogFooter>{!streams&&error ? <Button variant="ghost" className="mr-auto" onClick={() => {setError(null);setAttempt((value) => value+1);}}>{t("common.retry")}</Button> : null}<Button variant="outline" disabled={busy==="apply"} onClick={onClose}>{t("common.cancel")}</Button><Button variant="outline" disabled={blocked||!target||target===p4.connection?.stream} onClick={() => void inspect()}>{t("p4-operations.preview")}</Button><Button disabled={blocked||!approved||approved.unresolved||(!shelve&&approved.changes.length>0)} onClick={() => void apply()}>{busy==="apply" ? <LoaderCircleIcon className="animate-spin" /> : null}{t(approved?.changes.length&&shelve?"p4.switchStream.shelveApply":"p4.switchStream.apply")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function P4SwitchResultDialog({outcome,onClose}:{outcome:P4SwitchOutcome;onClose:()=>void}){
  const {t}=useTranslation();
  const success=outcome.stage==="done";
  return <Dialog open onOpenChange={(open) => {if(!open)onClose();}}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle className="flex items-center gap-2">{success?<CheckIcon className="size-4"/>:<TriangleAlertIcon className="size-4 text-destructive"/>}{t(success?"p4.switchStream.completed":"p4.switchStream.interrupted")}</DialogTitle><DialogDescription>{t(`p4.switchStream.result.${outcome.stage}`)}</DialogDescription></DialogHeader><div className="grid gap-2 rounded-lg border p-3 text-xs"><span className="text-muted-foreground">{t("p4.switchStream.current")}</span><span className="break-all font-mono">{outcome.connection.stream || outcome.source}</span>{outcome.backupShelf ? <div className="mt-1 flex items-center gap-2 border-t pt-3"><span>{t("p4.switchStream.backup")}</span><ChangeBadge id={outcome.backupShelf}/><HoverTip label={t("p4.switchStream.restoreHint")}><InfoIcon className="ml-auto size-3.5 text-muted-foreground"/></HoverTip></div> : null}</div>{!success&&outcome.output ? <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-xs">{p4DisplayError(outcome.output).slice(0,16000)}</pre>:null}<DialogFooter><Button onClick={onClose}>{t("common.close")}</Button></DialogFooter></DialogContent></Dialog>;
}
