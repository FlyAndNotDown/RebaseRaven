import { describe, expect, it } from "vitest";
import { streamRelation, streamRows } from "@/lib/p4-stream-tree";
const main={path:"//depot/main",parent:"none",kind:"mainline"};
const dev={path:"//depot/dev",parent:main.path,kind:"development"};
const task={path:"//depot/task",parent:dev.path,kind:"task"};
const orphan={path:"//other/release",parent:"//other/missing",kind:"release"};
const streams=[task,orphan,dev,main];
describe("Perforce stream relationships",()=>{
  it("keeps parent context for searches even inside a collapsed branch",()=>{
    expect(streamRows(streams,"task",new Set([main.path])).map(r=>[r.stream.path,r.depth])).toEqual([[main.path,0],[dev.path,1],[task.path,2]]);
    expect(streamRows(streams,"",new Set([main.path])).map(r=>r.stream.path)).toEqual([main.path,orphan.path]);
  });
  it("renders missing parents and cyclic input without losing nodes or looping",()=>{
    const nodes=[orphan,{path:"//cycle/a",parent:"//cycle/b",kind:"development"},{path:"//cycle/b",parent:"//cycle/a",kind:"development"}];
    const rows=streamRows(nodes,"",new Set());expect(rows).toHaveLength(3);expect(new Set(rows.map(r=>r.stream.path)).size).toBe(3);
    expect(streamRows(nodes,"cycle/b",new Set())).toHaveLength(2);
  });
  it("offers integration only for the actual current parent or child",()=>{
    expect(streamRelation(dev,main)).toBe("parent");expect(streamRelation(dev,task)).toBe("child");expect(streamRelation(dev,dev)).toBe("current");expect(streamRelation(dev,orphan)).toBe("other");expect(streamRelation(undefined,orphan)).toBe("other");
  });
});
