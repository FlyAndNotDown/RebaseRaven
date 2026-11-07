import { structuredPatch } from "diff";
import type { FileDiff } from "@/types/git";

export type P4Comparison = { kind: "diff"; diff: FileDiff } | { kind: "text"; path: string; before: string; after: string };

/** Workspace comparisons also work when the base revision used an older depot name. */
export function p4ComparisonDiff(result: P4Comparison): FileDiff {
  if (result.kind === "diff") return result.diff;
  const patch = structuredPatch("before", "after", result.before, result.after, "", "", { context: 3, timeout: 500 });
  if (!patch) throw new Error("The text comparison is too complex to preview.");
  const lines: FileDiff["lines"] = [];
  let truncated = false;
  outer: for (const hunk of patch.hunks) {
    lines.push({ kind: "hunk", content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, oldLineno: null, newLineno: null });
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (lines.length >= 4000) { truncated = true; break outer; }
      if (line.startsWith("\\")) { lines.push({ kind: "meta", content: line, oldLineno: null, newLineno: null }); continue; }
      const mark = line[0], kind = mark === "+" ? "add" : mark === "-" ? "delete" : "context";
      lines.push({ kind, content: line.slice(1), oldLineno: kind === "add" ? null : oldLine++, newLineno: kind === "delete" ? null : newLine++ });
    }
  }
  return { path: result.path, oldPath: null, binary: false, truncated, lines };
}
