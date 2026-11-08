import { useState } from "react";
import { ShieldAlertIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import { LfsRemoteField } from "@/components/lfs-remote";
import type { LfsAction, LfsLock, LfsLocks } from "@/types/lfs";

export function LfsLocksPane({remote,remotes,onRemote,locks,blocked,onAction}:{remote:string;remotes:string[];onRemote:(value:string)=>void;locks:LfsLocks|null;blocked:boolean;onAction:(action:LfsAction)=>void}){
  const {t}=useTranslation();
  const [path,setPath]=useState(""),[query,setQuery]=useState(""),[confirmation,setConfirmation]=useState("");
  const [selected,setSelected]=useState<{lock:LfsLock;force:boolean;snapshot:LfsLocks}|null>(null);
  const current=locks?.remote===remote ? locks : null;
  const chosen=selected?.snapshot===current ? selected : null;
  const items=current?.locks.filter(lock=>`${lock.path}\n${lock.owner?.name ?? ""}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  function choose(lock:LfsLock,force:boolean){if(!current)return;setConfirmation("");setSelected({lock,force,snapshot:current});}
  return <>
    <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto]"><LfsRemoteField id="lfs-lock-remote" value={remote} remotes={remotes} onChange={onRemote} disabled={blocked} /><Button variant="outline" size="sm" disabled={blocked || !remote} onClick={()=>onAction({kind:"locks",remote})}>{t("git.lfs.locks.refresh")}</Button></div>
    <div className="grid gap-2 rounded-lg border p-3"><Label htmlFor="lfs-lock-path">{t("git.lfs.locks.path")}</Label><div className="flex gap-2"><Input id="lfs-lock-path" value={path} onChange={event=>setPath(event.target.value)} disabled={blocked} placeholder={t("git.lfs.locks.placeholder")} className="min-w-0 font-mono text-xs" /><Button size="sm" disabled={blocked || !remote || !path.trim()} onClick={()=>onAction({kind:"lock",remote,path})}>{t("git.lfs.locks.lock")}</Button></div></div>
    {current ? <>
      <div className="flex items-center gap-2"><Badge variant="outline">{t("git.lfs.locks.count",{count:current.locks.length})}</Badge><span className="text-xs text-muted-foreground">{t("git.lfs.locks.verified")}</span></div>
      <Input aria-label={t("git.lfs.locks.search")} placeholder={t("git.lfs.locks.search")} value={query} onChange={event=>setQuery(event.target.value)} className="h-8 text-xs" />
      <div className="max-h-64 overflow-auto rounded-lg border">{items.length ? items.slice(0,200).map(lock=><div key={lock.id} className="grid gap-2 border-b px-3 py-2 last:border-0"><div className="flex items-center gap-2"><div className="min-w-0 flex-1"><p className="truncate font-mono text-xs" title={lock.path}>{lock.path}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">{lock.owner?.name ?? t("git.lfs.locks.unknownOwner")} · {lock.locked_at}</p></div>{lock.ours ? <Badge variant="outline" className="text-[10px]">{t("git.lfs.locks.mine")}</Badge> : null}<Button size="xs" variant="ghost" disabled={blocked || !lock.ours} aria-label={t("git.lfs.locks.unlockNamed",{path:lock.path})} onClick={()=>choose(lock,false)}>{t("git.lfs.locks.unlock")}</Button><HoverTip label={t("git.lfs.locks.forceHint")}><Button variant="ghost" size="icon-xs" disabled={blocked} className="text-destructive" aria-label={t("git.lfs.locks.forceNamed",{path:lock.path})} onClick={()=>choose(lock,true)}><ShieldAlertIcon /></Button></HoverTip></div>{chosen?.lock.id===lock.id ? <div className="grid gap-2 rounded-md bg-muted/30 p-2"><p className="text-xs">{t(chosen.force ? "git.lfs.locks.forceConfirm" : "git.lfs.locks.confirm")}</p>{chosen.force ? <Input aria-label={t("git.lfs.locks.confirmation")} placeholder={lock.path} value={confirmation} disabled={blocked} onChange={event=>setConfirmation(event.target.value)} className="h-8 font-mono text-xs" /> : null}<div className="flex justify-end gap-2"><Button variant="ghost" size="xs" disabled={blocked} onClick={()=>setSelected(null)}>{t("common.cancel")}</Button><Button variant={chosen.force ? "destructive" : "outline"} size="xs" disabled={blocked || chosen.force && confirmation!==lock.path} onClick={()=>onAction({kind:"unlock",remote,id:lock.id,path:lock.path,force:chosen.force,confirmation,lockFingerprint:chosen.snapshot.fingerprint})}>{t(chosen.force ? "git.lfs.locks.force" : "git.lfs.locks.unlock")}</Button></div></div> : null}</div>) : <p className="p-4 text-xs text-muted-foreground">{t(query ? "git.lfs.noMatches" : "git.lfs.locks.empty")}</p>}</div>
      {items.length>200 ? <p className="text-xs text-muted-foreground">{t("git.lfs.sample",{count:200,total:items.length})}</p> : null}
    </> : <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">{t("git.lfs.locks.loadHint")}</p>}
  </>;
}
