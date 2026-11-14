import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownFromLineIcon, ArrowDownToLineIcon, ArrowUpFromLineIcon, CodeXmlIcon, DownloadIcon, EllipsisIcon, FileInputIcon, FolderOpenIcon, RefreshCwIcon, Settings2Icon, SquareTerminalIcon } from "lucide-react";
import { RepositoryActions, RepositoryRefButton, ToolbarButton } from "@/components/repository-toolbar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HoverTip } from "@/components/ui/tooltip";

export function DemoSplit({ left, right, perforce = false }: { left: ReactNode; right: ReactNode; perforce?: boolean }) {
  return <ResizablePanelGroup orientation="horizontal" className="demo-split">
    <ResizablePanel defaultSize={perforce ? "42%" : "36%"} minSize="24%" maxSize="52%">{left}</ResizablePanel>
    <ResizableHandle />
    <ResizablePanel minSize="36%">{right}</ResizablePanel>
  </ResizablePanelGroup>;
}

export function DemoToolbar({ perforce = false, ahead = 0, onRefresh }: { perforce?: boolean; ahead?: number; onRefresh: () => void }) {
  const { t } = useTranslation();
  function desktopTool(label: string, icon: ReactNode, badge?: number) {
    return <HoverTip label={`${label} · ${t("demo.desktopOnly")}`}><span tabIndex={0} className="demo-desktop-tool"><ToolbarButton label={label} disabled badge={badge}>{icon}</ToolbarButton></span></HoverTip>;
  }
  return <div className="demo-toolbar">
    <HoverTip label={t("demo.desktopOnly")}><span tabIndex={0}><RepositoryRefButton disabled>{perforce ? "studio-main" : "main"}</RepositoryRefButton></span></HoverTip>
    <RepositoryActions>
      <HoverTip label={t("demo.refresh")}><ToolbarButton label={t("demo.refresh")} onClick={onRefresh}><RefreshCwIcon /></ToolbarButton></HoverTip>
      {perforce ? <>
        {desktopTool(t("demo.sync"), <DownloadIcon />)}
        <span className="demo-toolbar-divider" />
        {desktopTool(t("demo.workspaceActions"), <EllipsisIcon />)}
      </> : <>
        {desktopTool(t("demo.fetch"), <ArrowDownFromLineIcon />)}
        {desktopTool(t("demo.pull"), <ArrowDownToLineIcon />)}
        {desktopTool(t("demo.push"), <ArrowUpFromLineIcon />, ahead || undefined)}
        {desktopTool(t("demo.applyPatch"), <FileInputIcon />)}
        <span className="demo-toolbar-divider" />
        {desktopTool(t("demo.repositorySettings"), <Settings2Icon />)}
      </>}
    </RepositoryActions>
    <div className="demo-toolbar-external">
      {desktopTool(t("demo.openEditor"), <CodeXmlIcon />)}
      {desktopTool(t("demo.openTerminal"), <SquareTerminalIcon />)}
      {desktopTool(t("demo.openFolder"), <FolderOpenIcon />)}
    </div>
  </div>;
}
