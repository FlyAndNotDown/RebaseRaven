import { describe, expect, it } from "vitest";
import { joinRoot, nestSearchNodes, type SearchNode } from "@/lib/file-search";

function names(nodes: SearchNode[] | undefined) {
  return (nodes ?? []).map((node) => node.relative.split("/").pop());
}

describe("nestSearchNodes", () => {
  it("keeps a literal backslash distinct from a directory separator", () => {
    const tree = nestSearchNodes([
      { relative: "dir\\file.txt", dir: false },
      { relative: "dir/file.txt", dir: false },
    ]);
    expect(names(tree.entries[""])).toEqual(["dir", "dir\\file.txt"]);
    expect(tree.entries.dir[0].relative).toBe("dir/file.txt");
    expect(joinRoot("/work/repo\\", "dir\\file.txt")).toBe("/work/repo\\/dir\\file.txt");
  });

  it("shows a matching file under its parent folders and expands those folders", () => {
    const tree = nestSearchNodes([
      { relative: "client/src/notes.bat", dir: false, status: "current", detail: "Up to date" },
    ]);
    expect(names(tree.entries[""])).toEqual(["client"]);
    expect(names(tree.entries.client)).toEqual(["src"]);
    expect(names(tree.entries["client/src"])).toEqual(["notes.bat"]);
    expect(tree.entries["client/src"]?.[0]?.dir).toBe(false);
    expect(tree.open).toEqual(["client", "client/src"]);
  });

  it("keeps a matching folder collapsed until it has matching children", () => {
    const tree = nestSearchNodes([{ relative: ".cache", dir: true }]);
    expect(tree.entries[""]?.[0]).toMatchObject({ relative: ".cache", dir: true });
    expect(tree.open).toEqual([]);
  });

  it("opens a matching folder when a file inside it also matches", () => {
    const tree = nestSearchNodes([
      { relative: "src", dir: true },
      { relative: "src/app.ts", dir: false },
    ]);
    expect(names(tree.entries[""])).toEqual(["src"]);
    expect(names(tree.entries.src)).toEqual(["app.ts"]);
    expect(tree.open).toEqual(["src"]);
  });

  it("preserves native ignore matches for files and explicit parent folders", () => {
    const tree=nestSearchNodes([
      {relative:"cache/output.tmp",dir:false,ignored:true},
      {relative:"cache",dir:true,ignored:true},
      {relative:"cache/keep.txt",dir:false,ignored:false},
    ]);
    expect(tree.entries[""][0].ignored).toBe(true);
    expect(tree.entries.cache.find(node=>node.relative.endsWith("output.tmp"))?.ignored).toBe(true);
    expect(tree.entries.cache.find(node=>node.relative.endsWith("keep.txt"))?.ignored).toBe(false);
  });

  it("lists folders before files", () => {
    const tree = nestSearchNodes([
      { relative: "zeta.txt", dir: false },
      { relative: "alpha", dir: true },
    ]);
    expect(names(tree.entries[""])).toEqual(["alpha", "zeta.txt"]);
  });

  it("sorts matching files without case and keeps lexical number ordering", () => {
    const tree = nestSearchNodes([
      { relative: "src/item2.txt", dir: false },
      { relative: "src/beta.txt", dir: false },
      { relative: "src/item10.txt", dir: false },
      { relative: "src/ALPHA.txt", dir: false },
      { relative: "src/alpha.txt", dir: false },
    ]);
    expect(names(tree.entries.src)).toEqual([
      "ALPHA.txt",
      "alpha.txt",
      "beta.txt",
      "item10.txt",
      "item2.txt",
    ]);
  });
});

describe("joinRoot", () => {
  it("joins a windows workspace root with a relative filter path", () => {
    expect(joinRoot("E:\\work\\client", "src/app.ts")).toBe("E:\\work\\client\\src\\app.ts");
    expect(joinRoot("E:\\work\\client", "")).toBe("E:\\work\\client");
  });
});

it("preserves repository file kinds while constructing ancestor folders", () => {
  const tree=nestSearchNodes([
    {relative:"vendor/tool",dir:true,kind:"submodule"},
    {relative:"vendor/tool/media.bin",dir:false,kind:"lfs"},
  ]);
  expect(tree.entries.vendor.find(node => node.relative === "vendor/tool")?.kind).toBe("submodule");
  expect(tree.entries["vendor/tool"].find(node => node.relative.endsWith("media.bin"))?.kind).toBe("lfs");
});
