import { gitApi } from "@/lib/git";
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
  let finished = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // Closing immediately can race the worker that registers the native activity.
  async function stop() {
    if (finished) return;
    const accepted = await gitApi.cancelActivity(id).catch(() => false);
    if (!accepted && !finished) {
      retry = setTimeout(() => void stop(), 100);
    }
  }
  const abort = () => { void stop(); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    return await read();
  } finally {
    finished = true;
    clearTimeout(retry);
    signal.removeEventListener("abort", abort);
  }
}
