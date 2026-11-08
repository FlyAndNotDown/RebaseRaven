import { useEffect, useRef, useState } from "react";
import { FolderOpenIcon, FolderTreeIcon, HardDriveIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { HoverTip } from "@/components/ui/tooltip";
import { createExclusiveAction } from "@/lib/async-scope";
import { errorMessage, gitApi } from "@/lib/git";
import type { GitRepositoryField, GitRepositoryKey, GitRepositorySettings } from "@/types/git";

type Draft = Partial<Record<GitRepositoryKey, string | null>>;
const selectClass = "h-9 w-full rounded-md border border-input bg-input/30 px-2 text-sm disabled:opacity-50";

export function RepositorySettingsForm({repoPath, onClose, onBusyChange, onSparse, onLfs}: {repoPath: string; onClose: () => void; onBusyChange: (busy: boolean) => void; onSparse?:()=>void; onLfs?:()=>void}) {
  const { t } = useTranslation();
  const [page,setPage] = useState<"identity"|"signing">("identity");
  const [settings, setSettings] = useState<GitRepositorySettings | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mutation] = useState(createExclusiveAction);
  const owner = useRef<symbol | null>(null);
  useEffect(() => {
    const token = Symbol(); owner.current = token;
    void gitApi.getRepositorySettings(repoPath).then(value => {
      if (owner.current !== token) return;
      setSettings(value); setDraft(Object.fromEntries(value.fields.map(field => [field.key,field.value]))); setError(null);
    }).catch((error: unknown) => {if (owner.current === token) setError(errorMessage(error));});
    return () => {if (owner.current === token) owner.current = null;};
  }, [repoPath, attempt]);
  const changes = settings?.fields.filter(field => draft[field.key] !== field.value).map(field => ({key:field.key,value:draft[field.key] ?? null})) ?? [];
  const formatField = settings?.fields.find(field => field.key === "gpg.format");
  const format = formatField?.editable === false ? formatField.effective ?? "openpgp" : draft["gpg.format"] ?? formatField?.inherited ?? "openpgp";
  const edit = (key: GitRepositoryKey, value: string | null) => setDraft(current => ({...current,[key]:value}));
  async function browse(key: GitRepositoryKey) {
    const token = owner.current;
    try {
      const path = await open({directory:false,multiple:false,defaultPath:repoPath,title:t("git.signingSettings.chooseFile")});
      if (owner.current === token && typeof path === "string") edit(key,path);
    } catch (error) {if (owner.current === token) setError(errorMessage(error));}
  }
  async function save() {
    if (!settings || !changes.length || !owner.current) return;
    const token = owner.current;
    await mutation.run(async () => {
      if (owner.current !== token) return;
      setBusy(true); onBusyChange(true); setError(null);
      try {
        await gitApi.setRepositorySettings(repoPath,changes,settings.fingerprint);
        if (owner.current === token) {toast.success(t("git.ui.saved_repository_settings")); onClose();}
      } catch (error) {if (owner.current === token) setError(errorMessage(error));}
      finally {if (owner.current === token) setBusy(false); onBusyChange(false);}
    });
  }
  function display(key: GitRepositoryKey, value: string | null) {
    if (value === null) return t(key === "gpg.format" ? "git.signingSettings.openpgp" : key === "commit.gpgsign" || key === "tag.gpgsign" ? "git.signingSettings.disabled" : "git.signingSettings.gitDefault");
    if (key === "commit.gpgsign" || key === "tag.gpgsign") return value === "true" ? t("git.signingSettings.enabled") : value === "false" ? t("git.signingSettings.disabled") : t("git.signingSettings.invalid",{value});
    if (key === "gpg.format") return value === "ssh" ? "SSH" : value === "x509" ? "X.509" : value === "openpgp" ? t("git.signingSettings.openpgp") : value;
    return value;
  }
  return <div className="flex min-h-0 flex-col gap-4">
    <SegmentedControl label={t("git.ui.repository_settings")} value={page} onChange={setPage} disabled={busy} options={[{value:"identity",label:t("git.signingSettings.identity")},{value:"signing",label:t("git.signingSettings.title")}]} />
    <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
      {settings ? <>
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{t(settings.worktree ? "git.signingSettings.worktree" : "git.signingSettings.repository")}</span><HoverTip label={t(settings.worktree ? "git.signingSettings.worktreeHint" : "git.signingSettings.scopeHint")}><InfoIcon className="size-3.5" /></HoverTip></div>
        {settings.readOnly ? <p role="alert" className="text-xs text-destructive">{t("git.signingSettings.readOnly")}</p> : null}
        {settings.fields.filter(field => (page === "identity") === (field.key === "user.name" || field.key === "user.email")).filter(field => format === "ssh" || !field.key.startsWith("gpg.ssh.")).map(field => <RepositoryField key={field.key} field={field} value={draft[field.key] ?? null} busy={busy} readOnly={settings.readOnly} onChange={value => edit(field.key,value)} onBrowse={format === "ssh" && (field.key === "user.signingkey" || field.key.startsWith("gpg.ssh.")) ? () => void browse(field.key) : undefined} display={display} />)}
      </> : !error ? <div role="status" aria-label={t("git.signingSettings.loading")} className="grid gap-4"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div> : null}
      {error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p> : null}
    </div>
    {page === "identity" && (onSparse || onLfs) ? <div className="flex shrink-0 flex-wrap gap-2 border-t pt-4">
      {onSparse ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onSparse}><FolderTreeIcon />{t("git.sparse.title")}</Button> : null}
      {onLfs ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onLfs}><HardDriveIcon />{t("git.lfs.title")}</Button> : null}
    </div> : null}
    <DialogFooter className="shrink-0">
      <Button variant="ghost" disabled={busy} onClick={() => {setSettings(null);setError(null);setAttempt(value => value + 1);}}>{t("git.signingSettings.reload")}</Button>
      <Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
      <Button disabled={busy || !settings || !changes.length || settings.readOnly} onClick={() => void save()}>{t(busy ? "git.ui.saving" : "common.save")}</Button>
    </DialogFooter>
  </div>;
}

