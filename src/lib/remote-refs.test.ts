import { expect, it } from "vitest";
import { renamedRemoteViews } from "./remote-refs";

it("retains watched tracking refs, qualified refs and nested folders without changing sibling remotes", () => {
  const next = renamedRemoteViews(["origin/main","refs/remotes/origin/topic/nested","origin-other/main","feature"],["section:remotes","remote:origin","remote:origin/topic","remote:origin-other"],"origin","upstream",["origin/main"],["feature"]);
  expect(next.revs).toEqual(["upstream/main","refs/remotes/upstream/topic/nested","origin-other/main","feature"]);
  expect(next.expanded).toEqual(["section:remotes","remote:upstream","remote:upstream/topic","remote:origin-other"]);
});

it("preserves local names that are ambiguous with a remote and deduplicates rewritten filters", () => {
  const next=renamedRemoteViews(["origin/main","origin","refs/remotes/origin/main","upstream/main","origin/topic"],[],"origin","upstream",["origin/main","origin/topic"],["origin/main"]);
  expect(next.revs).toEqual(["origin/main","upstream","refs/remotes/upstream/main","upstream/main","upstream/topic"]);
});
