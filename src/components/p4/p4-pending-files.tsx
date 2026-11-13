import { useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { FileStatusTip, fileStatusText } from "@/components/p4/file-status-tip";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { HoverTip } from "@/components/ui/tooltip";
import { useTranslation } from "@/i18n";
import { depotBase, p4ActionStatus } from "@/lib/p4";
import { cn } from "@/lib/utils";

export type PendingFile = {
  depotPath: string;
  action: string;
  shelved: boolean;
  status: string;
  detail: string;
};

export type PendingDragFile = { change: string; path: string; shelved: boolean };

export function openedSelection(
  pending: { id: string; files: PendingFile[] }[],
  picked: ReadonlySet<string>,
  file: PendingDragFile,
  action: string,
) {
  const key = rowKey(file);
  const single = [{ change: file.change, path: file.path, action }];
  if (picked.size < 2 || !picked.has(key)) return single;
  const found: { change: string; path: string; action: string }[] = [];
  for (const change of pending) {
    for (const item of change.files) {
      if (item.shelved) continue;
      const row = { change: change.id, path: item.depotPath, shelved: false };
      if (!picked.has(rowKey(row))) continue;
      found.push({ change: change.id, path: item.depotPath, action: item.action });
    }
  }
  return found.length > 0 ? found : single;
}

export function PendingFiles({
  changeId,
  files,
  picked,
  selectedPath,
  selectedShelved,
  className,
  onSelect,
  onPointerDown,
  onContextMenu,
  menu,
}: {
  changeId: string;
  files: PendingFile[];
  picked: ReadonlySet<string>;
  selectedPath: string | null;
  selectedShelved: boolean;
  className: string;
  onSelect: (event: MouseEvent, path: string) => void;
  onPointerDown: (event: ReactPointerEvent, file: PendingDragFile) => void;
  onContextMenu?: (file: PendingDragFile) => void;
  menu?: (entry: PendingFile, file: PendingDragFile) => ReactNode;
}) {
  useTranslation();
  return files.map((file) => {
    const drag = { change: changeId, path: file.depotPath, shelved: file.shelved };
    const active =
      picked.size > 0
        ? picked.has(rowKey(drag))
        : file.depotPath === selectedPath && file.shelved === selectedShelved;
    const row = (
      <button
        type="button"
        className={cn(
          "flex w-full cursor-grab items-center gap-2 rounded-md py-1 pr-2 text-left text-xs hover:bg-muted/70",
          className,
          active && "bg-muted",
        )}
        onClick={(event) => onSelect(event, file.depotPath)}
        onPointerDown={(event) => onPointerDown(event, drag)}
        onContextMenu={() => onContextMenu?.(drag)}
      >
        <FileStatusIcon status={file.status || p4ActionStatus(file.action)} className="mr-1" />
        <span className="min-w-0 flex-1 truncate font-mono">{depotBase(file.depotPath)}</span>
      </button>
    );
    const text = fileStatusText(file.depotPath, file.detail, file.action);
    const tip = text ? <FileStatusTip text={text} /> : undefined;
    const key = `${file.depotPath}:${file.shelved ? "shelf" : "open"}`;
    if (menu) {
      return (
        <PendingFileMenu key={key} content={() => menu(file, drag)}>
          <HoverTip className="max-w-lg" label={tip}>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          </HoverTip>
        </PendingFileMenu>
      );
    }
    return (
      <HoverTip key={key} className="max-w-lg" label={tip}>
        {row}
      </HoverTip>
    );
  });
}

function PendingFileMenu({ children, content }: { children: ReactNode; content: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <ContextMenu open={open} onOpenChange={setOpen}>
    {children}
    {open ? content() : null}
  </ContextMenu>;
}

export function rowKey(file: PendingDragFile) {
  return `${file.change}\n${file.path}\n${file.shelved ? "1" : "0"}`;
}
