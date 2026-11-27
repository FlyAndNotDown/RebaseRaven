// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4Shelves } from "./p4-shelves";
import { P4Pending } from "./p4-pending";
import { PendingRestoreShelfDialog, RestoreShelfDialog } from "./p4-restore-shelf-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4Changelist } from "@/types/p4";

const calls = vi.hoisted(() => ({listShelves:vi.fn(),shelfDetail:vi.fn(),shelfDiff:vi.fn(),listUsers:vi.fn(),listClients:vi.fn(),previewUnshelve:vi.fn(),restoreShelf:vi.fn(),placeFiles:vi.fn(),selectFile:vi.fn(),setView:vi.fn(),closed:vi.fn()}));
vi.mock("@/state/p4-context", () => {
  const model = () => ({...calls,connection:{root:"/workspace",port:"example:1666",user:"alice",client:"main",stream:"//project/dev"},selectedChange:"default",busy:false,
    pending:[{...shelf,id:"default",shelved:false,files:[]},{...shelf,files:[]}],pendingShelves:{[shelf.id]:{status:"ready",detail:shelf}}});
  return {useP4:model, useP4Pick:model};
});
vi.mock("@/state/git-context", () => ({useGitPick:() => ({p4PendingExpanded:{"/workspace":["change:120","shelf:120"]}})}));
vi.mock("@/components/p4/p4-diff", () => ({P4Diff:() => <div>Diff</div>}));
vi.mock("@/components/p4/p4-stream-work", () => ({P4StreamDiffDialog:() => null}));
vi.mock("@/components/revision-meta", () => ({AuthorName:({name}:{name:string}) => <span>{name}</span>}));
vi.mock("@/components/ui/resizable", () => ({ResizablePanelGroup:({children}:{children:ReactNode}) => <div>{children}</div>,ResizablePanel:({children}:{children:ReactNode}) => <div>{children}</div>,ResizableHandle:() => null}));
vi.mock("@/components/p4/p4-filter-menu", () => ({withCurrent:(options:string[],current:string) => [...new Set([...options,current])],P4FilterMenu:({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}) => <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}><option value="">All</option><option value="alice">alice</option><option value="main">main</option></select>}));
vi.mock("@/components/p4/p4-change-select", () => ({P4ChangeSelect:({value,onChange,disabled}:{value:string;onChange:(value:string)=>void;disabled:boolean}) => <select aria-label="Pending changelist" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="default">default</option><option value="121">121</option></select>}));

const shelf: P4Changelist = {status:"pending",shelved:true,id:"120",description:"Improve settings\n\nKeep configuration together.",user:"alice",client:"main",time:0,files:["//depot/app.ts","//depot/theme.ts"].map(depotPath => ({depotPath,localPath:"",action:"edit",rev:"1",shelved:true,binary:false,status:"edit",detail:""}))};
const preview = {fingerprint:"reviewed",output:"2 files to unshelve",target:"/workspace"};
let root:Root, container:HTMLDivElement;
async function render(modal=false) { await act(async () => root.render(<TooltipProvider>{modal ? <RestoreShelfDialog detail={shelf} onClose={calls.closed} /> : <P4Shelves />}</TooltipProvider>)); }
function button(label:string) {const result=[...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);expect(result,`Missing button: ${label}`).toBeDefined();return result!;}
async function click(label:string) {await act(async () => button(label).click());}
async function field(selector:string,value:string,select=false) {
  const node=document.querySelector(selector)!;
  await act(async () => {Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype,"value")!.set!.call(node,value);node.dispatchEvent(new Event(select ? "change" : "input",{bubbles:true}));});
}
async function toggle(path:string) {await act(async () => (document.querySelector(`[role="checkbox"][aria-label="${path}"]`) as HTMLButtonElement).click());}
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  calls.listShelves.mockResolvedValue({changes:[shelf],hasMore:false,scannedThrough:null});calls.shelfDetail.mockResolvedValue(shelf);calls.shelfDiff.mockResolvedValue(null);calls.listUsers.mockResolvedValue(["alice"]);calls.listClients.mockResolvedValue(["main"]);calls.previewUnshelve.mockResolvedValue(preview);calls.restoreShelf.mockResolvedValue(undefined);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();});

