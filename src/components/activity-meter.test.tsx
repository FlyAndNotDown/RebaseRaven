// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { setLanguagePreference } from "@/i18n";
import { gitApi } from "@/lib/git";
import { defaultPrefs } from "@/lib/prefs";
import { GitProvider, useGitPick } from "@/state/git-context";
import { ActivityMeter } from "./activity-meter";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const tabId = "p4:/workspace";
const otherTabId = "p4:/other";
function useModel() {
  return useGitPick(["activeTabId", "setActiveTab", "runActivity", "beginActivity", "endActivity"]);
}

function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("cancels only the chosen activity, offers a retry, and keeps pending state on reopening", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  setLanguagePreference("en");
  vi.spyOn(gitApi, "getPrefs").mockResolvedValue(defaultPrefs);
  vi.spyOn(gitApi, "listRecents").mockResolvedValue([]);
  vi.spyOn(gitApi, "loadSession").mockResolvedValue({
    openPaths: [],
    openRepos: [{ path: "/workspace", vcs: "perforce" }, { path: "/other", vcs: "perforce" }],
    active: tabId,
  });
  vi.spyOn(gitApi, "saveSession").mockImplementation(async session => session);
  vi.spyOn(gitApi, "gitExecutables").mockResolvedValue({ pathGit: "/bin/git", active: "/bin/git" });
  const cancel = vi.spyOn(gitApi, "cancelActivity").mockResolvedValueOnce(false).mockResolvedValue(true);
  let model!: ReturnType<typeof useModel>;
  function Harness() {
    const value = useModel();
    useLayoutEffect(() => { model = value; }, [value]);
    return <TooltipProvider><ActivityMeter /></TooltipProvider>;
  }

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<GitProvider><Harness /></GitProvider>));
    expect(model.activeTabId).toBe(tabId);

    const ids = new Map<string, string>();
    const finishes: (() => void)[] = [];
    let refresh!: string;
    const start = (label: string, tabId: string) => model.runActivity(label, undefined, id => {
      ids.set(label, id);
      return new Promise<void>(resolve => { finishes.push(resolve); });
    }, true, tabId);
    await act(async () => {
      void start("Getting latest", tabId);
      void start("Getting revision", tabId);
      void start("Another workspace", otherTabId);
      refresh = model.beginActivity("Refreshing", undefined, undefined, tabId);
    });
    const trigger = button("3 operations running")!;
    await act(async () => trigger.click());
    expect(button("Cancel Refreshing")).toBeNull();
    expect(button("Cancel Another workspace")).toBeNull();

    await act(async () => button("Cancel Getting latest")!.click());
    expect(cancel).toHaveBeenCalledExactlyOnceWith(ids.get("Getting latest"));
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Could not cancel the operation. Try again.");
    expect(button("Cancel Getting latest")?.disabled).toBe(false);

    await act(async () => {
      const stop = button("Cancel Getting latest")!;
      stop.click();
      stop.click();
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(button("Cancelling: Getting latest")?.disabled).toBe(true);
    expect(button("Cancel Getting revision")?.disabled).toBe(false);
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    expect(button("Cancelling: Getting latest")?.disabled).toBe(true);

    await act(async () => model.setActiveTab(otherTabId));
    expect(button("3 operations running")).toBeNull();
    await act(async () => button("Another workspace")!.click());
    expect(button("Cancel Getting revision")).toBeNull();
    expect(button("Cancel Another workspace")?.disabled).toBe(false);
    await act(async () => {
      finishes.forEach(finish => finish());
      model.endActivity(refresh);
    });
    expect(button("Another workspace")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
