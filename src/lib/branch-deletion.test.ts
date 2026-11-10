import { expect, it, vi } from "vitest";
import { deleteBranchBatch } from "./branch-deletion";
import type { BranchInfo } from "@/types/git";
const branch = (name: string, isHead = false): BranchInfo => ({ name, isHead, isRemote: false, upstream: null });

it("deletes every reviewed branch in order while skipping HEAD and duplicates", async () => {
  const remove = vi.fn(async () => true);
  expect(await deleteBranchBatch([branch("first"), branch("main", true), branch("second"), branch("first"), branch("third")], remove)).toEqual({ kind: "complete" });
  expect(remove.mock.calls).toEqual([["first", false], ["second", false], ["third", false]]);
});

it("retains the entire remaining queue across each unmerged confirmation", async () => {
  const remove = vi.fn(async (name: string, force: boolean) => name === "first" || force ? true : "unmerged" as const);
  const first = await deleteBranchBatch([branch("first"), branch("second"), branch("third"), branch("last")], remove);
  expect(first.kind).toBe("unmerged"); if (first.kind !== "unmerged") throw new Error("Expected confirmation");
  expect(first.remaining.map(item => item.name)).toEqual(["second", "third", "last"]);
  const second = await deleteBranchBatch(first.remaining, remove, true);
  expect(second.kind).toBe("unmerged"); if (second.kind !== "unmerged") throw new Error("Expected confirmation");
  const third = await deleteBranchBatch(second.remaining, remove, true);
  expect(third.kind).toBe("unmerged"); if (third.kind !== "unmerged") throw new Error("Expected confirmation");
  expect(await deleteBranchBatch(third.remaining, remove, true)).toEqual({ kind: "complete" });
  expect(remove.mock.calls).toEqual([["first", false], ["second", false], ["second", true], ["third", false], ["third", true], ["last", false], ["last", true]]);
});

it("stops on a native failure without forcing or discarding the unprocessed selection", async () => {
  const remove = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const result = await deleteBranchBatch([branch("first"), branch("failed"), branch("last")], remove);
  expect(result).toEqual({ kind: "failed", remaining: [branch("failed"), branch("last")] }); expect(remove).toHaveBeenCalledTimes(2);
});

it("waits for each native deletion before starting the next", async () => {
  let finish!: (result: boolean) => void;
  const remove = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(true);
  const result = deleteBranchBatch([branch("first"), branch("second")], remove);
  expect(remove).toHaveBeenCalledOnce(); finish(true); await result; expect(remove).toHaveBeenCalledTimes(2);
});
