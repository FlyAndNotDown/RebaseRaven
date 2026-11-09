import { useEffect, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t, useTranslation } from "@/i18n";
import { p4Api, changeSummary } from "@/lib/p4";
import { errorMessage } from "@/lib/git";
import { useP4 } from "@/state/p4-context";

type Item = { value: string; detail: string };
export function P4RevisionPicker({ kind, onSelect, onClose }: {
  kind: "changelist" | "label" | "workspace";
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  useTranslation();
  const { connection } = useP4();
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<{query:string; items:Item[]; cursor:number|null; more:boolean} | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string|null>(null);
  const [before, setBefore] = useState<number|null>(null);
  const [previousQuery, setPreviousQuery] = useState(query);
  if (previousQuery !== query) { setPreviousQuery(query); setBefore(null); }
  useEffect(() => {
    if (!connection) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setBusy(true); setError(null);
      const request = async () => {
        if (kind === "changelist") {
          const result = await p4Api.searchSubmitted(connection, "", "", query, before, 50, 500);
          return {items:result.changes.map(change => ({value:change.id,detail:changeSummary(change.description)})), cursor:result.scannedThrough,more:result.hasMore};
        }
        if (kind === "label") {
          const result = await p4Api.listSpecs(connection,"label",query,"");
          return {items:result.items.map(item => ({value:item.name, detail:changeSummary(item.description)})),cursor:null,more:false};
        }
        const clients = await p4Api.listClients(connection, "");
        return {items:clients.filter(name => name.toLowerCase().includes(query.toLowerCase())).map(value => ({value,detail:""})),cursor:null,more:false};
      };
      void request().then(result => {
        if (live) setPage(current => ({...result,query,items:before && current?.query === query ? [...current.items,...result.items.filter(item => !current.items.some(old => old.value === item.value))] : result.items}));
      }).catch(caught => { if (live) setError(errorMessage(caught)); }).finally(() => { if (live) setBusy(false); });
    }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [attempt, before, connection, kind, query]);
  const items = page?.query === query ? page.items : [];
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}><DialogContent className="flex max-h-[75vh] flex-col sm:max-w-xl">
    <DialogHeader><DialogTitle>{t("p4.selectRevisionValue", {kind:t(`p4.${kind}`)})}</DialogTitle><DialogDescription className="sr-only">{t("p4.revisionBrowseSearch")}</DialogDescription></DialogHeader>
    <Input autoFocus value={query} placeholder={t("p4.revisionBrowseSearch")} aria-label={t("p4.revisionBrowseSearch")} onChange={event => setQuery(event.target.value)} />
    <div className="min-h-24 overflow-auto rounded-lg border">
      {items.map(item => <button type="button" key={item.value} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" onClick={() => {onSelect(item.value);onClose();}}><span className="shrink-0 font-mono text-xs">{kind === "changelist" ? `#${item.value}` : item.value}</span><span className="truncate text-xs text-muted-foreground">{item.detail}</span></button>)}
      {busy ? <div role="status" className="flex justify-center p-4"><LoaderCircleIcon className="size-4 animate-spin" /></div> : error ? <div className="grid gap-2 p-3"><p role="alert" className="text-xs text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</Button></div> : !items.length ? <p className="p-4 text-center text-sm text-muted-foreground">{t("p4.noRevisionMatches")}</p> : null}
    </div>
    {page?.more && page.cursor !== null ? <Button variant="ghost" disabled={busy} onClick={() => setBefore(page.cursor)}>{t("p4.loadMoreRevisions")}</Button> : null}
  </DialogContent></Dialog>;
}
