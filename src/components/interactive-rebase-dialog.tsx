import { useTranslation } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { AlertTriangleIcon, ArrowDownIcon, ArrowUpIcon, CombineIcon, GitCommitHorizontalIcon, InfoIcon, PencilLineIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChoiceSelect } from "@/components/ui/choice-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage, gitApi } from "@/lib/git";
import { rebasePlanIssue, type RebasePlanStep } from "@/lib/rebase-plan";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { RebaseAction, RebaseCommit } from "@/types/git";

const ACTIONS: { id: RebaseAction; labelKey: string; icon: typeof GitCommitHorizontalIcon }[] = [
  {id:"pick",labelKey:"git.ui.pick",icon:GitCommitHorizontalIcon},
  {id:"reword",labelKey:"git.ui.reword",icon:PencilLineIcon},
  {id:"squash",labelKey:"git.ui.squash",icon:CombineIcon},
  {id:"fixup",labelKey:"git.ui.fixup",icon:CombineIcon},
  {id:"drop",labelKey:"git.rebasePlan.drop",icon:Trash2Icon},
];

function initialSteps(commits: RebaseCommit[]): RebasePlanStep[] {
  return commits.map(commit => ({...commit,action:"pick",message:commit.message}));
}

export function InteractiveRebaseDialog({onto,onOpenChange}: {onto:{id:string;label:string}|null;onOpenChange:(open:boolean)=>void}) {
  useTranslation();
  const {activeTabId,snapshot} = useGitPick(["activeTabId","snapshot"]);
  return <Dialog open={Boolean(onto)} onOpenChange={onOpenChange}><DialogContent className="flex h-[min(46rem,86vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
    {onto ? <InteractiveRebaseForm key={`${activeTabId}:${snapshot?.repo.path}:${onto.id}`} onto={onto} onOpenChange={onOpenChange} /> : null}
  </DialogContent></Dialog>;
}

