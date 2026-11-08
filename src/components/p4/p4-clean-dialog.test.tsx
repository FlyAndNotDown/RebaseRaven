// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4CleanDialog } from "@/components/p4/p4-clean-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4CleanPreview, P4CleanRequest } from "@/types/p4";

const calls=vi.hoisted(()=>({previewClean:vi.fn(),applyClean:vi.fn()}));
let busy=false;
let previewRead=calls.previewClean;
vi.mock("@/state/p4-context",()=>({useP4:()=>({...calls,previewClean:previewRead,busy,connection:{root:"/work/project",client:"example"}})}));
const preview:P4CleanPreview={fingerprint:"reviewed",files:[
  {path:"/work/project/modified.txt",depotPath:"//depot/modified.txt",action:"restoreModified",revision:"2"},
  {path:"/work/project/missing.txt",depotPath:"//depot/missing.txt",action:"restoreMissing",revision:"1"},
  {path:"/work/project/local.txt",depotPath:"//depot/local.txt",action:"removeUntracked",revision:null},
]};
const request:P4CleanRequest={scope:"/work/project",restoreModified:true,restoreMissing:true,removeUntracked:true,includeIgnored:false};
const close=vi.fn();let root:Root,container:HTMLDivElement;
async function render(scope="/work/project"){await act(async()=>root.render(<TooltipProvider><P4CleanDialog key={scope} scope={scope} onClose={close}/></TooltipProvider>));}
function button(text:string){const found=[...document.querySelectorAll("button")].find(button=>button.textContent?.trim()===text);expect(found,`Missing button: ${text}`).toBeDefined();return found!;}
async function click(text:string){await act(async()=>button(text).click());}
async function check(name:string){const box=[...document.querySelectorAll('[role="checkbox"]')].find(box=>box.getAttribute("aria-label")===name || box.parentElement?.textContent?.trim()===name) as HTMLButtonElement;expect(box,`Missing checkbox: ${name}`).toBeDefined();await act(async()=>box.click());}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();busy=false;previewRead=calls.previewClean;calls.previewClean.mockResolvedValue(preview);calls.applyClean.mockResolvedValue(undefined);container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});

it("previews all actions while respecting ignores and waits for a second confirmation",async()=>{
  await render();expect(calls.previewClean).toHaveBeenCalledWith(request);expect(document.body.textContent).toContain("#2");expect(calls.applyClean).not.toHaveBeenCalled();
  await click("Review 3 files");expect(document.body.textContent).toContain("Restore: 2 · Delete local: 1");expect(calls.applyClean).not.toHaveBeenCalled();
  await click("Clean 3 files");expect(calls.applyClean).toHaveBeenCalledWith(request,preview.files.map(file=>file.path),"reviewed");expect(close).toHaveBeenCalledOnce();
});

it("applies only selected files and lets the user go back without cleaning",async()=>{
  await render();await check("local.txt");await click("Review 2 files");expect(document.body.textContent).toContain("Delete local: 0");expect(document.body.textContent).not.toContain("local.txt");await click("Back");expect(document.body.textContent).toContain("local.txt");
  await click("Review 2 files");await click("Clean 2 files");expect(calls.applyClean).toHaveBeenCalledWith(request,["/work/project/modified.txt","/work/project/missing.txt"],"reviewed");
});

it("invalidates the reviewed set when ignore policy changes and requires another preview",async()=>{
  await render();await check("Include ignored files");expect(button("Review 0 files").disabled).toBe(true);expect(calls.previewClean).toHaveBeenCalledOnce();await click("Preview");expect(calls.previewClean).toHaveBeenLastCalledWith({...request,includeIgnored:true});await click("Review 3 files");await click("Clean 3 files");expect(calls.applyClean.mock.calls[0][0].includeIgnored).toBe(true);
});

it("disables preview when all cleanup categories are cleared",async()=>{
  await render();for(const label of ["Restore modified files","Restore missing files","Remove untracked files"])await check(label);expect(button("Preview").disabled).toBe(true);expect(button("Review 0 files").disabled).toBe(true);expect(calls.applyClean).not.toHaveBeenCalled();
});

it("requires a new preview after a stale or partially failed apply and retains the native error",async()=>{
  calls.applyClean.mockRejectedValueOnce(new Error("The operation or workspace changed. Preview it again before applying."));await render();await click("Review 3 files");await click("Clean 3 files");expect(document.querySelector('[role="alert"]')).not.toBeNull();expect(button("Review 0 files").disabled).toBe(true);expect(close).not.toHaveBeenCalled();await click("Preview");expect(button("Review 3 files").disabled).toBe(false);
});

it("prevents duplicate cleanup and does not close a newer workspace dialog",async()=>{
  let finish!:()=>void;calls.applyClean.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();await click("Review 3 files");await act(async()=>{button("Clean 3 files").click();button("Clean 3 files").click();});expect(calls.applyClean).toHaveBeenCalledOnce();expect(button("Cancel").disabled).toBe(true);
  await render("/work/other");await act(async()=>finish());expect(close).not.toHaveBeenCalled();
});

it("discards old scan results after changing workspaces",async()=>{
  let finish!:(preview:P4CleanPreview)=>void;calls.previewClean.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({files:[],fingerprint:"other"});await render();await render("/work/other");await act(async()=>finish(preview));expect(document.body.textContent).toContain("No files need cleanup.");expect(button("Review 0 files").disabled).toBe(true);
});

it("allows preview retry after a read failure and blocks mutation while the workspace is busy",async()=>{
  calls.previewClean.mockRejectedValueOnce(new Error("Server unavailable"));await render();expect(document.querySelector('[role="alert"]')?.textContent).toBe("Server unavailable");await click("Preview");busy=true;await render();expect(button("Review 3 files").disabled).toBe(true);
});

it("replaces an in-flight preview without leaving the dialog stuck loading",async()=>{
  let finish!:(preview:P4CleanPreview)=>void;calls.previewClean.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await render();previewRead=vi.fn().mockResolvedValue({files:[],fingerprint:"refreshed"});await render();
  expect(previewRead).toHaveBeenCalledOnce();await act(async()=>finish(preview));expect(document.body.textContent).toContain("No files need cleanup.");expect(button("Preview").disabled).toBe(false);
});
