// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4Files } from "./p4-files";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4DirEntry, P4EntryStatus, P4FileSearch } from "@/types/p4";
import { analyticsP4FilesMode } from "@/state/analytics-screen";

const actions=vi.hoisted(()=>({listDir:vi.fn(),listDepot:vi.fn(),status:vi.fn(),search:vi.fn(),closeSearch:vi.fn(),cancel:vi.fn(),reconcile:vi.fn(),openClean:vi.fn(),epoch:0,connection:{root:"/workspace",port:"server:1666",user:"alice",client:"client",stream:""}}));
vi.mock("@/state/p4-context",()=>({useP4:()=>({connection:actions.connection,listDir:actions.listDir,listDepot:actions.listDepot,reconcile:actions.reconcile,openClean:actions.openClean,filesEpoch:actions.epoch,busy:false})}));
vi.mock("@/lib/p4",async importOriginal=>({...await importOriginal<typeof import("@/lib/p4")>(),p4Api:{listingStatus:actions.status,openWorkspaceSearch:async()=>({page:actions.search,close:actions.closeSearch}),cancelDepotSearch:actions.cancel}}));
vi.mock("@/components/p4/p4-file-history",()=>({P4FileHistory:({path}:{path:string})=><div data-file-history={path}/> }));
vi.mock("@/components/p4/p4-file-view",()=>({P4FileView:({path}:{path:string})=><div data-file-view={path}/> }));
vi.mock("@/components/p4/p4-directory-history",()=>({P4DirectoryHistory:({path}:{path:string})=><div data-directory-history={path}/> }));
vi.mock("@/components/ui/resizable",()=>({ResizablePanelGroup:({children}:{children:ReactNode})=><div>{children}</div>,ResizablePanel:({children}:{children:ReactNode})=><div>{children}</div>,ResizableHandle:()=>null}));
let root:Root,container:HTMLDivElement,sequence=0;
function entry(name:string,dir=false,ignored=false):P4DirEntry {return {name:name.split("/").at(-1)!,path:`/workspace/${name}`,dir,ignored,status:"",detail:""};}
function rows(path:string) {return [...container.querySelectorAll<HTMLButtonElement>('button[data-tree-path]')].filter(row=>row.dataset.treePath===path);}
async function render() {await act(async()=>root.render(<TooltipProvider><P4Files/></TooltipProvider>));}
beforeEach(()=>{
  vi.stubGlobal("ResizeObserver",class {observe(){} unobserve(){} disconnect(){}});
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();actions.epoch=0;actions.connection={...actions.connection,root:"/workspace",client:`client-${++sequence}`};
  actions.listDir.mockImplementation(async (relative:string)=>relative ? [entry(`${relative}/child.txt`)] : [entry("cache",true,true),entry("output.tmp",false,true)]);actions.status.mockResolvedValue([]);actions.cancel.mockResolvedValue(undefined);
  actions.listDepot.mockResolvedValue([]);
  actions.closeSearch.mockResolvedValue(undefined);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.restoreAllMocks();});

it("reports the selected file-tree mode and clears it when leaving the files view",async()=>{
  await render();expect(analyticsP4FilesMode()).toBe("workspace");
  const depot=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.trim()==="Depot")!;
  await act(async()=>depot.click());expect(depot.getAttribute("aria-pressed")).toBe("true");
  expect(analyticsP4FilesMode()).toBe("depot");
  await act(async()=>root.render(null));expect(analyticsP4FilesMode()).toBe("workspace");
  await render();expect(analyticsP4FilesMode()).toBe("workspace");
});

