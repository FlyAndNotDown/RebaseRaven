import { describe, expect, it } from "vitest";
import { commitDemoChanges, fileChangeIds, moveDemoChanges, pickedDemoChanges, scopedDemoDiff, type DemoChanges } from "./demo-model";
import { demoFiles } from "./demo-data";

const file = demoFiles[1];
const ids = fileChangeIds(file);
const removal = ids.find(id => id.endsWith(":delete"))!;
const addition = ids.find(id => id.endsWith(":add"))!;
const initial = (): DemoChanges => ({ remaining: new Set(ids), staged: new Set(), committed: new Set() });
const changed = (projection: ReturnType<typeof scopedDemoDiff>) => projection.diff.lines.filter(line => line.kind === "add" || line.kind === "delete");

describe("sample repository index and worktree", () => {
  it("stages just the added side of a replacement and leaves the removal unstaged", () => {
    const projection = scopedDemoDiff(file, initial(), false);
    const line = projection.diff.lines.find(line => line.kind === "add")!;
    const picked = pickedDemoChanges(projection, [{ old: line.oldLineno, new: line.newLineno }]);
    expect(picked).toEqual([addition]);
    const next = moveDemoChanges(initial(), picked, "stage");
    expect(changed(scopedDemoDiff(file, next, true)).map(line => line.kind)).toEqual(["add"]);
    expect(changed(scopedDemoDiff(file, next, false)).map(line => line.kind)).toEqual(["delete"]);
    expect(next.remaining.has(removal)).toBe(true);
  });

  it("commits the index while preserving unrelated working changes", () => {
    const next = commitDemoChanges(moveDemoChanges(initial(), [addition], "stage"));
    expect([...next.remaining]).toEqual([removal]);
    expect(next.staged.size).toBe(0);
    expect([...next.committed]).toEqual([addition]);
    expect(changed(scopedDemoDiff(file, next, true))).toEqual([]);
    expect(changed(scopedDemoDiff(file, next, false)).map(line => line.kind)).toEqual(["delete"]);
    expect(scopedDemoDiff(file, next, false).diff.lines.some(line => line.kind === "context" && line.content.includes("system"))).toBe(true);
  });

  it("discards a removal without treating it as a committed deletion", () => {
    const staged = moveDemoChanges(initial(), [addition], "stage");
    const next = moveDemoChanges(staged, [removal], "discard");
    expect(next.committed.size).toBe(0);
    expect(next.staged.has(addition)).toBe(true);
    expect(changed(scopedDemoDiff(file, next, false))).toEqual([]);
    expect(scopedDemoDiff(file, next, true).diff.lines.some(line => line.kind === "context" && line.content.includes("light"))).toBe(true);
  });

  it("unstages only the requested change and never resurrects a discarded line", () => {
    const next = moveDemoChanges(moveDemoChanges(initial(), ids, "stage"), [addition], "unstage");
    expect([...next.staged]).toEqual([removal]);
    const discarded = moveDemoChanges(next, [addition], "discard");
    expect(moveDemoChanges(discarded, [addition], "stage").remaining.has(addition)).toBe(false);
  });
});
