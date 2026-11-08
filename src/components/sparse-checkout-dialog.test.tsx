// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SparseCheckoutSession } from "@/components/sparse-checkout-dialog";
import { Dialog } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { SPARSE_CHECKOUT_STALE } from "@/lib/sparse-checkout";
import { setLanguagePreference } from "@/i18n";
import type { SparseCheckoutPreview, SparseCheckoutState, SparseCheckoutUpdate } from "@/types/sparse-checkout";
import type { Activity } from "@/types/git";

const model = vi.hoisted(() => ({change:vi.fn(), activities:[] as Activity[]}));
vi.mock("@/state/git-context", () => ({useGitPick:() => ({changeSparseCheckout:model.change, activeTabId:"git:first"}), useActivities:() => model.activities}));
let root: Root, container: HTMLDivElement;
function full(): SparseCheckoutState {return {enabled:false,cone:true,sparseIndex:false,rules:[],patterns:[],fingerprint:"full-checkout"};}
function partial(): SparseCheckoutState {return {...full(),enabled:true,rules:["src"],patterns:["/*","!/*/","/src/"],fingerprint:"partial-checkout"};}
function preview(): SparseCheckoutPreview {return {fingerprint:"reviewed-scope",selected:4,outside:2,selectedPaths:["README.md","src/main.rs"],ignoredCount:0,ignoredPaths:[],dirtyCount:0,dirtyPaths:[]};}
function deferred<T>() {let resolve!: (value:T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true}); setLanguagePreference("en");vi.restoreAllMocks();model.change.mockReset();model.activities=[];
  vi.spyOn(gitApi,"sparseCheckoutState").mockResolvedValue(full());vi.spyOn(gitApi,"previewSparseCheckout").mockResolvedValue(preview());vi.spyOn(gitApi,"cancelActivity").mockResolvedValue(true);
  model.change.mockResolvedValue({state:partial(),report:""});
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove();});
async function show() {await act(async () => root.render(<TooltipProvider><Dialog open><SparseCheckoutSession repoPath="/work/project" onClose={() => {}} /></Dialog></TooltipProvider>));}
function button(text:string) {
  const found=[...document.querySelectorAll("button")].find(button => button.textContent?.trim()===text || button.getAttribute("aria-label")===text);
  if (!found) throw new Error(`Missing button: ${text}`);return found;
}
async function click(text:string) {await act(async () => button(text).click());}
async function check(label:string) {
  const checkbox=[...document.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find(button => button.closest("label")?.textContent?.includes(label));
  if (!checkbox) throw new Error(`Missing checkbox: ${label}`);
  await act(async () => checkbox.click());
}
async function rules(value:string) {
  const textarea=document.getElementById("sparse-checkout-rules") as HTMLTextAreaElement;expect(textarea).not.toBeNull();
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,value);textarea.dispatchEvent(new Event("input",{bubbles:true}));});
}
async function select() {await check("Use sparse checkout");await rules("src");}

it("requires a preview and submits the reviewed request, repository and fingerprint", async () => {
  await show();expect(model.change).not.toHaveBeenCalled();await select();
  expect(button("Apply sparse checkout").disabled).toBe(true);await click("Preview");
  expect(gitApi.previewSparseCheckout).toHaveBeenCalledWith("/work/project",{kind:"set",cone:true,sparseIndex:false,rules:["src"]},"full-checkout");
  await click("Apply sparse checkout");
  expect(model.change).toHaveBeenCalledExactlyOnceWith("/work/project",{kind:"set",cone:true,sparseIndex:false,rules:["src"]},"reviewed-scope",false);
  expect(document.body.textContent).toContain("Working tree updated.");
});

it("ignores an older preview when the rules are edited while it is loading", async () => {
  const pending=deferred<SparseCheckoutPreview>();vi.mocked(gitApi.previewSparseCheckout).mockReturnValueOnce(pending.promise);
  await show();await select();await click("Preview");await rules("docs");
  await act(async () => pending.resolve(preview()));
  expect(button("Apply sparse checkout").disabled).toBe(true);expect(model.change).not.toHaveBeenCalled();
  await click("Preview");await click("Apply sparse checkout");
  expect(model.change).toHaveBeenLastCalledWith("/work/project",expect.objectContaining({rules:["docs"]}),"reviewed-scope",false);
});

