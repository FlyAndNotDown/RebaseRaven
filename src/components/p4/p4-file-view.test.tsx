// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P4FileView } from "./p4-file-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setLanguagePreference } from "@/i18n";
import type { P4FileSource, P4RevisionPage } from "@/types/p4";

const calls = vi.hoisted(() => ({ filelog: vi.fn(), annotate: vi.fn(), describeSubmitted: vi.fn(), revisionDiff: vi.fn(), selectSubmitted: vi.fn(), setView: vi.fn() }));
vi.mock("@/state/p4-context", () => ({ useP4: () => calls }));
vi.mock("@/components/author-avatar", () => ({ AuthorAvatar: () => null }));
vi.mock("@/lib/use-file-syntax", () => ({ useFileSyntax: () => null }));
vi.mock("@/components/p4/p4-image-diff", () => ({ P4ImageDiff: ({ source, single }: { source: P4FileSource; single: boolean }) => <div data-image-source={JSON.stringify(source)} data-single={single} /> }));
const page = (path = "//depot/app.ts", action = "edit"): P4RevisionPage => ({ revisions: [{ depotPath: path, rev: "4", change: "1286", action, user: "alice", time: 1, description: "Update settings" }], next: null });
let root: Root, host: HTMLDivElement;
async function render(path = "//depot/app.ts") { await act(async () => root.render(<TooltipProvider><P4FileView path={path} /></TooltipProvider>)); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); setLanguagePreference("en"); vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  calls.filelog.mockResolvedValue(page());
  calls.annotate.mockResolvedValue([
    { line: 1, change: "1286", user: "alice", time: "1", content: "const streaming = true;" },
    { line: 2, change: "1284", user: "morgan", time: "1", content: "export default streaming;" },
  ]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("shows latest submitted content and line authors without loading changelist details or a diff", async () => {
  await render();
  expect(calls.annotate).toHaveBeenCalledExactlyOnceWith("//depot/app.ts", "4");
  expect(host.textContent).toContain("const streaming = true;");
  expect(host.textContent).toContain("morgan");
  expect(calls.describeSubmitted).not.toHaveBeenCalled(); expect(calls.revisionDiff).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Line history");
});

it("keeps line changelists inspectable", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="View changelist #1284"]')!.click());
  expect(calls.selectSubmitted).toHaveBeenCalledWith("1284"); expect(calls.setView).toHaveBeenCalledWith("submitted");
});

it("discards an old file response after switching files", async () => {
  let finish!: (value: P4RevisionPage) => void;
  calls.filelog.mockImplementation(path => path.endsWith("old.ts") ? new Promise<P4RevisionPage>(resolve => { finish = resolve; }) : Promise.resolve(page("//depot/new.ts")));
  await render("//depot/old.ts"); await render("//depot/new.ts");
  await act(async () => finish(page("//depot/old.ts")));
  expect(calls.annotate).toHaveBeenCalledExactlyOnceWith("//depot/new.ts", "4");
});

it("retries a failed metadata request", async () => {
  calls.filelog.mockRejectedValueOnce(new Error("File unavailable"));
  await render(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("File unavailable");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(calls.annotate).toHaveBeenCalled();
});

it("uses a single image preview and requests no older image", async () => {
  calls.filelog.mockResolvedValue(page("//depot/preview.png")); await render("//depot/preview.png");
  const image = host.querySelector('[data-image-source]')!;
  expect(image.getAttribute("data-single")).toBe("true");
  expect(JSON.parse(image.getAttribute("data-image-source")!)).toEqual({ kind: "compare", request: {
    path: "//depot/preview.png", base: { kind: "revision", depotPath: "//depot/preview.png", revision: "0" },
    head: { kind: "revision", depotPath: "//depot/preview.png", revision: "4" },
  } });
  expect(calls.annotate).not.toHaveBeenCalled();
});

it("handles deleted and non-text files without trying to present them as code", async () => {
  calls.filelog.mockResolvedValueOnce(page("//depot/app.ts", "delete")); await render();
  expect(host.textContent).toContain("This file was deleted."); expect(calls.annotate).not.toHaveBeenCalled();
  calls.filelog.mockResolvedValue(page("//depot/data.bin"));
  calls.annotate.mockRejectedValueOnce(new Error("Select a live text revision for line history."));
  await render("//depot/data.bin");
  expect(host.textContent).toContain("Text preview is not available"); expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("distinguishes an empty file from an empty diff", async () => {
  calls.annotate.mockResolvedValue([]); await render(); expect(host.textContent).toContain("Empty file");
});
