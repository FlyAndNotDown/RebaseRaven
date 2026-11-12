// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4FileHistory } from "./p4-file-history";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { FileDiff } from "@/types/git";
import type { P4Changelist, P4HistoryCursor, P4Revision } from "@/types/p4";

const calls = vi.hoisted(() => ({ filelog: vi.fn(), revisionDiff: vi.fn(), describeSubmitted: vi.fn(), selectSubmitted: vi.fn(), setView: vi.fn() }));
vi.mock("@/state/p4-context", () => ({ useP4: () => calls }));
vi.mock("@/components/p4/p4-diff", () => ({ P4Diff: ({ diff, fileSource }: { diff: FileDiff | null; fileSource?: { path: string; revision: string } }) => <div data-diff-source={JSON.stringify(fileSource)}>{diff?.path}</div> }));
vi.mock("@/components/p4/p4-blame", () => ({ P4Blame: ({ revision }: { revision: P4Revision }) => <div data-blame={`${revision.depotPath}#${revision.rev}`} /> }));
vi.mock("@/components/p4/p4-get-revision-dialog", () => ({ P4GetRevisionDialog: () => null }));
vi.mock("@/components/author-avatar", () => ({ AuthorAvatar: () => <span /> }));
vi.mock("@/components/ui/resizable", () => ({ ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }));

const revision = (rev: string, change = rev, depotPath = "//depot/app.ts"): P4Revision => ({ rev, change, depotPath, action: "edit", user: "alice", time: 1, description: `Change ${change}` });
const details = (id: string): P4Changelist => ({ id, user: "alice", client: "work", status: "submitted", description: `Change ${id}`, time: 1, shelved: false, files: ["app.ts", "theme.ts"].map(name => ({ depotPath: `//depot/${name}`, localPath: "", rev: id, action: "edit", binary: false, status: "edit", detail: "", shelved: false })) });
const diff = (path: string): FileDiff => ({ path, oldPath: null, binary: false, truncated: false, lines: [] });
let root: Root, container: HTMLDivElement;
async function render() { await act(async () => root.render(<StrictMode><TooltipProvider><P4FileHistory path="//depot/app.ts" /></TooltipProvider></StrictMode>)); }
async function clickRevision(index: number, shiftKey = false) { await act(async () => document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[index].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }))); }
function button(label: string) { const result = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label); expect(result, label).toBeDefined(); return result!; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); setLanguagePreference("en"); vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  calls.filelog.mockResolvedValue({ revisions: [revision("3"), revision("2")], next: null });
  calls.describeSubmitted.mockImplementation(async id => details(id)); calls.revisionDiff.mockImplementation(async path => diff(path));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("shows the clicked revision immediately and lets its changelist files drive the diff", async () => {
  await render(); expect(calls.revisionDiff).toHaveBeenLastCalledWith("//depot/app.ts", "3");
  expect(document.querySelector('input')).toBeNull(); expect(document.body.textContent).not.toContain("Compare");
  await act(async () => button("theme.ts").click()); expect(calls.revisionDiff).toHaveBeenLastCalledWith("//depot/theme.ts", "3");
  await clickRevision(1, true); expect(calls.describeSubmitted).toHaveBeenLastCalledWith("2"); expect(calls.revisionDiff).toHaveBeenLastCalledWith("//depot/app.ts", "2");
});

it("discards late changelist details and diffs after another revision is selected", async () => {
  let oldDetail!: (value: P4Changelist) => void, oldDiff!: (value: FileDiff) => void;
  calls.describeSubmitted.mockImplementation(id => id === "3" ? new Promise(resolve => { oldDetail = resolve; }) : Promise.resolve(details(id)));
  calls.revisionDiff.mockImplementation((path, rev) => rev === "3" ? new Promise(resolve => { oldDiff = resolve; }) : Promise.resolve(diff(path + "#" + rev)));
  await render(); await clickRevision(1);
  await act(async () => { oldDetail(details("3")); oldDiff(diff("stale")); });
  expect(document.body.textContent).not.toContain("stale");
  expect(document.querySelector('[data-diff-source]')?.getAttribute('data-diff-source')).toContain('"revision":"2"');
  await act(async () => button("theme.ts").click()); expect(calls.revisionDiff).toHaveBeenLastCalledWith("//depot/theme.ts", "2");
});

it("pages across renames and shows the selected historical depot path", async () => {
  const cursor: P4HistoryCursor = { depotPath: "//depot/old.ts", beforeRevision: 8 };
  calls.filelog.mockResolvedValueOnce({ revisions: [revision("3")], next: cursor }).mockResolvedValueOnce({ revisions: [revision("7", "1", "//depot/old.ts")], next: null });
  await render(); await act(async () => button("Load older revisions").click());
  expect(calls.filelog).toHaveBeenLastCalledWith("//depot/app.ts", cursor);
  await clickRevision(1); expect(calls.revisionDiff).toHaveBeenLastCalledWith("//depot/old.ts", "7");
  expect(button("old.ts")).toBeDefined();
});

it("keeps the selected revision usable when its changelist detail fails", async () => {
  calls.describeSubmitted.mockRejectedValueOnce(new Error("Detail unavailable"));
  await render(); expect(document.body.textContent).toContain("Detail unavailable");
  expect(calls.revisionDiff).toHaveBeenCalledWith("//depot/app.ts", "3");
  await act(async () => button("Retry").click());
  expect(document.body.textContent).not.toContain("Detail unavailable"); expect(button("theme.ts")).toBeDefined();
});

it("uses the selected changelist file for line history", async () => {
  await render(); await act(async () => button("theme.ts").click()); await act(async () => button("Line history").click());
  expect(document.querySelector('[data-blame]')?.getAttribute('data-blame')).toBe("//depot/theme.ts#3");
});
