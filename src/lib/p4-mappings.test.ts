import { expect, it } from "vitest";
import { mappingLines, parseMappings } from "./p4-mappings";

it("preserves quoted paths, mapping kinds, ordering, and inline comments", () => {
  const lines = ['"//depot/space dir/..." "//ws/project/..." ## keep', '-//depot/cache/... //ws/cache/...', '+//other/... //ws/...', '&//depot/src/... //ws/copy/...'];
  const rows = parseMappings(lines, false)!;
  expect(rows.map(row => row.kind)).toEqual(["include", "exclude", "overlay", "ditto"]);
  expect(parseMappings(mappingLines(rows, false), false)).toEqual(rows);
  expect(rows[0].comment).toBe("## keep");
});
it("keeps unsupported text and comments out of the rule editor", () => {
  for (const lines of [['## comment', '//depot/... //ws/...'], ['"//depot/unclosed //ws/...'], ['//depot/... //ws/... extra']]) {
    expect(parseMappings(lines, false)).toBeNull();
  }
});
it("supports workspace-only overrides without inventing destination mappings", () => {
  const lines = ["//project/main/...", "-//project/main/cache/..."];
  expect(mappingLines(parseMappings(lines, true)!, true)).toEqual(lines);
  expect(parseMappings(["+//project/main/..."], true)).toBeNull();
  expect(parseMappings(["//project/... //ws/..."], true)).toBeNull();
});
