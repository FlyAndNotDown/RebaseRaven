import type { FileDiff, LineRef } from "@/types/git";
import type { DemoFile } from "./demo-data";

export type DemoChanges = {
  remaining: ReadonlySet<string>;
  staged: ReadonlySet<string>;
  committed: ReadonlySet<string>;
};

type SampleLine = { text: string; id?: string; kind: "context" | "add" | "delete" };

function sampleLines(file: DemoFile, hunkIndex: number): SampleLine[] {
  const hunk = file.hunks[hunkIndex];
  return hunk.lines.flatMap((line, index): SampleLine[] => {
    if (line.before === line.after) return [{ kind: "context", text: line.before ?? "" }];
    return [
      ...(line.before === undefined ? [] : [{ kind: "delete" as const, text: line.before, id: `${hunk.id}:${index}:delete` }]),
      ...(line.after === undefined ? [] : [{ kind: "add" as const, text: line.after, id: `${hunk.id}:${index}:add` }]),
    ];
  });
}

export function fileChangeIds(file: DemoFile) {
  return file.hunks.flatMap((_, index) => sampleLines(file, index).flatMap(line => line.id ? [line.id] : []));
}

export function fileHasChanges(file: DemoFile, state: DemoChanges, staged: boolean) {
  return fileChangeIds(file).some(id => state.remaining.has(id) && state.staged.has(id) === staged);
}

export function moveDemoChanges(state: DemoChanges, ids: readonly string[], action: "stage" | "unstage" | "discard"): DemoChanges {
  const remaining = new Set(state.remaining);
  const staged = new Set(state.staged);
  for (const id of ids) {
    if (!remaining.has(id)) continue;
    if (action === "stage") staged.add(id);
    else staged.delete(id);
    if (action === "discard") remaining.delete(id);
  }
  return { ...state, remaining, staged };
}

export function commitDemoChanges(state: DemoChanges): DemoChanges {
  return {
    remaining: new Set([...state.remaining].filter(id => !state.staged.has(id))),
    staged: new Set(),
    committed: new Set([...state.committed, ...state.staged]),
  };
}

/** Project HEAD, index, and worktree independently, including partial replacements. */
export function projectDemoDiff(file: DemoFile, before: ReadonlySet<string>, after: ReadonlySet<string>) {
  const lines: FileDiff["lines"] = [];
  const ids = new Map<number, string>();
  let beforeDelta = 0;
  let afterDelta = 0;
  for (let index = 0; index < file.hunks.length; index++) {
    const hunk = file.hunks[index];
    const start = Number(hunk.header.match(/@@ -(\d+)/)?.[1] ?? 1);
    const samples = sampleLines(file, index);
    const visible = (line: SampleLine, applied: ReadonlySet<string>) => line.kind === "context" || (line.kind === "add" ? applied.has(line.id!) : !applied.has(line.id!));
    const rows = samples.map(line => ({ line, left: visible(line, before), right: visible(line, after) }));
    const changed = rows.some(row => row.left !== row.right);
    const leftCount = rows.filter(row => row.left).length;
    const rightCount = rows.filter(row => row.right).length;
    const originalCount = samples.filter(line => line.kind !== "add").length;
    if (changed) {
      let oldLineno = Math.max(1, start + beforeDelta);
      let newLineno = Math.max(1, start + afterDelta);
      lines.push({ kind: "hunk", content: `@@ -${leftCount ? oldLineno : 0},${leftCount} +${rightCount ? newLineno : 0},${rightCount} @@`, oldLineno: null, newLineno: null });
      for (const { line, left, right } of rows) {
        if (!left && !right) continue;
        const kind = left && right ? "context" : left ? "delete" : "add";
        if (kind !== "context" && line.id) ids.set(lines.length, line.id);
        lines.push({ kind, content: line.text, oldLineno: left ? oldLineno++ : null, newLineno: right ? newLineno++ : null });
      }
    }
    beforeDelta += leftCount - originalCount;
    afterDelta += rightCount - originalCount;
  }
  return { diff: { path: file.path, oldPath: null, binary: false, truncated: false, lines } satisfies FileDiff, ids };
}

export function scopedDemoDiff(file: DemoFile, state: DemoChanges, staged: boolean) {
  const index = new Set([...state.committed, ...state.staged]);
  return staged
    ? projectDemoDiff(file, state.committed, index)
    : projectDemoDiff(file, index, new Set([...state.committed, ...state.remaining]));
}

export function pickedDemoChanges(projection: ReturnType<typeof projectDemoDiff>, refs: LineRef[]) {
  return projection.diff.lines.flatMap((line, index) => {
    const id = projection.ids.get(index);
    return id && refs.some(ref => ref.old === line.oldLineno && ref.new === line.newLineno) ? [id] : [];
  });
}
