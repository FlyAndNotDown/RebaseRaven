import { PathLabel } from "@/components/path-label";
import { depotBase } from "@/lib/p4";

export function P4StreamName({ path }: { path: string }) {
  return <PathLabel path={path} className="max-w-[60%] text-[11px] text-muted-foreground" />;
}

export function ShelfFilePath({ path, directory }: { path: string; directory: string }) {
  const name = depotBase(path);
  const parent = path.slice(directory.length, path.lastIndexOf("/"));
  return <span title={path} className="flex min-w-0 flex-1 items-baseline gap-2 font-mono text-[11px]">
    <span className="max-w-full shrink-0 truncate">{name}</span>
    {parent && <PathLabel path={parent} title={path} className="text-muted-foreground" />}
  </span>;
}