it("scopes directory reconciliation and cleanup to the right-clicked folder", async () => {
  await render();
  async function openMenu() {
    await act(async () => rows("/workspace/cache")[0].dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,button:2})));
  }
  function item(label: string) {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === label);
    expect(found, `Missing menu item: ${label}`).toBeDefined();
    return found!;
  }
  await openMenu();
  await act(async () => item("Reconcile").click());
  expect(actions.reconcile).toHaveBeenCalledExactlyOnceWith("/workspace/cache");
  await openMenu();
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Clean workspace");
  await act(async () => item("Clean").click());
  expect(actions.openClean).toHaveBeenCalledExactlyOnceWith("/workspace/cache");
  await act(async () => rows("/workspace/output.tmp")[0].dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,button:2})));
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim());
  expect(labels).not.toContain("Reconcile");
  expect(labels).not.toContain("Clean");
});

it("lets versioned status override ignore rules while keeping local files muted",async()=>{
  actions.listDir.mockResolvedValue([entry("cache",true,true),entry("output.tmp",false,true),entry("local.tmp",false,true)]);
  let finish!:(statuses:P4EntryStatus[])=>void;actions.status.mockReturnValue(new Promise<P4EntryStatus[]>(resolve=>{finish=resolve;}));
  await render();expect(rows("/workspace/output.tmp")[0].classList.contains("text-muted-foreground")).toBe(true);
  await act(async()=>finish([{path:"/workspace/output.tmp",status:"current",detail:"Up to date"}]));
  expect(rows("/workspace/output.tmp")[0].classList.contains("text-muted-foreground")).toBe(false);
  expect(rows("/workspace/local.tmp")[0].classList.contains("text-muted-foreground")).toBe(true);
  expect(rows("/workspace/cache")[0].classList.contains("text-muted-foreground")).toBe(true);
});

it("keeps known versioned styling during refresh and reapplies rules after a file becomes local",async()=>{
  actions.listDir.mockResolvedValue([entry("tracked.tmp",false,true),entry("added.tmp",false,true)]);
  actions.status.mockResolvedValue([{path:"/workspace/tracked.tmp",status:"current",detail:"Up to date"},{path:"/workspace/added.tmp",status:"add",detail:"Marked for add"}]);
  await render();
  let finish!:(statuses:P4EntryStatus[])=>void;
  actions.status.mockReturnValue(new Promise<P4EntryStatus[]>(resolve=>{finish=resolve;}));
  actions.epoch+=1;await render();
  expect(rows("/workspace/tracked.tmp")[0].classList.contains("text-muted-foreground")).toBe(false);
  expect(rows("/workspace/added.tmp")[0].classList.contains("text-muted-foreground")).toBe(false);
  await act(async()=>finish([{path:"/workspace/tracked.tmp",status:"current",detail:"Up to date"}]));
  expect(rows("/workspace/tracked.tmp")[0].classList.contains("text-muted-foreground")).toBe(false);
  expect(rows("/workspace/added.tmp")[0].classList.contains("text-muted-foreground")).toBe(true);
});

it.each([false,true])("keeps containers of versioned files visible (Windows: %s)",async(windows)=>{
  if(windows){vi.spyOn(navigator,"userAgent","get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");actions.connection={...actions.connection,root:"C:\\workspace"};}
  const path=(relative:string)=>windows ? `C:\\workspace\\${relative.replace(/\//g,"\\")}` : `/workspace/${relative}`;
  const item=(relative:string,dir=false)=>({...entry(relative,dir,true),path:path(relative)});
  actions.listDir.mockImplementation(async(relative:string)=>relative ? [item("cache/tracked.tmp"),item("cache/local.tmp")] : [item("cache",true)]);
  actions.status.mockImplementation(async(_connection:unknown,directory:string)=>directory ? [{path:path("cache/tracked.tmp"),status:"current",detail:"Up to date"}] : []);
  await render();expect(rows(path("cache"))[0].classList.contains("text-muted-foreground")).toBe(true);
  await act(async()=>container.querySelector<HTMLButtonElement>('button[aria-label="Expand cache"]')!.click());
  expect(rows(path("cache"))[0].classList.contains("text-muted-foreground")).toBe(false);
  expect(rows(path("cache/tracked.tmp"))[0].classList.contains("text-muted-foreground")).toBe(false);
  expect(rows(path("cache/local.tmp"))[0].classList.contains("text-muted-foreground")).toBe(true);
});

