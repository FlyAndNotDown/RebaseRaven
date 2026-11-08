// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4JobDialog } from "@/components/p4/p4-job-dialog";
import { P4JobFixDialog } from "@/components/p4/p4-job-fixes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import { P4_JOB_STALE } from "@/lib/p4-operation-preview";
import type { P4FixPreview, P4FixRequest, P4Job } from "@/types/p4-jobs";

const actions = vi.hoisted(() => ({read: vi.fn(), save: vi.fn(), remove: vi.fn(), previewFix: vi.fn(), applyFix: vi.fn()}));
vi.mock("@/state/p4-context", () => ({useP4: () => ({jobs: actions, busy: false})}));
let root: Root, container: HTMLDivElement;
const changed = vi.fn(), closed = vi.fn();
function job(): P4Job {
  const field = {kind:"word", required:true, readOnly:false, choices:[], hint:"", value:""};
  return {name:"job001", fingerprint:"reviewed-job", schemaFingerprint:"reviewed-schema", fields:[
    {...field, code:101, name:"Job", value:"job001", readOnly:true},
    {...field, code:102, name:"State", kind:"select", value:"open", choices:["open","waiting","fixed"]},
    {...field, code:104, name:"Modified", kind:"date", value:"2025/01/01", readOnly:true},
    {...field, code:105, name:"Details", kind:"text", value:"Description\n\n    Indentation"},
    {...field, code:106, name:"Priority", kind:"select", value:"high", required:false, choices:["low","high"]},
  ]};
}
const request: P4FixRequest = {job:"job001", change:"", status:"", remove:false};
function preview(edit: P4FixRequest): P4FixPreview {return {request:edit, changeStatus:"pending", currentStatus:"open", fixStatus:edit.status || "fixed", existingStatus:null, fingerprint:"reviewed-association"};}
function deferred<T>() {let resolve!: (value:T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true}); setLanguagePreference("en"); vi.resetAllMocks();
  actions.read.mockResolvedValue(job()); actions.save.mockResolvedValue(job()); actions.remove.mockResolvedValue(undefined);
  actions.previewFix.mockImplementation(async (edit: P4FixRequest) => preview(edit)); actions.applyFix.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove();});
async function render(element: React.ReactNode) {await act(async () => {root.render(<TooltipProvider>{element}</TooltipProvider>);});}
function button(text: string) {const value = [...document.querySelectorAll("button")].find(b => b.textContent?.trim() === text); if (!value) throw new Error(`Missing button: ${text}`); return value;}
async function click(text: string) {await act(async () => button(text).click());}
async function enter(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", {bubbles:true}));
  });
}
const editor = (mode: "new" | "edit" | "delete" = "edit") => <P4JobDialog mode={mode} name={mode === "new" ? null : "job001"} onClose={closed} onChanged={changed} />;

it("renders custom fields and preserves text while excluding server-managed fields from edits", async () => {
  await render(editor());
  expect((document.getElementById("p4-job-field-104") as HTMLInputElement).readOnly).toBe(true);
  expect((document.getElementById("p4-job-field-105") as HTMLTextAreaElement).value).toBe("Description\n\n    Indentation");
  expect(actions.save).not.toHaveBeenCalled();
  await enter("p4-job-field-106", ""); await click("Save");
  expect(actions.save).toHaveBeenCalledWith({name:"job001", schemaFingerprint:"reviewed-schema", values:{State:"open", Details:"Description\n\n    Indentation", Priority:""}}, "reviewed-job");
  expect(changed).toHaveBeenCalledWith(job());
});

it("loads new-job defaults without creating a job and requires mandatory text", async () => {
  const value = job(); value.name = "new"; value.fields[0] = {...value.fields[0], readOnly:false, value:"new"}; value.fields[3].value = "";
  actions.read.mockResolvedValue(value); await render(editor("new"));
  expect(actions.read).toHaveBeenCalledWith(null); expect(actions.save).not.toHaveBeenCalled(); expect(button("Save").disabled).toBe(true);
  await enter("p4-job-field-105", "Review content"); await click("Save");
  expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({name:"new", values:expect.objectContaining({Details:"Review content"})}), null);
});

