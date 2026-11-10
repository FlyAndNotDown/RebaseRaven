// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppSidebar } from "./app-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultPrefs, normalizePrefs } from "@/lib/prefs";
import { setLanguagePreference } from "@/i18n";
import type { AppPrefs } from "@/types/git";

const calls = vi.hoisted(() => ({setView:vi.fn(),setP4View:vi.fn(),updatePrefs:vi.fn(),setOpenPanel:vi.fn()}));
let prefs:AppPrefs;
let vcs:"git"|"perforce";
vi.mock("@/state/git-context", () => ({useGitPick:() => ({...calls,prefs,view:"changes",activeTab:{kind:"repo",vcs},openPanel:null})}));
vi.mock("@/state/p4-context", () => ({useP4:() => ({view:"pending",setView:calls.setP4View})}));
vi.mock("@/components/lazy-dialogs", () => ({SettingsDialog:() => null}));
let root:Root, container:HTMLDivElement;
function rows() { return [...container.querySelectorAll<HTMLButtonElement>('[data-sidebar-view]')]; }
function order() { return rows().map(node => node.dataset.sidebarView); }
function row(id:string) { return rows().find(node => node.dataset.sidebarView === id)!; }
async function render() { await act(async () => root.render(<TooltipProvider><AppSidebar /></TooltipProvider>)); }
function pointer(target:EventTarget,type:string,y:number,button=0) { target.dispatchEvent(new MouseEvent(type,{bubbles:true,button,clientY:y})); }
async function press(id:string) { await act(async () => pointer(row(id),"pointerdown",20)); }
async function move(y:number) { await act(async () => pointer(window,"pointermove",y)); }
async function release(type="pointerup") { await act(async () => pointer(window,type,1000)); }
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();vcs="perforce";prefs=normalizePrefs(defaultPrefs);
  calls.updatePrefs.mockImplementation(async (next:AppPrefs) => {prefs=normalizePrefs(JSON.parse(JSON.stringify(next)));});
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement) {
    const index=rows().indexOf(this as HTMLButtonElement);return {top:index*44,bottom:index*44+40,height:40,left:0,right:40,width:40,x:0,y:index*44,toJSON(){return {};}};
  });
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();vi.restoreAllMocks();});

it("saves a dragged Perforce view and restores its order after reopening", async () => {
  await render();await press("pending");await move(1000);await release();
  const expected=["submitted","shelves","workspace","specs","streams","pending"];
  expect(order()).toEqual(expected);expect(calls.updatePrefs).toHaveBeenCalledOnce();expect(prefs.p4SidebarOrder).toEqual(expected);expect(prefs.sidebarOrder).toEqual(defaultPrefs.sidebarOrder);
  await act(async () => root.unmount());root=createRoot(container);await render();expect(order()).toEqual(expected);
});

it("retains Git dragging and keeps its saved order separate from Perforce", async () => {
  vcs="git";await render();await press("changes");await move(1000);await release();
  expect(prefs.sidebarOrder).toEqual(["history","stash","files","changes"]);expect(prefs.p4SidebarOrder).toEqual(defaultPrefs.p4SidebarOrder);
  vcs="perforce";await render();expect(order()).toEqual(defaultPrefs.p4SidebarOrder);expect(calls.setP4View).not.toHaveBeenCalled();
});

it("saves the final drop even when movement and release occur before the next render", async () => {
  await render();await press("streams");await act(async () => {pointer(window,"pointermove",-10);pointer(window,"pointerup",-10);});
  expect(prefs.p4SidebarOrder).toEqual(["streams","pending","submitted","shelves","workspace","specs"]);
});

it("restores the original order without saving when a drag is cancelled", async () => {
  await render();await press("pending");await move(1000);expect(order().at(-1)).toBe("pending");await release("pointercancel");
  expect(order()).toEqual(defaultPrefs.p4SidebarOrder);expect(calls.updatePrefs).not.toHaveBeenCalled();
});

it("does not save an unfinished drag into another repository type", async () => {
  await render();await press("pending");await move(1000);vcs="git";await render();await release();
  expect(order()).toEqual(defaultPrefs.sidebarOrder);expect(calls.updatePrefs).not.toHaveBeenCalled();
});

it("keeps pointer and keyboard navigation and ignores small movements", async () => {
  await render();await press("workspace");await move(24);await release();expect(calls.setP4View).toHaveBeenCalledWith("workspace");expect(calls.updatePrefs).not.toHaveBeenCalled();
  await act(async () => row("streams").dispatchEvent(new MouseEvent("click",{bubbles:true,detail:0})));expect(calls.setP4View).toHaveBeenLastCalledWith("streams");
  calls.setP4View.mockClear();await act(async () => pointer(row("pending"),"pointerdown",20,2));expect(calls.setP4View).not.toHaveBeenCalled();
});
