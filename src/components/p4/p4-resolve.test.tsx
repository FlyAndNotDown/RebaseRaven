// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4Resolve } from "@/components/p4/p4-resolve";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4ResolveView } from "@/types/p4";

const calls = vi.hoisted(() => ({ resolveView: vi.fn(), resolveAccept: vi.fn(), manualResolveView: vi.fn(), manualResolveExternal: vi.fn(), manualResolveApply: vi.fn() }));
vi.mock("@/state/p4-context", () => ({ useP4: () => ({ ...calls, busy: false }) }));
vi.mock("@/state/git-context", () => ({ useGitPick: () => ({ prefs: { diffSplit: false }, setDiffOptions: vi.fn() }) }));
vi.mock("@/components/p4/p4-diff", () => ({ P4Diff: () => <div>Revision preview</div> }));
let root: Root, container: HTMLDivElement;
const close = vi.fn();
const view: P4ResolveView = { path: "//depot/app.ts", summary: "Merging app.ts", content: true, autoMergeable: false, comparable: true, workingCopy: true, pendingResolves: 1, diff: { path: "app.ts", oldPath: null, binary: false, truncated: false, lines: [] } };
function button(label: string) { const result = [...document.querySelectorAll("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label); expect(result).toBeDefined(); return result!; }
async function render(strict = false) { const editor = <TooltipProvider><P4Resolve path="//depot/app.ts" onClose={close} /></TooltipProvider>; await act(async () => root.render(strict ? <StrictMode>{editor}</StrictMode> : editor)); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); setLanguagePreference("en"); vi.resetAllMocks(); calls.resolveView.mockResolvedValue(view); calls.manualResolveView.mockResolvedValue({ base: "base\n", yours: "local\n", theirs: "incoming\n", fingerprint: "reviewed" }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("disables an unsafe automatic merge while keeping explicit side choices available", async () => {
  await render(); const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.map(radio => radio.disabled)).toEqual([true, false, false]);
  await act(async () => radios[0].click()); expect(button("Resolve").disabled).toBe(true);
  await act(async () => radios[1].click()); calls.resolveAccept.mockResolvedValue(true);
  await act(async () => button("Resolve").click()); expect(calls.resolveAccept).toHaveBeenCalledWith("//depot/app.ts", "yours"); expect(close).toHaveBeenCalledOnce();
});

it("refreshes merge eligibility after an unsuccessful resolve instead of retaining a stale selection", async () => {
  calls.resolveView.mockResolvedValueOnce({ ...view, autoMergeable: true }); calls.resolveAccept.mockResolvedValue(false);
  await render(); await act(async () => document.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await act(async () => button("Resolve").click()); expect(calls.resolveView).toHaveBeenCalledTimes(2); expect(button("Resolve").disabled).toBe(true); expect(close).not.toHaveBeenCalled();
});

it("imports external tool output but applies it only after explicit completion", async () => {
  calls.manualResolveExternal.mockResolvedValue("merged\n"); calls.manualResolveApply.mockResolvedValue(undefined);
  await render(); await act(async () => button("Open in merge tool").click());
  expect(calls.manualResolveExternal).toHaveBeenCalledOnce(); expect(calls.manualResolveApply).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  await act(async () => button("Mark merge complete").click());
  expect(calls.manualResolveApply).toHaveBeenCalledWith("//depot/app.ts", "merged\n", "reviewed"); expect(close).toHaveBeenCalledOnce();
});

it("keeps internal editing available when an external tool fails", async () => {
  calls.manualResolveExternal.mockRejectedValue(new Error("Merge tool is unavailable"));
  await render(true); await act(async () => button("Open in merge tool").click());
  expect(calls.manualResolveExternal).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Merge tool is unavailable");
  await act(async () => button("Theirs · incoming").click());
  await act(async () => button("Save and resolve").click());
  expect(calls.manualResolveApply).toHaveBeenCalledWith("//depot/app.ts", "incoming\n", "reviewed");
  expect(close).toHaveBeenCalledOnce();
});

it("confirms before discarding imported external output and reloads resolve options on return", async () => {
  calls.manualResolveExternal.mockResolvedValue("merged\r\n");
  await render(true); await act(async () => button("Open in merge tool").click());
  expect(calls.manualResolveExternal).toHaveBeenCalledOnce();
  await act(async () => button("Back to resolve options").click());
  expect(document.body.textContent).toContain("Discard merge edits?");
  expect(calls.resolveView).toHaveBeenCalledTimes(2);
  await act(async () => button("Discard edits").click());
  expect(calls.resolveView).toHaveBeenCalledTimes(3);
  expect(calls.manualResolveApply).not.toHaveBeenCalled();
});

it("does not launch an external tool after leaving while the merge inputs are loading", async () => {
  let finish!: (value: { base: string; yours: string; theirs: string; fingerprint: string }) => void;
  calls.manualResolveView.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); await act(async () => button("Open in merge tool").click());
  await act(async () => button("Back to resolve options").click());
  await act(async () => finish({ base: "base\n", yours: "local\n", theirs: "incoming\n", fingerprint: "reviewed" }));
  expect(calls.manualResolveExternal).not.toHaveBeenCalled();
});

it("retains the edited result after a save failure and preserves workspace line endings", async () => {
  calls.manualResolveView.mockResolvedValue({ base: "base\r\n", yours: "local\r\n", theirs: "incoming\r\n", fingerprint: "reviewed" });
  calls.manualResolveApply.mockRejectedValueOnce(new Error("Workspace changed"));
  await render(); await act(async () => button("Manual merge").click());
  await act(async () => button("Theirs · incoming").click());
  await act(async () => button("Save and resolve").click());
  expect(document.body.textContent).toContain("Workspace changed");
  expect(close).not.toHaveBeenCalled();
  expect(button("Save and resolve").disabled).toBe(false);
  await act(async () => button("Save and resolve").click());
  expect(calls.manualResolveApply).toHaveBeenLastCalledWith("//depot/app.ts", "incoming\r\n", "reviewed");
  expect(close).toHaveBeenCalledOnce();
});
