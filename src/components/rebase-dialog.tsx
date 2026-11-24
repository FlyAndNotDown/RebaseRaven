import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGitPick } from "@/state/git-context";

export function RebaseOntoDialog({
  target,
  onOpenChange,
}: {
  target: { onto: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      {target && <RebaseForm key={target.onto} target={target} close={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function RebaseForm({ target, close }: { target: { onto: string; label: string }; close: () => void }) {
  const { t } = useTranslation();
  const { snapshot, rebaseOnto } = useGitPick(["snapshot", "rebaseOnto"]);
  const [upstream, setUpstream] = useState("");
  const inputId = useId();
  const oldBase = upstream.trim();
  const branch = snapshot?.repo.currentBranch ?? t("git.dynamic.currentBranch");
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("git.dynamic.rebaseTitle", { target: target.label })}</DialogTitle>
        <DialogDescription className="break-words">
          {t(oldBase ? "git.dynamic.rebaseRangeDescription" : "git.dynamic.rebaseDescription", {
            branch, target: target.label, oldBase,
          })}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor={inputId}>{t("git.dynamic.rebaseOldBase")}</Label>
        <Input
          id={inputId}
          className="font-mono"
          value={upstream}
          placeholder={t("git.dynamic.rebaseOldBasePlaceholder")}
          onChange={(event) => setUpstream(event.target.value)}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>{t("git.ui.cancel")}</Button>
        <Button
          type="button"
          onClick={() => {
            close();
            void rebaseOnto(target.onto, target.label, oldBase || undefined);
          }}
        >{t("git.ui.rebase")}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function MergeDialog({
  target,
  onOpenChange,
}: {
  target: { onto: string; label: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  useTranslation();
  const { snapshot, mergeRef } = useGitPick(["snapshot", "mergeRef"]);
  const branch = snapshot?.repo.currentBranch;

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("git.dynamic.mergeTitle", { target: target?.label })}</DialogTitle>
          <DialogDescription>
            {t("git.dynamic.mergeDescription", { branch: branch ?? t("git.dynamic.currentBranch") })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("git.ui.cancel")}</Button>
          <Button
            type="button"
            onClick={() => {
              const next = target;
              if (!next) return;
              onOpenChange(false);
              void mergeRef(next.onto, next.label);
            }}
          >{t("git.ui.merge")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const OPERATION_LABEL: Record<string, string> = {
  merge: "git.ui.merge",
  rebase: "git.ui.rebase",
  "cherry-pick": "git.ui.cherry_pick",
  revert: "git.ui.revert",
};

export function RebaseBanner() {
  useTranslation();
  const { snapshot, operationContinue, operationAbort, rebaseSkip, setView } = useGitPick([
    "snapshot",
    "operationContinue",
    "operationAbort",
    "rebaseSkip",
    "setView",
  ]);
  const operation = snapshot?.repo.operation;
  if (!operation) return null;
  const conflicted = (snapshot?.status.unstaged ?? []).some((file) => file.kind === "conflicted");
  const progress =
    operation.step && operation.total ? t("git.dynamic.operationProgress", { step: operation.step, total: operation.total }) : "";
  const title = t(OPERATION_LABEL[operation.kind] ?? "git.ui.operation");

  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/60 px-3 py-1.5">
      <p className="min-w-0 flex-1 truncate text-sm">
        {t(conflicted ? "git.dynamic.operationConflicts" : "git.dynamic.operationRunning", { title, progress })}
      </p>
      <Button
        type="button"
        size="xs"
        disabled={conflicted}
        onClick={() => {
          setView("changes");
          void operationContinue();
        }}
      >{t("git.ui.continue")}</Button>
      {operation.kind === "rebase" ? (
        <Button type="button" size="xs" variant="outline" onClick={() => void rebaseSkip()}>{t("git.ui.skip")}</Button>
      ) : null}
      <Button type="button" size="xs" variant="destructive" onClick={() => void operationAbort()}>{t("git.ui.abort")}</Button>
    </div>
  );
}
