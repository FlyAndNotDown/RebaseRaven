import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { mappingLines, parseMappings, type MappingKind, type MappingRule } from "@/lib/p4-mappings";

export function P4MappingsEditor({value, onChange, overrides, client, disabled}: {
  value: string[]; onChange: (value: string[]) => void; overrides: boolean; client: string; disabled: boolean;
}) {
  const {t} = useTranslation();
  const [preferredMode, setMode] = useState<"rules" | "text">("rules");
  const [draft, setDraft] = useState<{source: string[]; rows: MappingRule[]} | null>(null);
  const rows = draft?.source === value ? draft.rows : parseMappings(value, overrides);
  const canShowRows = rows !== null && rows.length <= 200;
  const mode = preferredMode === "rules" && canShowRows ? "rules" : "text";
  const kinds: MappingKind[] = overrides ? ["include", "exclude"] : ["include", "exclude", "overlay", "ditto"];
  function publish(next: MappingRule[]) {
    const source = mappingLines(next, overrides);
    setDraft({source, rows: next}); onChange(source);
  }
  function change(index: number, patch: Partial<MappingRule>) {
    if (rows) publish(rows.map((row, i) => i === index ? {...row, ...patch} : row));
  }
  function move(index: number, delta: number) {
    if (!rows) return;
    const next = [...rows];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    publish(next);
  }
  return <div className="grid gap-3">
    <div className="flex items-center justify-between gap-3">
      <SegmentedControl label={t("p4.workspaceSettings.editor")} value={mode} onChange={setMode}
        options={[{value:"rules", label:t("p4.workspaceSettings.rules"), disabled:!canShowRows || disabled}, {value:"text", label:t("p4.workspaceSettings.text"), disabled}]} />
      {mode === "rules" ? <Button size="xs" variant="outline" disabled={disabled} onClick={() => publish([...(rows ?? []), {kind:"include", source:"", target:`//${client}/...`, comment:""}])}><PlusIcon />{t("p4.workspaceSettings.addMapping")}</Button> : null}
    </div>
    {mode === "text" ? <Textarea aria-label={t("p4.workspaceSettings.mapping")} value={value.join("\n")} onChange={event => onChange(event.target.value.split("\n"))} disabled={disabled} spellCheck={false} wrap="off" className="h-64 min-h-64 resize-none font-mono text-xs [field-sizing:fixed]" />
      : rows?.length ? <div className="max-h-72 overflow-auto rounded-lg border p-2">
        <div className={`grid items-center gap-2 pb-2 text-[11px] text-muted-foreground ${overrides ? "grid-cols-[6rem_minmax(0,1fr)_4.5rem]" : "grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_4.5rem]"}`}>
          <span>{t("p4.workspaceSettings.rule")}</span><span>{t(overrides ? "p4.workspaceSettings.path" : "p4.workspaceSettings.depotPath")}</span>{!overrides ? <span>{t("p4.workspaceSettings.workspacePath")}</span> : null}<span />
        </div>
        {rows.map((row, index) => <div key={index} className={`grid items-center gap-2 py-1 ${overrides ? "grid-cols-[6rem_minmax(0,1fr)_4.5rem]" : "grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_4.5rem]"}`}>
          <ChoiceSelect aria-label={t("p4.workspaceSettings.rowRule", {count:index + 1})} value={row.kind} disabled={disabled} options={kinds.map(kind => ({value:kind, label:t(`p4.workspaceSettings.kinds.${kind}`)}))} onValueChange={kind => change(index, {kind})} />
          <Input aria-label={t("p4.workspaceSettings.rowSource", {count:index + 1})} value={row.source} disabled={disabled} onChange={event => change(index, {source:event.target.value})} placeholder="//depot/project/..." title={row.source} className="h-8 font-mono text-xs" />
          {!overrides ? <Input aria-label={t("p4.workspaceSettings.rowTarget", {count:index + 1})} value={row.target} disabled={disabled} onChange={event => change(index, {target:event.target.value})} placeholder={`//${client}/project/...`} title={row.target} className="h-8 font-mono text-xs" /> : null}
          <div className="flex items-center">
            <HoverTip label={t("p4.workspaceSettings.moveUp")}><Button variant="ghost" size="icon-xs" aria-label={t("p4.workspaceSettings.moveUp")} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUpIcon /></Button></HoverTip>
            <HoverTip label={t("p4.workspaceSettings.moveDown")}><Button variant="ghost" size="icon-xs" aria-label={t("p4.workspaceSettings.moveDown")} disabled={disabled || index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDownIcon /></Button></HoverTip>
            <HoverTip label={t("p4.workspaceSettings.removeMapping")}><Button variant="ghost" size="icon-xs" aria-label={t("p4.workspaceSettings.removeMapping")} disabled={disabled} onClick={() => publish(rows.filter((_, i) => i !== index))}><Trash2Icon /></Button></HoverTip>
          </div>
        </div>)}
      </div> : <p className="rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">{t(overrides ? "p4.workspaceSettings.allStreamFiles" : "p4.workspaceSettings.noMappings")}</p>}
  </div>;
}
