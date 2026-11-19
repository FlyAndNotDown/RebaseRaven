import { RestoreShelfDialog } from "./p4-restore-shelf-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestoreIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { CommitMessage } from "@/components/commit-message";
import { AuthorName } from "@/components/revision-meta";
import { ChangeBadge, ChangelistMarker } from "@/components/p4/change-badge";
import { P4Diff } from "@/components/p4/p4-diff";
import { P4FilterMenu, withCurrent } from "@/components/p4/p4-filter-menu";
import { P4StreamDiffDialog } from "@/components/p4/p4-stream-work";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { changeSummary, p4ActionStatus } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { FileDiff } from "@/types/git";
import type { P4ChangePage, P4Changelist } from "@/types/p4";
import type { P4StreamDiffRequest } from "@/types/p4-stream-specs";

export function P4Shelves() {
  const { connection } = useP4();
  return <ShelfBrowser key={JSON.stringify(connection)} />;
}

function ShelfBrowser() {
  const { t } = useTranslation();
  const { connection, listShelves, listUsers, listClients, shelfDetail, shelfDiff } = useP4();
  const [streamDiff, setStreamDiff] = useState<P4StreamDiffRequest | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [user, setUser] = useState("");
  const [client, setClient] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [clients, setClients] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<P4ChangePage | null>(null);
  const [detail, setDetail] = useState<P4Changelist | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<{ key: string; value: FileDiff | null }>({ key: "", value: null });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const filter = useRef({ user: "", client: "" });
  const loaded = useRef({ users: false, clientsFor: "" });
  const invalidateRequests = useCallback(() => { ++generation.current; ++detailGeneration.current; }, []);
  const detailId = detail?.id ?? "";
  const diffKey = detailId && file ? JSON.stringify([detailId, file]) : "";
  const diff = diffResult.key === diffKey ? diffResult.value : null;
  const needle = query.trim().replace(/^#(?=\d+$)/, "").toLowerCase();
  const changes = useMemo(() => (page?.changes ?? []).filter(entry => !needle || [entry.id, entry.description, entry.user, entry.client].some(value => value.toLowerCase().includes(needle))), [page, needle]);

  const load = useCallback(async (owner: string, workspace: string, before: number | null) => {
    const token = ++generation.current;
    if (!before) { ++detailGeneration.current; setDetail(null); setFile(null); setPage(null); setDetailLoading(false); setRestoring(false); }
    setLoading(true); setError(null);
    try {
      const next = await listShelves(owner, workspace, before);
      if (mounted.current && token === generation.current) {
        filter.current = { user: owner, client: workspace };
        setPage(old => before && old ? { ...next, changes: [...old.changes, ...next.changes.filter(item => !old.changes.some(previous => item.id === previous.id))] } : next);
      }
    } catch (caught) { if (mounted.current && token === generation.current) setError(p4DisplayError(caught)); }
    finally { if (mounted.current && token === generation.current) setLoading(false); }
  }, [listShelves]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => { if (live) void load(user, client, null); });
    return () => { live = false; invalidateRequests(); };
  }, [load, user, client, invalidateRequests]);

  async function select(id: string, direct = false) {
    const token = ++detailGeneration.current;
    if (direct) { ++generation.current; setLoading(false); }
    setDetailLoading(true); setError(null); setDetail(null); setFile(null);
    try {
      const next = await shelfDetail(id);
      if (!mounted.current || token !== detailGeneration.current) return;
      setDetail(next); setFile(next.files[0]?.depotPath ?? null);
      if (direct) setPage(old => ({ changes: [next, ...(old?.changes.filter(entry => entry.id !== next.id) ?? [])], hasMore: old?.hasMore ?? false, scannedThrough: old?.scannedThrough ?? null }));
    } catch (caught) { if (mounted.current && token === detailGeneration.current) setError(p4DisplayError(caught)); }
    finally { if (mounted.current && token === detailGeneration.current) setDetailLoading(false); }
  }

  useEffect(() => {
    if (!detailId || !file) return;
    let live = true;
    void shelfDiff(file, detailId).then(value => { if (live) setDiffResult({ key: diffKey, value }); })
      .catch((caught: unknown) => { if (live) { setError(p4DisplayError(caught)); setDiffResult({ key: diffKey, value: null }); } });
    return () => { live = false; };
  }, [file, detailId, diffKey, shelfDiff]);

  function ensureUsers() {
    if (loaded.current.users) return;
    loaded.current.users = true;
    void listUsers().then(value => { if (mounted.current) setUsers(value); }).catch(() => { loaded.current.users = false; });
  }

  function ensureClients() {
    if (!user || loaded.current.clientsFor === user) return;
    loaded.current.clientsFor = user;
    void listClients(user).then(value => { if (mounted.current && loaded.current.clientsFor === user) setClients(value); })
      .catch(() => { if (loaded.current.clientsFor === user) { loaded.current.clientsFor = ""; setClients([]); } });
  }

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 flex-1">
      <ResizablePanel id="p4-shelves-list" defaultSize="40%" minSize="28%" maxSize="56%">
        <div className="absolute inset-0 flex min-h-0 flex-col">
          <form className="grid shrink-0 gap-1.5 border-b p-2" onSubmit={event => { event.preventDefault(); if (/^#?[1-9]\d*$/.test(query.trim())) void select(query.trim().replace(/^#/, ""), true); }}>
            <div className="grid grid-cols-2 gap-1.5">
              <P4FilterMenu label={t("p4.user")} value={user} emptyLabel={t("p4.allUsers")} pinned={connection?.user ? { label: t("p4.me"), value: connection.user } : undefined} options={withCurrent(users, user || connection?.user || "")} onOpen={ensureUsers} onChange={value => {setUser(value); setClient(""); setClients([]); loaded.current.clientsFor = "";}} />
              <P4FilterMenu label={t("p4.workspace")} value={client} emptyLabel={t("p4.allWorkspaces")} options={withCurrent(clients, client || connection?.client || "")} onOpen={ensureClients} onChange={setClient} />
            </div>
            <div className="flex min-w-0 gap-1"><Input aria-label={t("p4.filterChangelists")} placeholder={t("p4.filterChangelists")} value={query} onChange={event => setQuery(event.target.value)} className="h-8 min-w-0 flex-1" /><HoverTip label={t("p4.refresh")}><Button type="button" size="icon-sm" variant="ghost" aria-label={t("p4.refresh")} disabled={loading} onClick={() => void load(user, client, null)}><RefreshCwIcon /></Button></HoverTip></div>
          </form>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {changes.map(entry => <button key={entry.id} type="button" aria-pressed={detail?.id === entry.id} onClick={() => void select(entry.id)} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted/70", detail?.id === entry.id && "bg-muted")}>
              <ChangelistMarker opened={false} /><ChangeBadge id={entry.id} /><span className="min-w-0 flex-1 truncate text-xs" title={entry.description}>{changeSummary(entry.description)}</span><AuthorName name={entry.user} vcs="perforce" className="w-20" />
            </button>)}
            {loading ? <p role="status" className="p-5 text-center text-xs text-muted-foreground">{t("p4.shelves.loading")}</p> : !changes.length ? <p role="status" className="p-5 text-center text-xs text-muted-foreground">{t("p4.shelves.empty")}</p> : null}
            {page?.hasMore ? <Button variant="ghost" size="sm" className="w-full" disabled={loading} onClick={() => void load(filter.current.user, filter.current.client, page.scannedThrough)}>{t("p4.shelves.more")}</Button> : null}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-shelves-detail" defaultSize="60%" minSize="35%">
        <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
          {detailLoading ? <p role="status" className="p-6 text-sm text-muted-foreground">{t("p4.shelves.loading")}</p> : detail ? <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel id="p4-shelf-files" defaultSize="32%" minSize="16%">
              <div className="absolute inset-0 flex min-h-0 flex-col">
                <div className="shrink-0 space-y-2 border-b px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2"><ChangelistMarker opened={false} /><ChangeBadge id={detail.id} /><AuthorName name={detail.user} vcs="perforce" className="w-auto max-w-[35%]" /><span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={detail.client}>{detail.client}</span><Button size="sm" variant="outline" disabled={!detail.files.length} onClick={() => setRestoring(true)}><ArchiveRestoreIcon />{t("p4.shelves.restoreAction")}</Button></div>
                  <CommitMessage key={detail.id} message={detail.description} className="px-0 py-0" />
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {detail.shelvedStream ? <button type="button" className="flex h-8 w-full items-center gap-2 border-b px-3 text-left text-xs hover:bg-muted/50" onClick={() => setStreamDiff({kind:"shelf", path:detail.shelvedStream!.path, change:detail.id})}><GitBranchIcon className="size-3.5 text-muted-foreground" />{t("p4.streamWork.shelved")}</button> : null}
                  {detail.files.map(entry => <button key={entry.depotPath} type="button" onClick={() => setFile(entry.depotPath)} className={cn("flex h-7 w-full items-center gap-2 px-3 text-left text-xs hover:bg-muted/50", file === entry.depotPath && "bg-muted/60")}><FileStatusIcon status={p4ActionStatus(entry.action)} /><span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={entry.depotPath}>{entry.depotPath}</span></button>)}
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="p4-shelf-diff" defaultSize="68%" minSize="24%">
              <P4Diff fileSource={file ? {kind:"shelf",path:file,changeId:detail.id} : undefined} diff={diff} loading={Boolean(diffKey && diffResult.key !== diffKey)} empty={t("p4.noTextDifferences")} />
            </ResizablePanel>
          </ResizablePanelGroup> : <p className="p-8 text-center text-sm text-muted-foreground">{t("p4.shelves.select")}</p>}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
    {error ? <p role="alert" className="max-h-20 shrink-0 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-xs text-destructive">{error}</p> : null}
    {detail && restoring ? <RestoreShelfDialog detail={detail} onClose={() => setRestoring(false)} /> : null}
    {streamDiff ? <P4StreamDiffDialog target={streamDiff} onClose={() => setStreamDiff(null)} /> : null}
  </div>;
}
