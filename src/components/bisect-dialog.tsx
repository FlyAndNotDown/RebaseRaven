import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, GitCommitHorizontalIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { createExclusiveAction, createLatestRequest } from "@/lib/async-scope";
import { errorMessage, gitApi } from "@/lib/git";
import { useActivities, useGitPick } from "@/state/git-context";
import type { BisectAction, BisectRevision, BisectState, BisectVerdict } from "@/types/git";

export function BisectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { snapshot } = useGitPick(["snapshot"]);
  const repoPath = snapshot?.repo.path;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {open && repoPath ? <BisectSession key={repoPath} repoPath={repoPath} onClose={() => onOpenChange(false)} /> : null}
  </Dialog>;
}

function BisectSession({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { bisectAction, selectCommit, setView, activeTabId } = useGitPick(["bisectAction", "selectCommit", "setView", "activeTabId"]);
  const activities = useActivities();
  const [request] = useState(createLatestRequest);
  const [mutation] = useState(createExclusiveAction);
  const [state, setState] = useState<BisectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState("");
  const [bad, setBad] = useState("HEAD");
  const [good, setGood] = useState("");
  const [paths, setPaths] = useState("");
  const [firstParent, setFirstParent] = useState(false);
  const [revision, setRevision] = useState("");
  const mounted = useRef(false);
  const currentCard = useRef<HTMLDivElement>(null);
  const candidateList = useRef<HTMLDivElement>(null);
  const revisionInput = useRef<HTMLInputElement>(null);
  const cancelLoad = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    const cancel = request.run(() => gitApi.bisectState(repoPath), value => { setState(value); setLoading(false); }, caught => { setError(errorMessage(caught)); setLoading(false); });
    cancelLoad.current = cancel;
    return () => { mounted.current = false; cancelLoad.current?.(); };
  }, [repoPath, request]);
  const blocked = loading || busy || activities.some(activity => activity.tabId === activeTabId);

  function reload(clearError = true) {
    setLoading(true);
    if (clearError) setError(null);
    cancelLoad.current = request.run(() => gitApi.bisectState(repoPath), value => { setState(value); setLoading(false); }, caught => { setError(errorMessage(caught)); setLoading(false); });
  }
  function run(action: BisectAction) {
    if (!state || blocked) return;
    void mutation.run(async () => {
      setBusy(true); setError(null); cancelLoad.current?.();
      try {
        const result = await bisectAction(action, state.fingerprint);
        if (!mounted.current) return;
        if (result) {
          setState(result.state); setReport(result.report); setRevision("");
          if (action.kind === "checkout" || action.kind === "mark") {
            requestAnimationFrame(() => { if (mounted.current) (currentCard.current ?? candidateList.current)?.focus(); });
          }
        }
        else { setError(t("git.bisect.actionFailed")); reload(false); }
      } finally { if (mounted.current) setBusy(false); }
    });
  }
  function inspect(commit: BisectRevision) {
    setView("history"); void selectCommit(commit.id); onClose();
  }
  const term = (kind: "good" | "bad") => {
    const value = kind === "good" ? state?.goodTerm : state?.badTerm;
    return value && value !== kind ? value : t(`git.bisect.${kind}`);
  };
  function verdictButtons(other = false) {
    const mark = (verdict: BisectVerdict) => run({ kind: "mark", verdict, ...(other ? { revision } : {}) });
    return <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={blocked || (other && !revision.trim())} onClick={() => mark("good")}>{t("git.bisect.mark", { term: term("good") })}</Button>
      <Button type="button" variant="outline" size="sm" disabled={blocked || (other && !revision.trim())} onClick={() => mark("bad")}>{t("git.bisect.mark", { term: term("bad") })}</Button>
      <HoverTip label={t("git.bisect.skipHelp")}><Button type="button" variant="ghost" size="sm" disabled={blocked || (other && !revision.trim())} onClick={() => mark("skip")}>{t("git.bisect.skip")}</Button></HoverTip>
    </div>;
  }
  return <DialogContent className="flex max-h-[88vh] flex-col gap-4 sm:max-w-xl" showCloseButton={!busy} onEscapeKeyDown={event => { if (mutation.busy) event.preventDefault(); }} onPointerDownOutside={event => { if (mutation.busy) event.preventDefault(); }} onInteractOutside={event => { if (mutation.busy) event.preventDefault(); }}>
    <DialogHeader>
      <DialogTitle>{t("git.bisect.title")}</DialogTitle>
      <DialogDescription>{t("git.bisect.description")}</DialogDescription>
    </DialogHeader>
    <ScrollArea className="min-h-0 flex-1 -mx-1 px-1">
      <div className="space-y-4 pb-1">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />{t("git.bisect.loading")}</p> : null}
        {state?.active ? <>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">{t("git.bisect.goodCount", { count: state.goodCount, term: term("good") })}</Badge>
            <Badge variant="outline">{t("git.bisect.skippedCount", { count: state.skippedCount })}</Badge>
            {state.remainingCount !== null ? <Badge variant="outline">{t("git.bisect.remaining", { count: state.remainingCount })}{state.truncated ? "+" : ""}</Badge> : null}
            {state.firstParent ? <Badge variant="outline">{t("git.bisect.firstParent")}</Badge> : null}
            {state.noCheckout ? <HoverTip label={t("git.bisect.noCheckoutHelp")}><Badge variant="outline">{t("git.bisect.noCheckout")}</Badge></HoverTip> : null}
          </div>
          {state.found && state.firstBad ? <div ref={currentCard} tabIndex={-1} className="space-y-3 rounded-lg border bg-muted/30 p-4 outline-none" role="status">
            <h3 className="flex items-center gap-2 text-sm font-medium"><CheckIcon className="size-4" />{t("git.bisect.found", { term: term("bad") })}</h3>
            <Revision revision={state.firstBad} />
            <Button variant="outline" size="sm" disabled={blocked} onClick={() => inspect(state.firstBad!)}>{t("git.bisect.inspect")}</Button>
          </div> : <>
            {state.current && (!state.ambiguous || state.candidates.some(candidate => candidate.id === state.current?.id)) ? <div ref={currentCard} tabIndex={-1} className="space-y-3 rounded-lg border bg-muted/30 p-4 outline-none">
              <h3 className="text-sm font-medium">{t("git.bisect.testRevision")}</h3>
              <Revision revision={state.current} />
              {verdictButtons()}
            </div> : null}
            {state.ambiguous ? <div ref={candidateList} tabIndex={-1} className="space-y-2 outline-none">
              <p role="status" className="text-sm font-medium">{t("git.bisect.ambiguous")}</p>
              <p className="text-xs text-muted-foreground">{t("git.bisect.ambiguousHelp")}</p>
              <div className="divide-y rounded-md border">
                {state.candidates.map(candidate => <div key={candidate.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1"><Revision revision={candidate} /></div>
                  <Button size="xs" variant="ghost" disabled={blocked} onClick={() => inspect(candidate)} aria-label={t("git.bisect.inspectRevision", { id: candidate.shortId })}><GitCommitHorizontalIcon /></Button>
                  {!state.noCheckout ? <Button size="xs" variant="outline" disabled={blocked} onClick={() => run({ kind: "checkout", revision: candidate.id })}>{t("git.bisect.test")}</Button> : null}
                  <Button size="xs" variant="ghost" disabled={blocked} onClick={() => { setRevision(candidate.id); revisionInput.current?.focus(); }}>{t("git.bisect.classify")}</Button>
                </div>)}
              </div>
            </div> : null}
            <details className="group rounded-md border p-3" open={state.ambiguous || state.goodCount === 0 || !state.bad || Boolean(revision)}>
              <summary className="flex cursor-pointer items-center justify-between text-sm font-medium">{t("git.bisect.otherRevision")}<ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" /></summary>
              <div className="mt-3 space-y-3">
                <Label htmlFor="bisect-revision">{t("git.bisect.revision")}</Label>
                <Input ref={revisionInput} id="bisect-revision" className="font-mono" value={revision} disabled={blocked} placeholder={t("git.bisect.revisionPlaceholder")} onChange={event => setRevision(event.target.value)} />
                {verdictButtons(true)}
              </div>
            </details>
          </>}
          {state.original ? <p className="break-all text-xs text-muted-foreground">{t("git.bisect.returnTo", { revision: state.original })}</p> : null}
        </> : state ? <form id="bisect-start" className="space-y-4" onSubmit={event => { event.preventDefault(); run({ kind: "start", bad, good: good.split(/\r?\n/).map(line => line.trim()).filter(Boolean), paths: paths.split(/\r?\n/).filter(Boolean), firstParent }); }}>
          <div className="space-y-2"><Label htmlFor="bisect-bad">{t("git.bisect.knownBad")}</Label><Input id="bisect-bad" value={bad} className="font-mono" disabled={blocked} onChange={event => setBad(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="bisect-good">{t("git.bisect.knownGood")}</Label><Textarea id="bisect-good" rows={2} className="min-h-16 font-mono" value={good} disabled={blocked} placeholder="v1.0.0" onChange={event => setGood(event.target.value)} /></div>
          <details className="group rounded-md border p-3">
            <summary className="flex cursor-pointer items-center justify-between text-sm font-medium">{t("git.bisect.options")}<ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" /></summary>
            <div className="mt-3 space-y-3">
              <div className="space-y-2"><Label htmlFor="bisect-paths">{t("git.bisect.paths")}</Label><Textarea id="bisect-paths" rows={2} className="min-h-16 font-mono" value={paths} disabled={blocked} placeholder={t("git.bisect.pathsPlaceholder")} onChange={event => setPaths(event.target.value)} /></div>
              <HoverTip label={t("git.bisect.firstParentHelp")}><label className="flex w-fit items-center gap-2 text-sm"><Checkbox checked={firstParent} disabled={blocked} onCheckedChange={checked => setFirstParent(checked === true)} />{t("git.bisect.firstParent")}</label></HoverTip>
            </div>
          </details>
        </form> : null}
        {report ? <details className="group rounded-md border p-3"><summary className="flex cursor-pointer items-center justify-between text-sm text-muted-foreground">{t("git.bisect.output")}<ChevronDownIcon className="size-4 transition-transform group-open:rotate-180" /></summary><pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{report}</pre></details> : null}
      </div>
    </ScrollArea>
    <DialogFooter className="items-center sm:justify-between">
      <HoverTip label={t("git.bisect.reload")}><Button size="icon-sm" variant="ghost" aria-label={t("git.bisect.reload")} disabled={blocked} onClick={() => reload()}><RefreshCwIcon className={loading ? "animate-spin motion-reduce:animate-none" : ""} /></Button></HoverTip>
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onClose}>{t("common.close")}</Button>
        {state?.active ? <HoverTip label={t("git.bisect.resetHelp")}><Button disabled={blocked} onClick={() => run({ kind: "reset" })}>{busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t("git.bisect.reset")}</Button></HoverTip> : <Button form="bisect-start" type="submit" disabled={blocked || !state || !bad.trim() || !good.trim()}>{busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t("git.bisect.start")}</Button>}
      </div>
    </DialogFooter>
  </DialogContent>;
}

function Revision({ revision }: { revision: BisectRevision }) {
  return <div className="min-w-0 space-y-1"><span className="font-mono text-xs text-muted-foreground">{revision.shortId}</span><p className="truncate text-sm" title={revision.summary}>{revision.summary}</p></div>;
}
