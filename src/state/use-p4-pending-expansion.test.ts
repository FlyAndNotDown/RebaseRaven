import { expect, it } from "vitest";
import { pendingGroups, updatePendingGroups } from "@/state/use-p4-pending-expansion";

it("keeps changelist and shelf expansion independent, including an explicitly collapsed tree", () => {
  const selected = "42";
  let saved = updatePendingGroups(undefined, selected, "shelf", current => new Set(current).add("42"));
  expect([...pendingGroups(saved, selected, "change")]).toEqual(["42"]);
  saved = updatePendingGroups(saved, selected, "change", () => new Set());
  expect([...pendingGroups(saved, selected, "change")]).toEqual([]);
  expect([...pendingGroups(saved, selected, "shelf")]).toEqual(["42"]);
  expect([...pendingGroups([], selected, "change")]).toEqual([]);
});

it("restores every project's tree independently after serialization", () => {
  const projects = {"project-a":["change:default","change:42","shelf:42"],"project-b":["change:57"]};
  const restored = JSON.parse(JSON.stringify(projects)) as typeof projects;
  expect([...pendingGroups(restored["project-a"], "default", "change")]).toEqual(["default","42"]);
  expect([...pendingGroups(restored["project-b"], "default", "shelf")]).toEqual([]);
});
