import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CopyIcon, InfoIcon, Loader2Icon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { formatBytes, formatDate, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { createExclusiveAction, createLatestRequest } from "@/lib/async-scope";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4FilePropertiesView } from "@/types/p4";

export function P4FilePropertiesDialog({ paths, edit = false, onClose }: { paths: string[]; edit?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const p4 = useP4();
  const pathKey = JSON.stringify(paths);
  const [epoch, setEpoch] = useState(0);
  const key = `${JSON.stringify(p4.connection)}:${pathKey}:${epoch}`;
  const [request] = useState(createLatestRequest);
  const [mutation] = useState(createExclusiveAction);
  const [result, setResult] = useState<{ key: string; value: P4FilePropertiesView } | null>(null);
  const [failure, setFailure] = useState<{ key: string; value: string } | null>(null);
  const [editing, setEditing] = useState(edit);
  const [draft, setDraft] = useState<{ fingerprint: string; type: string; selected: string[] } | null>(null);
  const [changeId, setChangeId] = useState(p4.selectedChange || "default");
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const mounted = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const suggestions = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = p4.fileProperties;
  useEffect(() => request.run(() => load(JSON.parse(pathKey)), value => setResult({ key, value }), caught => setFailure({ key, value: errorMessage(caught) })), [key, pathKey, load, request]);
  const data = result?.key === key ? result.value : null;
  const error = applyError ?? (failure?.key === key ? failure.value : null);
  const loading = !data && !error;
  const current = draft?.fingerprint === data?.fingerprint && draft ? draft : { fingerprint: data?.fingerprint ?? "", type: data?.files.length === 1 ? data.files[0].openType || data.files[0].headType : "", selected: data?.files.filter(file => !file.blocked).map(file => file.depotPath) ?? [] };
  const selected = data?.files.filter(file => current.selected.includes(file.depotPath)) ?? [];
  const unopened = selected.filter(file => !file.action).length;
  const blocked = busy || p4.busy;
  const file = data?.files.length === 1 ? data.files[0] : null;
  const ready = Boolean(data && !error && current.type.trim() && selected.length > 0 && !blocked);
  function reload() { setApplyError(null); setEpoch(value => value + 1); }
  function select(path: string, checked: boolean) {
    setDraft({ ...current, selected: checked ? [...current.selected, path] : current.selected.filter(value => value !== path) });
  }
  function apply() {
    if (!ready || !data) return;
    void mutation.run(async () => {
      setBusy(true); setApplyError(null);
      try {
        await p4.changeFileTypes({ paths: JSON.parse(pathKey), selected: current.selected, fileType: current.type, changeId }, data.fingerprint);
        if (mounted.current) onClose();
      } catch (caught) { if (mounted.current) setApplyError(errorMessage(caught)); }
      finally { if (mounted.current) setBusy(false); }
    });
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast.success(t("p4.properties.copied")); }
    catch { toast.error(t("p4.properties.copyFailed")); }
  }
  function field(label: string, value: ReactNode, copyValue?: string) {
    return <div className="grid min-w-0 gap-1 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3"><span className="text-muted-foreground">{label}</span><div className="flex min-w-0 items-start gap-1"><span className="min-w-0 flex-1 break-all font-mono text-xs leading-5">{value || "—"}</span>{copyValue ? <HoverTip label={t("p4.properties.copy")}><Button size="icon-xs" variant="ghost" aria-label={`${t("p4.properties.copy")}: ${label}`} onClick={() => void copy(copyValue)}><CopyIcon /></Button></HoverTip> : null}</div></div>;
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent ref={content} className="flex max-h-[88vh] flex-col sm:max-w-2xl" showCloseButton={!busy} onOpenAutoFocus={event => { event.preventDefault(); content.current?.focus(); }}>
      <DialogHeader><DialogTitle>{t(editing ? "p4.properties.editTitle" : "p4.properties.title")}</DialogTitle><DialogDescription className="break-all">{file ? file.depotPath : t("p4.properties.count", { count: data?.files.length ?? paths.length })}</DialogDescription></DialogHeader>
      <ScrollArea className="-mx-1 min-h-0 flex-1 px-1"><div className="space-y-4 pb-1">
        {error ? <p role="alert" className="break-words text-sm text-destructive">{p4DisplayError(error)}</p> : null}
        {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />{t("p4.properties.loading")}</p> : null}
        {data && editing ? <>
          <form id={inputId} className="space-y-4" onSubmit={event => { event.preventDefault(); apply(); }}>
            <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={`${inputId}-type`}>{t("p4.properties.fileType")}</Label><HoverTip label={t("p4.properties.typeHelp")}><InfoIcon className="size-3.5 text-muted-foreground" tabIndex={0} /></HoverTip></div><Input id={`${inputId}-type`} autoFocus value={current.type} list={suggestions} disabled={blocked} spellCheck={false} placeholder={t("p4.properties.placeholder")} className="font-mono" onChange={event => { setApplyError(null); setDraft({ ...current, type: event.target.value }); }} /><datalist id={suggestions}>{["text", "binary", "text+x", "binary+l", "text+k", "utf8", "unicode", "utf16", "symlink", "+x", "+l"].map(value => <option key={value} value={value} />)}</datalist></div>
            {unopened > 0 ? <div className="flex flex-wrap items-center justify-between gap-2"><Label>{t("p4.properties.checkoutChange", { count: unopened })}</Label><P4ChangeSelect value={changeId} onChange={setChangeId} disabled={blocked} /></div> : null}
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{t("p4.properties.selected", { count: selected.length })}</span><HoverTip label={t("p4.properties.pendingHelp")}><InfoIcon className="size-3.5" tabIndex={0} /></HoverTip></div>
            {/\+[^+]*S/.test(current.type) ? <p className="text-xs text-amber-600 dark:text-amber-400">{t("p4.properties.retention")}</p> : null}
            <div className="divide-y rounded-md border">{data.files.map(item => <label key={item.depotPath} className="flex min-w-0 items-start gap-2 p-2.5 text-xs"><Checkbox className="mt-0.5" aria-label={item.depotPath} checked={current.selected.includes(item.depotPath)} disabled={blocked || Boolean(item.blocked)} onCheckedChange={value => select(item.depotPath, value === true)} /><span className="min-w-0 flex-1"><span className="block break-all font-mono">{item.depotPath}</span><span className="mt-1 block text-muted-foreground">{item.openType || item.headType}{item.action ? ` · ${item.action} · ${item.changeId === "default" ? t("p4-operations.defaultChange") : item.changeId}` : ` · ${t("p4.properties.checkout")}`}</span></span>{item.blocked ? <span className="shrink-0 text-muted-foreground">{t(`p4.properties.blocked.${item.blocked}`)}</span> : null}</label>)}</div>
          </form>
        </> : null}
        {file && !editing ? <>
          <div className="flex flex-wrap gap-2"><Badge variant="outline">{file.openType || file.headType}</Badge>{file.action ? <Badge variant="outline">{file.action}</Badge> : null}{file.locked ? <Badge variant="outline">{t("p4.properties.locked")}</Badge> : null}{file.blocked ? <Badge variant="outline">{t(`p4.properties.blocked.${file.blocked}`)}</Badge> : null}</div>
          <div className="divide-y text-sm">
            {field(t("p4.properties.depotPath"), file.depotPath, file.depotPath)}
            {field(t("p4.properties.localPath"), file.localPath, file.localPath)}
            {field(t("p4.properties.have"), file.haveRev ? `#${file.haveRev}` : "—")}
            {field(t("p4.properties.head"), file.headRev ? `#${file.headRev}` : "—")}
            {field(t("p4.properties.depotType"), file.headType)}
            {field(t("p4.properties.openType"), file.openType)}
            {field(t("p4.properties.change"), file.changeId === "default" ? t("p4-operations.defaultChange") : file.changeId)}
            {field(t("p4.properties.headChange"), file.headChange)}
            {field(t("p4.properties.size"), file.size === null ? "—" : formatBytes(file.size))}
            {field(t("p4.properties.submitted"), file.headTime ? formatDate(file.headTime * 1000, { dateStyle: "medium", timeStyle: "short" }) : "—")}
            {field(t("p4.properties.modified"), file.headModTime ? formatDate(file.headModTime * 1000, { dateStyle: "medium", timeStyle: "short" }) : "—")}
            {field(t("p4.properties.digest"), file.digest)}
          </div>
          {file.otherOpen.length ? <div className="space-y-2"><h3 className="text-sm font-medium">{t("p4.properties.otherOpen", { count: file.otherOpen.length })}</h3><div className="divide-y rounded-md border">{file.otherOpen.map((other, index) => <div key={index} className="flex flex-wrap items-center gap-2 p-2 text-xs"><span className="min-w-0 flex-1 break-all font-mono">{other.owner}</span><span className="text-muted-foreground">{other.action} · {other.change}</span>{other.locked ? <Badge variant="outline">{t("p4.properties.locked")}</Badge> : null}</div>)}</div></div> : null}
        </> : null}
      </div></ScrollArea>
      <DialogFooter className="items-center sm:justify-between"><HoverTip label={t("p4.properties.reload")}><Button size="icon-sm" variant="ghost" disabled={blocked} aria-label={t("p4.properties.reload")} onClick={reload}><RefreshCwIcon /></Button></HoverTip><div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>{t(editing ? "common.cancel" : "common.close")}</Button>{editing ? <Button type="submit" form={inputId} disabled={!ready}>{busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t("common.apply")}</Button> : <Button disabled={blocked || !file || Boolean(file.blocked)} onClick={() => setEditing(true)}><PencilIcon />{t("p4.properties.editTitle")}</Button>}</div></DialogFooter>
    </DialogContent>
  </Dialog>;
}
