import { useEffect, useState } from "react";
import { ClipboardListIcon, LoaderCircleIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HoverTip } from "@/components/ui/tooltip";
import { P4JobDialog } from "@/components/p4/p4-job-dialog";
import { P4JobFixes } from "@/components/p4/p4-job-fixes";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { cn } from "@/lib/utils";
import { useP4 } from "@/state/p4-context";
import type { P4Job, P4JobPage } from "@/types/p4-jobs";

export function P4Jobs() {
  const { t } = useTranslation();
  const { jobs, busy } = useP4();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<{ key: string; value: P4JobPage } | null>(null);
  const [error, setError] = useState<{ key: string; value: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const key = JSON.stringify([query, attempt]);
  const items = page?.key === key ? page.value.items : null;
  const shownError = error?.key === key ? error.value : null;
  const reload = () => setAttempt(value => value + 1);
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void jobs.list(query).then(value => {if (live) setPage({ key, value });})
        .catch((caught: unknown) => {if (live) setError({ key, value: p4DisplayError(errorMessage(caught)) });});
    }, 200);
    return () => {live = false; window.clearTimeout(timer);};
  }, [jobs, query, key]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
      <h1 className="mr-2 flex items-center gap-2 text-xs font-medium"><ClipboardListIcon className="size-3.5 text-muted-foreground" />{t("p4.jobs.title")}</h1>
      <HoverTip label={t("p4.jobs.filterHint")}><Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t("p4.jobs.filter")} placeholder={t("p4.jobs.filter")} className="h-7 max-w-72 font-mono text-xs" /></HoverTip>
      <div className="ml-auto flex gap-1"><HoverTip label={t("p4.refresh")}><Button variant="ghost" size="icon-xs" aria-label={t("p4.refresh")} disabled={busy} onClick={reload}><RefreshCwIcon /></Button></HoverTip><Button variant="outline" size="sm" disabled={busy} onClick={() => setCreating(true)}><PlusIcon />{t("p4.jobs.create")}</Button></div>
    </div>
    {shownError ? <p role="alert" className="border-b p-3 text-xs text-destructive">{shownError}</p> : null}
    {page?.key === key && page.value.truncated ? <p className="border-b px-3 py-2 text-xs text-muted-foreground">{t("p4.jobs.listLimit")}</p> : null}
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="p4-job-list" defaultSize="36%" minSize="25%">
        <div className="absolute inset-0 overflow-auto p-1" role="list" aria-label={t("p4.jobs.title")}>
          {items ? items.length ? items.map(item => <button key={item.name} type="button" aria-pressed={selected === item.name} onClick={() => setSelected(item.name)} className={cn("grid w-full gap-1 rounded-md px-3 py-2.5 text-left hover:bg-muted/60", selected === item.name && "bg-muted")}>
            <span className="flex min-w-0 items-center gap-3"><span className="min-w-0 flex-1 truncate font-mono text-xs" title={item.name}>{item.name}</span><span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.status || item.user}</span></span>
            <span className="truncate text-xs text-muted-foreground">{item.description.trim() || item.user}</span>
          </button>) : <p className="p-6 text-center text-xs text-muted-foreground">{t("p4.jobs.noMatches")}</p> : !shownError ? <JobLoading /> : null}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="p4-job-detail" defaultSize="64%" minSize="35%">
        {selected ? <JobInspector key={`${selected}:${attempt}`} name={selected} onChanged={reload} onDeleted={() => {setSelected(null); reload();}} /> : <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">{t("p4.jobs.select")}</div>}
      </ResizablePanel>
    </ResizablePanelGroup>
    {creating ? <P4JobDialog mode="new" name={null} onClose={() => setCreating(false)} onChanged={job => {setCreating(false); if (job) setSelected(job.name); setQuery(""); reload();}} /> : null}
  </div>;
}

function JobInspector({ name, onChanged, onDeleted }: {name: string; onChanged: () => void; onDeleted: () => void}) {
  const { t } = useTranslation();
  const { jobs, busy } = useP4();
  const [job, setJob] = useState<P4Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"edit" | "delete" | null>(null);
  useEffect(() => {
    let live = true;
    void jobs.read(name).then(value => {if (live) {setJob(value); setError(null);}}).catch((caught: unknown) => {if (live) setError(p4DisplayError(errorMessage(caught)));});
    return () => {live = false;};
  }, [name, jobs, attempt]);
  return <div className="absolute inset-0 overflow-auto p-5">
    {job ? <div className="mx-auto grid max-w-2xl gap-5">
      <div className="flex items-center gap-2"><h2 className="min-w-0 flex-1 break-all font-mono text-base font-medium">{job.name}</h2><HoverTip label={t("p4.jobs.edit")}><Button variant="outline" size="icon-sm" aria-label={t("p4.jobs.edit")} disabled={busy} onClick={() => setMode("edit")}><PencilIcon /></Button></HoverTip><HoverTip label={t("p4.jobs.delete")}><Button variant="ghost" size="icon-sm" aria-label={t("p4.jobs.delete")} disabled={busy} onClick={() => setMode("delete")}><Trash2Icon /></Button></HoverTip></div>
      <dl className="grid gap-4">{job.fields.filter(field => field.code !== 101).map(field => <div key={field.code} className="grid gap-1.5"><dt className="text-xs text-muted-foreground">{field.name}</dt><dd className="whitespace-pre-wrap break-words text-sm">{field.value || "—"}</dd></div>)}</dl>
      <P4JobFixes job={name} onChanged={onChanged} />
    </div> : !error ? <JobLoading /> : null}
    {error ? <div className="mt-4 grid gap-3"><p role="alert" className="text-xs text-destructive">{error}</p><Button variant="outline" size="sm" className="justify-self-start" onClick={() => {setError(null); setJob(null); setAttempt(value => value + 1);}}>{t("common.retry")}</Button></div> : null}
    {mode ? <P4JobDialog mode={mode} name={name} onClose={() => setMode(null)} onChanged={value => {setMode(null); if (value) onChanged(); else onDeleted();}} /> : null}
  </div>;
}

export function JobLoading() {return <div role="status" className="flex h-32 items-center justify-center text-muted-foreground"><LoaderCircleIcon className="size-5 animate-spin" /></div>;}
