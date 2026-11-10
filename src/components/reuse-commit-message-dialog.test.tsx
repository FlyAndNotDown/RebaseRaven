// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReuseCommitMessageDialog, type CommitMessageTarget } from "@/components/reuse-commit-message-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { setLanguagePreference } from "@/i18n";
import { resolveCommitEditor, type CommitDraft, type CommitEditorState } from "@/state/commit-editor";
import type { WorkspaceSnapshot } from "@/types/git";

const reuse = vi.hoisted(() => vi.fn(() => true));
let model: {activeTabId:string; snapshot:WorkspaceSnapshot; commitEditor:CommitEditorState|null; commitDraft:CommitDraft|null; reuseCommitMessage:typeof reuse};
vi.mock("@/state/git-context", () => ({useGitPick: () => model}));
const target:CommitMessageTarget={tabId:"repo:/work/first",path:"/work/first",commit:{id:"a".repeat(40),shortId:"aaaaaaa",summary:"Folded list title"}};
const message="Full subject\ncontinues on the next line\n\nBody\n\nSigned-off-by: Original <original@example.com>\n";
const close=vi.fn();
let root:Root,container:HTMLDivElement;
async function render(next=target) {await act(async()=>root.render(<TooltipProvider><ReuseCommitMessageDialog key={`${next.tabId}:${next.commit.id}`} target={next} onClose={close}/></TooltipProvider>));}
function button(text:string) {const found=[...document.querySelectorAll("button")].find(button=>button.textContent?.trim()===text);expect(found,`Missing button: ${text}`).toBeDefined();return found!;}
async function click(text:string) {await act(async()=>button(text).click());}
function proposed() {return (document.getElementById("reuse-proposed-message") as HTMLTextAreaElement).value;}
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();reuse.mockReturnValue(true);
  model={activeTabId:target.tabId,snapshot:{repo:{path:target.path,headId:"first",currentBranch:"main",operation:null}} as WorkspaceSnapshot,commitEditor:null,commitDraft:null,reuseCommitMessage:reuse};
  vi.spyOn(gitApi,"getCommitMessage").mockResolvedValue(message);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();});

it("loads the full native message and waits for explicit confirmation",async()=>{
  await render();expect(gitApi.getCommitMessage).toHaveBeenCalledWith(target.path,target.commit.id);expect(proposed()).toBe(message);expect(reuse).not.toHaveBeenCalled();
  await click("Use message");expect(reuse).toHaveBeenCalledWith(target.tabId,target.path,expect.objectContaining({text:""}),message,"replace");expect(close).toHaveBeenCalledOnce();
});

it("previews replacement and append against the existing draft",async()=>{
  model.commitEditor={...resolveCommitEditor(model),text:"Keep my draft",amend:true};
  await render();expect((document.getElementById("reuse-current-draft") as HTMLTextAreaElement).value).toBe("Keep my draft");expect(proposed()).toBe(message);
  await click("Append");expect(proposed()).toBe(`Keep my draft\n\n${message}`);await click("Append to draft");expect(reuse).toHaveBeenLastCalledWith(target.tabId,target.path,expect.objectContaining({text:"Keep my draft"}),message,"append");
});

it("requires a renewed review after the draft changes while the source is loading",async()=>{
  let finish!:(message:string)=>void;vi.mocked(gitApi.getCommitMessage).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await render();expect(button("Use message").disabled).toBe(true);
  model.commitEditor={...resolveCommitEditor(model),text:"New input arrived"};await render();await act(async()=>finish(message));
  expect(button("Use message").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("draft");
  await click("Review current draft");expect((document.getElementById("reuse-current-draft") as HTMLTextAreaElement).value).toBe("New input arrived");await click("Append");await click("Append to draft");expect(reuse).toHaveBeenCalledOnce();
});

it("blocks applying to another repository or during a native operation",async()=>{
  await render();model.activeTabId="repo:/work/second";await render();expect(button("Use message").disabled).toBe(true);await click("Use message");expect(reuse).not.toHaveBeenCalled();
  model.activeTabId=target.tabId;model.snapshot={...model.snapshot,repo:{...model.snapshot.repo,operation:{kind:"merge",headName:null,onto:null,step:null,total:null,message:"Merge work"}}};await render();expect(button("Use message").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("Git operation");
});

it("supports retry and does not load an empty commit message",async()=>{
  vi.mocked(gitApi.getCommitMessage).mockRejectedValueOnce(new Error("Commit unavailable")).mockResolvedValueOnce("");
  await render();expect(document.querySelector('[role="alert"]')?.textContent).toBe("Commit unavailable");await click("Retry");expect(button("Use message").disabled).toBe(true);expect(document.querySelector('[role="alert"]')?.textContent).toContain("no message");expect(reuse).not.toHaveBeenCalled();
});

it("discards a late source response after the dialog closes",async()=>{
  let finish!:(message:string)=>void;vi.mocked(gitApi.getCommitMessage).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  await render();await click("Cancel");await act(async()=>root.render(null));await act(async()=>finish(message));expect(reuse).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
});
