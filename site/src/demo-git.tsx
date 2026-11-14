import { ChoiceSelect } from "@/components/ui/choice-select";
import { useTranslation } from "react-i18next";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArchiveIcon, ArrowUpFromLineIcon, ChevronDownIcon, CircleDotIcon, FolderTreeIcon, GitBranchIcon, HistoryIcon, ListIcon, SearchIcon, SettingsIcon, TagIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { HoverTip } from "@/components/ui/tooltip";
import { SyntaxText } from "@/components/syntax-text";
import { cn } from "@/lib/utils";
import { laneColor, type GraphRow } from "@/lib/commit-graph";
import { demoCommits, demoFiles, type DemoCommit, type DemoFile } from "./demo-data";
import { DemoFileRow, DiffPane, EmptyPane, PaneHeader } from "./demo-shared";
import { DemoSplit, DemoToolbar } from "./demo-chrome";
import { commitDemoChanges, fileChangeIds, fileHasChanges, moveDemoChanges, pickedDemoChanges, projectDemoDiff, scopedDemoDiff, type DemoChanges } from "./demo-model";
import { reconcileDemoSelection } from "./demo-selection";
import { DEMO_GRAPH_ROW_HEIGHT, demoGraphPath, demoGraphSegments, demoGraphWidth, demoGraphX, layoutDemoHistoryGraph } from "./demo-history-graph";

type GitView = "changes" | "history" | "stash" | "files";
const views = [
  { value: "changes", label: "demo.changes", icon: CircleDotIcon },
  { value: "history", label: "demo.history", icon: HistoryIcon },
  { value: "stash", label: "demo.stash", icon: ArchiveIcon },
  { value: "files", label: "demo.files", icon: FolderTreeIcon },
] as const;

function initialChanges(): DemoChanges {
  return {
    remaining: new Set(demoFiles.filter(file => file.id !== "readme").flatMap(fileChangeIds)),
    staged: new Set(fileChangeIds(demoFiles[1])), committed: new Set(),
  };
}

