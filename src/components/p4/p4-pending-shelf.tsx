import { useEffect, type ReactNode } from "react";
import { ArchiveRestoreIcon, ChevronDownIcon, GitBranchIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useTranslation } from "@/i18n";
import { depotBase } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { cn } from "@/lib/utils";
import type { PendingShelf } from "@/state/p4-session";

export function PendingShelfGroup({ id, exists, shelf, open, busy, load, onToggle, onUnshelve, onDelete, onStream, children }: {
  id: string;
  exists: boolean;
  shelf?: PendingShelf;
  open: boolean;
  busy: boolean;
  load: (id: string, retry?: boolean) => Promise<void>;
  onToggle: () => void;
  onUnshelve: () => void;
  onDelete: () => void;
  onStream: (path: string) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (open && exists && !shelf) void load(id);
  }, [exists, id, load, open, shelf]);
  const detail = shelf?.status === "ready" ? shelf.detail : undefined;
  const stream = detail?.shelvedStream;
  const count = detail ? detail.files.length + (stream ? 1 : 0) : exists ? null : 0;
  const header = (
    <button type="button" className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 pl-7 text-left hover:bg-muted/70" onClick={onToggle} aria-expanded={open}>
      <ChevronDownIcon className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      <span className="text-xs font-medium">{t("p4.shelved")}</span>
      {count !== null ? <span className="tabular-nums text-xs text-muted-foreground">{count}</span> : null}
    </button>
  );
  return (
    <div>
      {exists ? <ContextMenu>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-36">
          <ContextMenuItem disabled={busy || (detail && !detail.files.length)} onClick={onUnshelve}><ArchiveRestoreIcon />{t("p4.unshelve")}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" disabled={busy} onClick={onDelete}><Trash2Icon />{t("p4.delete")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu> : header}
      {open && exists && !detail ? (
        shelf?.status === "error"
          ? <ShelfReadError message={shelf.message} retry={() => void load(id, true)} />
          : <p role="status" className="py-1 pl-12 text-xs text-muted-foreground">{t("p4.loading")}</p>
      ) : null}
      {open && stream ? <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button" className="flex w-full items-center gap-2 rounded-md py-1.5 pl-9 pr-2 text-left text-xs hover:bg-muted/70" onClick={() => onStream(stream.path)}>
            <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t("p4.streamWork.shelved")}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{depotBase(stream.path)}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem variant="destructive" disabled={busy} onClick={onDelete}><Trash2Icon />{t("p4.delete")}</ContextMenuItem></ContextMenuContent>
      </ContextMenu> : null}
      {open && detail ? children : null}
    </div>
  );
}

export function ShelfReadError({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useTranslation();
  return <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs">
    <span className="text-muted-foreground">{p4DisplayError(message)}</span>
    <Button type="button" size="xs" variant="ghost" onClick={retry}>{t("common.retry")}</Button>
  </div>;
}
