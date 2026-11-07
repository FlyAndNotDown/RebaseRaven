import { useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { P4StreamOption } from "@/types/p4";

export function P4StreamSelect({ streams, value, onChange, disabled, label }: { streams: P4StreamOption[] | null; value: string; onChange: (value: string) => void; disabled?: boolean; label: string }) {
  const { t } = useTranslation();
  const [query,setQuery] = useState("");
  const filtered = streams?.filter((stream) => stream.path.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <DropdownMenu onOpenChange={(open) => {if(!open)setQuery("");}}><DropdownMenuTrigger asChild><Button variant="outline" disabled={disabled || !streams} className="w-full justify-between font-mono text-xs" aria-label={label}><span className="truncate">{value || t(streams ? "p4.switchStream.choose" : "p4.loadingStreams")}</span><ChevronDownIcon className="shrink-0" /></Button></DropdownMenuTrigger><DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width)" align="start"><div className="p-1" onKeyDown={(event) => event.stopPropagation()}><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("p4.filterStreams")} className="h-7 font-mono text-xs" /></div><div className="max-h-56 overflow-auto">{filtered.slice(0,100).map((stream) => <DropdownMenuItem key={stream.path} onClick={() => onChange(stream.path)}><span className="w-4 shrink-0">{value === stream.path ? <CheckIcon className="size-3.5" /> : null}</span><span className="truncate font-mono text-xs">{stream.path}</span><span className="ml-auto text-[10px] text-muted-foreground">{stream.kind}</span></DropdownMenuItem>)}{!filtered.length ? <p className="p-3 text-xs text-muted-foreground">{t("p4.noMatchingStreams")}</p> : filtered.length>100 ? <p className="p-2 text-xs text-muted-foreground">{t("p4.switchStream.refine")}</p> : null}</div></DropdownMenuContent></DropdownMenu>;
}