export function GitDemo({ onNotice }: { onNotice: (notice: string) => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<GitView>("changes");
  const [changes, setChanges] = useState(initialChanges);
  const [fileId, setFileId] = useState("navigation");
  const [scope, setScope] = useState<"unstaged" | "staged">("unstaged");
  const [closed, setClosed] = useState(false);
  const [tree, setTree] = useState(false);
  const [openGroups, setOpenGroups] = useState({ unstaged: true, staged: true });
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [commits, setCommits] = useState(demoCommits);
  const [historyHash, setHistoryHash] = useState(demoCommits[0].hash);
  const [stashApplied, setStashApplied] = useState(false);
  const commitSequence = useRef(0);
  const selectedFileButton = useRef<HTMLButtonElement | null>(null);
  const commitInput = useRef<HTMLTextAreaElement | null>(null);
  const pendingFileFocus = useRef(false);
  useLayoutEffect(() => {
    if (!pendingFileFocus.current) return;
    pendingFileFocus.current = false;
    selectedFileButton.current?.focus({ preventScroll: true });
  });
  const selection = reconcileDemoSelection(demoFiles, changes.remaining, changes.staged, { fileId, scope });
  const currentScope = selection?.scope ?? scope;
  const file = demoFiles.find(item => item.id === selection?.fileId);
  const projection = useMemo(() => file ? scopedDemoDiff(file, changes, currentScope === "staged") : undefined, [file, changes, currentScope]);
  const changed = demoFiles.filter(item => fileChangeIds(item).some(id => changes.remaining.has(id)));
  const stagedFiles = changed.filter(item => fileHasChanges(item, changes, true));
  const unstagedFiles = changed.filter(item => fileHasChanges(item, changes, false));
  const canCommit = Boolean(message.trim()) && (amend || changes.staged.size > 0);

  function selectFile(next: DemoFile, nextScope: "unstaged" | "staged") {
    setClosed(false); setFileId(next.id); setScope(nextScope);
  }
  function move(ids: string[], action: "stage" | "unstage" | "discard") {
    pendingFileFocus.current = true;
    setChanges(current => moveDemoChanges(current, ids, action));
    setOpenGroups(current => ({ ...current, staged: true, unstaged: true }));
    onNotice(t(action === "stage" ? "demo.stagedNotice" : action === "unstage" ? "demo.unstagedNotice" : "demo.discardedNotice"));
  }
  function commit() {
    if (!canCommit) return;
    const previous = commits[0];
    const ids = [...new Set([...(amend ? previous.changeIds ?? demoFiles.filter(item => previous.fileIds.includes(item.id)).flatMap(fileChangeIds) : []), ...changes.staged])];
    const next: DemoCommit = {
      hash: (0xd31a720 + commitSequence.current++).toString(16),
      parents: amend ? previous.parents : [previous.hash], summary: message.trim(), ref: "main", time: "demo.justNow",
      fileIds: [...new Set([...(amend ? previous.fileIds : []), ...stagedFiles.map(item => item.id)])],
      changeIds: ids, baseChangeIds: amend ? previous.baseChangeIds : [...changes.committed],
    };
    setCommits(current => [next, ...(amend ? current.slice(1) : current).map(item => ({ ...item, ref: item.ref === "main" ? undefined : item.ref }))]);
    setChanges(commitDemoChanges); setHistoryHash(next.hash); setMessage(""); setAmend(false);
    onNotice(t("demo.commitNotice"));
    commitInput.current?.focus({ preventScroll: true });
  }
  const stash = demoFiles.find(item => item.id === "readme")!;
  return <>
    <DemoToolbar ahead={commits.length - demoCommits.length} onRefresh={() => onNotice(t("demo.refreshedNotice"))} />
    <Tabs orientation="vertical" value={view} onValueChange={value => setView(value as GitView)} className="demo-view-tabs">
      <div className="demo-sidebar">
        <TabsList aria-label={t("demo.gitViews")}>{views.map(({ value, label, icon: Icon }) => <HoverTip key={value} label={t(label)} side="right"><TabsTrigger value={value} aria-label={t(label)}><Icon /></TabsTrigger></HoverTip>)}</TabsList>
        <HoverTip label={t("demo.desktopOnly")}><span className="demo-settings" tabIndex={0}><Button variant="ghost" size="icon" disabled aria-label={t("demo.repositorySettings")}><SettingsIcon /></Button></span></HoverTip>
      </div>
      <TabsContent forceMount hidden={view !== "changes"} value="changes" className="demo-view-panel">
        <DemoSplit left={<div className="demo-file-pane">
          <PaneHeader><span className="demo-muted">{t("demo.changedFiles", { count: changed.length })}</span><SegmentedControl label={t("demo.fileLayout")} dense value={tree ? "tree" : "list"} onChange={value => setTree(value === "tree")} options={[{ value: "list", label: <ListIcon />, tip: t("demo.list") }, { value: "tree", label: <FolderTreeIcon />, tip: t("demo.tree") }]} /></PaneHeader>
          <ScrollArea className="demo-file-scroll" gutter={false}>
            {([['unstaged', unstagedFiles], ['staged', stagedFiles]] as const).map(([group, items]) => <section className="demo-file-group" key={group} aria-label={t(group === "staged" ? "demo.stagedFiles" : "demo.unstagedFiles")}>
              <div className="demo-file-group-heading"><h4><button type="button" onClick={() => setOpenGroups(current => ({ ...current, [group]: !current[group] }))} aria-expanded={openGroups[group]} aria-controls={`demo-git-${group}`}><ChevronDownIcon className={openGroups[group] ? undefined : "-rotate-90"} /><span>{t(group === "staged" ? "demo.staged" : "demo.changes")}</span><span>{items.length}</span></button></h4>
                {items.length ? <Button size="xs" variant="ghost" onClick={() => move(items.flatMap(fileChangeIds), group === "staged" ? "unstage" : "stage")}>{t(group === "staged" ? "demo.unstageAll" : "demo.stageAll")}</Button> : null}
              </div>
              <div id={`demo-git-${group}`} hidden={!openGroups[group]} className={tree ? "demo-file-tree" : undefined}>

                {items.map((item, index) => <div key={item.id}>{tree && (index === 0 || items[index - 1].path.split("/").slice(0, -1).join("/") !== item.path.split("/").slice(0, -1).join("/")) ? <div className="demo-tree-folder"><ChevronDownIcon /><FolderTreeIcon />{item.path.split("/").slice(0, -1).join("/")}</div> : null}<DemoFileRow file={item} selectRef={!closed && file?.id === item.id && currentScope === group ? selectedFileButton : undefined} directory={!tree} active={!closed && file?.id === item.id && currentScope === group} onSelect={() => selectFile(item, group)} action={group === "staged" ? "unstage" : "stage"} actionLabel={t(group === "staged" ? "demo.unstageFile" : "demo.stageFile", { path: item.path })} onAction={() => { setClosed(false); setFileId(item.id); move(fileChangeIds(item), group === "staged" ? "unstage" : "stage"); }} /></div>)}
                {!items.length ? <p className="demo-group-empty">{t(group === "staged" ? "demo.noStagedFiles" : "demo.noUnstaged")}</p> : null}
              </div>
            </section>)}
          </ScrollArea>
          <form className="demo-compose" onSubmit={event => { event.preventDefault(); commit(); }}>
            <label className="sr-only" htmlFor="demo-commit-message">{t("demo.message")}</label>
            <Textarea ref={commitInput} id="demo-commit-message" value={message} maxLength={500} onChange={event => setMessage(event.target.value)} placeholder={t("demo.messagePlaceholder")} className="min-h-20 resize-none" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); commit(); } }} />
            <div><Button size="sm" variant="ghost" disabled={!unstagedFiles.length} onClick={() => setDiscardOpen(true)}><Undo2Icon />{t("demo.discardAll")}</Button>
              <div className="demo-commit-buttons"><Button type="submit" disabled={!canCommit}>{t(amend ? "demo.amend" : "demo.commit")}</Button><DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={t("demo.commitOptions")}><ChevronDownIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled><ArrowUpFromLineIcon />{t("demo.commitAndPush")}</DropdownMenuItem><DropdownMenuCheckboxItem checked={amend} onCheckedChange={checked => { setAmend(checked === true); setMessage(checked ? commits[0].summary : ""); }}>{t("demo.amendLast")}</DropdownMenuCheckboxItem></DropdownMenuContent></DropdownMenu></div>
            </div>
          </form>
        </div>} right={!closed && file && projection ? <DiffPane file={file} projection={projection} staged={currentScope === "staged"} scopeLabel={t(currentScope === "staged" ? "demo.staged" : "demo.workingChanges")} onClose={() => setClosed(true)} onApply={async (action, refs) => { move(pickedDemoChanges(projection, refs), action); return true; }} /> : <EmptyPane title={t(closed ? "demo.chooseFile" : "demo.clean")} />} />
      </TabsContent>
      <TabsContent forceMount hidden={view !== "history"} value="history" className="demo-view-panel"><GitHistory commits={commits} selectedHash={historyHash} onSelect={setHistoryHash} /></TabsContent>
      <TabsContent forceMount hidden={view !== "stash"} value="stash" className="demo-view-panel"><DemoSplit left={<div className="demo-file-pane"><PaneHeader>{t("demo.stash")}</PaneHeader>{stashApplied ? <EmptyPane title={t("demo.stashApplied")} /> : <div className="demo-stash-summary"><ArchiveIcon /><strong>{t("demo.sampleStash")}</strong><span>{t("demo.stashTime")}</span><Button size="sm" variant="outline" onClick={() => { setChanges(current => ({ ...current, remaining: new Set([...current.remaining, ...fileChangeIds(stash)]) })); setStashApplied(true); selectFile(stash, "unstaged"); setView("changes"); onNotice(t("demo.stashNotice")); }}>{t("demo.applyStash")}</Button></div>}</div>} right={<DiffPane file={stash} />} /></TabsContent>
      <TabsContent forceMount hidden={view !== "files"} value="files" className="demo-view-panel"><FilesDemo /></TabsContent>
    </Tabs>
    <Dialog open={discardOpen} onOpenChange={setDiscardOpen}><DialogContent><DialogHeader><DialogTitle>{t("demo.discardAllTitle")}</DialogTitle><DialogDescription>{t("demo.discardAllBody")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscardOpen(false)}>{t("demo.cancel")}</Button><Button variant="destructive" onClick={() => { move(unstagedFiles.flatMap(item => fileChangeIds(item).filter(id => !changes.staged.has(id))), "discard"); setDiscardOpen(false); }}>{t("demo.discardAll")}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}

