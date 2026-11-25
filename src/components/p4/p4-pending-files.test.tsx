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

it("windows a large changelist inside the shared scroller and still selects its last file", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const viewport = document.createElement("div");
  const host = document.createElement("div");
  viewport.append(host);
  document.body.append(viewport);
  Object.defineProperty(viewport, "clientHeight", { value: 240 });
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this === viewport ? 0 : 64 - viewport.scrollTop, 400, 240);
  });
  const root = createRoot(host);
  const many = Array.from({ length: 1000 }, (_, index) => ({ ...files[0], depotPath: `//depot/file-${index}` }));
  const select = vi.fn();
  try {
    await act(async () => root.render(<TooltipProvider><PendingFiles
      viewport={viewport} changeId={changeId} files={many} picked={new Set()}
      selectedPath={null} selectedShelved={false} className="" onSelect={select} onPointerDown={() => {}}
    /></TooltipProvider>));
    expect(host.querySelectorAll("button").length).toBeLessThan(100);
    expect(host.textContent).not.toContain("file-999");
    await act(async () => {
      viewport.scrollTop = 24 * 990 + 64;
      viewport.dispatchEvent(new Event("scroll"));
    });
    const last = [...host.querySelectorAll("button")].find(button => button.textContent === "file-999");
    expect(last).toBeDefined();
    await act(async () => last!.click());
    expect(select).toHaveBeenCalledWith(expect.anything(), "//depot/file-999");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
    bounds.mockRestore();
    vi.unstubAllGlobals();
  }
});

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
