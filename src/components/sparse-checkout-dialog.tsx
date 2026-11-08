import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { InfoIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { gitApi } from "@/lib/git";
import { sparseCheckoutError } from "@/lib/sparse-checkout";
import { useActivities, useGitPick } from "@/state/git-context";
import type { SparseCheckoutPreview, SparseCheckoutRequest, SparseCheckoutState } from "@/types/sparse-checkout";

export function SparseCheckoutDialog({open, onOpenChange}: {open:boolean; onOpenChange:(open:boolean)=>void}) {
  const {snapshot} = useGitPick(["snapshot"]);
  const repoPath = snapshot?.repo.path;
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && repoPath ? <SparseCheckoutSession key={repoPath} repoPath={repoPath} onClose={() => onOpenChange(false)} /> : null}</Dialog>;
}

export function SparseCheckoutSession({repoPath, onClose}: {repoPath:string; onClose:()=>void}) {
  const {t} = useTranslation();
  const {changeSparseCheckout, activeTabId} = useGitPick(["changeSparseCheckout", "activeTabId"]);
  const activities = useActivities();
  const [state, setState] = useState<SparseCheckoutState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [cone, setCone] = useState(true);
  const [sparseIndex, setSparseIndex] = useState(false);
  const [directories, setDirectories] = useState("");
  const [patterns, setPatterns] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<"preview" | "apply" | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState("");
  const [reviewed, setReviewed] = useState<{key:string; request:SparseCheckoutRequest; value:SparseCheckoutPreview} | null>(null);
  const [allowIgnored, setAllowIgnored] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(false), running = useRef(false), generation = useRef(0);
  const key = JSON.stringify([repoPath, state?.fingerprint, enabled, cone, sparseIndex, directories, patterns]);
  const currentKey = useRef(key);
  useLayoutEffect(() => {currentKey.current = key;}, [key]);
  function receive(value: SparseCheckoutState, replaceDraft = true) {
    setState(value); setReviewed(null); setAllowIgnored(false);
    if (replaceDraft) {setEnabled(value.enabled); setCone(value.cone); setSparseIndex(value.sparseIndex); setDirectories(value.cone ? value.rules.join("\n") : ""); setPatterns(value.patterns.join("\n"));}
  }
  useEffect(() => {
    live.current = true;
    let active = true;
    void gitApi.sparseCheckoutState(repoPath).then(value => {if (active) {receive(value); setLoading(false);}}).catch((caught:unknown) => {if (active) {setError(sparseCheckoutError(caught)); setLoading(false);}});
    return () => {active = false; live.current = false;};
  }, [repoPath, attempt]);
  const ownerBusy = activities.some(activity => activity.tabId === activeTabId);
  const cancellable = activities.find(activity => activity.tabId === activeTabId && activity.cancellable);
  const blocked = loading || working === "apply" || ownerBusy;
  const accepted = reviewed?.key === key ? reviewed : null;
  const dirty = Boolean(state && (enabled !== state.enabled || enabled && (cone !== state.cone || sparseIndex !== state.sparseIndex || (cone ? directories : patterns) !== state.rules.join("\n"))));
  function changed(action: () => void) {generation.current++; setReviewed(null); setAllowIgnored(false); setError(null); action();}
  function reload() {if (running.current || blocked) return; changed(() => {setLoading(true); setReport(""); setAttempt(value => value + 1);});}
  async function preview(reapply = false) {
    if (!state || blocked || running.current) return;
    running.current = true; setWorking("preview"); setError(null); setReviewed(null); setAllowIgnored(false);
    const token = ++generation.current;
    const request: SparseCheckoutRequest = reapply ? {kind:"reapply"} : !enabled ? {kind:"disable"} : {kind:"set", cone, sparseIndex:cone && sparseIndex, rules:(cone ? directories : patterns).split("\n").filter(line => line.length > 0)};
    try {
      const value = await gitApi.previewSparseCheckout(repoPath, request, state.fingerprint);
      if (live.current && generation.current === token && currentKey.current === key) setReviewed({key, request, value});
    } catch (caught) {if (live.current && generation.current === token) setError(sparseCheckoutError(caught));}
    finally {running.current = false; if (live.current) setWorking(null);}
  }
  async function apply() {
    if (!accepted || blocked || running.current || accepted.value.ignoredCount > 0 && !allowIgnored) return;
    running.current = true; setWorking("apply"); setCancelling(false); setError(null);
    try {
      const result = await changeSparseCheckout(repoPath, accepted.request, accepted.value.fingerprint, allowIgnored);
      if (!live.current) return;
      if (result) {receive(result.state); setReport(result.report || t("git.sparse.completed"));}
      else {
        setReviewed(null); setAllowIgnored(false); setError(t("git.sparse.failed"));
        const latest = await gitApi.sparseCheckoutState(repoPath);
        if (live.current) receive(latest, false);
      }
    } catch (caught) {if (live.current) setError(sparseCheckoutError(caught));}
    finally {running.current = false; if (live.current) setWorking(null);}
  }
  async function cancel() {
    if (!cancellable || cancelling) return;
    setCancelling(true);
    try {if (!await gitApi.cancelActivity(cancellable.id) && live.current) setCancelling(false);}
    catch (caught) {if (live.current) {setCancelling(false); setError(sparseCheckoutError(caught));}}
  }
  return <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl" showCloseButton={working !== "apply"} onEscapeKeyDown={event => {if (working === "apply") event.preventDefault();}} onInteractOutside={event => {if (working === "apply") event.preventDefault();}}>
    <DialogHeader><DialogTitle>{t("git.sparse.title")}</DialogTitle><DialogDescription>{t("git.sparse.description")}</DialogDescription></DialogHeader>
    <div className="grid min-h-0 gap-4 overflow-auto py-1">
      {loading ? <div role="status" className="flex h-24 items-center justify-center"><LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" /></div> : null}
      {state && !loading ? <>
        <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">{t("git.sparse.current")}</span><Badge variant="outline">{t(!state.enabled ? "git.sparse.full" : state.cone ? "git.sparse.directories" : "git.sparse.patterns")}</Badge>{state.enabled && state.sparseIndex ? <Badge variant="outline">{t("git.sparse.sparseIndex")}</Badge> : null}<HoverTip label={t("git.sparse.reloadHint")}><Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={t("git.sparse.reload")} disabled={blocked || Boolean(working)} onClick={reload}><RefreshCwIcon /></Button></HoverTip></div>
        <Label className="text-sm"><Checkbox checked={enabled} disabled={blocked} onCheckedChange={value => changed(() => setEnabled(value === true))} />{t("git.sparse.enable")}</Label>
        {enabled ? <>
          <SegmentedControl label={t("git.sparse.mode")} value={cone ? "directories" : "patterns"} disabled={blocked} onChange={value => changed(() => {setCone(value === "directories"); if (value === "patterns") setSparseIndex(false);})} options={[{value:"directories", label:t("git.sparse.directories")}, {value:"patterns", label:t("git.sparse.patterns")}]} />
          <div className="grid gap-2"><div className="flex items-center gap-2"><Label htmlFor="sparse-checkout-rules">{t(cone ? "git.sparse.directoryList" : "git.sparse.patternList")}</Label><HoverTip label={t(cone ? "git.sparse.coneHint" : "git.sparse.patternHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div><Textarea id="sparse-checkout-rules" spellCheck={false} value={cone ? directories : patterns} disabled={blocked} onChange={event => changed(() => cone ? setDirectories(event.target.value) : setPatterns(event.target.value))} placeholder={t(cone ? "git.sparse.directoryPlaceholder" : "git.sparse.patternPlaceholder")} className="h-28 min-h-28 resize-none whitespace-pre font-mono text-xs [field-sizing:fixed]" /></div>
          <div className="flex items-center gap-2"><Label className="text-xs"><Checkbox checked={cone && sparseIndex} disabled={blocked || !cone} onCheckedChange={value => changed(() => setSparseIndex(value === true))} />{t("git.sparse.sparseIndex")}</Label><HoverTip label={t("git.sparse.indexHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div>
        </> : null}
        {accepted ? <div className="grid gap-3 rounded-lg border bg-muted/10 p-3">
          <div className="grid grid-cols-2 gap-3"><Count label={t("git.sparse.selected")} count={accepted.value.selected} /><Count label={t("git.sparse.outside")} count={accepted.value.outside} /></div>
          <Paths title={t("git.sparse.selectedPaths")} paths={accepted.value.selectedPaths} count={accepted.value.selected} />
          {accepted.value.dirtyCount ? <Paths title={t("git.sparse.keptChanges")} paths={accepted.value.dirtyPaths} count={accepted.value.dirtyCount} /> : null}
          {accepted.value.ignoredCount ? <><Paths title={t("git.sparse.ignoredRisk")} paths={accepted.value.ignoredPaths} count={accepted.value.ignoredCount} /><Label className="items-start text-xs leading-relaxed"><Checkbox checked={allowIgnored} disabled={blocked} onCheckedChange={value => setAllowIgnored(value === true)} />{t("git.sparse.confirmIgnored", {count:accepted.value.ignoredCount})}</Label></> : null}
        </div> : <p className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">{t("git.sparse.previewRequired")}</p>}
        {report ? <pre role="status" className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/10 p-3 font-mono text-xs leading-relaxed">{report}</pre> : null}
      </> : null}
      {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
    </div>
    <DialogFooter className="flex-wrap">{working === "apply" ? <Button variant="outline" className="sm:mr-auto" disabled={!cancellable || cancelling} onClick={() => void cancel()}>{t(cancelling ? "git.sparse.cancelling" : "git.sparse.cancel")}</Button> : state?.enabled ? <Button variant="ghost" disabled={blocked || Boolean(working) || dirty} className="sm:mr-auto" onClick={() => void preview(true)}>{t("git.sparse.previewReapply")}</Button> : !state && error ? <Button variant="ghost" onClick={reload}>{t("common.retry")}</Button> : null}<Button variant="outline" disabled={working === "apply"} onClick={onClose}>{t("common.close")}</Button><Button variant="outline" disabled={blocked || Boolean(working) || !state || !dirty} onClick={() => void preview()}>{working === "preview" ? <LoaderCircleIcon className="animate-spin" /> : null}{t("git.sparse.preview")}</Button><Button disabled={blocked || Boolean(working) || !accepted || accepted.value.ignoredCount > 0 && !allowIgnored} onClick={() => void apply()}>{working === "apply" ? <LoaderCircleIcon className="animate-spin" /> : null}{t(accepted?.request.kind === "reapply" ? "git.sparse.reapply" : !enabled ? "git.sparse.restore" : "git.sparse.apply")}</Button></DialogFooter>
  </DialogContent>;
}

function Count({label, count}: {label:string; count:number}) {return <div className="rounded-md border bg-background px-3 py-2"><span className="block text-[11px] text-muted-foreground">{label}</span><span className="text-xl font-medium tabular-nums">{count.toLocaleString()}</span></div>;}
function Paths({title, paths, count}: {title:string; paths:string[]; count:number}) {
  const {t} = useTranslation();
  return <div className="grid gap-1.5"><span className="text-xs font-medium">{title}</span>{paths.length ? <pre className="max-h-24 overflow-auto whitespace-pre font-mono text-[11px] leading-relaxed text-muted-foreground">{paths.join("\n")}</pre> : <p className="text-xs text-muted-foreground">{t("git.sparse.noMatches")}</p>}{count > paths.length ? <p className="text-[11px] text-muted-foreground">{t("git.sparse.sample", {count:paths.length, total:count})}</p> : null}</div>;
}
