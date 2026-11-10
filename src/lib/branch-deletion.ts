import type { BranchInfo } from "@/types/git";

export interface BranchDeletionOwner {
  tabId: string;
  repoPath: string;
}

export type BranchDeletionResult =
  | { kind: "complete" }
  | { kind: "unmerged" | "failed"; remaining: BranchInfo[] };

/** Resume the reviewed queue after confirming only its first unmerged branch. */
export async function deleteBranchBatch(
  branches: readonly BranchInfo[],
  remove: (name: string, force: boolean) => Promise<boolean | "unmerged">,
  forceFirst = false,
): Promise<BranchDeletionResult> {
  const seen = new Set<string>();
  const queue: BranchInfo[] = [];
  for (const branch of branches) {
    if (branch.isHead || seen.has(branch.name)) continue;
    seen.add(branch.name);
    queue.push(branch);
  }
  for (let index = 0; index < queue.length; index++) {
    const result = await remove(queue[index].name, forceFirst && index === 0);
    if (result !== true) return { kind: result === "unmerged" ? "unmerged" : "failed", remaining: queue.slice(index) };
  }
  return { kind: "complete" };
}
