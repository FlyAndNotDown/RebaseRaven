import { useState } from "react";
import { toast } from "sonner";
import { SyncPopover } from "@/components/sync-popover";
import { RepositoryActions, RepositoryRefButton, ToolbarButton } from "@/components/repository-toolbar";
import { Checkbox } from "@/components/ui/checkbox";
import { useGitPick } from "@/state/git-context";
import { errorMessage } from "@/lib/git";
import { t, useTranslation } from "@/i18n";
import { BrushCleaningIcon, CableIcon, DownloadIcon, EllipsisIcon, FolderPenIcon, GitMergeIcon, ListChecksIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
      <SyncPopover action={syncAction} openAction={openAction} onOpenAction={setOpenAction} label={t("p4.getLatest")} hint={t("p4.getLatest")} icon={<DownloadIcon />} disabled={busy}>
        <div className="grid gap-3">
          <h3 className="text-sm font-medium">{t("p4.getLatest")}</h3>
          <HoverTip label={t("p4.autoResolveAfterSyncHint")}>
            <label className="flex items-center gap-2 text-xs"><Checkbox checked={prefs.p4AutoResolveAfterSync} disabled={saving} onCheckedChange={value => void setAutoResolve(value === true)} />{t("p4.autoResolveAfterSync")}</label>
          </HoverTip>
          <Button size="sm" className="w-full" disabled={busy || saving} onClick={() => {setOpenAction(null); void p4.sync();}}><DownloadIcon />{t("p4.getLatest")}</Button>
        </div>
      </SyncPopover>
      <span className="h-3.5 w-px self-center bg-foreground/20" />
      <DropdownMenu>
        <HoverTip label={t("p4.workspaceActions")}><DropdownMenuTrigger asChild><ToolbarButton label={t("p4.workspaceActions")} disabled={busy}><EllipsisIcon /></ToolbarButton></DropdownMenuTrigger></HoverTip>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => void p4.reconcile()}><ListChecksIcon />{t("p4.reconcileReview.title")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => p4.openClean()}><BrushCleaningIcon />{t("p4.clean.title")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => p4.openIntegration()}><GitMergeIcon />{t("p4.integration.title")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => p4.setWorkspaceOpen(true)}><FolderPenIcon />{t("p4.editWorkspace")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => p4.setConnectionOpen(true)}><CableIcon />{t("p4.editConnection")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </RepositoryActions>
  </div>;
}
