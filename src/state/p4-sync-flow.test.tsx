// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { setLanguagePreference } from "@/i18n";
import { p4Api } from "@/lib/p4";
import { defaultPrefs } from "@/lib/prefs";
import { P4Provider, useP4 } from "./p4-context";
import type { P4Changelist } from "@/types/p4";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/components/p4/p4-connection-dialog", () => ({ P4ConnectionDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
const tab = { id: "p4:/workspace", kind: "repo", vcs: "perforce", path: "/workspace", name: "example" };
const model = {
  activeTab: tab, tabs: [tab], beginActivity: vi.fn(() => "activity"), endActivity: vi.fn(),
  runActivity: vi.fn(async (_label: string, _detail: string, run: (id: string) => Promise<unknown>) => run("activity")),
  setTabMeta: vi.fn(), retargetRepoTab: vi.fn(), refreshRecents: vi.fn(),
  prefs: { ...defaultPrefs, p4RefreshMinutes: 0 },
};
vi.mock("@/state/git-context", () => ({ useGitPick: () => model }));
let state: ReturnType<typeof useP4>, root: Root, host: HTMLDivElement;
function Capture() {
  const value = useP4();
  useLayoutEffect(() => { state = value; });
  return null;
}
const skipped = {
  failed: true, updated: 1, added: 1, deleted: 0, unchanged: false,
  warnings: {writable: 2}, diagnostics: 0, firstDiagnostic: "",
};

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLanguagePreference("en"); vi.clearAllMocks();
  vi.spyOn(p4Api, "open").mockResolvedValue({ status: "ready", connection: {
    root: "/workspace", client: "example", port: "perforce.example.com:1666", user: "alice", charset: "", stream: null, server: "",
  }, pending: [] });
  vi.spyOn(p4Api, "refreshPending").mockResolvedValue([]);
  vi.spyOn(p4Api, "sync").mockResolvedValue({ output: skipped, autoResolve: null });
  vi.spyOn(p4Api, "getRevision").mockResolvedValue(skipped);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<P4Provider><Capture /></P4Provider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("reports partial sync as one warning and finishes refreshing and releasing the workspace", async () => {
  await act(async () => state.sync());
  expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Skipped 2 writable files");
  expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
  expect(p4Api.refreshPending).toHaveBeenCalled();
  expect(model.runActivity).toHaveBeenCalledExactlyOnceWith("Getting latest", "example", expect.any(Function), true, tab.id);
  expect(p4Api.sync).toHaveBeenCalledWith(expect.objectContaining({ client: "example" }), [], "activity", false);
  expect(state.busy).toBe(false);
});

it("uses the same skipped-file warning for revision updates", async () => {
  await act(async () => { await state.getRevision({
    paths: ["//depot/a.txt"], mode: "latest", value: "", force: false, safe: false,
    changelistFilesOnly: false, removeNotInLabel: true, preview: false,
  }).catch(() => {}); });
  expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Skipped 2 writable files");
  expect(toast.error).not.toHaveBeenCalled(); expect(state.busy).toBe(false);
});

it("keeps a mixed transport failure as an error", async () => {
  vi.mocked(p4Api.sync).mockResolvedValueOnce({ output: { ...skipped, diagnostics: 1, firstDiagnostic: "TCP receive failed." }, autoResolve: null });
  await act(async () => state.sync());
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("TCP receive failed. · Skipped 2 writable files");
  expect(toast.warning).not.toHaveBeenCalled(); expect(state.busy).toBe(false);
});

it("summarizes successful revision updates instead of showing the last file path", async () => {
  vi.mocked(p4Api.getRevision).mockResolvedValueOnce({...skipped, failed:false, added:0, warnings:{}});
  await act(async () => { await state.getRevision({
    paths: ["//depot/a.txt"], mode: "latest", value: "", force: false, safe: false,
    changelistFilesOnly: false, removeNotInLabel: true, preview: false,
  }); });
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("Updated 1 file.");
});

it("refreshes after cancelling Get latest and unlocks the workspace for a retry", async () => {
  let finishRefresh!: (changes: P4Changelist[]) => void;
  vi.mocked(p4Api.refreshPending).mockReturnValueOnce(new Promise(resolve => { finishRefresh = resolve; }));
  vi.mocked(p4Api.sync).mockRejectedValueOnce("Cancelled");
  await act(async () => state.sync());
  expect(toast.info).toHaveBeenCalledExactlyOnceWith("Cancelled: Get latest");
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
  expect(p4Api.refreshPending).toHaveBeenCalledOnce();
  expect(state.busy).toBe(false);
  await act(async () => state.sync());
  expect(p4Api.sync).toHaveBeenCalledTimes(2);
  await act(async () => finishRefresh([]));
});

it.each([false, true])("cancels Get Revision (preview: %s) without dismissing its form", async (preview) => {
  vi.mocked(p4Api.getRevision).mockRejectedValueOnce("Cancelled");
  const onActivity = vi.fn();
  await act(async () => {
    await expect(state.getRevision({
      paths: ["//depot/a.txt"], mode: "latest", value: "", force: false, safe: false,
      changelistFilesOnly: false, removeNotInLabel: true, preview,
    }, onActivity)).resolves.toBeNull();
  });
  expect(onActivity).toHaveBeenCalledExactlyOnceWith("activity");
  expect(model.runActivity).toHaveBeenCalledExactlyOnceWith(
    preview ? "Previewing revision" : "Getting revision", "example", expect.any(Function), true, tab.id,
  );
  expect(p4Api.refreshPending).toHaveBeenCalledTimes(preview ? 0 : 1);
  expect(toast.error).not.toHaveBeenCalled();
  expect(state.busy).toBe(false);
});
