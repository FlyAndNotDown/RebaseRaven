import { activityApi } from "./activity";
import { normalizeRepoPath, pathsIgnoreCase } from "@/lib/format";

function containsFolder(parent: string, folder: string) {
  const prefix = normalizeRepoPath(parent);
  const path = normalizeRepoPath(folder);
  const separator = pathsIgnoreCase() ? "\\" : "/";
  return path === prefix || path.startsWith(prefix.endsWith(separator) ? prefix : prefix + separator);
}

/** A recursive scan needs each subtree only once. Reject the entire pick if any folder is outside. */
export function addScanFolders(root: string, current: string[], chosen: string[]): string[] | null {
  const separator = pathsIgnoreCase() ? "\\" : "/";
  if (!root || chosen.some(path => !containsFolder(root, path) || normalizeRepoPath(path).split(separator).includes(".."))) return null;
  let folders = [...current];
  for (const path of chosen) {
    if (folders.some(parent => containsFolder(parent, path))) continue;
    folders = folders.filter(child => !containsFolder(path, child));
    folders.push(path);
  }
  return folders;
}

export async function abortableScan<T>(signal: AbortSignal, id: string, read: () => Promise<T>) {
  signal.throwIfAborted();
  const abort = () => { void activityApi.cancel(id).catch(() => {}); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    return await read();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
