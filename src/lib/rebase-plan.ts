import type { RebaseAction, RebaseCommit } from "@/types/git";

export type RebasePlanStep = RebaseCommit & { action: RebaseAction; message: string };

export function rebasePlanIssue(steps: RebasePlanStep[]): { id: string | null; key: string } | null {
  if (!steps.length) return null;
  if (steps.every(step => step.action === "drop")) return {id:null,key:"allDropped"};
  let previous = false;
  for (const step of steps) {
    if (step.action === "drop") continue;
    if ((step.action === "squash" || step.action === "fixup") && !previous) return {id:step.id,key:"needsPrevious"};
    if ((step.action === "reword" || step.action === "squash") && !step.message.trim()) return {id:step.id,key:"needsMessage"};
    previous = true;
  }
  return null;
}
