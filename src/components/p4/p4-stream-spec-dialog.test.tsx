// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4StreamSpecDialog, type StreamSpecTarget } from "@/components/p4/p4-stream-spec-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import { P4_STREAM_SPEC_STALE } from "@/lib/p4-operation-preview";
import type { P4StreamSpec } from "@/types/p4-stream-specs";

const actions = vi.hoisted(() => ({read: vi.fn(), template: vi.fn(), save: vi.fn(), remove: vi.fn()}));
vi.mock("@/state/p4-context", () => ({useP4: () => ({streamSpecs: actions, busy: false})}));
let root: Root, container: HTMLDivElement;
const changed = vi.fn(), closed = vi.fn();
function spec(): P4StreamSpec {
  return {path:"//project/feature", name:"Feature", owner:"alice", kind:"development", parent:"//project/main", parentView:"noinherit", description:"Feature work", paths:["share src/...", "import lib/... //library/main/..."], remapped:["old/... new/..."], ignored:[".cache"], options:{locked:false, ownerSubmit:true, toParent:true, fromParent:true, mergeAny:false}, fingerprint:"reviewed-definition"};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
  setLanguagePreference("en"); vi.resetAllMocks();
  actions.read.mockResolvedValue(spec()); actions.template.mockResolvedValue(spec()); actions.save.mockResolvedValue(spec()); actions.remove.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove();});
async function show(target: StreamSpecTarget) {
  await act(async () => {root.render(<TooltipProvider><P4StreamSpecDialog target={target} onClose={closed} onChanged={changed} /></TooltipProvider>);});
}
function button(text: string) {
  const button = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}
async function click(text: string) {await act(async () => button(text).click());}
async function enter(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles:true}));
  });
}

it("loads server defaults without creating a stream, then creates with no existing fingerprint", async () => {
  await show({mode:"new", parent:"//project/main"});
  expect(actions.template).not.toHaveBeenCalled(); expect(actions.save).not.toHaveBeenCalled();
  await enter("p4-new-stream-path", "//project/feature"); await click("Load settings");
  expect(actions.template).toHaveBeenCalledWith({path:"//project/feature", parent:"//project/main", kind:"development", parentView:null});
  expect((document.getElementById("p4-stream-name") as HTMLInputElement).value).toBe("Feature");
  expect(actions.save).not.toHaveBeenCalled();
  await enter("p4-stream-name", "Feature workspace"); await click("Save");
  expect(actions.save).toHaveBeenCalledOnce();
  expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({name:"Feature workspace", paths:spec().paths, remapped:spec().remapped, ignored:spec().ignored, parentView:"noinherit", options:spec().options}), null);
  expect(changed).toHaveBeenCalledWith(spec());
});

it("keeps the reviewed fingerprint and entered draft when a stale save is rejected", async () => {
  actions.save.mockRejectedValueOnce(new Error(P4_STREAM_SPEC_STALE));
  await show({mode:"edit", path:"//project/feature"});
  await enter("p4-stream-name", "My stream draft"); await click("Save");
  expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({name:"My stream draft"}), "reviewed-definition");
  expect((document.getElementById("p4-stream-name") as HTMLInputElement).value).toBe("My stream draft");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("changed");
  expect(actions.read).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
  expect(button("Save").disabled).toBe(true);
  const latest = {...spec(), name:"Server-side change", fingerprint:"latest-definition"};
  actions.read.mockResolvedValue(latest);
  await click("Discard draft and reload");
  expect((document.getElementById("p4-stream-name") as HTMLInputElement).value).toBe("Server-side change");
  await click("Save");
  expect(actions.save).toHaveBeenLastCalledWith(expect.objectContaining({name:"Server-side change"}), "latest-definition");
});

it("requires the exact full path before deleting the reviewed definition", async () => {
  await show({mode:"delete", path:"//project/feature"});
  expect(button("Delete stream").disabled).toBe(true);
  await enter("p4-delete-stream", "feature"); await click("Delete stream"); expect(actions.remove).not.toHaveBeenCalled();
  await enter("p4-delete-stream", "//project/feature"); await click("Delete stream");
  expect(actions.remove).toHaveBeenCalledExactlyOnceWith("//project/feature", "reviewed-definition"); expect(changed).toHaveBeenCalledWith(null);
});

it("submits once while a mutation is pending and ignores its completion after unmount", async () => {
  const pending = deferred<P4StreamSpec>(); actions.save.mockReturnValue(pending.promise);
  await show({mode:"edit", path:"//project/feature"});
  await act(async () => {button("Save").click(); button("Save").click();});
  expect(actions.save).toHaveBeenCalledOnce(); expect(button("Save").disabled).toBe(true);
  await act(async () => {root.render(null);});
  await act(async () => {pending.resolve(spec());});
  expect(changed).not.toHaveBeenCalled();
});

it("can return to setup and loads a fresh template for a changed destination", async () => {
  await show({mode:"new", parent:"//project/main"});
  await enter("p4-new-stream-path", "//project/feature"); await click("Load settings"); await click("Back");
  await enter("p4-new-stream-path", "//project/second"); await click("Load settings");
  expect(actions.template).toHaveBeenLastCalledWith(expect.objectContaining({path:"//project/second"}));
  expect(actions.save).not.toHaveBeenCalled();
});

it("requires a fresh typed confirmation after reloading a changed deletion target", async () => {
  actions.remove.mockRejectedValueOnce(new Error(P4_STREAM_SPEC_STALE));
  await show({mode:"delete", path:"//project/feature"});
  await enter("p4-delete-stream", "//project/feature"); await click("Delete stream");
  expect(button("Delete stream").disabled).toBe(true);
  actions.read.mockResolvedValue({...spec(), fingerprint:"latest-definition"});
  await click("Reload definition");
  expect((document.getElementById("p4-delete-stream") as HTMLInputElement).value).toBe("");
  expect(button("Delete stream").disabled).toBe(true);
  await enter("p4-delete-stream", "//project/feature"); await click("Delete stream");
  expect(actions.remove).toHaveBeenLastCalledWith("//project/feature", "latest-definition");
});

it("labels private edits and disables fields not isolated by the server", async () => {
  actions.read.mockResolvedValue({...spec(), opened:true, editableFields:["Paths", "Remapped", "Ignored"]});
  await show({mode:"edit", path:"//project/feature"});
  expect(document.body.textContent).toContain("Edit private definition");
  expect(document.body.textContent).toContain("Changes stay private");
  expect((document.getElementById("p4-stream-name") as HTMLInputElement).disabled).toBe(true);
  expect((document.getElementById("p4-stream-owner") as HTMLInputElement).disabled).toBe(true);
  await click("View mappings");
  expect((document.getElementById("p4-stream-paths") as HTMLTextAreaElement).disabled).toBe(false);
});
