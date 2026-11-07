import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useP4 } from "@/state/p4-context";

export function P4ChangeSelect({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const { pending, connection } = useP4();
  const choices = ["default", ...pending.filter((change) => change.id !== "default" && change.user === connection?.user && change.client === connection.client).map((change) => change.id)];
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="outline" disabled={disabled} aria-label={t("p4-operations.pendingChange")} className="justify-between font-mono text-xs"><span>{value === "default" ? t("p4-operations.defaultChange") : value}</span><ChevronDownIcon /></Button></DropdownMenuTrigger>
    <DropdownMenuContent className="max-h-60 min-w-52 overflow-auto">
      {choices.map((id) => <DropdownMenuItem key={id} onClick={() => onChange(id)}><span className="min-w-4">{id === value ? <CheckIcon className="size-3.5" /> : null}</span>{id === "default" ? t("p4-operations.defaultChange") : id}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