function InteractiveRebaseForm({onto,onOpenChange}: {onto:{id:string;label:string};onOpenChange:(open:boolean)=>void}) {
  const {t}=useTranslation();
  const {snapshot,rebaseInteractive}=useGitPick(["snapshot","rebaseInteractive"]);
  const repoPath=snapshot?.repo.path;
  const [steps,setSteps]=useState<RebasePlanStep[]>([]);
  const [original,setOriginal]=useState<RebaseCommit[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [loading,setLoading]=useState(Boolean(repoPath));
  const [error,setError]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(0);
  const [planHead,setPlanHead]=useState(snapshot?.repo.headId);
  const starting=useRef(false);
  const stale=planHead !== snapshot?.repo.headId || Boolean(snapshot?.repo.operation);
  const problem=rebasePlanIssue(steps);
  const selected=steps.find(step => step.id === selectedId) ?? steps[0];
  const editable=selected?.action === "reword" || selected?.action === "squash";

  useEffect(() => {
    if (!repoPath) return;
    let live=true;
    void Promise.resolve().then(async () => {
      if (!live) return;
      setLoading(true);setError(null);
      try {
        const commits=await gitApi.rebasePlan(repoPath,onto.id);
        if (!live) return;
        setOriginal(commits);setSteps(initialSteps(commits));setSelectedId(commits[0]?.id ?? null);
      } catch (caught) {if (live) setError(errorMessage(caught));}
      finally {if (live) setLoading(false);}
    });
    return () => {live=false;};
  },[repoPath,onto.id,attempt]);

  function reload() {setPlanHead(snapshot?.repo.headId);setLoading(true);setAttempt(value => value+1);}
  function update(id:string,patch:Partial<RebasePlanStep>) {setSelectedId(id);setSteps(current => current.map(step => step.id === id ? {...step,...patch} : step));}
  function move(id:string,direction:-1|1) {
    setSelectedId(id);
    setSteps(current => {
      const index=current.findIndex(step => step.id === id),next=index+direction;
      if (index<0 || next<0 || next>=current.length) return current;
      const copy=[...current];const [item]=copy.splice(index,1);copy.splice(next,0,item);return copy;
    });
  }

  return <>
    <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12"><DialogTitle>{t("git.ui.interactive_rebase")}</DialogTitle><DialogDescription className="truncate" title={onto.label}>{t("git.rebasePlan.onto",{target:onto.label})}</DialogDescription></DialogHeader>
    <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-xs"><span className="font-medium">{t("git.rebasePlan.commits",{count:steps.length})}</span><HoverTip label={t("git.dynamic.interactiveDescription",{target:onto.label})}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip><span className="text-muted-foreground">{t("git.rebasePlan.oldestFirst")}</span><Button size="xs" variant="ghost" className="ml-auto" disabled={loading || !steps.length || stale} onClick={() => {setSteps(initialSteps(original));setSelectedId(original[0]?.id ?? null);}}><RotateCcwIcon />{t("git.rebasePlan.reset")}</Button></div>
    {loading || error || !steps.length ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-sm text-muted-foreground">{loading ? <p role="status">{t("git.ui.loading_commits")}</p> : error ? <><p role="alert" className="max-w-full whitespace-pre-wrap break-words text-destructive">{error}</p><Button size="sm" variant="outline" onClick={reload}>{t("common.retry")}</Button></> : t("git.ui.nothing_to_rebase")}</div> : <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.4fr)_minmax(18rem,1fr)]">
      <div className="min-h-0 overflow-auto border-r p-1.5" role="list" aria-label={t("git.rebasePlan.sequence")}>
        {steps.map((step,index) => <div key={step.id} role="listitem" data-rebase-step={step.id} className={cn("flex min-w-0 items-center gap-1 rounded-md py-1 pr-1 pl-2 hover:bg-muted/50",selected?.id === step.id && "bg-muted")}>
          <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">{index+1}</span>
          <ChoiceSelect aria-label={t("git.dynamic.rebaseAction",{id:step.shortId})} value={step.action} onValueChange={action => update(step.id,{action})} className="h-7 w-28 shrink-0 border-transparent bg-transparent" options={ACTIONS.map(action => ({value:action.id,label:<span className="flex items-center gap-1.5"><action.icon className="size-3.5 shrink-0 text-muted-foreground" />{t(action.labelKey)}</span>}))} />
          <button type="button" aria-pressed={selected?.id === step.id} className="min-w-0 flex-1 px-1 py-1 text-left" title={step.summary} onClick={() => setSelectedId(step.id)} onKeyDown={event => {if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {event.preventDefault();move(step.id,event.key === "ArrowUp" ? -1 : 1);}}}><span className={cn("block truncate text-xs",step.action === "drop" && "text-muted-foreground line-through")}>{step.summary || t("git.ui.no_message")}</span><span className="font-mono text-[10px] text-muted-foreground">{step.shortId}</span></button>
          {problem?.id === step.id ? <HoverTip label={t(`git.rebasePlan.${problem.key}`)}><AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" /></HoverTip> : null}
          <div className="flex shrink-0 flex-col"><HoverTip label={t("git.ui.move_up")}><Button type="button" variant="ghost" size="icon-xs" className="size-5" aria-label={t("git.ui.move_up")} disabled={index === 0} onClick={() => move(step.id,-1)}><ArrowUpIcon className="size-3" /></Button></HoverTip><HoverTip label={t("git.ui.move_down")}><Button type="button" variant="ghost" size="icon-xs" className="size-5" aria-label={t("git.ui.move_down")} disabled={index === steps.length-1} onClick={() => move(step.id,1)}><ArrowDownIcon className="size-3" /></Button></HoverTip></div>
        </div>)}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-3 p-4">
        <div className="flex shrink-0 items-center gap-2"><code className="text-xs text-muted-foreground">{selected?.shortId}</code><span className="ml-auto text-xs font-medium">{t(ACTIONS.find(action => action.id === selected?.action)!.labelKey)}</span></div>
        <p className="shrink-0 text-xs leading-5 text-muted-foreground">{t(`git.rebasePlan.${selected?.action}Hint`)}</p>
        {selected ? editable ? <Textarea className="min-h-0 flex-1 resize-none font-mono text-xs leading-5 [field-sizing:fixed]" aria-label={t(selected.action === "reword" ? "git.ui.new_message" : "git.ui.squash_message")} value={selected.message} onChange={event => update(selected.id,{message:event.target.value})} /> : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/15 p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{selected.message || t("git.ui.no_message")}</pre> : null}
      </div>
    </div>}
    <DialogFooter className="mx-0 mb-0 shrink-0 items-center border-t px-5 py-3 sm:justify-between"><div className="min-w-0 flex-1 text-xs text-destructive" role={stale || problem ? "alert" : undefined}>{stale ? <span>{t("git.rebasePlan.stale")} <Button size="xs" variant="link" onClick={reload}>{t("git.rebasePlan.reload")}</Button></span> : problem ? t(`git.rebasePlan.${problem.key}`) : null}</div><div className="flex shrink-0 gap-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("git.ui.cancel")}</Button><Button type="button" disabled={!steps.length || loading || Boolean(error) || Boolean(problem) || stale} onClick={() => {if (starting.current) return;starting.current=true;onOpenChange(false);void rebaseInteractive(onto.id,steps.map(({id,action,message}) => ({id,action,message})));}}>{t("git.ui.start_rebase")}</Button></div></DialogFooter>
  </>;
}
