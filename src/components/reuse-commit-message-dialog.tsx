import { useEffect, useState } from "react";
import { InfoIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { CommitLine } from "@/components/create-ref-dialogs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage, gitApi } from "@/lib/git";
import { sameRepoPath } from "@/lib/format";
import { reviewCommitDraft, reusedCommitMessage, sameReviewedCommitDraft, type CommitMessageMode } from "@/state/commit-editor";
import { useGitPick } from "@/state/git-context";
import type { CommitSummary } from "@/types/git";

export type CommitMessageTarget = {tabId: string; path: string; commit: Pick<CommitSummary, "id" | "shortId" | "summary">};

export function ReuseCommitMessageDialog({target, onClose}: {target: CommitMessageTarget; onClose: () => void}) {
  const { t } = useTranslation();
  const model = useGitPick(["activeTabId", "snapshot", "commitEditor", "commitDraft", "reuseCommitMessage"]);
  const [review, setReview] = useState(() => reviewCommitDraft(model));
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<CommitMessageMode>("replace");
  useEffect(() => {
    let live = true;
    void gitApi.getCommitMessage(target.path, target.commit.id)
      .then(message => {if (live) {setSource(message); setError(null);}})
      .catch((caught: unknown) => {if (live) setError(errorMessage(caught));});
    return () => {live = false;};
  }, [target.path, target.commit.id, attempt]);
  const ownerChanged = model.activeTabId !== target.tabId || !model.snapshot || !sameRepoPath(model.snapshot.repo.path, target.path);
  const operating = Boolean(model.snapshot?.repo.operation);
  const fresh = sameReviewedCommitDraft(model, review);
  const stale = !fresh && !operating && !ownerChanged;
  const issue = error ?? (ownerChanged ? t("git.reuseMessage.ownerChanged") : operating ? t("git.reuseMessage.operation") : stale ? t("git.reuseMessage.stale") : source !== null && !source.trim() ? t("git.reuseMessage.empty") : null);
  const proposed = source === null ? "" : reusedCommitMessage(review.text, source, mode);
  const canApply = !ownerChanged && !operating && fresh && !error && Boolean(source?.trim());
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
      <DialogHeader><DialogTitle>{t("git.reuseMessage.title")}</DialogTitle><DialogDescription>{t("git.reuseMessage.description")}</DialogDescription></DialogHeader>
      <CommitLine commit={target.commit} />
      <div className="grid min-h-0 gap-4 overflow-auto">
        {review.text.trim() ? <div className="grid gap-2"><Label htmlFor="reuse-current-draft">{t("git.reuseMessage.current")}</Label><Textarea id="reuse-current-draft" value={review.text} readOnly spellCheck={false} className="h-20 min-h-20 resize-none font-mono text-xs [field-sizing:fixed]" />
          <SegmentedControl label={t("git.reuseMessage.mode")} value={mode} onChange={setMode} options={[{value:"replace",label:t("git.reuseMessage.replace")},{value:"append",label:t("git.reuseMessage.append")}]} />
        </div> : null}
        <div className="grid gap-2"><div className="flex items-center gap-2"><Label htmlFor="reuse-proposed-message">{t("git.reuseMessage.proposed")}</Label><HoverTip label={t("git.reuseMessage.hint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip></div>
          {source !== null ? <Textarea id="reuse-proposed-message" value={proposed} readOnly spellCheck={false} className="h-56 min-h-32 resize-none font-mono text-xs [field-sizing:fixed]" /> : !error ? <div role="status" className="flex h-32 items-center justify-center text-muted-foreground"><LoaderCircleIcon className="size-5 animate-spin" /></div> : null}
        </div>
      </div>
      {issue ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{issue}</p> : null}
      <DialogFooter>
        {source === null && error ? <Button variant="ghost" onClick={() => {setError(null); setAttempt(value => value + 1);}}>{t("git.ui.retry")}</Button> : null}
        {stale ? <Button variant="ghost" onClick={() => {setReview(reviewCommitDraft(model)); setError(null);}}>{t("git.reuseMessage.reviewAgain")}</Button> : null}
        <Button variant="outline" onClick={onClose}>{t("git.ui.cancel")}</Button>
        <Button disabled={!canApply} onClick={() => {
          if (!canApply || source === null) return;
          if (model.reuseCommitMessage(target.tabId, target.path, review, source, mode)) onClose();
          else setError(t("git.reuseMessage.stale"));
        }}>{t(review.text.trim() ? mode === "append" ? "git.reuseMessage.appendAction" : "git.reuseMessage.replaceAction" : "git.reuseMessage.use")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
