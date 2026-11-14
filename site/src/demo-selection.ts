import type { DemoFile } from "./demo-data";
import { fileChangeIds } from "./demo-model";

export type DemoFileScope = "unstaged" | "staged";
export type DemoSelection = { fileId: string; scope: DemoFileScope };

/** Follow a remaining file or scope after staging and committing sample changes. */
export function reconcileDemoSelection(
  files: readonly DemoFile[],
  remaining: ReadonlySet<string>,
  staged: ReadonlySet<string>,
  selection: DemoSelection,
): DemoSelection | null {
  const hasChanges = (file: DemoFile, scope: DemoFileScope) => fileChangeIds(file).some(id =>
    remaining.has(id) && staged.has(id) === (scope === "staged"));
  const selected = files.find((file) => file.id === selection.fileId);
  if (selected && hasChanges(selected, selection.scope)) return selection;
  const otherScope = selection.scope === "staged" ? "unstaged" : "staged";
  if (selected && hasChanges(selected, otherScope)) return { ...selection, scope: otherScope };
  for (const scope of [selection.scope, otherScope] as const) {
    const file = files.find((candidate) => hasChanges(candidate, scope));
    if (file) return { fileId: file.id, scope };
  }
  return null;
}
