// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { setLanguagePreference } from "@/i18n";
import { p4Api } from "@/lib/p4";
import { defaultPrefs } from "@/lib/prefs";
import { P4Provider, useP4 } from "./p4-context";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/components/p4/p4-connection-dialog", () => ({ P4ConnectionDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
const tab = { id: "p4:/workspace", kind: "repo", vcs: "perforce", path: "/workspace", name: "example" };
const model = {
  activeTab: tab, tabs: [tab], beginActivity: vi.fn(() => "activity"), endActivity: vi.fn(),
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
const skipped = [
  "Can't clobber writable file C:\\work\\a.txt",
  "Can't clobber writable file C:\\work\\b.txt",
  "//depot/a.txt#2 - updating C:\\work\\a.txt",
  "//depot/b.txt#2 - added as C:\\work\\b.txt",
].join("\n");

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setLanguagePreference("en"); vi.clearAllMocks();
  vi.spyOn(p4Api, "open").mockResolvedValue({ status: "ready", connection: {
    root: "/workspace", client: "example", port: "perforce.example.com:1666", user: "alice", charset: "", stream: null, server: "",
  }, pending: [] });
  vi.spyOn(p4Api, "refreshPending").mockResolvedValue([]);
  vi.spyOn(p4Api, "sync").mockRejectedValue(skipped);
  vi.spyOn(p4Api, "getRevision").mockRejectedValue(skipped);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<P4Provider><Capture /></P4Provider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("reports partial sync as one warning and finishes refreshing and releasing the workspace", async () => {
  await act(async () => state.sync());
  expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Skipped 2 writable files");
  expect(toast.error).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
  expect(p4Api.refreshPending).toHaveBeenCalled();
  expect(model.endActivity).toHaveBeenCalledWith("activity"); expect(state.busy).toBe(false);
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
  vi.mocked(p4Api.sync).mockRejectedValueOnce(`${skipped}\nTCP receive failed.`);
  await act(async () => state.sync());
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("TCP receive failed. · Skipped 2 writable files");
  expect(toast.warning).not.toHaveBeenCalled(); expect(state.busy).toBe(false);
});

it("summarizes successful revision updates instead of showing the last file path", async () => {
  vi.mocked(p4Api.getRevision).mockResolvedValueOnce("//depot/a.txt#2 - updating C:\\work\\a.txt");
  await act(async () => { await state.getRevision({
    paths: ["//depot/a.txt"], mode: "latest", value: "", force: false, safe: false,
    changelistFilesOnly: false, removeNotInLabel: true, preview: false,
  }); });
  expect(toast.success).toHaveBeenCalledExactlyOnceWith("Updated 1 file.");
});
