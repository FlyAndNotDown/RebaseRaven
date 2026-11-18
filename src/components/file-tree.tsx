import type { GitFileKind } from "@/types/git";
import { t, useTranslation } from "@/i18n";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileBoxIcon, FolderGit2Icon, ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { nestSearchNodes, type SearchNode } from "@/lib/file-search";
import { fileTreeRows } from "@/lib/file-tree-rows";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { cn } from "@/lib/utils";

export interface FileTreeEntry {
  kind?: GitFileKind;
  path: string;
  name: string;
  dir: boolean;
  ignored?: boolean;
  icon?: ReactNode;
  iconTitle?: ReactNode;
}

interface FileTreeProps {
  dir: string;
  depth: number;
  entries: Record<string, FileTreeEntry[]>;
  open: Set<string>;
  selected: string | null;
  onToggle: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onOpenDirectory?: (path: string) => void;
  trailing?: (entry: FileTreeEntry) => ReactNode;
  menu?: (entry: FileTreeEntry) => ReactNode;
  loading?: ReadonlySet<string>;
  revealKey?: number;
}

/** A selectable root folder that keeps its lazily loaded children mounted. */
export function FileTreeRoot({
  entry, selected, onOpenDirectory, menu, revealKey, children,
}: {
  entry: FileTreeEntry;
  selected: string | null;
  onOpenDirectory: (path: string) => void;
  menu?: (entry: FileTreeEntry) => ReactNode;
  revealKey?: string | number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const [lastReveal, setLastReveal] = useState(revealKey);
  if (lastReveal !== revealKey) {
    setLastReveal(revealKey);
    if (revealKey !== undefined) setExpanded(true);
  }
  return <>
    <TreeRow item={entry} depth={0} expanded={expanded} selected={selected}
      onToggle={() => setExpanded(current => !current)} onOpenDirectory={onOpenDirectory}
      onOpenFile={onOpenDirectory} menu={menu} />
    <div hidden={!expanded} className={expanded ? "flex min-h-0 flex-1 flex-col" : undefined}>{children}</div>
  </>;
}

/** A scrolling tree that mounts one screen of rows, regardless of folder size. */
export function VirtualFileTree(props: FileTreeProps) {
  const { dir, depth, entries, open, selected } = props;
  const rows = useMemo(() => fileTreeRows(entries, open, dir, depth), [entries, open, dir, depth]);
  const windowed = useWindowedRows(rows.length, 28, 10, 640);
  const revealed = useRef<{path: string; key?: number} | null>(null);
  const viewportHeight = windowed.viewport?.clientHeight ?? 0;
  useLayoutEffect(() => {
    const viewport = windowed.viewport;
    if (!selected) {
      revealed.current = null;
      return;
    }
    if (!viewport || viewportHeight === 0 || (selected === revealed.current?.path && props.revealKey === revealed.current.key)) return;
    const index = rows.findIndex((row) => row.entry.path === selected);
    if (index < 0) return;
    revealed.current = {path: selected, key: props.revealKey};
    const top = index * 28;
    if (top < viewport.scrollTop) viewport.scrollTo({ top });
    else if (top + 28 > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTo({ top: top + 28 - viewport.clientHeight });
    }
  }, [rows, selected, props.revealKey, windowed.viewport, viewportHeight]);
  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={windowed.viewportRef} scrollbars="vertical">
      <div style={{ paddingTop: windowed.before, paddingBottom: windowed.after }}>
        {rows.slice(windowed.start, windowed.end).map(({ entry, depth: rowDepth }) => (
          <TreeRow
            key={entry.path}
            {...props}
            item={entry}
            depth={rowDepth}
            expanded={entry.dir && open.has(entry.path)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function TreeRow({
  item, depth, expanded, selected, onToggle, onOpenFile, onOpenDirectory, trailing, menu, loading,
}: Pick<FileTreeProps, "depth" | "selected" | "onToggle" | "onOpenFile" | "onOpenDirectory" | "trailing" | "menu" | "loading"> & {
  item: FileTreeEntry;
  expanded: boolean;
}) {
  useTranslation();
  const busy = loading?.has(item.path) ?? false;
  const selectableDirectory = item.dir && !!onOpenDirectory;
  const kind = item.kind === "submodule" ? t("git-files.submodule") : item.kind === "lfs" ? t("git.lfs.title") : "";
  const tip = item.iconTitle || [item.name, kind, item.ignored ? t("git-files.ignored") : ""].filter(Boolean).join(" · ");
  const row = (
    <button
      type="button"
      data-tree-path={item.path}
      aria-expanded={item.dir ? expanded : undefined}
      aria-busy={busy || undefined}
      className={cn(
        "flex h-7 w-full items-center pr-2 text-left text-xs hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected === item.path && "bg-muted",
        item.ignored && "text-muted-foreground",
        selectableDirectory && "select-none",
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => (item.dir ? (onOpenDirectory ?? onToggle)(item.path) : onOpenFile(item.path))}
      onDoubleClick={selectableDirectory ? () => onToggle(item.path) : undefined}
      onContextMenu={() => {
        if (!item.dir) onOpenFile(item.path);
        else onOpenDirectory?.(item.path);
      }}
    >
      <HoverTip label={tip} className="max-w-lg">
        <span className="inline-flex w-fit min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
          {selectableDirectory ? <span className="size-3.5 shrink-0" /> : busy ? (
            <LoaderCircleIcon className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          ) : item.dir ? (
            <ChevronRightIcon className={cn("size-3.5 shrink-0 motion-safe:transition-transform", expanded && "rotate-90")} />
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          {item.kind === "submodule" ? <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("git-files.submodule")} /> : item.kind === "lfs" ? <FileBoxIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("git.lfs.title")} /> : item.dir ? (
            expanded ? (
              <FolderOpenIcon className="size-3.5 shrink-0" />
            ) : (
              <FolderIcon className="size-3.5 shrink-0" />
            )
          ) : item.icon ? (
            <span className="inline-flex shrink-0">{item.icon}</span>
          ) : (
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate font-mono">{item.name}</span>
        </span>
      </HoverTip>
      {trailing ? <span className="ml-auto pl-2">{trailing(item)}</span> : null}
    </button>
  );
  const target = selectableDirectory ? <div className="relative">
    {row}
    <button type="button" disabled={busy} aria-expanded={expanded} aria-label={t(expanded ? "git-files.collapseFolder" : "git-files.expandFolder", {name:item.name})}
      className="absolute top-0 flex h-7 w-5 items-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      style={{left:8 + depth * 12}}
      onClick={event=>{event.stopPropagation();if (event.detail < 2) onToggle(item.path);}}
      onDoubleClick={event=>event.stopPropagation()}
    >{busy ? <LoaderCircleIcon className="size-3.5 shrink-0 motion-safe:animate-spin"/> : <ChevronRightIcon className={cn("size-3.5 shrink-0 motion-safe:transition-transform", expanded && "rotate-90", item.ignored && "text-muted-foreground")}/>}</button>
  </div> : row;
  return menu ? (
    <ContextMenu>
      <ContextMenuTrigger asChild>{target}</ContextMenuTrigger>
      {menu(item)}
    </ContextMenu>
  ) : target;
}

export function FileTreeFilter({
  title,
  query,
  onQuery,
  leading,
  placeholder,
}: {
  title: string;
  query: string;
  onQuery: (value: string) => void;
  leading?: ReactNode;
  placeholder?: string;
}) {
  useTranslation();
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
      {leading ?? <span className="shrink-0 px-1 text-sm font-medium">{title}</span>}
      <div className="relative min-w-0 flex-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onQuery("");
            }
          }}
          placeholder={placeholder ?? t("git-files.filterFiles")}
          aria-label={t("git-files.filterTitle", { title })}
          spellCheck={false}
          className="h-7 pl-7"
        />
      </div>
    </div>
  );
}

function treeEntry(node: SearchNode, toPath: (relative: string) => string): FileTreeEntry {
  return {
    kind: node.kind,
    path: toPath(node.relative),
    name: node.relative.split("/").pop() ?? node.relative,
    dir: node.dir,
    ignored: node.ignored,
  };
}

function buildFilteredTree(
  nodes: SearchNode[],
  toPath: (relative: string) => string,
  decorate?: (node: SearchNode, entry: FileTreeEntry) => FileTreeEntry,
) {
  const nested = nestSearchNodes(nodes);
  const entries: Record<string, FileTreeEntry[]> = {};
  for (const [parent, list] of Object.entries(nested.entries)) {
    entries[toPath(parent)] = list.map((node) => {
      const entry = treeEntry(node, toPath);
      return decorate ? decorate(node, entry) : entry;
    });
  }
  return {
    entries,
    open: new Set(nested.open.map((relative) => toPath(relative))),
  };
}

export function FilteredFileTree({
  nodes,
  toPath,
  selected,
  onOpenFile,
  onOpenDirectory,
  onLoadDir,
  menu,
  decorate,
  depth = 0,
}: {
  nodes: SearchNode[];
  toPath: (relative: string) => string;
  selected: string | null;
  onOpenFile: (path: string) => void;
  onOpenDirectory?: (path: string) => void;
  onLoadDir?: (path: string) => Promise<FileTreeEntry[] | null>;
  menu?: (entry: FileTreeEntry) => ReactNode;
  decorate?: (node: SearchNode, entry: FileTreeEntry) => FileTreeEntry;
  depth?: number;
}) {
  useTranslation();
  const source = useMemo(() => buildFilteredTree(nodes, toPath, decorate), [nodes, toPath, decorate]);
  const [overrides, setOverrides] = useState(() => new Map<string, boolean>());
  const [loaded, setLoaded] = useState<Record<string, FileTreeEntry[]>>({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const inflight = useRef(new Set<string>());
  const open = useMemo(() => {
    const result = new Set(source.open);
    for (const [path, expanded] of overrides) {
      if (expanded) result.add(path);
      else result.delete(path);
    }
    return result;
  }, [source.open, overrides]);
  const entries = useMemo(() => {
    const result = {...source.entries};
    for (const [path, children] of Object.entries(loaded)) {
      const matches = new Map(source.entries[path]?.map(entry => [entry.path, entry]));
      result[path] = children.map(entry => {
        const match = matches.get(entry.path);
        matches.delete(entry.path);
        return match ?? entry;
      }).concat([...matches.values()]);
    }
    return result;
  }, [source.entries, loaded]);

  async function toggle(path: string) {
    const expand = !open.has(path);
    setOverrides(current => new Map(current).set(path, expand));
    if (!expand || entries[path] || !onLoadDir || inflight.current.has(path)) return;
    inflight.current.add(path);
    setLoading(new Set(inflight.current));
    try {
      const children = await onLoadDir(path);
      if (children) setLoaded(current => ({ ...current, [path]: children }));
    } finally {
      inflight.current.delete(path);
      setLoading(new Set(inflight.current));
    }
  }

  if (nodes.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{t("git-files.noMatches")}</p>;
  }

  return (
    <VirtualFileTree
      dir={toPath("")}
      depth={depth}
      entries={entries}
      open={open}
      selected={selected}
      onToggle={(path) => void toggle(path)}
      onOpenFile={onOpenFile}
      onOpenDirectory={onOpenDirectory}
      menu={menu}
      loading={loading}
    />
  );
}
