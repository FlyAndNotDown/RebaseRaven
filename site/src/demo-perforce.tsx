import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, ChevronDownIcon, CircleDotIcon, EllipsisIcon, FolderTreeIcon, HistoryIcon, PencilIcon, SendIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { ChangeBadge, ChangelistMarker } from "@/components/p4/change-badge";
import { P4ChangeDialog, type ChangeDialogRequest } from "@/components/p4/p4-change-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HoverTip } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { demoFiles, p4Changes } from "./demo-data";
import { FilesDemo } from "./demo-git";
import { DemoSplit, DemoToolbar } from "./demo-chrome";
import { DemoFileRow, DiffPane, EmptyPane, PaneHeader } from "./demo-shared";

type P4View = "pending" | "history" | "shelves" | "workspace";
const views = [
  { value: "pending", label: "demo.pending", icon: CircleDotIcon },
  { value: "history", label: "demo.history", icon: HistoryIcon },
  { value: "shelves", label: "demo.teamShelves", icon: ArchiveRestoreIcon },
  { value: "workspace", label: "demo.workspace", icon: FolderTreeIcon },
] as const;

export function PerforceDemo({ onNotice }: { onNotice: (notice: string) => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<P4View>("pending");
  const pendingButton = useRef<HTMLButtonElement | null>(null);
  const actionsButton = useRef<HTMLButtonElement | null>(null);
  const dialogReturn = useRef<HTMLButtonElement | null>(null);
  const [fileId, setFileId] = useState("navigation");
  const [shelf, setShelf] = useState(false);
  const [hasShelf, setHasShelf] = useState(false);
  const [changeOpen, setChangeOpen] = useState(true);
  const [shelfOpen, setShelfOpen] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [description, setDescription] = useState("fix: wrap workspace navigation");
  const [dialog, setDialog] = useState<ChangeDialogRequest | null>(null);
  const [deleteShelfOpen, setDeleteShelfOpen] = useState(false);
  const [historyId, setHistoryId] = useState("41");
  const [query, setQuery] = useState("");
  const [historyFileId, setHistoryFileId] = useState("navigation");
  const [teamShelfId, setTeamShelfId] = useState("41");
  const [teamFileId, setTeamFileId] = useState("theme");
  const files = demoFiles.slice(0, 2);
  const file = files.find(item => item.id === fileId) ?? files[0];
  const history = submitted ? [{ id: "42", summary: description, fileId: "navigation", time: "demo.justNow" }, ...p4Changes] : p4Changes;
  const filtered = history.filter(change => `${change.id} ${change.summary}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = filtered.find(change => change.id === historyId) ?? filtered[0];
  const historyFiles = selected?.id === "42" ? files : demoFiles.filter(item => item.id === selected?.fileId);
  const historyFile = historyFiles.find(item => item.id === historyFileId) ?? historyFiles[0];

  const teamShelves = [...(hasShelf ? [{ id: "42", summary: description, files }] : []), { id: "41", summary: "feat: follow system appearance", files: [demoFiles[1]] }];
  const teamShelf = teamShelves.find(item => item.id === teamShelfId) ?? teamShelves[0];
  const teamFile = teamShelf.files.find(item => item.id === teamFileId) ?? teamShelf.files[0];

  function shelve() {
    setHasShelf(true); setShelfOpen(true); setChangeOpen(true);
    onNotice(t(hasShelf ? "demo.shelfUpdated" : "demo.shelvedNotice"));
  }
  function request(mode: "edit" | "submit") { dialogReturn.current = actionsButton.current; setDialog({ id: "42", description, mode }); }
  const actions = <>
    <ContextMenuItem onSelect={() => request("submit")}><SendIcon />{t("p4.submitChangelist")}</ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem onSelect={shelve}><ArchiveIcon />{t(hasShelf ? "demo.updateShelf" : "demo.shelve")}</ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem onSelect={() => request("edit")}><PencilIcon />{t("p4.changeDialog.editTitle")}</ContextMenuItem>
  </>;
  return <>
    <DemoToolbar perforce onRefresh={() => onNotice(t("demo.refreshedNotice"))} />
    <Tabs orientation="vertical" value={view} onValueChange={value => setView(value as P4View)} className="demo-view-tabs">
      <div className="demo-sidebar"><TabsList aria-label={t("demo.p4Views")}>{views.map(({ value, label, icon: Icon }) => <HoverTip key={value} label={t(label)} side="right"><TabsTrigger ref={value === "pending" ? pendingButton : undefined} value={value} aria-label={t(label)}><Icon /></TabsTrigger></HoverTip>)}</TabsList><HoverTip label={t("demo.desktopOnly")}><span className="demo-settings" tabIndex={0}><Button variant="ghost" size="icon" disabled aria-label={t("demo.repositorySettings")}><SettingsIcon /></Button></span></HoverTip></div>
      <TabsContent forceMount hidden={view !== "pending"} value="pending" className="demo-view-panel">
        <DemoSplit perforce left={<div className="demo-file-pane"><PaneHeader>{t("demo.pending")}</PaneHeader><ScrollArea className="demo-file-scroll" gutter={false}>
          <div className="demo-p4-default"><ChevronDownIcon className="-rotate-90" /><ChangelistMarker opened={false} /><ChangeBadge id="default" /><span>{t("demo.noDescription")}</span></div>
          {!submitted ? <>
            <ContextMenu><ContextMenuTrigger asChild><div className="demo-changelist-title">
              <button type="button" className="demo-change-disclosure" aria-label={t("demo.toggleChangelist")} aria-expanded={changeOpen} onClick={() => setChangeOpen(!changeOpen)}><ChevronDownIcon className={changeOpen ? undefined : "-rotate-90"} /></button>
              <button type="button" className="demo-changelist-select" onClick={() => { setChangeOpen(true); setShelf(false); setFileId(files[0].id); }}><ChangelistMarker opened shelved={hasShelf} /><ChangeBadge id="42" /><span>{description}</span></button>
              <DropdownMenu><HoverTip label={t("demo.changeActions")}><DropdownMenuTrigger asChild><Button ref={actionsButton} size="icon-xs" variant="ghost" aria-label={t("demo.changeActions")}><EllipsisIcon /></Button></DropdownMenuTrigger></HoverTip><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => request("submit")}><SendIcon />{t("p4.submitChangelist")}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={shelve}><ArchiveIcon />{t(hasShelf ? "demo.updateShelf" : "demo.shelve")}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => request("edit")}><PencilIcon />{t("p4.changeDialog.editTitle")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            </div></ContextMenuTrigger><ContextMenuContent>{actions}</ContextMenuContent></ContextMenu>
            <div hidden={!changeOpen}><section className="demo-p4-file-group" aria-label={t("demo.openedFiles")}>{files.map(item => <DemoFileRow key={item.id} file={item} perforce active={fileId === item.id && !shelf} onSelect={() => { setFileId(item.id); setShelf(false); }} />)}</section>
              <div className="demo-shelf-group-heading"><button type="button" onClick={() => setShelfOpen(!shelfOpen)} aria-expanded={shelfOpen}><ChevronDownIcon className={shelfOpen ? undefined : "-rotate-90"} />{t("demo.shelved")}<span>{hasShelf ? files.length : 0}</span></button>{hasShelf ? <HoverTip label={t("p4.deleteShelf")}><Button variant="ghost" size="icon-xs" aria-label={t("p4.deleteShelf")} onClick={() => setDeleteShelfOpen(true)}><Trash2Icon /></Button></HoverTip> : null}</div>
              {hasShelf && shelfOpen ? <section className="demo-p4-file-group demo-p4-shelf-files" aria-label={t("demo.shelvedFiles")}>{files.map(item => <DemoFileRow key={item.id} file={item} perforce active={fileId === item.id && shelf} onSelect={() => { setFileId(item.id); setShelf(true); }} />)}</section> : null}
            </div>
          </> : <p className="demo-group-empty">{t("demo.noPending")}</p>}
        </ScrollArea></div>} right={submitted ? <EmptyPane title={t("demo.noPending")} detail={t("demo.changeInHistory")}><Button size="sm" variant="outline" onClick={() => setView("history")}>{t("demo.viewChangelist")}</Button></EmptyPane> : <DiffPane file={{ ...file, path: `//depot/main/${file.path}` }} scopeLabel={shelf ? t("demo.shelvedVersion") : undefined} />} />
      </TabsContent>
      <TabsContent forceMount hidden={view !== "history"} value="history" className="demo-view-panel"><DemoSplit perforce left={<div className="demo-file-pane"><PaneHeader>{t("demo.history")}</PaneHeader><div className="demo-p4-filter"><Input aria-label={t("demo.filterChangesLabel")} placeholder={t("demo.filterChanges")} value={query} onChange={event => setQuery(event.target.value)} /></div><ScrollArea className="demo-file-scroll" gutter={false}>{filtered.map(change => <button type="button" key={change.id} className={cn("demo-change-row", selected?.id === change.id && "selected")} aria-pressed={selected?.id === change.id} onClick={() => setHistoryId(change.id)}><ChangeBadge id={change.id} /><strong>{change.summary}</strong><span>Alice · studio-main · {t(change.time)}</span></button>)}{!filtered.length ? <p className="demo-no-results">{t("demo.noChangelists")}</p> : null}</ScrollArea></div>} right={selected && historyFile ? <div className="demo-p4-history-detail"><div className="demo-p4-history-files"><PaneHeader><ChangeBadge id={selected.id} /><span>{selected.summary}</span></PaneHeader>{historyFiles.map(item => <DemoFileRow key={item.id} file={item} perforce active={historyFile.id === item.id} onSelect={() => setHistoryFileId(item.id)} />)}</div><DiffPane file={historyFile} /></div> : <EmptyPane title={t("demo.noChangelists")} />} /></TabsContent>
      <TabsContent forceMount hidden={view !== "shelves"} value="shelves" className="demo-view-panel"><DemoSplit perforce left={<div className="demo-file-pane"><PaneHeader>{t("demo.teamShelves")}</PaneHeader>{teamShelves.map(item => <button type="button" className={cn("demo-change-row", teamShelf.id === item.id && "selected")} aria-pressed={teamShelf.id === item.id} key={item.id} onClick={() => setTeamShelfId(item.id)}><ChangeBadge id={item.id} /><strong>{item.summary}</strong><span>Alice · studio-main · {t("demo.time.oneHour")}</span></button>)}</div>} right={<div className="demo-p4-history-detail"><div className="demo-p4-history-files"><PaneHeader><ChangeBadge id={teamShelf.id} /><span>{t("demo.shelvedFiles")}</span></PaneHeader>{teamShelf.files.map(item => <DemoFileRow key={item.id} file={item} perforce active={teamFile.id === item.id} onSelect={() => setTeamFileId(item.id)} />)}</div><DiffPane file={teamFile} scopeLabel={t("demo.shelvedVersion")} /></div>} /></TabsContent>
      <TabsContent forceMount hidden={view !== "workspace"} value="workspace" className="demo-view-panel"><FilesDemo perforce /></TabsContent>
    </Tabs>
    {dialog ? <P4ChangeDialog key={dialog.mode} request={dialog} openedCount={files.length} shelved={hasShelf} available busy={false} onManageShelf={() => setDeleteShelfOpen(true)} onClose={() => setDialog(null)} onCloseAutoFocus={event => { event.preventDefault(); dialogReturn.current?.focus({ preventScroll: true }); }} onConfirm={async next => { setDescription(next.trim()); if (dialog.mode === "submit") { dialogReturn.current = pendingButton.current; setSubmitted(true); setHistoryId("42"); onNotice(t("demo.submittedNotice")); } return true; }} /> : null}
    <Dialog open={deleteShelfOpen} onOpenChange={setDeleteShelfOpen}><DialogContent><DialogHeader><DialogTitle>{t("p4.deleteShelf")}</DialogTitle><DialogDescription>{t("demo.deleteShelfBody")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleteShelfOpen(false)}>{t("demo.cancel")}</Button><Button variant="destructive" onClick={() => { setHasShelf(false); setShelf(false); setDeleteShelfOpen(false); onNotice(t("demo.shelfDeletedNotice")); }}>{t("p4.deleteShelf")}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
