// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { GitProvider, useGitPick } from "@/state/git-context";
import { ChangesPane } from "@/components/changes-pane";
import { AppToolbar } from "@/components/app-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveCommitEditor } from "@/state/commit-editor";
import { gitApi } from "@/lib/git";
import { defaultPrefs } from "@/lib/prefs";
import { setLanguagePreference } from "@/i18n";
import type { WorkspaceSnapshot } from "@/types/git";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const A = "/work/first",
  B = "/work/second";
let model: ReturnType<typeof useModel>, root: Root, container: HTMLDivElement;
let snapshots: Record<string, WorkspaceSnapshot>;
let pending: {
  path: string;
  resolve: (value: WorkspaceSnapshot) => void;
  reject: (error: Error) => void;
}[];
function initial(path: string): WorkspaceSnapshot {
  return {
    repo: {
      path,
      name: path.split("/").pop() || "repository",
      headId: "first",
      currentBranch: "main",
      isDetached: false,
      ahead: 0,
      behind: 0,
      upstream: null,
      rebase: null,
      operation: null,
    },
    status: {
      staged: [
        { path: "file.txt", kind: "modified", staged: true, oldPath: null },
      ],
      unstaged: [],
    },
    branches: {
      current: "main",
      isDetached: false,
      local: [],
      remote: [],
      tags: [],
    },
    remotes: [],
    stashes: [],
    headCommit: {
      id: "first",
      shortId: "first",
      summary: "Original summary",
      body: "Original details",
      authorName: "Alice",
      authorEmail: "alice@example.com",
      timestamp: 0,
      parents: [],
      refs: [],
      onCurrentBranch: true,
      onTrackingBranch: false,
    },
  };
}
function useModel() {
  return useGitPick([
    "snapshot",
    "activeTabId",
    "activeTab",
    "view",
    "commitEditor",
    "commitDraft",
    "loading",
    "prefsReady",
    "openPath",
    "setActiveTab",
    "setView",
    "setCommitEditor",
    "commit",
    "commitAndPush",
    "pushRemote",
    "publishPrompt",
    "confirmPublish",
    "undoLastCommit",
    "refreshRepository",
    "operationContinue",
    "retargetRepoTab",
    "closeTab",
  ]);
}
function capture(next: ReturnType<typeof useModel>) {
  model = next;
}
function Harness() {
  const current = useModel();
  useLayoutEffect(() => capture(current), [current]);
  return (
    <TooltipProvider>
      {current.publishPrompt ? <AppToolbar /> : null}
      {current.snapshot && current.view === "changes" ? (
        <ChangesPane key={current.activeTabId} />
      ) : null}
    </TooltipProvider>
  );
}
beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterAll(() => vi.unstubAllGlobals());
async function open(path: string) {
  await act(async () => {
    await model.openPath(path, "git");
  });
}
function input() {
  return container.querySelector("textarea")!;
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input().value).toBe(text);
  expect(model.commitEditor?.text).toBe(text);
}
async function switchTo(path: string) {
  await act(async () => {
    model.setActiveTab("repo:" + path);
  });
}
async function remount() {
  await act(async () => {
    model.setView("history");
  });
  await act(async () => {
    model.setView("changes");
  });
}
async function amend() {
  await act(async () => {
    model.setCommitEditor(model.activeTabId, {
      ...resolveCommitEditor(model),
      amend: true,
    });
  });
}
async function start() {
  let result!: Promise<boolean>;
  await act(async () => {
    result = model.commit(input().value, resolveCommitEditor(model).amend);
    await Promise.resolve();
  });
  return { result };
}
async function finish() {
  const item = pending.shift()!;
  await act(async () => {
    snapshots[item.path] = {
      ...snapshots[item.path],
      repo: { ...snapshots[item.path].repo, headId: "committed" },
      status: { staged: [], unstaged: [] },
    };
    item.resolve(snapshots[item.path]);
  });
}
async function enablePush(upstream: string | null = "origin/main") {
  for (const path of [A, B])
    snapshots[path] = {
      ...snapshots[path],
      repo: { ...snapshots[path].repo, upstream },
      remotes: [
        {
          name: "origin",
          url: "https://example.invalid/repository.git",
          pushUrl: null,
        },
      ],
    };
  await act(async () => {
    await model.refreshRepository();
  });
}
async function startPush() {
  let result!: Promise<boolean>;
  await act(async () => {
    result = model.commitAndPush(
      input().value,
      resolveCommitEditor(model).amend,
    );
    await Promise.resolve();
  });
  return { result };
}
beforeEach(async () => {
  setLanguagePreference("en");
  snapshots = { [A]: initial(A), [B]: initial(B) };
  pending = [];
  vi.spyOn(gitApi, "getPrefs").mockResolvedValue({
    ...defaultPrefs,
    analyticsEnabled: false,
  });
  vi.spyOn(gitApi, "listRecents").mockResolvedValue([]);
  vi.spyOn(gitApi, "loadSession").mockResolvedValue({
    openPaths: [],
    openRepos: [],
    active: "welcome",
    historyRevs: {},
    historyExpanded: {},
  });
  vi.spyOn(gitApi, "saveSession").mockImplementation(async (value) => value);
  vi.spyOn(gitApi, "gitExecutables").mockResolvedValue({
    active: "git",
    pathGit: "git",
  });
  vi.spyOn(gitApi, "syncWatches").mockResolvedValue();
  vi.spyOn(gitApi, "openRepository").mockImplementation(
    async (path) => snapshots[path],
  );
  vi.spyOn(gitApi, "refreshWorkspace").mockImplementation(
    async (path) => snapshots[path],
  );
  vi.spyOn(gitApi, "getBranches").mockImplementation(
    async (path) => snapshots[path].branches,
  );
  vi.spyOn(gitApi, "getCommits").mockResolvedValue([]);
  vi.spyOn(gitApi, "commit").mockImplementation(
    (path) =>
      new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
  );
  vi.spyOn(gitApi, "pushRemote").mockImplementation(
    async (path, _activity, options) => {
      if (options?.setUpstream)
        snapshots[path] = {
          ...snapshots[path],
          repo: {
            ...snapshots[path].repo,
            upstream: options.remote + "/" + snapshots[path].repo.currentBranch,
          },
        };
      return snapshots[path];
    },
  );
  vi.spyOn(gitApi, "operationContinue").mockImplementation(async (path) => {
    snapshots[path] = {
      ...snapshots[path],
      repo: { ...snapshots[path].repo, operation: null, headId: "continued" },
    };
    return snapshots[path];
  });
  vi.spyOn(gitApi, "undoLastCommit").mockImplementation(async (path) => ({
    snapshot: snapshots[path],
    message: "Recovered summary\n\nRecovered details",
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <GitProvider>
        <Harness />
      </GitProvider>,
    );
  });
  expect(model.loading).toBe(false);
  await open(A);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

it("keeps typed messages and amend mode across actual repository and view remounts", async () => {
  await type("First draft\n\nDetails");
  await amend();
  expect(resolveCommitEditor(model).amend).toBe(true);
  await open(B);
  await type("Second draft");
  await switchTo(A);
  expect(input().value).toBe("First draft\n\nDetails");
  expect(resolveCommitEditor(model).amend).toBe(true);
  await remount();
  expect(input().value).toBe("First draft\n\nDetails");
  await switchTo(B);
  expect(input().value).toBe("Second draft");
  expect(resolveCommitEditor(model).amend).toBe(false);
});

it("clears only the owning repository after an asynchronous commit and tab switch", async () => {
  await type("Commit A");
  const operation = await start();
  await open(B);
  await type("Keep B");
  await finish();
  expect(await operation.result).toBe(true);
  expect(input().value).toBe("Keep B");
  await switchTo(A);
  expect(input().value).toBe("");
});

it("preserves text re-entered while the same commit is pending", async () => {
  await type("Repeated text");
  const operation = await start();
  await type("");
  await type("Repeated text");
  await finish();
  expect(await operation.result).toBe(true);
  expect(input().value).toBe("Repeated text");
});

it("preserves a fresh draft typed after switching away and back during a commit", async () => {
  await type("Submitted");
  const operation = await start();
  await open(B);
  await switchTo(A);
  await type("Next change");
  await finish();
  expect(await operation.result).toBe(true);
  expect(input().value).toBe("Next change");
});

it("keeps the editor and amend choice on a failed commit", async () => {
  await type("Retain failed commit");
  await amend();
  const operation = await start();
  await act(async () => {
    pending.shift()!.reject(new Error("Rejected by commit hook"));
  });
  expect(await operation.result).toBe(false);
  expect(input().value).toBe("Retain failed commit");
  expect(resolveCommitEditor(model).amend).toBe(true);
});

it("restores Undo messages on remount and respects an explicit clear", async () => {
  await act(async () => {
    await model.undoLastCommit();
  });
  await remount();
  expect(input().value).toBe("Recovered summary\n\nRecovered details");
  await type("");
  await remount();
  expect(input().value).toBe("");
});

it("removes a consumed Undo request after a successful commit", async () => {
  await act(async () => {
    await model.undoLastCommit();
  });
  const operation = await start();
  await finish();
  expect(await operation.result).toBe(true);
  await remount();
  expect(input().value).toBe("");
  expect(model.commitDraft).toBe(null);
});

it("keeps custom text when a banner continues using the native merge message", async () => {
  snapshots[A] = {
    ...snapshots[A],
    repo: {
      ...snapshots[A].repo,
      operation: {
        kind: "merge",
        message: "Native merge",
        headName: null,
        onto: null,
        step: null,
        total: null,
      },
    },
  };
  await act(async () => {
    await model.refreshRepository();
  });
  expect(input().value).toBe("Native merge");
  await type("Custom explanation");
  await act(async () => {
    await model.operationContinue();
  });
  expect(input().value).toBe("Custom explanation");
});

it("clears the message actually used for operation continuation", async () => {
  snapshots[A] = {
    ...snapshots[A],
    repo: {
      ...snapshots[A].repo,
      operation: {
        kind: "merge",
        message: "Native merge",
        headName: null,
        onto: null,
        step: null,
        total: null,
      },
    },
  };
  await act(async () => {
    await model.refreshRepository();
  });
  await type("Edited merge");
  await act(async () => {
    await model.operationContinue("Edited merge");
  });
  expect(input().value).toBe("");
});

it("disables amend after an external HEAD change while retaining text", async () => {
  await type("Reviewed text");
  await amend();
  snapshots[A] = {
    ...snapshots[A],
    repo: { ...snapshots[A].repo, headId: "external" },
  };
  await act(async () => {
    await model.refreshRepository();
  });
  expect(resolveCommitEditor(model).amend).toBe(false);
  expect(input().value).toBe("Reviewed text");
});

it("retains the editor when an open worktree tab is retargeted", async () => {
  await type("Retain relocated draft");
  await amend();
  await act(async () => {
    model.retargetRepoTab("repo:" + A, "/work/relocated", "relocated", true);
  });
  expect(input().value).toBe("Retain relocated draft");
  expect(resolveCommitEditor(model).amend).toBe(true);
});

it("does not clear a reopened repository session when an older commit completes", async () => {
  await type("Old submission");
  const operation = await start();
  await open(B);
  await act(async () => {
    model.closeTab("repo:" + A);
  });
  await open(A);
  await type("New session text");
  await finish();
  expect(await operation.result).toBe(true);
  expect(input().value).toBe("New session text");
});

it("keeps commit and push on the originating repository after a tab switch", async () => {
  await enablePush();
  await type("Commit then push");
  const operation = await startPush();
  await open(B);
  await type("Keep B");
  await finish();
  expect(await operation.result).toBe(true);
  expect(input().value).toBe("Keep B");
  expect(gitApi.pushRemote).toHaveBeenCalledExactlyOnceWith(
    A,
    expect.any(String),
    {
      remote: "origin",
      force: false,
      setUpstream: false,
      expectedBranch: "main",
    },
  );
});

it("skips the push if the originating tab closes while its commit is pending", async () => {
  await enablePush();
  await type("Commit then close");
  const operation = await startPush();
  await open(B);
  await act(async () => {
    model.closeTab("repo:" + A);
  });
  await finish();
  expect(await operation.result).toBe(false);
  expect(gitApi.pushRemote).not.toHaveBeenCalled();
});

it("stops a delayed push after the originating repository changes branch", async () => {
  await enablePush();
  await type("Commit on main");
  const operation = await startPush();
  snapshots[A] = {
    ...snapshots[A],
    repo: { ...snapshots[A].repo, currentBranch: "another" },
  };
  await finish();
  expect(await operation.result).toBe(false);
  expect(gitApi.pushRemote).not.toHaveBeenCalled();
});

it("publishes the original repository and branch after switching tabs", async () => {
  await enablePush(null);
  await act(async () => {
    expect(await model.pushRemote()).toBe(false);
  });
  expect(model.publishPrompt).toEqual({
    tabId: "repo:" + A,
    name: "first",
    branch: "main",
    remote: "origin",
  });
  await open(B);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("first / main");
  const confirm = [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Publish");
  expect(confirm).toBeDefined();
  await act(async () => {
    confirm!.click();
    await Promise.resolve();
  });
  expect(gitApi.pushRemote).toHaveBeenCalledExactlyOnceWith(
    A,
    expect.any(String),
    {
      remote: "origin",
      force: false,
      setUpstream: true,
      expectedBranch: "main",
    },
  );
});

it("does not publish another repository if the prompt owner has closed", async () => {
  await enablePush(null);
  await act(async () => {
    await model.pushRemote();
  });
  await open(B);
  await act(async () => {
    model.closeTab("repo:" + A);
  });
  expect(model.publishPrompt).toBeNull();
  await act(async () => {
    await model.confirmPublish();
  });
  expect(gitApi.pushRemote).not.toHaveBeenCalled();
});

it("cancels a pending publication when its worktree is retargeted", async () => {
  await enablePush(null);
  await act(async () => {
    await model.pushRemote();
  });
  await act(async () => {
    model.retargetRepoTab("repo:" + A, "/work/relocated", "relocated", true);
  });
  expect(model.publishPrompt).toBeNull();
  await act(async () => {
    await model.confirmPublish();
  });
  expect(gitApi.pushRemote).not.toHaveBeenCalled();
});

it("rejects a stale publication confirmation after changing branch", async () => {
  await enablePush(null);
  await act(async () => {
    await model.pushRemote();
  });
  snapshots[A] = {
    ...snapshots[A],
    repo: { ...snapshots[A].repo, currentBranch: "another" },
  };
  await act(async () => {
    await model.refreshRepository();
  });
  await open(B);
  await act(async () => {
    await model.confirmPublish();
  });
  expect(gitApi.pushRemote).not.toHaveBeenCalled();
});

it("respects amend mode in the actual menu without automatically force pushing", async () => {
  await enablePush();
  snapshots[A] = { ...snapshots[A], status: { staged: [], unstaged: [] } };
  await act(async () => {
    await model.refreshRepository();
  });
  await type("Amended message");
  await amend();
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Commit options"]',
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
  });
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((value) => value.textContent === "Amend and push");
  expect(item).toBeDefined();
  expect(item!.getAttribute("data-disabled")).toBeNull();
  await act(async () => {
    item!.click();
    await Promise.resolve();
  });
  expect(gitApi.commit).toHaveBeenCalledWith(A, "Amended message", true);
  await open(B);
  await finish();
  expect(gitApi.pushRemote).toHaveBeenCalledWith(
    A,
    expect.any(String),
    expect.objectContaining({ force: false, expectedBranch: "main" }),
  );
});

it("does not create a commit for an unavailable push destination or detached HEAD", async () => {
  await type("Keep this message");
  let operation = await startPush();
  expect(await operation.result).toBe(false);
  await enablePush();
  snapshots[A] = {
    ...snapshots[A],
    repo: { ...snapshots[A].repo, currentBranch: null, isDetached: true },
  };
  await act(async () => {
    await model.refreshRepository();
  });
  operation = await startPush();
  expect(await operation.result).toBe(false);
  expect(gitApi.commit).not.toHaveBeenCalled();
  expect(input().value).toBe("Keep this message");
});
