import { t, useTranslation } from "@/i18n";
import { BrushCleaningIcon, CableIcon, DownloadIcon, EllipsisIcon, FolderPenIcon, GitMergeIcon, ListChecksIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/tooltip";
import { useP4 } from "@/state/p4-context";

const actionClass = "h-[calc(1.75rem-2px)]! w-[calc(1.75rem-2px)]! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background";

export function P4Header() {
  useTranslation();
  const p4 = useP4();
  const { connection, busy } = p4;
  return <div className="flex min-w-0 items-center gap-1.5">
    {connection?.client ? <HoverTip label={t("p4.editWorkspace")}>
      <Button variant="outline" size="sm" className="max-w-44 shrink-0 font-mono" disabled={busy} onClick={() => p4.setWorkspaceOpen(true)}><span className="truncate">{connection.client}</span></Button>
    </HoverTip> : null}
    <div className="flex h-7 shrink-0 items-center gap-1 rounded-[min(var(--radius-md),12px)] border border-input bg-secondary px-0.5">
      <HoverTip label={t("p4.refresh")}><Button type="button" variant="ghost" size="icon-xs" className={actionClass} aria-label={t("p4.refresh")} disabled={busy} onClick={() => void p4.refresh()}><RefreshCwIcon /></Button></HoverTip>
      <HoverTip label={t("p4.getLatest")}><Button type="button" variant="ghost" size="icon-xs" className={actionClass} aria-label={t("p4.getLatest")} disabled={busy} onClick={() => void p4.sync()}><DownloadIcon /></Button></HoverTip>
      <span className="h-3.5 w-px self-center bg-foreground/20" />
      <DropdownMenu>
        <HoverTip label={t("p4.workspaceActions")}><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className={actionClass} aria-label={t("p4.workspaceActions")} disabled={busy}><EllipsisIcon /></Button></DropdownMenuTrigger></HoverTip>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => void p4.reconcile()}><ListChecksIcon />{t("p4.reconcileReview.title")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => p4.openClean()}><BrushCleaningIcon />{t("p4.clean.title")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => p4.openIntegration()}><GitMergeIcon />{t("p4.integration.title")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => p4.setWorkspaceOpen(true)}><FolderPenIcon />{t("p4.editWorkspace")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => p4.setConnectionOpen(true)}><CableIcon />{t("p4.editConnection")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>;
}
