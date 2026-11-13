// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { identifier } from "../../src-tauri/tauri.conf.json";
import type { AnalyticsEvent, AnalyticsInit, AnalyticsPane } from "@/lib/analytics-protocol";
import { setAnalyticsSessionAllowed } from "@/lib/analytics";
import { setAnalyticsP4FilesMode } from "./analytics-screen";
import { useAnalytics } from "./use-analytics";
import type { P4View } from "./p4-session";
import type { View } from "./session";

const state = vi.hoisted(() => ({
  native: true, focused: true, now: 0, enabled: true,
  tab: { kind: "welcome" } as { kind: "welcome" } | { kind: "repo"; vcs: "git" | "perforce" },
  view: "changes" as View, p4View: "pending" as P4View,
  identifier: vi.fn(), version: vi.fn(),
  frames: [] as { init: AnalyticsInit; events: AnalyticsEvent[]; disable: ReturnType<typeof vi.fn> }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => state.native }));
vi.mock("@tauri-apps/api/app", () => ({ getIdentifier: state.identifier, getVersion: state.version }));
vi.mock("./git-context", () => ({ useGitPick: () => ({
  prefs: { analyticsEnabled: state.enabled }, prefsReady: true, activeTab: state.tab, view: state.view,
}) }));
vi.mock("./p4-context", () => ({ useP4View: () => state.p4View }));
vi.mock("@/lib/analytics-frame", () => ({
  createAnalyticsFrame(init: AnalyticsInit, callbacks: { ready: () => void }) {
    const frame = { init, events: [] as AnalyticsEvent[], disable: vi.fn() };
    state.frames.push(frame);
    queueMicrotask(callbacks.ready);
    return { send: (event: AnalyticsEvent) => { frame.events.push(event); }, disable: frame.disable };
  },
}));

let root: Root;
let container: HTMLDivElement;
function App() { useAnalytics(); return null; }
async function render() { await act(async () => { root.render(<App />); }); }
function panes(): AnalyticsPane[] {
  return state.frames.flatMap(({ events }) => events.flatMap((event) => event.event === "pane_view" ? [event.pane] : []));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubEnv("DEV", false);
  vi.resetAllMocks();
  Object.assign(state, { native: true, focused: true, now: 0, enabled: true, tab: { kind: "welcome" }, view: "changes", p4View: "pending", frames: [] });
  state.identifier.mockResolvedValue(identifier);
  state.version.mockResolvedValue("9.8.7");
  vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(performance, "now").mockImplementation(() => state.now);
  localStorage.clear();
  setAnalyticsSessionAllowed(true);
  setAnalyticsP4FilesMode("workspace");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reports actual main views, including Perforce shelves and the depot subview, without duplicate renders", async () => {
  await render();
  expect(state.frames[0].init).toMatchObject({ appVersion: "9.8.7", screenSchema: 2 });
  state.tab = { kind: "repo", vcs: "perforce" };
  for (const view of ["pending", "submitted", "shelves", "workspace"] as const) {
    state.now += 1_000;
    state.p4View = view;
    await render();
    await render();
  }
  state.now += 1_000;
  await act(async () => { setAnalyticsP4FilesMode("depot"); });
  state.now += 1_000;
  await act(async () => { setAnalyticsP4FilesMode("workspace"); });
  state.tab = { kind: "repo", vcs: "git" };
  for (const view of ["changes", "history", "stash", "files"] as const) {
    state.now += 1_000;
    state.view = view;
    await render();
  }
  expect(panes()).toEqual([
    "welcome", "p4_pending", "p4_history", "p4_shelves", "p4_files", "p4_depot", "p4_files",
    "git_changes", "git_history", "git_stash", "git_files",
  ]);
});

it("does not count an initial background workspace as a view until it becomes visible", async () => {
  state.focused = false;
  state.tab = { kind: "repo", vcs: "git" };
  state.view = "history";
  await render();
  expect(panes()).toEqual([]);
  state.focused = true;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(panes()).toEqual(["git_history"]);
});

it.each(["preview", "development", "different-package", "invalid-version", "metadata-error"])(
  "excludes %s before creating an analytics identity or bridge", async (scenario) => {
    if (scenario === "preview") state.native = false;
    if (scenario === "development") vi.stubEnv("DEV", true);
    if (scenario === "different-package") state.identifier.mockResolvedValue("com.example.desktop");
    if (scenario === "invalid-version") state.version.mockResolvedValue("unknown");
    if (scenario === "metadata-error") state.identifier.mockRejectedValue(new Error("Unavailable"));
    await render();
    expect(state.frames).toEqual([]);
    expect(localStorage.getItem("rebaseraven.analytics.install-id")).toBeNull();
  },
);

it("honors an opt-out made while native package metadata is still loading", async () => {
  let resolve!: (value: string) => void;
  state.identifier.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
  await render();
  state.enabled = false;
  await render();
  await act(async () => { resolve(identifier); });
  expect(state.frames).toEqual([]);
  expect(localStorage.getItem("rebaseraven.analytics.install-id")).toBeNull();
});
