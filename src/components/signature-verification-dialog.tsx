import { useEffect, useState } from "react";
import { InfoIcon, LoaderCircleIcon, ShieldCheckIcon, ShieldQuestionIcon, ShieldXIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/git";
import { startSignatureVerification } from "@/lib/signature-verification";
import { cn } from "@/lib/utils";
import type { GitSignatureTarget, GitSignatureVerification } from "@/types/git";

export type SignatureDialogTarget = {tabId: string; path: string; object: GitSignatureTarget};

export function SignatureVerificationDialog({target, onClose}: {target: SignatureDialogTarget; onClose: () => void}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<GitSignatureVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => startSignatureVerification(target.path, target.object, setResult,
    error => setError(errorMessage(error))), [target.path, target.object, attempt]);
  const busy = !result && !error;
  const status = result?.status;
  const failed = status === "invalid" || status === "revoked" || status === "failed";
  const Icon = status === "verified" ? ShieldCheckIcon : failed ? ShieldXIcon : ShieldQuestionIcon;
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
      <DialogHeader><DialogTitle>{t("git.signature.title")}</DialogTitle><DialogDescription>{t(target.object.kind === "tag" ? "git.signature.tag" : "git.signature.commit")}</DialogDescription></DialogHeader>
      <div className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/30 p-3">
        <div className="min-w-0 flex-1"><div className="break-all font-mono text-xs">{target.object.value}</div>
          {result && result.oid !== target.object.value ? <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{result.oid}</div> : null}
        </div>
        <HoverTip label={t("git.signature.localHint")}><InfoIcon className="size-3.5 shrink-0 text-muted-foreground" /></HoverTip>
      </div>
      {busy ? <div role="status" className="flex h-24 items-center justify-center gap-2 text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />{t("git.signature.verifying")}</div> : null}
      {result ? <div role="status" className="flex items-start gap-2.5 py-1">
        <Icon className={cn("mt-0.5 size-5 shrink-0", status === "verified" ? "text-emerald-500" : failed ? "text-destructive" : "text-muted-foreground")} />
        <div className="min-w-0"><p className="text-sm font-medium">{t(`git.signature.status.${status}`)}</p><p className="mt-1 text-xs text-muted-foreground">{t(`git.signature.detail.${status}`)}</p></div>
      </div> : null}
      {error ? <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p> : null}
      {result?.output ? <div className="grid min-h-0 gap-2"><span className="text-xs text-muted-foreground">{t("git.signature.output")}</span><Textarea aria-label={t("git.signature.output")} value={result.output} readOnly spellCheck={false} className="h-40 min-h-24 resize-none font-mono text-[11px] [field-sizing:fixed]" />{result.truncated ? <p className="text-xs text-muted-foreground">{t("git.signature.truncated")}</p> : null}</div> : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => {setResult(null); setError(null); setAttempt(value => value + 1);}}>{t("git.signature.retry")}</Button>
        <Button variant="outline" onClick={onClose}>{t(busy ? "git.ui.cancel" : "common.close")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