it("keeps ignored directories, files, and exclusions distinct in filtered results",async()=>{
  vi.useFakeTimers();actions.search.mockResolvedValue({hits:[entry("cache",true,true),entry("cache/output.tmp",false,true),entry("cache/keep.txt")],truncated:false,scope:""});
  await render();const input=container.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"cache");input.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>vi.advanceTimersByTimeAsync(250));
  expect(rows("/workspace/cache").at(-1)!.classList.contains("text-muted-foreground")).toBe(true);
  expect(rows("/workspace/cache/output.tmp").at(-1)!.classList.contains("text-muted-foreground")).toBe(true);
  expect(rows("/workspace/cache/keep.txt").at(-1)!.classList.contains("text-muted-foreground")).toBe(false);
});

it("shows names before status arrives and discards results after a query change", async () => {
  vi.useFakeTimers();
  const page = (name: string): P4FileSearch => ({ hits: [entry(name)], truncated: false, scope: "" });
  let finish!: (page: P4FileSearch) => void;
  actions.search.mockImplementationOnce((names: (page: P4FileSearch) => void) => {
    names(page("first-hit"));
    return new Promise<P4FileSearch>(resolve => { finish = resolve; });
  }).mockResolvedValueOnce(page("second-hit"));
  await render();
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')!;
  async function query(term: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, term);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
  }
  await query("first");
  expect(rows("/workspace/first-hit")).toHaveLength(1);
  await query("second");
  expect(actions.closeSearch).toHaveBeenCalledTimes(2);
  await act(async () => finish(page("stale-hit")));
  expect(rows("/workspace/second-hit")).toHaveLength(1);
  expect(rows("/workspace/stale-hit")).toHaveLength(0);
});

it("recognizes versioned Windows paths despite different casing and separators",async()=>{
  vi.spyOn(navigator,"userAgent","get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");actions.connection={...actions.connection,root:"C:\\workspace"};
  actions.listDir.mockResolvedValue([{...entry("output.tmp",false,true),path:"C:\\workspace\\output.tmp"}]);
  actions.status.mockResolvedValue([{path:"c:/WORKSPACE/OUTPUT.tmp",status:"current",detail:"Up to date"}]);
  await render();expect(rows("C:\\workspace\\output.tmp")[0].classList.contains("text-muted-foreground")).toBe(false);
});

it("selects folder history on a single click and expands only with an arrow or double click",async()=>{
  await render();await act(async()=>rows("/workspace/output.tmp")[0].click());
  const arrow=()=>container.querySelector<HTMLButtonElement>('button[aria-label="Expand cache"],button[aria-label="Collapse cache"]')!;
  await act(async()=>arrow().click());
  expect(container.querySelector('[data-file-view="/workspace/output.tmp"]')).not.toBeNull();
  expect(rows("/workspace/cache")[0].getAttribute("aria-expanded")).toBe("true");
  await act(async()=>rows("/workspace/cache")[0].click());
  expect(container.querySelector('[data-directory-history="/workspace/cache"]')).not.toBeNull();
  expect(rows("/workspace/cache")[0].getAttribute("aria-expanded")).toBe("true");
  await act(async()=>{
    const folder=rows("/workspace/cache")[0];
    folder.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}));
    folder.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:2}));
    folder.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,detail:2}));
  });
  expect(rows("/workspace/cache")[0].getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('[data-directory-history="/workspace/cache"]')).not.toBeNull();
  expect(actions.listDir.mock.calls.filter(([path])=>path==="cache")).toHaveLength(1);
});

