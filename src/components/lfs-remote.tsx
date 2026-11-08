import { useTranslation } from "@/i18n";
import { Label } from "@/components/ui/label";

export function LfsRemoteField({id,remotes,value,onChange,disabled}:{id:string;remotes:string[];value:string;onChange:(value:string)=>void;disabled:boolean}){
  const {t}=useTranslation();
  return <div className="grid gap-2"><Label htmlFor={id}>{t("git.lfs.remote")}</Label><select id={id} value={value} disabled={disabled || !remotes.length} onChange={event=>onChange(event.target.value)} className="h-8 rounded-md border border-input bg-input/30 px-2 text-xs disabled:opacity-50">{remotes.length ? remotes.map(name=><option key={name} value={name}>{name}</option>) : <option value="">{t("git.lfs.noRemote")}</option>}</select></div>;
}
