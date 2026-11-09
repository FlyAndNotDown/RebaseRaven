import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon, FolderPenIcon, GitBranchIcon, GitMergeIcon, LoaderCircleIcon, LocateFixedIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { P4StreamWorkDialog } from "@/components/p4/p4-stream-work";
import { P4StreamSpecDialog, type StreamSpecTarget } from "@/components/p4/p4-stream-spec-dialog";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/git";
import { depotBase } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { streamRelation, streamRows } from "@/lib/p4-stream-tree";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { useP4 } from "@/state/p4-context";
import type { P4StreamOption } from "@/types/p4";
import type { P4StreamSpec } from "@/types/p4-stream-specs";

const ROW_HEIGHT = 32;

export function P4Streams() {
  const { t } = useTranslation();
  const p4 = useP4();
  const { listStreams } = p4;
  const [streams, setStreams] = useState<P4StreamOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [privateOpen, setPrivateOpen] = useState(false);
  const [definition, setDefinition] = useState<StreamSpecTarget | null>(null);

  function reload() {setLoading(true); setError(null); setAttempt(value => value + 1);}
  function definitionChanged(spec: P4StreamSpec | null) {
    const removed = definition && definition.mode !== "new" ? definition.path : null;
    setStreams(items => {
      const remaining = (items ?? []).filter(item => item.path !== (spec?.path ?? removed));
      return spec ? [...remaining, {path:spec.path, kind:spec.kind, parent:spec.parent}] : remaining;
    });
    setPicked(spec?.path ?? null); setQuery(""); setDefinition(null); reload();
  }

  useEffect(() => {
    let active = true;
    void listStreams().then(value => {if (active) {setStreams(value); setError(null);}})
      .catch((caught: unknown) => {if (active) setError(p4DisplayError(errorMessage(caught)));})
      .finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [listStreams, attempt]);

  const rows = useMemo(() => streamRows(streams ?? [], query, collapsed), [streams, query, collapsed]);
  const current = streams?.find(stream => stream.path === p4.connection?.stream);
  const selected = streams?.find(stream => stream.path === (picked ?? current?.path)) ?? current ?? streams?.[0];
  const parent = streams?.find(stream => stream.path === selected?.parent);
  const childCount = streams?.filter(stream => stream.parent === selected?.path).length ?? 0;
  const blocked = loading || p4.busy;
  const focusPath = rows.some(row => row.stream.path === selected?.path) ? selected?.path : rows[0]?.stream.path;
  const {viewportRef, viewport, start, end, before, after} = useWindowedRows(rows.length, ROW_HEIGHT);

  useEffect(() => {
    if (query) return;
    const index = rows.findIndex(row => row.stream.path === (picked ?? current?.path));
    if (viewport && index >= 0 && (index * ROW_HEIGHT < viewport.scrollTop || (index + 1) * ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight)) viewport.scrollTo({top:Math.max(0, index * ROW_HEIGHT - 120)});
  }, [rows, current, picked, query, viewport]);

  function toggle(path: string) {
    setCollapsed(old => {const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next;});
  }
  function locate() {setQuery(""); setCollapsed(new Set()); setPicked(null);}
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const row = rows[index];
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "ArrowRight" && row.children) {
      if (collapsed.has(row.stream.path) && !query) toggle(row.stream.path);
      else if (rows[index + 1]?.depth > row.depth) next = index + 1;
    } else if (event.key === "ArrowLeft") {
      if (row.children && !collapsed.has(row.stream.path) && !query) toggle(row.stream.path);
      else {const parentIndex = rows.findIndex(item => item.stream.path === row.stream.parent); if (parentIndex >= 0) next = parentIndex;}
    } else return;
    event.preventDefault(); event.stopPropagation();
    const path = rows[next].stream.path;
    setPicked(path);
    if (viewport) {
      if (next * ROW_HEIGHT < viewport.scrollTop) viewport.scrollTo({top:next * ROW_HEIGHT});
      else if ((next + 1) * ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTo({top:(next + 1) * ROW_HEIGHT - viewport.clientHeight});
    }
    requestAnimationFrame(() => viewport?.querySelector<HTMLButtonElement>(`[data-stream-path="${CSS.escape(path)}"]`)?.focus());
  }

  function integration(stream: P4StreamOption) {
    const relation = streamRelation(current, stream);
    return {
      merge: Boolean(current && current.kind !== "virtual" && current.parent?.startsWith("//") && (relation === "parent" || relation === "current")),
      copy: Boolean(current && current.kind !== "virtual" && stream.kind !== "virtual" && relation === "child"),
    };
  }
  function menu(stream: P4StreamOption, context = false) {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    const operations = integration(stream);
    return <>
      <Item disabled={blocked} onClick={() => setDefinition({mode:"edit", path:stream.path})}><PencilIcon />{t("p4.streamSpec.edit")}</Item>
      <Item disabled={blocked} onClick={() => setDefinition({mode:"new", parent:stream.path})}><PlusIcon />{t("p4.streamSpec.create")}</Item>
      {stream.path === current?.path ? <Item disabled={blocked} onClick={() => setPrivateOpen(true)}><GitBranchIcon />{t("p4.streamWork.title")}</Item> : null}
      {operations.merge ? <Item disabled={blocked} onClick={() => p4.openStreamIntegration("merge", current!.parent!)}><GitMergeIcon />{t("p4.streamTree.mergeShort")}</Item> : null}
      {operations.copy ? <Item disabled={blocked} onClick={() => p4.openStreamIntegration("copy", stream.path)}><GitMergeIcon />{t("p4.streamTree.copyShort")}</Item> : null}
      <Separator />
      <Item disabled={blocked} onClick={() => p4.setWorkspaceOpen(true)}><FolderPenIcon />{t("p4.editWorkspace")}</Item>
      <Item disabled={blocked} variant="destructive" onClick={() => setDefinition({mode:"delete", path:stream.path})}><Trash2Icon />{t("p4.streamSpec.delete")}</Item>
    </>;
  }

  const operations = selected ? integration(selected) : null;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <h1 className="shrink-0 text-xs font-medium">{t("p4.streamTree.title")}</h1>
      <span className="text-[11px] text-muted-foreground tabular-nums">{streams?.length ?? 0}</span>
      <Input aria-label={t("p4.filterStreams")} placeholder={t("p4.filterStreams")} value={query} onChange={event => setQuery(event.target.value)} className="ml-2 h-7 max-w-64 font-mono text-xs" />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <HoverTip label={t("p4.streamTree.locate")}><Button variant="ghost" size="icon-xs" disabled={!current} aria-label={t("p4.streamTree.locate")} onClick={locate}><LocateFixedIcon /></Button></HoverTip>
        <HoverTip label={t("p4.refresh")}><Button variant="ghost" size="icon-xs" disabled={blocked} aria-label={t("p4.refresh")} onClick={reload}><RefreshCwIcon className={loading ? "animate-spin" : ""} /></Button></HoverTip>
        <Button variant="outline" size="sm" className="ml-1" disabled={blocked} onClick={() => setDefinition({mode:"new", parent:selected?.path ?? ""})}><PlusIcon />{t("p4.streamSpec.create")}</Button>
      </div>
    </div>
    {error ? <p role="alert" className="shrink-0 border-b px-3 py-2 text-xs text-destructive">{error}</p> : null}
    {streams && streams.length >= 2000 ? <p className="border-b px-3 py-1 text-[11px] text-muted-foreground">{t("p4.streamTree.limit")}</p> : null}
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="p4-stream-tree" defaultSize="64%" minSize="35%">
        <div ref={viewportRef} className="absolute inset-0 overflow-auto p-1" role="tree" aria-label={t("p4.streamTree.title")}>
          {!streams && loading ? <div className="flex h-full items-center justify-center"><LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" /></div> : !rows.length ? <p className="p-6 text-center text-xs text-muted-foreground">{t("p4.noMatchingStreams")}</p> : <>
            <div aria-hidden style={{height:before}} />
            {rows.slice(start, end).map((row, offset) => <ContextMenu key={row.stream.path}>
              <ContextMenuTrigger asChild>
                <div role="treeitem" aria-level={row.depth + 1} aria-selected={selected?.path === row.stream.path} aria-expanded={row.children ? Boolean(query) || !collapsed.has(row.stream.path) : undefined} onContextMenu={() => setPicked(row.stream.path)} className={cn("flex h-8 items-center gap-1 rounded pr-2 hover:bg-muted/50", selected?.path === row.stream.path && "bg-muted")} style={{paddingLeft:4 + Math.min(row.depth, 16) * 16}}>
                  {row.children ? <Button variant="ghost" size="icon-xs" className="size-5 shrink-0" tabIndex={-1} aria-label={t(collapsed.has(row.stream.path) ? "p4.streamTree.expand" : "p4.streamTree.collapse",{stream:row.stream.path})} disabled={Boolean(query)} onClick={() => toggle(row.stream.path)}>{collapsed.has(row.stream.path) && !query ? <ChevronRightIcon /> : <ChevronDownIcon />}</Button> : <span className="size-5 shrink-0" />}
                  <button type="button" data-stream-path={row.stream.path} tabIndex={row.stream.path === focusPath ? 0 : -1} onKeyDown={event => navigate(event, start + offset)} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" title={row.stream.path} onClick={() => setPicked(row.stream.path)}>
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{depotBase(row.stream.path)}</span>
                    {row.stream.path === current?.path ? <HoverTip label={t("p4.streamTree.current")}><span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-label={t("p4.streamTree.current")} /></HoverTip> : null}
                    <StreamKind kind={row.stream.kind} />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>{menu(row.stream, true)}</ContextMenuContent>
            </ContextMenu>)}
            <div aria-hidden style={{height:after}} />
          </>}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-stream-inspector" defaultSize="36%" minSize="26%">
        <div className="absolute inset-0 overflow-auto">
          {selected ? <>
            <div className="border-b px-3 py-2.5">
              <div className="flex items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-sm font-medium">{depotBase(selected.path)}</h2><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={t("p4.streamTree.actions")}><EllipsisIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{menu(selected)}</DropdownMenuContent></DropdownMenu></div>
              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={selected.path}>{selected.path}</p>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 px-3 py-3 text-xs">
              <dt className="text-muted-foreground">{t("p4.streamSpec.type")}</dt><dd><StreamKind kind={selected.kind} /></dd>
              <dt className="text-muted-foreground">{t("p4.streamTree.parent")}</dt><dd className="min-w-0">{parent ? <button type="button" onClick={() => {setPicked(parent.path); setQuery(""); setCollapsed(new Set());}} className="max-w-full truncate font-mono underline-offset-4 hover:underline" title={parent.path}>{depotBase(parent.path)}</button> : <span className="truncate text-muted-foreground" title={selected.parent ?? ""}>{selected.parent?.startsWith("//") ? selected.parent : "—"}</span>}</dd>
            </dl>
            {childCount ? <p className="px-3 pb-3 text-[11px] text-muted-foreground">{t("p4.streamTree.children",{count:childCount})}</p> : null}
            <div className="flex flex-wrap gap-2 border-t px-3 py-3">
              <Button variant="outline" size="sm" disabled={blocked} onClick={() => setDefinition({mode:"edit", path:selected.path})}><PencilIcon />{t("p4.streamSpec.edit")}</Button>
              {operations?.merge ? <HoverTip label={t("p4.streamTree.merge")}><Button variant="outline" size="sm" disabled={blocked} onClick={() => p4.openStreamIntegration("merge", current!.parent!)}><GitMergeIcon />{t("p4.streamTree.mergeShort")}</Button></HoverTip> : null}
              {operations?.copy ? <HoverTip label={t("p4.streamTree.copy")}><Button variant="outline" size="sm" disabled={blocked} onClick={() => p4.openStreamIntegration("copy", selected.path)}><GitMergeIcon />{t("p4.streamTree.copyShort")}</Button></HoverTip> : null}
            </div>
            {selected.path === current?.path ? <button type="button" disabled={blocked} onClick={() => p4.setWorkspaceOpen(true)} className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-[11px] text-muted-foreground hover:bg-muted/50"><FolderPenIcon className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{t("p4.streamTree.workspace",{client:p4.connection?.client})}</span><ChevronRightIcon className="size-3 shrink-0" /></button> : null}
          </> : <p className="p-6 text-xs text-muted-foreground">{t("p4.streamTree.select")}</p>}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
    {privateOpen ? <P4StreamWorkDialog onClose={() => {setPrivateOpen(false); reload();}} /> : null}
    {definition ? <P4StreamSpecDialog key={JSON.stringify(definition)} target={definition} onClose={() => setDefinition(null)} onChanged={definitionChanged} /> : null}
  </div>;
}

function StreamKind({kind}: {kind: string}) {
  const { t } = useTranslation();
  const known = ["mainline","development","release","virtual","task","sparsedev","sparserel"].includes(kind);
  return <span className="inline-flex shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] leading-3 text-muted-foreground">{known ? t(`p4.streamTree.kinds.${kind}`) : kind}</span>;
}
