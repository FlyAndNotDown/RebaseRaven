import { useGitPick } from "@/state/git-context";

export function pendingGroups(saved: readonly string[] | undefined, selected: string, section: "change" | "shelf") {
  if (!saved) return new Set(section === "change" && selected ? [selected] : []);
  return new Set(saved.filter(id => id.startsWith(`${section}:`)).map(id => id.slice(section.length + 1)));
}

export function updatePendingGroups(saved: readonly string[] | undefined, selected: string, section: "change" | "shelf", update: (current: Set<string>) => Set<string>) {
  const other = section === "change" ? "shelf" : "change";
  return [...update(pendingGroups(saved, selected, section))].map(id => `${section}:${id}`)
    .concat([...pendingGroups(saved, selected, other)].map(id => `${other}:${id}`));
}

export function useP4PendingExpansion(path: string, selected: string) {
  const {p4PendingExpanded, setP4PendingExpanded} = useGitPick(["p4PendingExpanded", "setP4PendingExpanded"]);
  const saved = p4PendingExpanded[path];
  return {
    openChanges: pendingGroups(saved, selected, "change"),
    shelvedOpen: pendingGroups(saved, selected, "shelf"),
    setExpanded: (update: (current:Set<string>) => Set<string>) => setP4PendingExpanded(path, current => updatePendingGroups(current, selected, "change", update)),
    setShelvedOpen: (update: (current:Set<string>) => Set<string>) => setP4PendingExpanded(path, current => updatePendingGroups(current, selected, "shelf", update)),
  };
}
