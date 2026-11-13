// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { P4WorkspaceDialog } from "./p4-workspace-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4WorkspaceSettings } from "@/types/p4";

const api = vi.hoisted(() => ({workspaceSettings:vi.fn(), saveWorkspace:vi.fn(), setWorkspaceOpen:vi.fn(), switchStream:vi.fn()}));
vi.mock("@/state/p4-context", () => ({useP4:() => ({...api, connection:{client:"example"}, busy:false})}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open:vi.fn()}));
let root: Root, host: HTMLDivElement;
const settings = (stream = ""): P4WorkspaceSettings => ({root:"/workspace", lineEnd:"local", view:["//depot/... //example/..."], limitView:[], limitViewSupported:true, stream, fingerprint:"reviewed"});
function button(text: string) {const el=[...document.querySelectorAll("button")].find(el => el.textContent?.trim()===text); if(!el)throw new Error(text);return el;}
async function click(text: string) {await act(async () => button(text).click());}
async function enter(label: string, value: string) {
  const node=document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(node,value);node.dispatchEvent(new Event("input",{bubbles:true}));});
}
async function show(value=settings()) {api.workspaceSettings.mockResolvedValue(value);await act(async () => root.render(<TooltipProvider><P4WorkspaceDialog /></TooltipProvider>));}
beforeEach(() => {Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");vi.resetAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async () => {await act(async () => root.unmount());host.remove();});

it("removes the five workspace flags and edits classic source and destination mappings", async () => {
  await show();
  expect(document.querySelector('[role="checkbox"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Keep files writable");
  expect(button("Save").disabled).toBe(true);
  await click("Mappings"); await click("Add rule");
  await enter("Source path 2","//library/space dir/...");
  await enter("Workspace path 2","//example/vendor/...");
  await click("Save");
  expect(api.saveWorkspace).toHaveBeenCalledWith({
    root:"/workspace", lineEnd:"local", view:['//depot/... //example/...', '"//library/space dir/..." //example/vendor/...'], limitView:[],
  }, "reviewed");
});
it("saves Stream overrides independently from its generated view and keeps rule precedence", async () => {
  const original=settings("//depot/main");
  await show({...original,limitView:["//depot/main/...","-//depot/main/cache/..."]});
  await click("Mappings");
  expect(document.querySelector('input[aria-label="Workspace path 1"]')).toBeNull();
  await act(async () => document.querySelectorAll<HTMLButtonElement>('button[aria-label="Move down"]')[0].click());
  await enter("Source path 1","//depot/main/excluded/...");
  await click("Save");
  expect(api.saveWorkspace).toHaveBeenCalledWith({root:original.root,lineEnd:"local",view:original.view,limitView:["-//depot/main/excluded/...","//depot/main/..."]},"reviewed");
});
it("keeps the mapping draft on failure and requires reload after a stale save", async () => {
  await show(settings("//depot/main")); await click("Mappings"); await click("Add rule"); await enter("Source path 1","//depot/main/src/...");
  api.saveWorkspace.mockRejectedValueOnce(new Error("The workspace changed. Reload it before saving."));
  await click("Save");
  expect((document.querySelector('input[aria-label="Source path 1"]') as HTMLInputElement).value).toBe("//depot/main/src/...");
  expect(button("Save").disabled).toBe(true);
  await click("Discard draft and reload");
  expect(document.body.textContent).toContain("All stream files");
});