it("places a shelf selection at its drop target once and ignores cancelled drags", async () => {
  await act(async () => root.render(<TooltipProvider><P4Pending /></TooltipProvider>));
  const file = button("app.ts");
  const target = container.querySelector<HTMLElement>('[data-drop="open"][data-change="default"]')!;
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
  async function drag(end: "pointerup" | "pointercancel") {
    await act(async () => {
      file.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 20, buttons: 1 }));
      window.dispatchEvent(new PointerEvent(end, { pointerId: 1, clientX: 20 }));
    });
  }
  try {
    await act(async () => { file.click(); button("theme.ts").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); });
    await drag("pointercancel");
    expect(calls.placeFiles).not.toHaveBeenCalled();
    await drag("pointerup");
    expect(calls.placeFiles).toHaveBeenCalledExactlyOnceWith(shelf.files.map(entry => ({
      path: entry.depotPath, change: shelf.id, shelved: true,
    })), "default", false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.previewUnshelve).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
});

it("browses shelves without selecting restore files and moves restoration into a modal", async () => {
  await render();expect(calls.listShelves).toHaveBeenCalledWith("","",null);
  await act(async () => (document.querySelector('button[aria-pressed]') as HTMLButtonElement).click());
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
  expect(document.querySelector('[aria-label="Pending changelist"]')).toBeNull();
  await click("Restore…");expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(3);
  expect(calls.previewUnshelve).not.toHaveBeenCalled();expect(calls.restoreShelf).not.toHaveBeenCalled();
});

it("passes user and workspace filters together and resets the workspace when the user changes", async () => {
  await render();await field('select[aria-label="User"]',"alice",true);await field('select[aria-label="Workspace"]',"main",true);
  expect(calls.listShelves).toHaveBeenLastCalledWith("alice","main",null);
  await field('select[aria-label="User"]',"",true);expect(calls.listShelves).toHaveBeenLastCalledWith("","",null);
});

it("ignores an earlier shelf response after the filters change", async () => {
  let finish!: (page: {changes:P4Changelist[];hasMore:boolean;scannedThrough:null}) => void;
  calls.listShelves.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
  calls.listShelves.mockResolvedValueOnce({changes:[{...shelf,id:"200",description:"Filtered shelf"}],hasMore:false,scannedThrough:null});
  await render();await field('select[aria-label="User"]',"alice",true);
  expect(document.body.textContent).toContain("Filtered shelf");
  await act(async () => finish({changes:[shelf],hasMore:false,scannedThrough:null}));
  expect(document.body.textContent).toContain("Filtered shelf");expect(document.body.textContent).not.toContain("Improve settings");
});

it("restores the selected files to their destination without requiring a preview", async () => {
  await render(true);
  await toggle("//depot/theme.ts");
  await field('select[aria-label="Pending changelist"]', "121", true);
  await click("Restore 1 file");
  expect(calls.restoreShelf).toHaveBeenCalledExactlyOnceWith({
    changeId: "120", target: "121", files: ["//depot/app.ts"], stream: "",
  }, undefined);
  expect(calls.previewUnshelve).not.toHaveBeenCalled();
  expect(calls.closed).toHaveBeenCalledOnce();
});

