import { describe, expect, it } from "vitest";
import { applyConflictChoice, conflictHunks } from "@/lib/conflict-text";
import { hasConflictMarkers, threeWayText } from "@/lib/three-way-text";

describe("three-way text", () => {
  it("keeps one-sided and identical changes without conflict markers", () => {
    expect(threeWayText("a\n", "b\n", "a\n")).toBe("b\n");
    expect(threeWayText("a\n", "a\n", "b\n")).toBe("b\n");
    expect(threeWayText("a\n", "b\n", "b\n")).toBe("b\n");
  });
  it("merges independent and adjacent edits while preserving a missing final newline", () => {
    expect(threeWayText("a\nb\nc", "A\nb\nc", "a\nB\nc")).toBe("A\nB\nc");
    expect(threeWayText("a\nb\nc\n", "a\ninserted\nb\nc\n", "a\nb\nC\n")).toBe("a\ninserted\nb\nC\n");
  });
  it("retains the common base and both overlapping changes for the shared editor", () => {
    const text = threeWayText("a\nb\nc\n", "a\nlocal\nc\n", "a\nincoming\nc\n");
    const hunks = conflictHunks(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ ours: "local\n", theirs: "incoming\n", base: "b\n", hasBase: true });
    expect(applyConflictChoice(text, 0, "both")).toBe("a\nlocal\nincoming\nc\n");
  });
  it("preserves an adjacent local edit when choosing the incoming conflict", () => {
    const merged = threeWayText("name = raven\nreview = base\nparallel = 4\n", "name = raven\nreview = local\nparallel = 8\n", "name = raven\nreview = incoming\nparallel = 4\n");
    expect(applyConflictChoice(merged, 0, "theirs")).toBe("name = raven\nreview = incoming\nparallel = 8\n");
  });
  it("keeps conflicting insertions and delete-versus-edit conflicts explicit", () => {
    expect(conflictHunks(threeWayText("", "ours", "theirs"))).toHaveLength(1);
    expect(conflictHunks(threeWayText("a\nb\nc\n", "a\nc\n", "a\nB\nc\n"))).toHaveLength(1);
  });
  it("handles overlapping edit chains without duplicating or losing surrounding lines", () => {
    const merged = threeWayText("a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n", "a\ncombined\ne\n");
    expect(conflictHunks(merged)).toHaveLength(1);
    expect(applyConflictChoice(merged, 0, "ours")).toBe("a\nB\nc\nD\ne\n");
    expect(applyConflictChoice(merged, 0, "theirs")).toBe("a\ncombined\ne\n");
  });
  it("handles large unchanged regions without overflowing the JavaScript argument stack", () => {
    const original = Array.from({ length: 150_000 }, (_, index) => `line ${index}\n`);
    const base = original.join("");
    const ours = `local\n${original.slice(1).join("")}`;
    const theirs = `${original.slice(0, -1).join("")}incoming\n`;
    expect(threeWayText(base, ours, theirs)).toBe(`local\n${original.slice(1, -1).join("")}incoming\n`);
  });
  it("normalizes CRLF and rejects incomplete marker sets as unresolved", () => {
    expect(threeWayText("a\r\nb\r\n", "A\r\nb\r\n", "a\r\nB\r\n")).toBe("A\nB\n");
    expect(hasConflictMarkers("text\n<<<<<<< Yours\nunfinished\n")).toBe(true);
    expect(hasConflictMarkers("clean text\n")).toBe(false);
  });
});
