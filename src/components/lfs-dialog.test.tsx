// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LfsSession } from "@/components/lfs-dialog";
import { Dialog } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { setLanguagePreference } from "@/i18n";
import type { LfsState, LfsUpdate } from "@/types/lfs";
import type { Activity } from "@/types/git";

const model=vi.hoisted(()=>({change:vi.fn(),activities:[] as Activity[]}));
vi.mock("@/state/git-context",()=>({useGitPick:()=>({changeLfs:model.change,activeTabId:"git:current"}),useActivities:()=>model.activities}));
let root:Root,container:HTMLDivElement;
function state():LfsState{return {version:"git-lfs/3.6.0",filtersConfigured:true,remotes:["origin","upstream"],fingerprint:"current-lfs",files:[{name:"assets/model.bin",size:8192,oid:"a".repeat(64),checkout:false,downloaded:true,modified:false}],patterns:[{pattern:"*.bin",source:".gitattributes",tracked:true,lockable:false,editable:true},{pattern:"*.psd",source:"media/.gitattributes",tracked:true,lockable:true,editable:true},{pattern:"*.zip",source:"global attributes",tracked:true,lockable:false,editable:false}]};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.restoreAllMocks();model.change.mockReset();model.activities=[];
  vi.spyOn(gitApi,"lfsState").mockResolvedValue(state());vi.spyOn(gitApi,"cancelActivity").mockResolvedValue(true);model.change.mockResolvedValue({state:state(),report:"Completed"});
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
async function show(path="/work/project"){await act(async()=>root.render(<TooltipProvider><Dialog open><LfsSession key={path} repoPath={path} onClose={()=>{}} /></Dialog></TooltipProvider>));}
function button(text:string){const found=[...document.querySelectorAll("button")].find(button=>button.textContent?.trim()===text || button.getAttribute("aria-label")===text);if(!found)throw new Error(`Missing button: ${text}`);return found;}
async function click(text:string){await act(async()=>button(text).click());}
async function input(id:string,value:string){const element=document.getElementById(id) as HTMLInputElement;expect(element).not.toBeNull();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));});}
async function check(text:string){const box=[...document.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find(button=>button.closest("label")?.textContent?.includes(text));expect(box).toBeDefined();await act(async()=>box!.click());}

it("shows missing Git LFS without exposing mutation actions",async()=>{
  vi.mocked(gitApi.lfsState).mockResolvedValue({...state(),version:null,filtersConfigured:false,files:[],patterns:[]});await show();
  expect(document.body.textContent).toContain("Git LFS was not found");expect(button("Get Git LFS")).toBeDefined();
  expect(document.querySelector('[aria-label="Git LFS sections"]')).toBeNull();expect(model.change).not.toHaveBeenCalled();
});

it("pins local setup and transfers to the exact repository and current fingerprint",async()=>{
  await show();await click("Set up locally");expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"install"},"current-lfs");
  await input("lfs-include","*.bin,*.psd");await input("lfs-exclude","archive/**");await check("Fetch recent refs too");
  const remote=document.getElementById("lfs-remote") as HTMLSelectElement;
  await act(async()=>{remote.value="upstream";remote.dispatchEvent(new Event("change",{bubbles:true}));});
  await click("Fetch objects");expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"fetch",remote:"upstream",include:"*.bin,*.psd",exclude:"archive/**",recent:true},"current-lfs");
  await click("Download and checkout");expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"pull",remote:"upstream",include:"*.bin,*.psd",exclude:"archive/**"},"current-lfs");
  await click("Upload objects");expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"push",remote:"upstream"},"current-lfs");
  await click("Checkout cached");expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"checkout"},"current-lfs");
});

it("adds literal lockable rules and clears the input only after success",async()=>{
  await show();await click("Tracking rules");await input("lfs-pattern","asset [1].bin");await check("Literal filename");await check("Lockable");
  await click("Track");expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"track",pattern:"asset [1].bin",literal:true,lockable:true},"current-lfs");
  expect((document.getElementById("lfs-pattern") as HTMLInputElement).value).toBe("");
});

it("confirms untracking an exact nested rule and keeps inherited rules read only",async()=>{
  await show();await click("Tracking rules");expect(button("Remove *.zip").disabled).toBe(true);
  await click("Remove *.psd");expect(model.change).not.toHaveBeenCalled();await click("Cancel");expect(document.body.textContent).not.toContain("Remove this rule from its attribute file?");
  await click("Remove *.psd");await click("Remove rule");expect(model.change).toHaveBeenCalledExactlyOnceWith("/work/project",{kind:"untrack",pattern:"*.psd",source:"media/.gitattributes"},"current-lfs");
});

it("reloads effective data after failure while preserving pattern and transfer drafts",async()=>{
  await show();await input("lfs-include","*.bin");await click("Tracking rules");await input("lfs-pattern","*.psd");
  model.change.mockResolvedValue(null);vi.mocked(gitApi.lfsState).mockResolvedValue({...state(),fingerprint:"new-lfs"});
  await click("Track");expect((document.getElementById("lfs-pattern") as HTMLInputElement).value).toBe("*.psd");expect(document.body.textContent).toContain("Current data was refreshed");
  model.change.mockResolvedValue({state:state(),report:"Done"});await click("Track");expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"track",pattern:"*.psd",literal:false,lockable:false},"new-lfs");
  await click("Files");expect((document.getElementById("lfs-include") as HTMLInputElement).value).toBe("*.bin");
});

it("prevents double transfers, cancels only this repository activity, and ignores a closed result",async()=>{
  const pending=deferred<LfsUpdate|null>();model.change.mockReturnValue(pending.promise);await show();
  const fetch=button("Fetch objects");await act(async()=>{fetch.click();fetch.click();});expect(model.change).toHaveBeenCalledTimes(1);expect(button("Close").disabled).toBe(true);
  model.activities=[{id:"other-job",tabId:"git:other",label:"Git LFS",cancellable:true},{id:"current-job",tabId:"git:current",label:"Git LFS",cancellable:true}] as Activity[];
  await show();await click("Cancel operation");expect(gitApi.cancelActivity).toHaveBeenCalledExactlyOnceWith("current-job");
  model.activities=[];await show("/work/second");await act(async()=>pending.resolve({state:{...state(),version:"old session"},report:"Old result"}));
  expect(document.body.textContent).not.toContain("Old result");expect(document.body.textContent).not.toContain("old session");
});

it("ignores an older state read after switching repositories",async()=>{
  const old=deferred<LfsState>();vi.mocked(gitApi.lfsState).mockReturnValueOnce(old.promise);await show();await show("/work/second");
  await act(async()=>old.resolve({...state(),version:"outdated"}));expect(document.body.textContent).not.toContain("outdated");
  await click("Checkout cached");expect(model.change).toHaveBeenLastCalledWith("/work/second",{kind:"checkout"},"current-lfs");
});
