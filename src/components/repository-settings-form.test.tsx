// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RepositorySettingsForm } from "@/components/repository-settings-form";
import { TooltipProvider } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { setLanguagePreference } from "@/i18n";
import type { GitRepositorySettings } from "@/types/git";
import { open } from "@tauri-apps/plugin-dialog";
vi.mock("@tauri-apps/plugin-dialog",()=>({open:vi.fn()}));

const initial:GitRepositorySettings={worktree:false,readOnly:false,fingerprint:"reviewed",fields:[
  {key:"gpg.format",value:"ssh",inherited:"openpgp",effective:"ssh",origin:"file:.git/config",editable:true},
  {key:"user.signingkey",value:"local-key",inherited:"inherited-key",effective:"local-key",origin:"file:.git/config",editable:true},
  {key:"commit.gpgsign",value:null,inherited:"true",effective:"true",origin:"file:shared.cfg",editable:true},
  {key:"tag.gpgsign",value:"false",inherited:"true",effective:"false",origin:"file:.git/config",editable:true},
  {key:"gpg.ssh.allowedsignersfile",value:null,inherited:"trusted-signers",effective:"trusted-signers",origin:"file:shared.cfg",editable:true},
  {key:"gpg.ssh.revocationfile",value:null,inherited:null,effective:null,origin:null,editable:true},
]};
const close=vi.fn(),busy=vi.fn();let root:Root,container:HTMLDivElement;
async function render(path="/work/first") {await act(async()=>root.render(<TooltipProvider><RepositorySettingsForm key={path} repoPath={path} onClose={close} onBusyChange={busy}/></TooltipProvider>));await click("Signing");}
function button(text:string) {const found=[...document.querySelectorAll("button")].find(button=>button.textContent?.trim()===text);expect(found,`Missing button: ${text}`).toBeDefined();return found!;}
async function click(text:string) {await act(async()=>button(text).click());}
function select(key:string) {return document.getElementById("repo-config-"+key) as HTMLSelectElement;}
async function choose(key:string,value:string) {await act(async()=>{select(key).value=value;select(key).dispatchEvent(new Event("change",{bubbles:true}));});}
async function input(key:string,value:string) {await act(async()=>{const field=document.getElementById("repo-config-"+key)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});}
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  vi.spyOn(gitApi,"getRepositorySettings").mockResolvedValue(structuredClone(initial));vi.spyOn(gitApi,"setRepositorySettings").mockResolvedValue(structuredClone(initial));
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});

it("keeps inheritance distinct from an explicit disabled override and only saves changed fields",async()=>{
  await render();expect(select("commit.gpgsign").value).toBe("inherit");expect(select("tag.gpgsign").value).toBe("false");expect(button("Save").disabled).toBe(true);
  await choose("commit.gpgsign","false");await click("Save");expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/first",[{key:"commit.gpgsign",value:"false"}],"reviewed");expect(close).toHaveBeenCalledOnce();expect(busy.mock.calls).toEqual([[true],[false]]);
});

it("resets only the selected local field and keeps inherited key data as a placeholder",async()=>{
  await render();const reset=document.querySelector('button[aria-label="Reset Signing key to inherit"]') as HTMLButtonElement;await act(async()=>reset.click());
  const field=document.getElementById("repo-config-user.signingkey") as HTMLInputElement;expect(field.value).toBe("");expect(field.placeholder).toBe("inherited-key");await click("Save");expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/first",[{key:"user.signingkey",value:null}],"reviewed");
});

it("does not clear hidden SSH configuration when changing the signature format",async()=>{
  await render();await input("gpg.ssh.revocationfile","revoked-keys");await choose("gpg.format","openpgp");expect(document.getElementById("repo-config-gpg.ssh.revocationfile")).toBeNull();
  await choose("gpg.format","ssh");expect((document.getElementById("repo-config-gpg.ssh.revocationfile") as HTMLInputElement).value).toBe("revoked-keys");
  await choose("gpg.format","openpgp");await click("Save");expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/first",[{key:"gpg.format",value:"openpgp"},{key:"gpg.ssh.revocationfile",value:"revoked-keys"}],"reviewed");
});

it("keeps the draft on a stale save failure and reloads only when asked",async()=>{
  vi.mocked(gitApi.setRepositorySettings).mockRejectedValueOnce(new Error("Repository configuration changed. Reload it before saving."));await render();await choose("commit.gpgsign","false");await click("Save");expect(document.querySelector('[role="alert"]')?.textContent).toContain("Reload");expect(select("commit.gpgsign").value).toBe("false");expect(close).not.toHaveBeenCalled();
  await click("Reload");expect(select("commit.gpgsign").value).toBe("inherit");expect(button("Save").disabled).toBe(true);
});

it("blocks duplicate saves synchronously and does not close a newer repository dialog",async()=>{
  let finish!:(settings:GitRepositorySettings)=>void;vi.mocked(gitApi.setRepositorySettings).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await render();await choose("commit.gpgsign","false");await act(async()=>{button("Save").click();button("Save").click();});expect(gitApi.setRepositorySettings).toHaveBeenCalledOnce();expect(button("Cancel").disabled).toBe(true);
  await render("/work/second");await act(async()=>finish(initial));expect(close).not.toHaveBeenCalled();expect(gitApi.setRepositorySettings).toHaveBeenCalledWith("/work/first",expect.any(Array),"reviewed");
});

it("ignores late reads from a previous repository and exposes read errors for retry",async()=>{
  let finish!:(settings:GitRepositorySettings)=>void;vi.mocked(gitApi.getRepositorySettings).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockRejectedValueOnce(new Error("Read failed"));
  await render();await render("/work/second");await act(async()=>finish(initial));expect(document.querySelector('[role="alert"]')?.textContent).toBe("Read failed");await click("Reload");expect(select("gpg.format").value).toBe("ssh");
});

it("shows worktree scope and prevents editing overridden or read-only configuration",async()=>{
  const state=structuredClone(initial);state.worktree=true;state.fields[0].editable=false;vi.mocked(gitApi.getRepositorySettings).mockResolvedValueOnce(state);
  await render();expect(document.body.textContent).toContain("This worktree");expect(select("gpg.format").disabled).toBe(true);expect(document.body.textContent).toContain("Overridden");
  vi.mocked(gitApi.getRepositorySettings).mockResolvedValueOnce({...state,readOnly:true,fields:state.fields.map(field=>({...field,editable:false}))});await click("Reload");expect(button("Save").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("read-only");
});

it("starts file selection in the original repository and ignores a late selection after switching repositories",async()=>{
  let finish!:(path:string)=>void;vi.mocked(open).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await render();
  const browse=document.querySelector('button[aria-label="Choose Signing key"]') as HTMLButtonElement;await act(async()=>browse.click());
  expect(open).toHaveBeenCalledWith({directory:false,multiple:false,defaultPath:"/work/first",title:"Choose a file"});
  await render("/work/second");await act(async()=>finish("/work/first/key.pub"));expect((document.getElementById("repo-config-user.signingkey") as HTMLInputElement).value).toBe("local-key");
});
