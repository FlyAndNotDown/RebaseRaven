// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { P4Provider, useP4 } from "./p4-context";
import { p4Api } from "@/lib/p4";
import { defaultPrefs } from "@/lib/prefs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4Connection } from "@/types/p4";

vi.mock("@tauri-apps/api/event", () => ({listen:vi.fn(async () => () => {})}));
vi.mock("@/components/p4/p4-connection-dialog", () => ({P4ConnectionDialog:() => null}));
const tab={id:"p4:/workspace",kind:"repo",vcs:"perforce",path:"/workspace",name:"example"};
const model={activeTab:tab,tabs:[tab],beginActivity:vi.fn(() => "activity"),endActivity:vi.fn(),setTabMeta:vi.fn(),retargetRepoTab:vi.fn(),refreshRecents:vi.fn(),prefs:{...defaultPrefs,p4RefreshMinutes:0}};
vi.mock("@/state/git-context", () => ({useGitPick:() => model}));
let state: ReturnType<typeof useP4>, root:Root, host:HTMLDivElement, current:P4Connection;
function Capture() {const value=useP4();useLayoutEffect(() => {state=value;});return <div data-view={value.view} />;}
function button(text: string) {const el=[...document.querySelectorAll("button")].find(el => el.textContent?.trim()===text);if(!el)throw new Error(text);return el;}
async function click(text: string) {await act(async () => button(text).click());}
beforeEach(async () => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});setLanguagePreference("en");
  current={root:"/workspace",client:"example",port:"perforce.example.com:1666",user:"alice",charset:"",stream:"//project/main",server:""};
  vi.spyOn(p4Api,"open").mockImplementation(async () => ({status:"ready",connection:{...current},pending:[]}));
  vi.spyOn(p4Api,"refreshPending").mockResolvedValue([]);
  vi.spyOn(p4Api,"listStreams").mockResolvedValue([{path:"//project/main",kind:"mainline"},{path:"//project/dev",kind:"development"}]);
  vi.spyOn(p4Api,"applySwitch").mockImplementation(async (_connection,request) => {current={...current,stream:request.target};return current;});
  vi.spyOn(p4Api,"sync").mockResolvedValue({output:"up to date",autoResolve:null});
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  await act(async () => root.render(<TooltipProvider><P4Provider><Capture /></P4Provider></TooltipProvider>));
});
afterEach(async () => {await act(async () => root.unmount());host.remove();vi.restoreAllMocks();});
async function switchStream() {
  await act(async () => {state.setView("submitted");state.switchStream("//project/dev");});
  expect(document.body.textContent).not.toContain("Preview");
  await click("Switch");
  expect(p4Api.applySwitch).toHaveBeenCalledWith(expect.objectContaining({stream:"//project/main"}),{target:"//project/dev"});
  expect(document.body.textContent).toContain("Update to latest?");
}
it("switches without syncing and allows skipping the subsequent update", async () => {
  await switchStream();expect(p4Api.sync).not.toHaveBeenCalled();
  await click("Not now");expect(p4Api.sync).not.toHaveBeenCalled();expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("returns to Pending and runs the normal update flow only after opting in", async () => {
  await switchStream();expect(button("Get latest").disabled).toBe(false);
  let updateView="";
  vi.mocked(p4Api.sync).mockImplementation(async () => {updateView=state.view;return {output:"up to date",autoResolve:null};});
  await click("Get latest");
  expect(updateView).toBe("pending");
  expect(p4Api.sync).toHaveBeenCalledWith(expect.objectContaining({stream:"//project/dev"}),[],"activity",defaultPrefs.p4AutoResolveAfterSync);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("keeps a rejected switch open without forcing a switch or starting any update", async () => {
  vi.mocked(p4Api.applySwitch).mockRejectedValueOnce(new Error("Client has files opened."));
  await act(async () => state.switchStream("//project/dev"));await click("Switch");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("files opened");
  expect(document.body.textContent).not.toContain("Update to latest?");
  expect(p4Api.sync).not.toHaveBeenCalled();
});
