import { useState } from "react";
import { toast } from "sonner";
import { SyncPopover } from "@/components/sync-popover";
import { P4WorkspaceActions } from "@/components/p4/p4-workspace-actions";
import { RepositoryActions, RepositoryRefButton, ToolbarButton } from "@/components/repository-toolbar";
import { Checkbox } from "@/components/ui/checkbox";
import { useGitPick } from "@/state/git-context";
import { errorMessage } from "@/lib/git";
import { t, useTranslation } from "@/i18n";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { useP4 } from "@/state/p4-context";

const syncAction = "sync" as const;

export function P4Header() {
  useTranslation();
  const p4 = useP4();
  const { connection, busy } = p4;
  const { prefs, updatePrefs } = useGitPick(["prefs", "updatePrefs"]);
  const [openAction, setOpenAction] = useState<"sync" | null>(null);
  const [saving, setSaving] = useState(false);
  const workspaceActions = {
    reconcile: () => void p4.reconcile(),
    clean: () => p4.openClean(),
    integrate: () => p4.openIntegration(),
    workspace: () => p4.setWorkspaceOpen(true),
    connection: () => p4.setConnectionOpen(true),
  };
  async function setAutoResolve(checked: boolean) {
    if (saving) return;
    setSaving(true);
    try { await updatePrefs({...prefs, p4AutoResolveAfterSync: checked}); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); }
  }
  return <div className="flex min-w-0 items-center gap-1.5">
    {connection?.client ? <HoverTip label={t("p4.editWorkspace")}>
      <RepositoryRefButton disabled={busy} onClick={() => p4.setWorkspaceOpen(true)}>{connection.client}</RepositoryRefButton>
    </HoverTip> : null}
    <RepositoryActions>
      <HoverTip label={t("p4.refresh")}><ToolbarButton label={t("p4.refresh")} disabled={busy} onClick={() => void p4.refresh()}><RefreshCwIcon /></ToolbarButton></HoverTip>
      <SyncPopover action={syncAction} openAction={openAction} onOpenAction={setOpenAction} label={t("p4.getLatest")} hint={t("p4.getLatest")} icon={<DownloadIcon />} disabled={busy}
        onOpenAutoFocus={event => {
          event.preventDefault();
          if (event.target instanceof HTMLElement) event.target.focus();
        }}>
        <div className="grid gap-3">
          <h3 className="text-sm font-medium">{t("p4.getLatest")}</h3>
          <HoverTip label={t("p4.autoResolveAfterSyncHint")}>
            <label className="flex items-center gap-2 text-xs"><Checkbox checked={prefs.p4AutoResolveAfterSync} disabled={saving} onCheckedChange={value => void setAutoResolve(value === true)} />{t("p4.autoResolveAfterSync")}</label>
          </HoverTip>
          <Button size="sm" className="w-full" disabled={busy || saving} onClick={() => {setOpenAction(null); void p4.sync();}}><DownloadIcon />{t("p4.getLatest")}</Button>
        </div>
      </SyncPopover>
      <P4WorkspaceActions renderAction={(action, label, icon) => (
        <HoverTip label={label}>
          <ToolbarButton label={label} disabled={busy} onClick={workspaceActions[action]}>{icon}</ToolbarButton>
        </HoverTip>
      )} />
    </RepositoryActions>
  </div>;
}
