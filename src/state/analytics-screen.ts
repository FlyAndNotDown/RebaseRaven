import type { AnalyticsPane } from "@/lib/analytics-protocol";
import type { P4View } from "./p4-session";
import type { VcsKind, View } from "./session";

export type AnalyticsP4FilesMode = "workspace" | "depot";

const gitPanes = {
  changes: "git_changes", history: "git_history", stash: "git_stash", files: "git_files",
} satisfies Record<View, AnalyticsPane>;
const p4Panes = {
  pending: "p4_pending", submitted: "p4_history", workspace: "p4_files", shelves: "p4_shelves",
} satisfies Record<P4View, AnalyticsPane>;

export function analyticsPane(vcs: VcsKind | null, view: View, p4View: P4View, filesMode: AnalyticsP4FilesMode): AnalyticsPane {
  if (vcs === null) return "welcome";
  if (vcs === "git") return gitPanes[view];
  return p4View === "workspace" && filesMode === "depot" ? "p4_depot" : p4Panes[p4View];
}

let filesMode: AnalyticsP4FilesMode = "workspace";
const listeners = new Set<() => void>();
export const analyticsP4FilesMode = () => filesMode;
export function subscribeAnalyticsP4FilesMode(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setAnalyticsP4FilesMode(next: AnalyticsP4FilesMode) {
  if (next === filesMode) return;
  filesMode = next;
  for (const listener of listeners) listener();
}
