// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4Shelves, RestoreShelfDialog } from "./p4-shelves";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4Changelist } from "@/types/p4";

const calls = vi.hoisted(() => ({listShelves:vi.fn(),shelfDetail:vi.fn(),shelfDiff:vi.fn(),listUsers:vi.fn(),listClients:vi.fn(),previewUnshelve:vi.fn(),restoreShelf:vi.fn(),setView:vi.fn(),closed:vi.fn()}));
vi.mock("@/state/p4-context", () => ({useP4:() => ({...calls,connection:{root:"/workspace",port:"example:1666",user:"alice",client:"main"},selectedChange:"default",busy:false})}));
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

it("restores only reviewed files to the selected pending changelist", async () => {
  await render(true);await toggle("//depot/theme.ts");await field('select[aria-label="Pending changelist"]',"121",true);
  expect(button("Restore 1 files").disabled).toBe(true);
  await click("Preview");expect(calls.previewUnshelve).toHaveBeenLastCalledWith({changeId:"120",target:"121",files:["//depot/app.ts"],stream:""});
  await click("Restore 1 files");expect(calls.restoreShelf).toHaveBeenCalledWith({changeId:"120",target:"121",files:["//depot/app.ts"],stream:""},preview);
  expect(calls.closed).toHaveBeenCalledOnce();expect(calls.setView).toHaveBeenCalledWith("pending");
});

it("invalidates a preview when the destination changes and requires all files for stream mapping", async () => {
  await render(true);await toggle("//depot/theme.ts");await click("Preview");expect(button("Restore 1 files").disabled).toBe(false);
  await field('#shelf-stream-mapping',"//depot/dev");expect(button("Restore 2 files").disabled).toBe(true);
  expect([...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].every(node => node.disabled)).toBe(true);
  await click("Preview");expect(calls.previewUnshelve).toHaveBeenLastCalledWith({changeId:"120",target:"default",files:shelf.files.map(file => file.depotPath),stream:"//depot/dev"});
  await field('select[aria-label="Pending changelist"]',"121",true);expect(button("Restore 2 files").disabled).toBe(true);
});

it("keeps the dialog open and requires another preview after restore fails", async () => {
  calls.restoreShelf.mockRejectedValueOnce(new Error("The workspace changed. Preview again."));
  await render(true);await click("Preview");await click("Restore 2 files");expect(document.querySelector('[role="alert"]')?.textContent).toContain("workspace changed");expect(button("Restore 2 files").disabled).toBe(true);expect(calls.closed).not.toHaveBeenCalled();expect(calls.setView).not.toHaveBeenCalled();
});
