import { InfoIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import type { GitSigningMode } from "@/types/git";

const modes: GitSigningMode[] = ["default", "sign", "unsigned"];

export function GitSigningMenu({value, onChange, disabled}: {value: GitSigningMode; onChange: (value: GitSigningMode) => void; disabled?: boolean}) {
  const { t } = useTranslation();
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger disabled={disabled}><ShieldCheckIcon />{t("git.signing.signature")}</DropdownMenuSubTrigger>
    <DropdownMenuSubContent><DropdownMenuRadioGroup value={value} onValueChange={value => onChange(value as GitSigningMode)}>
      {modes.map(mode => <DropdownMenuRadioItem key={mode} value={mode}>{t(`git.signing.modes.${mode}`)}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup></DropdownMenuSubContent>
  </DropdownMenuSub>;
}

export function GitSigningSelect({value, onChange, disabled, id}: {value: GitSigningMode; onChange: (value: GitSigningMode) => void; disabled?: boolean; id: string}) {
  const { t } = useTranslation();
  return <div className="grid gap-2">
    <div className="flex items-center gap-2"><Label htmlFor={id}>{t("git.signing.signature")}</Label><HoverTip label={t("git.signing.hint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div>
    <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value as GitSigningMode)} className="h-9 w-full rounded-md border border-input bg-input/30 px-2 text-sm disabled:opacity-50">
      {modes.map(mode => <option key={mode} value={mode}>{t(`git.signing.modes.${mode}`)}</option>)}
    </select>
  </div>;
}