it("retains a stale draft until the user explicitly discards it and reloads", async () => {
  actions.save.mockRejectedValueOnce(new Error(P4_JOB_STALE)); await render(editor());
  await enter("p4-job-field-105", "My draft"); await click("Save");
  expect((document.getElementById("p4-job-field-105") as HTMLTextAreaElement).value).toBe("My draft"); expect(button("Save").disabled).toBe(true);
  expect(actions.read).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
  actions.read.mockResolvedValue({...job(), fingerprint:"updated-job"}); await click("Discard draft and reload"); await click("Save");
  expect(actions.save).toHaveBeenLastCalledWith(expect.anything(), "updated-job");
});

it("requires the exact job name before deletion and keeps native errors visible", async () => {
  actions.remove.mockRejectedValue(new Error("Job has fixes.")); await render(editor("delete"));
  expect(button("Delete job").disabled).toBe(true); await enter("p4-delete-job", "job001 "); expect(button("Delete job").disabled).toBe(true);
  await enter("p4-delete-job", "job001"); await click("Delete job");
  expect(actions.remove).toHaveBeenCalledWith("job001", "reviewed-job"); expect(document.querySelector('[role="alert"]')?.textContent).toBe("Job has fixes."); expect(changed).not.toHaveBeenCalled();
});

it("previews pending status before mutation and invalidates approval when the form changes", async () => {
  await render(<P4JobFixDialog request={request} onClose={closed} onChanged={changed} />);
  await enter("p4-fix-change", "42"); await enter("p4-fix-status", "waiting"); await click("Preview association");
  expect(actions.applyFix).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("when this pending changelist is submitted");
  await enter("p4-fix-change", "43"); expect(document.body.textContent).not.toContain("when this pending changelist is submitted");
  await click("Preview association"); await click("Confirm link");
  expect(actions.applyFix).toHaveBeenCalledWith({...request, change:"43", status:"waiting"}, "reviewed-association");
});

it("requires a fresh preview after the server rejects a changed association", async () => {
  actions.applyFix.mockRejectedValueOnce(new Error("The job, changelist, or fix changed. Preview the association again."));
  await render(<P4JobFixDialog request={{...request, change:"42"}} onClose={closed} onChanged={changed} />);
  await click("Preview association"); await click("Confirm link");
  expect(button("Preview association").disabled).toBe(false); expect(document.querySelector('[role="alert"]')?.textContent).toContain("Preview"); expect(changed).not.toHaveBeenCalled();
  await click("Preview association"); expect(actions.previewFix).toHaveBeenCalledTimes(2);
});

it("shows immediate submitted effects and keeps unlinking separate from changing status", async () => {
  actions.previewFix.mockImplementation(async (edit: P4FixRequest) => ({...preview(edit), changeStatus:"submitted"}));
  await render(<P4JobFixDialog request={{...request, change:"42"}} onClose={closed} onChanged={changed} />);
  await click("Preview association"); expect(document.body.textContent).toContain("immediately");
  await act(async () => root.unmount()); root = createRoot(container);
  await render(<P4JobFixDialog request={{...request, change:"42", remove:true}} onClose={closed} onChanged={changed} />);
  expect(document.getElementById("p4-fix-status")).toBeNull(); await click("Preview association"); await click("Remove link");
  expect(actions.applyFix).toHaveBeenCalledWith(expect.objectContaining({remove:true}), "reviewed-association");
});

it("ignores a late mutation result after the owning dialog unmounts", async () => {
  const pending = deferred<P4Job>(); actions.save.mockReturnValueOnce(pending.promise); await render(editor()); await click("Save");
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => pending.resolve(job())); expect(changed).not.toHaveBeenCalled();
});

it("describes same-status links without claiming an immediate status change", async () => {
  await render(<P4JobFixDialog request={{...request, change:"42", status:"same"}} onClose={closed} onChanged={changed} />);
  await click("Preview association");
  expect(document.body.textContent).toContain("current status is preserved");
  expect(document.body.textContent).not.toContain("status changes when");
  expect(document.body.textContent).not.toContain("updates the job status immediately");
});
