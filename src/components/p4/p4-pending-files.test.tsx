// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PendingFiles, openedSelection, rowKey, type PendingDragFile, type PendingFile } from "./p4-pending-files";

const files: PendingFile[] = ["edit", "add", "delete"].map((action, index) => ({
  action, depotPath: `//depot/file-${index}`, status: "", detail: "", shelved: false,
}));
const changeId = "52";
const drag = (entry: PendingFile): PendingDragFile => ({ path: entry.depotPath, change: changeId, shelved: entry.shelved });

it("creates a file's context menu only when opened and preserves its multi-file selection", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const picked = new Set([rowKey(drag(files[0])), rowKey(drag(files[1]))]);
  const apply = vi.fn();
  const menu = vi.fn((entry: PendingFile, target: PendingDragFile) => {
    const targets = openedSelection([{ id: changeId, files }], picked, target, entry.action);
    return <ContextMenuContent><ContextMenuItem onSelect={() => apply(targets)}>Apply</ContextMenuItem></ContextMenuContent>;
  });
  try {
    await act(async () => root.render(<TooltipProvider><PendingFiles changeId={changeId} files={files} picked={picked}
      selectedPath={null} selectedShelved={false} className="" onSelect={() => {}} onPointerDown={() => {}} menu={menu} /></TooltipProvider>));
    expect(menu).not.toHaveBeenCalled();
    await act(async () => { host.querySelectorAll("button")[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(menu.mock.calls.length).toBeGreaterThan(0);
    expect(menu.mock.calls.every(([entry]) => entry === files[1])).toBe(true);
    const item = document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(item).not.toBeNull();
    await act(async () => item!.click());
    expect(apply).toHaveBeenCalledWith([
      { change: changeId, path: files[0].depotPath, action: "edit" },
      { change: changeId, path: files[1].depotPath, action: "add" },
    ]);
    expect(openedSelection([{ id: changeId, files }], picked, drag(files[2]), "delete"))
      .toEqual([{ change: changeId, path: files[2].depotPath, action: "delete" }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