function GitHistory({ commits, selectedHash, onSelect }: { commits: DemoCommit[]; selectedHash: string; onSelect: (hash: string) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [pickedFile, setPickedFile] = useState("navigation");
  const [branch, setBranch] = useState("main");
  const [branchQuery, setBranchQuery] = useState("");
  const reachable = new Set<string>();
  const tip = branch === "v1.0.0" ? commits.at(-1)?.hash : commits.find(item => item.ref === (branch === "origin/main" ? "main" : branch))?.hash;
  const visit = (hash: string) => {
    if (reachable.has(hash)) return;
    reachable.add(hash);
    commits.find(item => item.hash === hash)?.parents.forEach(visit);
  };
  if (tip) visit(tip);
  const branchVisible = (label: string) => label.toLowerCase().includes(branchQuery.trim().toLowerCase());
  const branchButton = (label: string, tag = false) => branchVisible(label) ? <button type="button" className={branch === label ? "selected" : undefined} aria-pressed={branch === label} onClick={() => setBranch(label)}>{tag ? <TagIcon /> : <GitBranchIcon />}<span>{label}</span>{label === "main" ? <small>HEAD</small> : null}</button> : null;
  const filtered = commits.filter(commit => reachable.has(commit.hash)).filter((commit) => `${commit.summary} ${commit.hash} ${commit.ref ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const graph = layoutDemoHistoryGraph(filtered);
  const graphWidth = demoGraphWidth(graph);
  const selected = filtered.find((commit) => commit.hash === selectedHash) ?? filtered[0];
  const files = demoFiles.filter((file) => selected?.fileIds.includes(file.id));
  const file = files.find((item) => item.id === pickedFile) ?? files[0];
  return (
    <div className="demo-history">
      <aside className="demo-branches" aria-label={t("demo.branches")}><PaneHeader><Input aria-label={t("demo.filterBranches")} placeholder={t("demo.filterBranches")} value={branchQuery} onChange={event => setBranchQuery(event.target.value)} /></PaneHeader><p>{t("demo.local")}</p>{branchButton("main")}{branchButton("feature/search")}<p>{t("demo.remotes")}</p><div><ChevronDownIcon />origin</div>{branchButton("origin/main")}<p>{t("demo.tags")}</p>{branchButton("v1.0.0", true)}</aside>
      <div className="demo-history-main">
        <PaneHeader><div className="demo-history-search"><SearchIcon aria-hidden="true" /><Input aria-label={t("demo.filterCommitsLabel")} placeholder={t("demo.filterCommits")} value={query} onChange={(event) => setQuery(event.target.value)} className="demo-history-filter" /></div></PaneHeader>
        <ScrollArea className="demo-history-list" gutter={false}>
          {filtered.map((commit, index) => <button type="button" key={commit.hash} className={cn("demo-commit-row", selected?.hash === commit.hash && "selected")} aria-pressed={selected?.hash === commit.hash} onClick={() => onSelect(commit.hash)}><DemoHistoryGraph row={graph[index]} previous={graph[index - 1]} width={graphWidth} selected={selected?.hash === commit.hash} /><span className="demo-commit-summary">{commit.ref ? <span className={cn("demo-ref", commit.ref === "main" && "demo-ref-head")}>{commit.ref}</span> : null}{commit.summary}</span><code>{commit.hash}</code><time>{t(commit.time)}</time></button>)}
          {!filtered.length ? <p className="demo-no-results">{t("demo.noCommits")}</p> : null}
        </ScrollArea>
        {selected && file ? <div className="demo-history-detail"><div className="demo-history-files"><PaneHeader>{t("demo.changedFilesLabel")} <span>{files.length}</span></PaneHeader>{files.map((item) => <DemoFileRow key={item.id} file={item} active={file.id === item.id} onSelect={() => setPickedFile(item.id)} />)}<div className="demo-commit-meta"><strong>{selected.summary}</strong><span>{selected.hash} · Alice · {t(selected.time)}</span></div></div><div className="demo-history-diff"><div className="demo-mobile-file-picker"><label htmlFor="demo-history-file">{t("demo.changedFile")}</label><ChoiceSelect id="demo-history-file" value={file.id} onValueChange={setPickedFile} options={files.map(item => ({value:item.id,label:item.path}))} /></div><DiffPane file={file} projection={projectDemoDiff(file, new Set(selected.baseChangeIds ?? []), new Set([...(selected.baseChangeIds ?? []), ...(selected.changeIds ?? fileChangeIds(file))]))} /></div></div> : <EmptyPane title={t("demo.noCommits")} detail={t("demo.tryCommit")} />}
      </div>
    </div>
  );
}

function DemoHistoryGraph({ row, previous, width, selected }: { row: GraphRow; previous?: GraphRow; width: number; selected: boolean }) {
  const color = laneColor(row.lane);
  return (
    <span className="demo-history-graph" style={{ width }} aria-hidden="true">
      <svg width={width} height="100%" viewBox={`0 0 ${width} ${DEMO_GRAPH_ROW_HEIGHT}`} preserveAspectRatio="none">
        {demoGraphSegments(row, previous).map((segment, index) => <path key={index} d={demoGraphPath(segment)} fill="none" stroke={laneColor(segment.color)} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
        <circle cx={demoGraphX(row.lane)} cy={DEMO_GRAPH_ROW_HEIGHT / 2} r="3" fill={selected ? color : "var(--background)"} stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

export function FilesDemo({ perforce = false }: { perforce?: boolean }) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState("navigation");
  const file = demoFiles.find((item) => item.id === fileId) ?? demoFiles[0];
  return <div className="demo-split"><div className="demo-file-pane"><PaneHeader>{perforce ? t("demo.workspace") : t("demo.files")}</PaneHeader><div className="demo-tree-folder"><ChevronDownIcon /><FolderTreeIcon />{perforce ? "//depot/main/src" : "src"}</div>{demoFiles.map((item) => <DemoFileRow key={item.id} file={item} directory={false} perforce={perforce} active={file.id === item.id} onSelect={() => setFileId(item.id)} />)}</div><section className="demo-diff"><PaneHeader><span className="demo-path">{file.path}</span><span className="demo-language">TypeScript</span></PaneHeader><ScrollArea className="demo-code-scroll" gutter={false} viewportClassName="demo-code-viewport focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" viewportProps={{ role: "region", "aria-label": t("demo.contents", { path: file.path }), tabIndex: 0 }}><div className="demo-code">{file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.after !== undefined).map((line, index) => <div className="demo-code-row" key={index}><span className="demo-line-number">{line.newNumber}</span><code><SyntaxText path={file.path} text={line.after ?? ""} /></code></div>)}</div></ScrollArea></section></div>;
}
