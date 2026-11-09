// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffToolbar } from "@/components/diff-toolbar";
import { DiffSearchScope } from "@/components/diff-search";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { DiffToolSource } from "@/lib/diff-tools";

const actions = vi.hoisted(() => ({invoke:vi.fn(), editor:vi.fn(), diff:vi.fn(), options:vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke:actions.invoke}));
vi.mock("@/lib/git", () => ({gitApi:{openFileInEditor:actions.editor,openDifftool:actions.diff},errorMessage:String}));
vi.mock("@/state/git-context", () => ({useGitPick:() => ({prefs:{diffSplit:false,diffIgnoreWhitespace:false},setDiffOptions:actions.options})}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();
  for (const action of Object.values(actions)) action.mockResolvedValue(undefined);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount());container.remove();});
async function render(source: DiffToolSource, textual=true) {
  await act(async () => root.render(<TooltipProvider><DiffSearchScope lines={["example"]}><DiffToolbar source={source} textual={textual} line={12} /></DiffSearchScope></TooltipProvider>));
}
async function click(label:string) {await act(async () => (document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click());}

it("opens the selected historical revision rather than a worktree path", async () => {
  const source = {kind:"commit" as const,oid:"a1b2c3d",path:"deleted.txt",oldPath:null};
  await render({kind:"git",repoPath:"project",source});
  await click("Open in editor");expect(actions.editor).toHaveBeenCalledWith("project",source,12);
  await click("Open in diff tool");expect(actions.diff).toHaveBeenCalledWith("project",source);
  await click("Hide whitespace changes");expect(actions.options).toHaveBeenCalledWith({ignoreWhitespace:true});
});

it("passes Perforce revisions and stream text to the same external actions", async () => {
  const source:DiffToolSource = {kind:"text",path:"stream.txt",before:"old",after:"new"};
  await render(source);await click("Open in editor");
  expect(actions.invoke).toHaveBeenCalledWith("open_diff_document",{source,line:12,externalDiff:false});
  await click("Open in diff tool");
  expect(actions.invoke).toHaveBeenCalledWith("open_diff_document",{source,line:null,externalDiff:true});
});

it("keeps external actions for images and binary files without text-only controls", async () => {
  await render({kind:"git",repoPath:"project",source:{kind:"workdir",path:"image.png",staged:false}},false);
  expect(document.querySelector('[aria-label="Hide whitespace changes"]')).toBeNull();
  expect(document.querySelector('[aria-label="Side by side"]')).toBeNull();
  await click("Open in diff tool");expect(actions.diff).toHaveBeenCalledOnce();
});