it("requires explicit ignored-file approval and clears it when the selection changes", async () => {
  vi.mocked(gitApi.previewSparseCheckout).mockResolvedValue({...preview(),ignoredCount:2,ignoredPaths:["docs/local.cache","tools/build.cache"]});
  await show();await select();await click("Preview");expect(button("Apply sparse checkout").disabled).toBe(true);
  await check("Allow Git to remove all 2 ignored paths");expect(button("Apply sparse checkout").disabled).toBe(false);
  await rules("docs");expect(button("Apply sparse checkout").disabled).toBe(true);
  await click("Preview");expect(button("Apply sparse checkout").disabled).toBe(true);
  await check("Allow Git to remove all 2 ignored paths");await click("Apply sparse checkout");
  expect(model.change).toHaveBeenLastCalledWith("/work/project",expect.objectContaining({rules:["docs"]}),"reviewed-scope",true);
});

it("passes arbitrary pattern rules to Git and disables sparse indexes in pattern mode", async () => {
  await show();await select();await check("Sparse index");await click("Patterns");
  const index=[...document.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find(button => button.closest("label")?.textContent?.includes("Sparse index"));
  expect(index?.disabled).toBe(true);
  await rules("# Included paths\n/*\n!/tools/");await click("Preview");
  expect(gitApi.previewSparseCheckout).toHaveBeenLastCalledWith("/work/project",{kind:"set",cone:false,sparseIndex:false,rules:["# Included paths","/*","!/tools/"]},"full-checkout");
});

it("preserves the draft after a stale preview and reloads only on an explicit action", async () => {
  vi.mocked(gitApi.previewSparseCheckout).mockRejectedValueOnce(new Error(SPARSE_CHECKOUT_STALE));
  await show();await select();await click("Preview");
  expect((document.getElementById("sparse-checkout-rules") as HTMLTextAreaElement).value).toBe("src");
  expect(gitApi.sparseCheckoutState).toHaveBeenCalledOnce();expect(document.querySelector('[role="alert"]')?.textContent).toContain("changed");
  vi.mocked(gitApi.sparseCheckoutState).mockResolvedValue({...partial(),rules:["docs"],fingerprint:"external-definition"});
  await click("Reload settings");expect((document.getElementById("sparse-checkout-rules") as HTMLTextAreaElement).value).toBe("docs");
  await rules("src");await click("Preview");expect(gitApi.previewSparseCheckout).toHaveBeenLastCalledWith("/work/project",expect.objectContaining({rules:["src"]}),"external-definition");
});

it("previews reapply separately and restores the full checkout through the same review flow", async () => {
  vi.mocked(gitApi.sparseCheckoutState).mockResolvedValue(partial());await show();
  expect(button("Preview").disabled).toBe(true);await click("Preview reapply");await click("Reapply rules");
  expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"reapply"},"reviewed-scope",false);
  await check("Use sparse checkout");await click("Preview");
  expect(gitApi.previewSparseCheckout).toHaveBeenLastCalledWith("/work/project",{kind:"disable"},"partial-checkout");
  model.change.mockResolvedValue({state:full(),report:""});await click("Restore full checkout");
  expect(model.change).toHaveBeenLastCalledWith("/work/project",{kind:"disable"},"reviewed-scope",false);
  expect(document.getElementById("sparse-checkout-rules")).toBeNull();
});

it("submits once and cancels only the current repository operation", async () => {
  const pending=deferred<SparseCheckoutUpdate>();
  model.change.mockImplementation(() => {model.activities=[{id:"other",tabId:"git:second",label:"Other operation",cancellable:true},{id:"checkout",tabId:"git:first",label:"Sparse checkout",cancellable:true}];return pending.promise;});
  await show();await select();await click("Preview");
  await act(async () => {button("Apply sparse checkout").click();button("Apply sparse checkout").click();});
  expect(model.change).toHaveBeenCalledOnce();await click("Cancel operation");
  expect(gitApi.cancelActivity).toHaveBeenCalledExactlyOnceWith("checkout");
  await act(async () => {root.render(null);});await act(async () => pending.resolve({state:partial(),report:""}));
  expect(gitApi.sparseCheckoutState).toHaveBeenCalledOnce();
});

it("keeps the intended draft while reading effective settings after a failed mutation", async () => {
  vi.mocked(gitApi.sparseCheckoutState).mockResolvedValueOnce(full()).mockResolvedValue({...partial(),rules:["docs"],fingerprint:"effective-settings"});
  model.change.mockResolvedValue(null);await show();await select();await click("Preview");await click("Apply sparse checkout");
  expect((document.getElementById("sparse-checkout-rules") as HTMLTextAreaElement).value).toBe("src");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("draft is preserved");
  expect(button("Apply sparse checkout").disabled).toBe(true);await click("Preview");
  expect(gitApi.previewSparseCheckout).toHaveBeenLastCalledWith("/work/project",expect.objectContaining({rules:["src"]}),"effective-settings");
});
