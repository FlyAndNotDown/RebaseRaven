import { useEffect, useRef, useState } from "react";
import { FolderTreeIcon, HardDriveIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { HoverTip } from "@/components/ui/tooltip";
import { createExclusiveAction } from "@/lib/async-scope";
import { errorMessage, gitApi } from "@/lib/git";
import type { GitRepositoryField, GitRepositoryKey, GitRepositorySettings } from "@/types/git";

type Draft = Partial<Record<GitRepositoryKey, string | null>>;

export function RepositorySettingsForm({repoPath, onClose, onBusyChange, onSparse, onLfs}: {repoPath: string; onClose: () => void; onBusyChange: (busy: boolean) => void; onSparse?:()=>void; onLfs?:()=>void}) {
  const { t } = useTranslation();
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
  const edit = (key: GitRepositoryKey, value: string | null) => setDraft(current => ({...current,[key]:value}));
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
  return <div className="flex min-h-0 flex-col gap-4">
    <div className="grid min-h-0 gap-4 overflow-y-auto pr-1">
      {settings ? <>
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{t(settings.worktree ? "git.repositorySettings.worktree" : "git.repositorySettings.repository")}</span><HoverTip label={t(settings.worktree ? "git.repositorySettings.worktreeHint" : "git.repositorySettings.scopeHint")}><InfoIcon className="size-3.5" /></HoverTip></div>
        {settings.readOnly ? <p role="alert" className="text-xs text-destructive">{t("git.repositorySettings.readOnly")}</p> : null}
        {settings.fields.map(field => <RepositoryField key={field.key} field={field} value={draft[field.key] ?? null} busy={busy} readOnly={settings.readOnly} onChange={value => edit(field.key,value)} />)}
      </> : !error ? <div role="status" aria-label={t("git.repositorySettings.loading")} className="grid gap-4"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div> : null}
      {error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p> : null}
    </div>
    {(onSparse || onLfs) ? <div className="flex shrink-0 flex-wrap gap-2 border-t pt-4">
      {onSparse ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onSparse}><FolderTreeIcon />{t("git.sparse.title")}</Button> : null}
      {onLfs ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onLfs}><HardDriveIcon />{t("git.lfs.title")}</Button> : null}
    </div> : null}
    <DialogFooter className="shrink-0">
      <Button variant="ghost" disabled={busy} onClick={() => {setSettings(null);setError(null);setAttempt(value => value + 1);}}>{t("git.repositorySettings.reload")}</Button>
      <Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
      <Button disabled={busy || !settings || !changes.length || settings.readOnly} onClick={() => void save()}>{t(busy ? "git.ui.saving" : "common.save")}</Button>
    </DialogFooter>
  </div>;
}

function RepositoryField({ field, value, busy, readOnly, onChange }: { field: GitRepositoryField; value: string | null; busy: boolean; readOnly: boolean; onChange: (value: string | null) => void }) {
  const { t } = useTranslation();
  const id = `repo-config-${field.key}`;
  const label = t(`git.repositorySettings.fields.${field.key.replace(/\./g, "_")}`);
  return <div className="grid gap-1.5">
    <div className="flex items-center gap-1.5"><Label htmlFor={id}>{label}</Label><HoverTip label={t(`git.repositorySettings.hints.${field.key.replace(/\./g, "_")}`)}><InfoIcon className="size-3" /></HoverTip>
      {!field.editable ? <HoverTip label={t("git.repositorySettings.overridden", { value: field.effective ?? "", origin: field.origin ?? "" })}><span className="ml-auto text-[10px] text-muted-foreground">{t("git.repositorySettings.source")}</span></HoverTip> : null}
    </div>
    <div className="flex items-center gap-1.5">
      <Input id={id} type={field.key === "user.email" ? "email" : "text"} value={value ?? ""} placeholder={field.inherited ?? t("git.repositorySettings.gitDefault")} disabled={busy || readOnly || !field.editable} spellCheck={false} onChange={event => onChange(event.target.value || null)} />
      {value !== null ? <HoverTip label={t("git.repositorySettings.reset")}><Button type="button" variant="ghost" size="icon-sm" disabled={busy || readOnly} aria-label={t("git.repositorySettings.resetField", { label })} onClick={() => onChange(null)}><RotateCcwIcon /></Button></HoverTip> : null}
    </div>
  </div>;
}