it("shows the shared shelf directory once and disambiguates matching filenames", async () => {
  const directory = "//depot/render/";
  const files = ["surface-pass", "surface-cache"].map(folder => ({
    ...shelf.files[0], depotPath: directory + folder + "/shader.txt",
  }));
  await act(async () => root.render(<TooltipProvider><RestoreShelfDialog detail={{ ...shelf, files }} onClose={calls.closed} /></TooltipProvider>));
  expect(document.querySelectorAll(`[title="${directory}"]`)).toHaveLength(1);
  for (const file of files) {
    const checkbox = document.querySelector(`[role="checkbox"][aria-label="${file.depotPath}"]`)!;
    const row = checkbox.closest("label")!;
    expect(row.textContent).toBe("shader.txt" + file.depotPath.split("/").at(-2));
    expect(row.querySelector(`[title="${file.depotPath}"]`)).not.toBeNull();
  }
});

it("disables restore for an empty selection and while a restore is running", async () => {
  let finish!: () => void;
  calls.restoreShelf.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  await render(true);
  await toggle("//depot/theme.ts");
  await toggle("//depot/app.ts");
  expect(button("Preview").disabled).toBe(true);
  expect(button("Restore 0 files").disabled).toBe(true);
  await toggle("//depot/theme.ts");
  await click("Restore 1 file");
  expect(button("Restore 1 file").disabled).toBe(true);
  await click("Restore 1 file");
  expect(calls.restoreShelf).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(calls.closed).toHaveBeenCalledOnce();
});

it("invalidates the preview when the selection, mapping or destination changes", async () => {
  await render(true);
  await click("Preview");
  expect(document.querySelector("pre")?.textContent).toBe(preview.output);
  await toggle("//depot/theme.ts");
  expect(document.querySelector("pre")).toBeNull();
  await click("Preview");
  await field("#shelf-stream-mapping", "//depot/dev");
  expect(document.querySelector("pre")).toBeNull();
  expect([...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].every(node => node.disabled)).toBe(true);
  await click("Preview");
  await field('select[aria-label="Pending changelist"]', "121", true);
  expect(document.querySelector("pre")).toBeNull();
  await click("Restore 2 files");
  expect(calls.restoreShelf).toHaveBeenCalledWith({
    changeId: "120", target: "121", files: shelf.files.map(file => file.depotPath), stream: "//depot/dev",
  }, undefined);
});

it("checks an optional preview at restore time and keeps a rejected restore open", async () => {
  const stale = new Error("The workspace changed. Preview again.");
  calls.restoreShelf.mockRejectedValueOnce(stale).mockRejectedValueOnce(stale);
  await render(true);
  await click("Preview");
  await click("Restore 2 files");
  expect(calls.restoreShelf).toHaveBeenCalledExactlyOnceWith({
    changeId: "120", target: "default", files: shelf.files.map(file => file.depotPath), stream: "",
  }, preview);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("workspace changed");
  expect(calls.closed).not.toHaveBeenCalled();
  expect(document.querySelector("pre")).toBeNull();
  await click("Restore 2 files");
  expect(calls.restoreShelf.mock.lastCall?.[1]).toBe(preview);
  const updated = { ...preview, fingerprint: "updated" };
  calls.previewUnshelve.mockResolvedValueOnce(updated);
  await click("Preview");
  await click("Restore 2 files");
  expect(calls.restoreShelf.mock.lastCall?.[1]).toBe(updated);
  expect(calls.closed).toHaveBeenCalledOnce();
});

it("opens the pending shelf from its menu and restores only the selected files in the current stream", async () => {
  const source = {...shelf, files: shelf.files.map(file => ({...file, depotPath: file.depotPath.replace("//depot/", "//project/main/")}))};
  calls.shelfDetail.mockResolvedValue(source);
  await act(async () => root.render(<TooltipProvider><PendingRestoreShelfDialog id="120" initialTarget="default"
    initialFiles={["//project/main/app.ts"]} onClose={calls.closed} /></TooltipProvider>));
  expect(calls.shelfDetail).toHaveBeenCalledExactlyOnceWith("120");
  expect(document.body.textContent).toContain("//project/dev");
  await click("Restore 1 file");
  expect(calls.restoreShelf).toHaveBeenCalledWith({changeId:"120",target:"default",files:["//project/main/app.ts"],stream:""}, undefined);
});
