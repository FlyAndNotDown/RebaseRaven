// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RepoSettingsDialog } from "@/components/repo-settings-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { setLanguagePreference } from "@/i18n";
import type { GitRepositorySettings, WorkspaceSnapshot } from "@/types/git";

let model:{snapshot:WorkspaceSnapshot;setOpenPanel:ReturnType<typeof vi.fn>};
vi.mock("@/state/git-context",()=>({useGitPick:()=>model}));
const close=vi.fn();let root:Root,container:HTMLDivElement;
async function render() {await act(async()=>root.render(<TooltipProvider><RepoSettingsDialog open onOpenChange={close}/></TooltipProvider>));}
function button(text:string) {const found=[...document.querySelectorAll("button")].find(button=>!button.closest(".hidden") && button.textContent?.trim()===text);expect(found,`Missing visible button: ${text}`).toBeDefined();return found!;}
async function click(text:string) {await act(async()=>button(text).click());}
async function name(value:string) {await act(async()=>{const field=document.getElementById("repo-config-user.name")!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});}
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();model={snapshot:{repo:{path:"/work/first"}} as WorkspaceSnapshot,setOpenPanel:vi.fn()};
  vi.spyOn(gitApi,"getRepositorySettings").mockResolvedValue({worktree:false,readOnly:false,fingerprint:"initial",fields:[
    {key:"user.name",value:null,inherited:"Example",effective:"Example",origin:"file:shared.cfg",editable:true},
    {key:"user.email",value:null,inherited:"example@example.com",effective:"example@example.com",origin:"file:shared.cfg",editable:true},
  ]});
  vi.spyOn(gitApi,"setRepositorySettings").mockResolvedValue({worktree:false,readOnly:false,fingerprint:"saved",fields:[]});
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});

it("saves the repository identity without exposing signing pages",async()=>{
  await render();await name("Draft identity");expect(document.getElementById("repo-config-gpg.format")).toBeNull();await click("Save");expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/first",[{key:"user.name",value:"Draft identity"}],"initial");
});

it("blocks closing while identity settings are saving",async()=>{
  let finish!:(value:GitRepositorySettings)=>void;vi.mocked(gitApi.setRepositorySettings).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await render();await name("Draft");await click("Save");expect(button("Cancel").disabled).toBe(true);
  await act(async()=>{(document.querySelector('[data-slot="dialog-close"]') as HTMLButtonElement).click();});expect(close).not.toHaveBeenCalled();
  await act(async()=>finish({worktree:false,readOnly:false,fingerprint:"saved",fields:[]}));expect(close).toHaveBeenCalledWith(false);
});
