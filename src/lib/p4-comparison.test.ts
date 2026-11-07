import { describe, expect, it } from "vitest";
import { p4ComparisonDiff } from "@/lib/p4-comparison";

describe("P4 workspace comparison", () => {
  it("preserves comparison direction and correct line numbers", () => {
    const diff = p4ComparisonDiff({ kind: "text", path: "//depot/file.txt", before: "shared\nold\n", after: "shared\nnew\n" });
    expect(diff.lines).toContainEqual({ kind: "delete", content: "old", oldLineno: 2, newLineno: null });
    expect(diff.lines).toContainEqual({ kind: "add", content: "new", oldLineno: null, newLineno: 2 });
    expect(p4ComparisonDiff({ kind: "text", path: diff.path, before: "new\n", after: "old\n" }).lines.some((line) => line.kind === "delete" && line.content === "new")).toBe(true);
  });
  it("does not report identical files as changed and preserves missing-newline metadata", () => {
    expect(p4ComparisonDiff({ kind: "text", path: "file", before: "same", after: "same" }).lines).toEqual([]);
    expect(p4ComparisonDiff({ kind: "text", path: "file", before: "same", after: "same\n" }).lines.some((line) => line.kind === "meta")).toBe(true);
  });
  it("bounds rendered output for large edits", () => {
    const result = p4ComparisonDiff({ kind: "text", path: "file", before: "", after: "added\n".repeat(6000) });
    expect(result.truncated).toBe(true); expect(result.lines.length).toBeLessThanOrEqual(4000);
  });
});
