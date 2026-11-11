// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4Files } from "./p4-files";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4DirEntry, P4EntryStatus } from "@/types/p4";

const actions=vi.hoisted(()=>({listDir:vi.fn(),status:vi.fn(),search:vi.fn(),cancel:vi.fn(),connection:{root:"/workspace",port:"server:1666",user:"alice",client:"client",stream:""}}));
vi.mock("@/state/p4-context",()=>({useP4:()=>({connection:actions.connection,listDir:actions.listDir,filesEpoch:0,busy:false})}));
vi.mock("@/lib/p4",async importOriginal=>({...await importOriginal<typeof import("@/lib/p4")>(),p4Api:{listingStatus:actions.status,searchFiles:actions.search,cancelDepotSearch:actions.cancel}}));
vi.mock("@/components/p4/p4-file-history",()=>({P4FileHistory:({path}:{path:string})=><div data-file-history={path}/> }));
vi.mock("@/components/ui/resizable",()=>({ResizablePanelGroup:({children}:{children:ReactNode})=><div>{children}</div>,ResizablePanel:({children}:{children:ReactNode})=><div>{children}</div>,ResizableHandle:()=>null}));
let root:Root,container:HTMLDivElement,sequence=0;
function entry(name:string,dir=false,ignored=false):P4DirEntry {return {name:name.split("/").at(-1)!,path:`/workspace/${name}`,dir,ignored,status:"",detail:""};}
function rows(path:string) {return [...container.querySelectorAll<HTMLButtonElement>('button[data-tree-path]')].filter(row=>row.dataset.treePath===path);}
async function render() {await act(async()=>root.render(<TooltipProvider><P4Files/></TooltipProvider>));}
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();actions.connection={...actions.connection,root:"/workspace",client:`client-${++sequence}`};
  actions.listDir.mockResolvedValue([entry("cache",true,true),entry("output.tmp",false,true)]);actions.status.mockResolvedValue([]);actions.cancel.mockResolvedValue(undefined);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.restoreAllMocks();});

it("keeps native ignore matches after asynchronous status icons arrive",async()=>{
  let finish!:(statuses:P4EntryStatus[])=>void;actions.status.mockReturnValue(new Promise<P4EntryStatus[]>(resolve=>{finish=resolve;}));
  await render();expect(rows("/workspace/output.tmp")[0].classList.contains("text-muted-foreground")).toBe(true);
  await act(async()=>finish([{path:"/workspace/output.tmp",status:"current",detail:"Up to date"}]));
  expect(rows("/workspace/output.tmp")[0].classList.contains("text-muted-foreground")).toBe(true);
  expect(rows("/workspace/cache")[0].classList.contains("text-muted-foreground")).toBe(true);
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

it("preserves ignore styling when Windows status paths use different casing and separators",async()=>{
  vi.spyOn(navigator,"platform","get").mockReturnValue("Win32");actions.connection={...actions.connection,root:"C:\\workspace"};
  actions.listDir.mockResolvedValue([{...entry("output.tmp",false,true),path:"C:\\workspace\\output.tmp"}]);
  actions.status.mockResolvedValue([{path:"c:/WORKSPACE/OUTPUT.tmp",status:"current",detail:"Up to date"}]);
  await render();expect(rows("C:\\workspace\\output.tmp")[0].classList.contains("text-muted-foreground")).toBe(true);
});
