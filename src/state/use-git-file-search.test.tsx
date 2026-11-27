// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { gitApi } from "@/lib/git";
import type { FileSearch } from "@/types/git";
import { useGitFileSearch } from "./use-git-file-search";

function page(path: string, truncated = false): FileSearch {
  return { hits: [{ path, dir: false, kind: "regular" }], truncated };
}

function Search({ term }: { term: string }) {
  const search = useGitFileSearch("/repository", term);
  return <button onClick={search.next}>{search.result?.hits.map(hit => hit.path).join(",")}</button>;
}

it("reuses the listing across terms, drops late rows and reopens it after external changes", async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  let finish!: (result: FileSearch) => void;
  const read = vi.fn<Awaited<ReturnType<typeof gitApi.openFileSearch>>["page"]>()
    .mockImplementationOnce(() => new Promise<FileSearch>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(page("first", true))
    .mockResolvedValueOnce(page("second"))
    .mockResolvedValueOnce(page("new-file"));
  const close = vi.fn(async () => {});
  const open = vi.spyOn(gitApi, "openFileSearch").mockResolvedValue({ page: read, close });
  const settle = () => act(async () => vi.advanceTimersByTimeAsync(201));
  try {
    await act(async () => root.render(<Search term="old" />));
    await settle();
    await act(async () => root.render(<Search term="new" />));
    await settle();
    await act(async () => finish(page("stale")));
    expect(container.textContent).toBe("first");
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("first,second");
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(container.textContent).toBe("new-file");
    expect(close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
  expect(close).toHaveBeenCalledTimes(2);
});