function RepositoryField({field,value,busy,readOnly,onChange,onBrowse,display}: {field:GitRepositoryField;value:string|null;busy:boolean;readOnly:boolean;onChange:(value:string|null)=>void;onBrowse?:()=>void;display:(key:GitRepositoryKey,value:string|null)=>string}) {
  const { t } = useTranslation();
  const id = `repo-config-${field.key}`;
  const disabled = busy || !field.editable;
  const inherited = display(field.key,field.inherited);
  const options = field.key === "gpg.format" ? ["openpgp","ssh","x509"] : field.key === "commit.gpgsign" || field.key === "tag.gpgsign" ? ["true","false"] : null;
  const invalid = value !== null && options && !options.includes(value);
  const label = t(`git.signingSettings.fields.${field.key.replace(/\./g,"_")}`);
  return <div className="grid gap-1.5">
    <div className="flex items-center gap-1.5"><Label htmlFor={id}>{label}</Label><HoverTip label={t(`git.signingSettings.hints.${field.key.replace(/\./g,"_")}`)}><InfoIcon className="size-3 text-muted-foreground" /></HoverTip>
      {!field.editable ? <HoverTip label={t("git.signingSettings.overridden",{value:display(field.key,field.effective),origin:field.origin ?? ""})}><span className="ml-auto text-[10px] text-muted-foreground">{t("git.signingSettings.source")}</span></HoverTip> : null}
    </div>
    <div className="flex items-center gap-1.5">
      {options ? <select id={id} className={selectClass} value={value ?? "inherit"} disabled={disabled} onChange={event => onChange(event.target.value === "inherit" ? null : event.target.value)}>
        <option value="inherit">{t("git.signingSettings.inherit",{value:inherited})}</option>
        {invalid ? <option value={value!}>{t("git.signingSettings.invalid",{value})}</option> : null}
        {options.map(option => <option key={option} value={option}>{display(field.key,option)}</option>)}
      </select> : <Input id={id} type={field.key === "user.email" ? "email" : "text"} value={value ?? ""} placeholder={inherited} className={field.key === "user.name" || field.key === "user.email" ? undefined : "font-mono text-xs"} disabled={disabled} spellCheck={false} onChange={event => onChange(event.target.value || null)} />}
      {onBrowse ? <HoverTip label={t("git.signingSettings.chooseFile")}><Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("git.signingSettings.chooseField",{label})} onClick={onBrowse}><FolderOpenIcon /></Button></HoverTip> : null}
      {value !== null ? <HoverTip label={t("git.signingSettings.reset")}><Button type="button" variant="ghost" size="icon-sm" disabled={busy || readOnly} aria-label={t("git.signingSettings.resetField",{label})} onClick={() => onChange(null)}><RotateCcwIcon /></Button></HoverTip> : null}
    </div>
  </div>;
}
