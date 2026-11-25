import { expect, it, vi } from "vitest";
import { RepositoryOperations } from "./repository-operations";

it("preempts a background fetch, then waits for native cancellation before writing", async () => {
  const operations = new RepositoryOperations();
  let finish!: () => void;
  const native = new Promise<void>((resolve) => { finish = resolve; });
  const cancel = vi.fn();
  const stage = vi.fn(async () => true);
  const fetch = operations.backgroundWrite("repo", async (_owner, signal) => {
    signal.addEventListener("abort", cancel, { once: true });
    await native;
  });
  const staged = operations.write("repo", false, stage);
  expect(cancel).toHaveBeenCalledOnce();
  expect(stage).not.toHaveBeenCalled();
  finish();
  await fetch;
  expect(await staged).toBe(true);
});

it("leaves the next automatic fetch eligible when a foreground write owns the repository", async () => {
  const operations = new RepositoryOperations();
  let finish!: () => void;
  const write = operations.write("repo", undefined, () => new Promise<void>((resolve) => { finish = resolve; }));
  const fetch = vi.fn(async () => {});
  await operations.backgroundWrite("repo", fetch);
  expect(fetch).not.toHaveBeenCalled();
  finish();
  await write;
  await operations.backgroundWrite("repo", fetch);
  expect(fetch).toHaveBeenCalledOnce();
});
