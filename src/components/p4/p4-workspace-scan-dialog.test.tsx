// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLanguagePreference } from "@/i18n";
import { P4WorkspaceScanDialog } from "./p4-workspace-scan-dialog";

const api = vi.hoisted(() => ({
  previewClean: vi.fn(), previewReconcile: vi.fn(), applyClean: vi.fn(), applyReconcile: vi.fn(),
  open: vi.fn(), close: vi.fn(),
}));
let busy = false;
vi.mock("@tauri-apps/plugin-dialog", () => ({open: api.open}));
vi.mock("@/state/p4-context", () => ({useP4: () => ({
  ...api, busy, pending: [], selectedChange: "default", connection: { root: "/work", client: "example" },
})}));
const clean = {scopes: ["/work/art"], restoreModified: true, restoreMissing: true, removeUntracked: true, includeIgnored: false};
const changed = {fingerprint: "original", path: "/work/art/material", action: "restoreModified", revision: "2"};
const local = {fingerprint: "local", path: "/work/art/temporary", action: "removeUntracked"};
const result = {fingerprint: "reviewed", files: [changed, local]};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  setLanguagePreference("en");
  vi.resetAllMocks();
  busy = false;
  api.previewClean.mockResolvedValue(result);
  api.previewReconcile.mockResolvedValue({...result, files: [changed,local].map(file => ({...file, action: "edit"}))});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function render(operation: "reconcile" | "clean", scope?: string) {
  await act(async () => root.render(<StrictMode>
    <P4WorkspaceScanDialog key={operation + scope} operation={operation} scope={scope} onClose={api.close} />
  </StrictMode>));
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function check(label: string) {
  const box = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')].find(node =>
    node.getAttribute("aria-label") === label || node.parentElement?.textContent?.trim() === label);
  expect(box, label).toBeDefined();
  await act(async () => box!.click());
}

it.each(["clean", "reconcile"] as const)("requires explicit folders and Scan from the workspace %s action", async operation => {
  await render(operation);
  expect(button("Scan").disabled).toBe(true);
  api.open.mockResolvedValueOnce(["/elsewhere"]).mockResolvedValueOnce(["/work/art/details", "/work/docs", "/work/art"]);
  await click("Add folders");
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/inside this workspace/);
  await click("Add folders");
  expect(api.open).toHaveBeenCalledWith(expect.objectContaining({defaultPath: "/work", directory: true, multiple: true}));
  expect(document.querySelector('[aria-label="Remove art/details"]')).toBeNull();
  expect(api.previewClean).not.toHaveBeenCalled();
  expect(api.previewReconcile).not.toHaveBeenCalled();
  await click("Scan");
  const scopes = ["/work/docs","/work/art"];
  const args = [expect.any(AbortSignal), expect.any(Function)];
  if (operation === "clean") expect(api.previewClean).toHaveBeenCalledExactlyOnceWith({...clean, scopes}, ...args);
  else expect(api.previewReconcile).toHaveBeenCalledExactlyOnceWith(scopes, ...args);
  expect(api.applyClean).not.toHaveBeenCalled();
  expect(api.applyReconcile).not.toHaveBeenCalled();
});

it("reconciles only the picked changes in the right-clicked folder", async () => {
  await render("reconcile", "/work/art");
  expect(api.previewReconcile).not.toHaveBeenCalled();
  await click("Scan");
  await check("art/temporary");
  await click("Reconcile 1 file");
  expect(api.applyReconcile).toHaveBeenCalledExactlyOnceWith([{path:changed.path, fingerprint:changed.fingerprint}], "default", "reviewed", ["/work/art"]);
  expect(api.close).toHaveBeenCalledOnce();
});

it("reviews clean actions and their revisions, then applies the confirmed subset once", async () => {
  await render("clean", "/work/art");
  await click("Scan");
  expect(document.body.textContent).toContain("#2");
  expect(document.body.textContent).toContain("Restore: 1 · Delete local: 1");
  await check("art/temporary");
  expect(document.body.textContent).toContain("Delete local: 0");
  let finish!: () => void;
  api.applyClean.mockReturnValue(new Promise<void>(resolve => {finish = resolve;}));
  await act(async () => {button("Clean 1 file").click(); button("Clean 1 file").click();});
  expect(api.applyClean).toHaveBeenCalledExactlyOnceWith(clean, [{path:changed.path, fingerprint:changed.fingerprint}], "reviewed");
  expect(button("Cancel").disabled).toBe(true);
  await render("clean", "/work/other");
  await act(async () => finish());
  expect(api.close).not.toHaveBeenCalled();
});

it("changes options before scanning again and keeps stale clean results inapplicable", async () => {
  await render("clean", "/work/art");
  await click("Scan");
  await click("Back");
  await check("Include ignored files");
  await click("Scan");
  expect(api.previewClean).toHaveBeenLastCalledWith({...clean, includeIgnored: true}, expect.any(AbortSignal), expect.any(Function));
  api.applyClean.mockRejectedValueOnce(new Error("Files changed"));
  await click("Clean 2 files");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Files changed");
  for (const label of ["Restore modified files", "Restore missing files", "Remove untracked files"]) await check(label);
  expect(button("Scan").disabled).toBe(true);
});

it("aborts the scan on close or workspace switch and ignores late results", async () => {
  let finish!: (value: typeof result) => void;
  api.previewClean.mockReturnValue(new Promise<typeof result>(resolve => {finish = resolve;}));
  await render("clean", "/work/art");
  await click("Scan");
  const signal = api.previewClean.mock.calls[0][1] as AbortSignal;
  await click("Cancel");
  expect(signal.aborted).toBe(true);
  await render("clean", "/work/other");
  await act(async () => finish(result));
  expect(button("Scan").disabled).toBe(false);
  expect(document.body.textContent).not.toContain("art/material");
  expect(api.previewClean).toHaveBeenCalledOnce();
});

it("allows retries, handles an empty scan and blocks apply when another operation is busy", async () => {
  api.previewClean.mockRejectedValueOnce(new Error("Server unavailable")).mockResolvedValueOnce({...result, files: []});
  await render("clean", "/work/art");
  await click("Scan");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Server unavailable");
  await click("Scan");
  expect(document.body.textContent).toContain("No files need cleanup.");
  await click("Back");
  await click("Scan");
  busy = true;
  await render("clean", "/work/art");
  expect(button("Clean 2 files").disabled).toBe(true);
});
