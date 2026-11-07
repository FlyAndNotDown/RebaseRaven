export const DEFAULT_HISTORY_EXPANDED = ["section:local", "section:remotes", "remote:origin", "section:tags"];

/** Retain history filters and expanded folders after Git renames tracking refs.
 * Unqualified names that also identify a local branch keep their local meaning.
 */
export function renamedRemoteViews(
  revs: readonly string[],
  expanded: readonly string[],
  oldName: string,
  newName: string,
  remoteRefs: readonly string[],
  localRefs: readonly string[],
) {
  const knownRemote = new Set(remoteRefs);
  const knownLocal = new Set(localRefs);
  const prefix = `${oldName}/`;
  const fullPrefix = `refs/remotes/${prefix}`;
  const folder = `remote:${oldName}`;
  function renameRef(rev:string) {
      if (rev.startsWith(fullPrefix)) return `refs/remotes/${newName}/${rev.slice(fullPrefix.length)}`;
      if (knownLocal.has(rev)) return rev;
      if (rev === oldName) return newName;
      return rev.startsWith(prefix) && knownRemote.has(rev) ? `${newName}/${rev.slice(prefix.length)}` : rev;
  }
  return {
    renameRef,
    revs: [...new Set(revs.map(renameRef))],
    expanded: [...new Set(expanded.map(id => id === folder || id.startsWith(`${folder}/`) ? `remote:${newName}${id.slice(folder.length)}` : id))],
  };
}
