import type { ReactNode } from "react";
import { BrushCleaningIcon, CableIcon, FolderPenIcon, GitMergeIcon, ListChecksIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

type WorkspaceAction = "reconcile" | "clean" | "integrate" | "workspace" | "connection";

export function P4WorkspaceActions({ renderAction }: {
  renderAction: (action: WorkspaceAction, label: string, icon: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  return <>
    <span aria-hidden className="h-3.5 w-px bg-foreground/20" />
    {renderAction("reconcile", t("p4.reconcileReview.title"), <ListChecksIcon />)}
    {renderAction("clean", t("p4.clean.title"), <BrushCleaningIcon />)}
    {renderAction("integrate", t("p4.integration.title"), <GitMergeIcon />)}
    <span aria-hidden className="h-3.5 w-px bg-foreground/20" />
    {renderAction("workspace", t("p4.editWorkspace"), <FolderPenIcon />)}
    {renderAction("connection", t("p4.editConnection"), <CableIcon />)}
  </>;
}