it("shows the workspace root above its children and opens its full history without reloading on collapse", async () => {
  await render();
  const folder = rows("/workspace")[0];
  expect(folder.textContent).toBe("workspace");
  expect(folder.style.paddingLeft).toBe("8px");
  expect(rows("/workspace/cache")[0].style.paddingLeft).toBe("20px");
  await act(async () => folder.click());
  expect(container.querySelector('[data-directory-history="/workspace"]')).not.toBeNull();
  expect(container.querySelector('[role="group"][aria-label="File view"]')).toBeNull();
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  const calls = actions.listDir.mock.calls.length;
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Collapse workspace"]')!.click());
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  expect(rows("/workspace/cache")[0].closest('[hidden]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Expand workspace"]')!.click());
  expect(actions.listDir).toHaveBeenCalledTimes(calls);
  expect(container.querySelector('[data-directory-history="/workspace"]')).not.toBeNull();
});

it("shows a selectable depot root above every depot and limits its menu to history", async () => {
  actions.listDepot.mockResolvedValue([{ name: "depot", path: "//depot", dir: true, ignored: false, status: "", detail: "" }]);
  await render();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Depot")!.click());
  const folder = rows("//")[0];
  expect(folder.textContent).toBe("//");
  expect(rows("//depot")[0].style.paddingLeft).toBe("20px");
  await act(async () => folder.click());
  expect(container.querySelector('[data-directory-history="//"]')).not.toBeNull();
  expect(container.querySelector('[role="group"][aria-label="File view"]')).toBeNull();
  await act(async () => folder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 })));
  expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["History"]);
});

it("keeps filtered matches below the workspace root", async () => {
  vi.useFakeTimers();
  actions.search.mockResolvedValue({ hits: [entry("cache", true), entry("cache/output.tmp")], truncated: false, scope: "" });
  await render();
  const input = container.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "cache");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(250));
  const folder = rows("/workspace").at(-1)!;
  expect(folder.closest('[hidden]')).toBeNull();
  expect(rows("/workspace/cache").at(-1)!.style.paddingLeft).toBe("20px");
  await act(async () => folder.click());
  expect(container.querySelector('[data-directory-history="/workspace"]')).not.toBeNull();
});

it("shows the view switch only for files and preserves their selected mode across directory selections", async () => {
  await render();
  expect(container.querySelector('[role="group"][aria-label="File view"]')).toBeNull();
  await act(async () => rows("/workspace/output.tmp")[0].click());
  const views = container.querySelector('[role="group"][aria-label="File view"]')!;
  const file = [...views.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "File")!;
  const history = [...views.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "History")!;
  expect(file.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[data-file-view="/workspace/output.tmp"]')).not.toBeNull();
  expect(container.querySelector('[data-file-history]')).toBeNull();
  await act(async () => history.click());
  expect(container.querySelector('[data-file-history="/workspace/output.tmp"]')).not.toBeNull();
  expect(container.querySelector('[data-file-view]')).toBeNull();
  await act(async () => file.click());
  await act(async () => rows("/workspace/cache")[0].click());
  expect(container.querySelector('[role="group"][aria-label="File view"]')).toBeNull();
  expect(container.querySelector('[data-directory-history="/workspace/cache"]')).not.toBeNull();
  await act(async () => rows("/workspace/output.tmp")[0].click());
  const restored = container.querySelector('[role="group"][aria-label="File view"]')!;
  const restoredFile = [...restored.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "File")!;
  const restoredHistory = [...restored.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "History")!;
  expect(restoredFile.disabled).toBe(false);
  expect(restoredFile.getAttribute("aria-pressed")).toBe("true");
  await act(async () => restoredHistory.click());
  await act(async () => rows("/workspace/cache")[0].click());
  expect(container.querySelector('[role="group"][aria-label="File view"]')).toBeNull();
  await act(async () => rows("/workspace/output.tmp")[0].click());
  const finalHistory = [...container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="File view"] button')].find(button => button.textContent === "History")!;
  expect(finalHistory.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[data-file-history="/workspace/output.tmp"]')).not.toBeNull();
});
