import { ChoiceSelect } from "@/components/ui/choice-select";
import { useTranslation } from "@/i18n";
import { Label } from "@/components/ui/label";

export function LfsRemoteField({id,remotes,value,onChange,disabled}:{id:string;remotes:string[];value:string;onChange:(value:string)=>void;disabled:boolean}){
  const {t}=useTranslation();
  return <div className="grid gap-2"><Label htmlFor={id}>{t("git.lfs.remote")}</Label><ChoiceSelect id={id} value={value} disabled={disabled || !remotes.length} onValueChange={onChange} placeholder={t("git.lfs.noRemote")} options={remotes.map(name => ({value:name,label:name}))} /></div>;
}
