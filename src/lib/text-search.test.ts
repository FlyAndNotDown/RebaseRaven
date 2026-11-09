import { expect, it } from "vitest";
import { findText, searchSpans } from "@/lib/text-search";

it("matches literal punctuation and Unicode without changing source offsets", () => {
  expect(findText(["İx .*[foo] 😀 Rust RUST rust"], ".*[foo]")).toEqual([{id:0,line:0,start:3,end:10}]);
  expect(findText(["😀 Rust RUST rust"], "rust").map(item => [item.start,item.end])).toEqual([[3,7],[8,12],[13,17]]);
  expect(findText(["Rust RUST rust"], "rust", true).map(item => item.start)).toEqual([10]);
  expect(findText(["a  b"], "  ")).toHaveLength(1);
  expect(findText(["anything"], "")).toEqual([]);
});

it("searches all logical rows, including rows outside a virtual viewport", () => {
  const lines = Array.from({length:10000}, (_, index) => `row ${index}`);
  lines[9876] = "needle needle";
  expect(findText(lines,"needle")).toEqual([{id:0,line:9876,start:0,end:6},{id:1,line:9876,start:7,end:13}]);
});

it("preserves syntax and change tones when a match crosses token boundaries", () => {
  const spans = [{text:"return ",cls:"keyword",changed:false},{text:"value",cls:"name",changed:true}];
  const parts = searchSpans(spans,findText(["return value"],"urn val"));
  expect(parts).toEqual([
    {text:"ret",cls:"keyword",changed:false,match:null},
    {text:"urn ",cls:"keyword",changed:false,match:0},
    {text:"val",cls:"name",changed:true,match:0},
    {text:"ue",cls:"name",changed:true,match:null},
  ]);
  expect(parts.map(part => part.text).join("")).toBe("return value");
});
