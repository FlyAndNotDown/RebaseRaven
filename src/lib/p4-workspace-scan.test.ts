import { afterEach, expect, it, vi } from "vitest";
import { addScanFolders, abortableScan } from "./p4-workspace-scan";
import { activityApi } from "./activity";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("folds Windows scopes by path component and preserves sibling names", () => {
  vi.stubGlobal("navigator", {userAgent: "Windows"});
  const root = "W:\\project";
  const folders = addScanFolders(root, ["W:\\project\\Art\\models"], ["w:/PROJECT/art", "W:\\project\\Artist"]);
  expect(folders).toEqual(["w:/PROJECT/art", "W:\\project\\Artist"]);
  expect(addScanFolders(root, [], ["W:\\project-other", "W:\\project\\art"])).toBeNull();
  expect(addScanFolders(root, [], ["w:/project/../outside"])).toBeNull();
});

it("stops a native scan once when closing the scan dialog", async () => {
  vi.useFakeTimers();
  const cancel = vi.spyOn(activityApi, "cancel").mockResolvedValue(true);
  const controller = new AbortController();
  let finish!: () => void;
  const read = abortableScan(controller.signal, "test-scan", () => new Promise<void>(resolve => {finish = resolve;}));
  controller.abort();
  await vi.advanceTimersByTimeAsync(100);
  expect(cancel.mock.calls).toEqual([["test-scan"]]);
  finish();
  await read;
  await vi.advanceTimersByTimeAsync(250);
  expect(cancel).toHaveBeenCalledTimes(1);
});
