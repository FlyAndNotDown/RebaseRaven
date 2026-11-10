import { t, useTranslation } from "@/i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestoreIcon, TagsIcon, NetworkIcon, ArchiveIcon, CircleDotIcon, FolderTreeIcon, HistoryIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/lazy-dialogs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { normalizeP4SidebarOrder, normalizeSidebarOrder } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useGitPick, type View } from "@/state/git-context";
import { useP4, type P4View } from "@/state/p4-context";

const itemMeta: Record<View, SidebarItemMeta> = {
  changes: { get label() { return t("desktop.appSidebar.changes"); }, icon: CircleDotIcon },
  history: { get label() { return t("desktop.appSidebar.history"); }, icon: HistoryIcon },
  stash: { get label() { return t("desktop.appSidebar.stash"); }, icon: ArchiveIcon },
  files: { get label() { return t("desktop.appSidebar.files"); }, icon: FolderTreeIcon },
};

const perforceMeta: Record<P4View, SidebarItemMeta> = {
  pending: { get label() { return t("desktop.appSidebar.pending"); }, icon: CircleDotIcon },
  submitted: { get label() { return t("desktop.appSidebar.history"); }, icon: HistoryIcon },
  shelves: { get label() { return t("p4.shelves.title"); }, icon: ArchiveRestoreIcon },
  workspace: { get label() { return t("desktop.appSidebar.workspace"); }, icon: FolderTreeIcon },
  specs: { get label() { return t("p4.specs.title"); }, icon: TagsIcon },
  streams: { get label() { return t("p4.streamTree.title"); }, icon: NetworkIcon },
};

export function AppSidebar() {
  useTranslation();
  const { view, setView, activeTab, prefs, updatePrefs, openPanel, setOpenPanel } = useGitPick([
    "view",
    "setView",
    "activeTab",
    "prefs",
    "updatePrefs",
    "openPanel",
    "setOpenPanel",
  ]);
  const settingsOpen = openPanel === "settings" || openPanel === "settings-about";
  const setSettingsOpen = (open: boolean) => setOpenPanel(open ? "settings" : null);
  const p4 = useP4();
  const perforce = activeTab.kind === "repo" && activeTab.vcs === "perforce";
  const repoOpen = activeTab.kind === "repo";
  const gitOrder = useMemo(() => normalizeSidebarOrder(prefs.sidebarOrder), [prefs.sidebarOrder]);
  const p4Order = useMemo(() => normalizeP4SidebarOrder(prefs.p4SidebarOrder), [prefs.p4SidebarOrder]);

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2">
      {perforce ? <SidebarViews
        key="perforce"
        meta={perforceMeta}
        savedOrder={p4Order}
        selected={p4.view}
        enabled={repoOpen}
        onSelect={p4.setView}
        onReorder={next => { void updatePrefs({ ...prefs, p4SidebarOrder: next }); }}
      /> : <SidebarViews
        key="git"
        meta={itemMeta}
        savedOrder={gitOrder}
        selected={view}
        enabled={repoOpen}
        onSelect={setView}
        onReorder={next => { void updatePrefs({ ...prefs, sidebarOrder: next }); }}
      />}
      <div className="mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("common.settings")}
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("common.settings")}</TooltipContent>
        </Tooltip>
      </div>
      <SettingsDialog open={settingsOpen} initialSection={openPanel === "settings-about" ? "about" : "general"} onOpenChange={setSettingsOpen} />
    </nav>
  );
}

interface SidebarItemMeta { label: string; icon: typeof CircleDotIcon }

function SidebarViews<V extends string>({meta, savedOrder, selected, enabled, onSelect, onReorder}: {
  meta: Record<V, SidebarItemMeta>;
  savedOrder: V[];
  selected: V;
  enabled: boolean;
  onSelect: (view: V) => void;
  onReorder: (order: V[]) => void;
}) {
  const [order, setOrder] = useState(savedOrder);
  const [previousOrder, setPreviousOrder] = useState(savedOrder);
  const [dragging, setDragging] = useState<V | null>(null);
  const dragRef = useRef<{ view: V; startY: number; active: boolean; original: V[] } | null>(null);
  const orderRef = useRef(order);
  const listRef = useRef<HTMLDivElement>(null);
  if (previousOrder !== savedOrder) {
    setPreviousOrder(savedOrder);
    setOrder(savedOrder);
  }
  useLayoutEffect(() => {
    orderRef.current = order;
  });

  useEffect(() => {
    function dropTargetAt(clientY: number): { view: V; place: "before" | "after" } | null {
      const nodes = listRef.current
        ? Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-sidebar-view]"))
        : [];
      if (nodes.length === 0) return null;
      for (const node of nodes) {
        const id = node.dataset.sidebarView as V | undefined;
        if (!id) continue;
        const rect = node.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          return { view: id, place: "before" };
        }
      }
      const last = nodes[nodes.length - 1]?.dataset.sidebarView as V | undefined;
      return last ? { view: last, place: "after" } : null;
    }

    function moveItem(from: V, to: V, place: "before" | "after") {
      const current = orderRef.current;
      const fromIndex = current.indexOf(from);
      if (fromIndex < 0) return current;
      const next = current.filter((item) => item !== from);
      let insert = next.indexOf(to);
      if (insert < 0) return current;
      if (place === "after") insert += 1;
      next.splice(insert, 0, from);
      if (next.every((item, index) => item === current[index])) return current;
      orderRef.current = next;
      setOrder(next);
      return next;
    }

    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active && Math.abs(event.clientY - drag.startY) < 6) return;
      if (!drag.active) {
        drag.active = true;
        setDragging(drag.view);
      }
      const target = dropTargetAt(event.clientY);
      if (target && target.view !== drag.view) {
        moveItem(drag.view, target.view, target.place);
      }
    }

    function endDrag(event: PointerEvent) {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      if (!drag?.active) return;
      if (event.type === "pointercancel") {
        orderRef.current = drag.original;
        setOrder(drag.original);
        return;
      }
      const next = orderRef.current;
      if (next.join() === savedOrder.join()) return;
      onReorder(next);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [savedOrder, onReorder]);

  return <div ref={listRef} className={cn("flex flex-col items-center gap-1", dragging && "select-none")}>
    {order.map(id => {
      const item = meta[id];
      const Icon = item.icon;
      const active = enabled && selected === id;
      return <Tooltip key={id}>
        <TooltipTrigger asChild><Button
          type="button"
          variant="ghost"
          size="icon"
          data-sidebar-view={id}
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          className={cn("cursor-grab touch-none", active && "bg-muted text-foreground", !enabled && "opacity-50", dragging === id && "cursor-grabbing opacity-60")}
          onPointerDown={event => {
            if (event.button !== 0) return;
            dragRef.current = { view: id, startY: event.clientY, active: false, original: orderRef.current };
            if (enabled) onSelect(id);
          }}
          onClick={event => {
            // Pointer presses switch on pointerdown; detail 0 is Enter or Space.
            if (event.detail === 0 && enabled) onSelect(id);
          }}
        ><Icon /></Button></TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>;
    })}
  </div>;
}
