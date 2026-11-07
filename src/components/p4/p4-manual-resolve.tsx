import { useEffect, useRef, useState } from "react";
import { GitMergeIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { depotBase } from "@/lib/p4";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4ManualResolve } from "@/types/p4";

export function P4ManualResolve({ path, onClose, onBack }: { path: string; onClose: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  const { manualResolveView, manualResolveApply, busy: workspaceBusy } = useP4();
  const [view, setView] = useState<P4ManualResolve | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState<"close" | "back" | null>(null);
  const running = useRef(false);
  const dirty = view !== null && text !== view.yours.replace(/\r\n/g, "\n");

  useEffect(() => {
    let live = true;
    void manualResolveView(path).then((next) => {
      if (live) { setView(next); setText(next.yours.replace(/\r\n/g, "\n")); }
    }).catch((caught: unknown) => { if (live) setError(p4DisplayError(errorMessage(caught))); });
    return () => { live = false; };
  }, [path, manualResolveView, attempt]);

  function close(destination: "close" | "back") {
    if (running.current) return;
    if (dirty) setDiscard(destination);
    else if (destination === "back") onBack();
    else onClose();
  }

  async function apply() {
    if (!view || running.current || workspaceBusy) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = view.yours.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text;
      await manualResolveApply(path, result, view.fingerprint);
      onClose();
    } catch (caught) { setError(p4DisplayError(errorMessage(caught))); }
    finally { running.current = false; setBusy(false); }
  }

  return <>
    <Dialog open onOpenChange={(open) => { if (!open) close("close"); }}>
      <DialogContent className="flex max-h-[92vh] flex-col sm:max-w-[min(76rem,94vw)]" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("p4.manual.title", { file: depotBase(path) })}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={path}>{path}</DialogDescription>
        </DialogHeader>
        {view ? <>
          <div className="grid min-h-0 grid-cols-3 gap-2">
            {(["base", "yours", "theirs"] as const).map((side) => <div key={side} className="min-w-0 overflow-hidden rounded-md border">
              <div className="flex h-8 items-center border-b bg-muted/40 px-3 text-xs font-medium">{t(`p4.manual.${side}`)}</div>
              <Textarea aria-label={t(`p4.manual.${side}`)} value={view[side]} readOnly spellCheck={false} wrap="off" className="h-[22vh] resize-none rounded-none border-0 bg-transparent! font-mono text-xs! leading-5 shadow-none [field-sizing:fixed]" />
            </div>)}
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden rounded-md border">
            <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3">
              <span className="text-xs font-medium">{t("p4.manual.result")}</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => setText(view.yours.replace(/\r\n/g, "\n"))}>{t("p4.manual.useYours")}</Button>
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => setText(view.theirs.replace(/\r\n/g, "\n"))}>{t("p4.manual.useTheirs")}</Button>
              </div>
            </div>
            <Textarea aria-label={t("p4.manual.result")} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} spellCheck={false} wrap="off" className="h-[28vh] resize-none rounded-none border-0 bg-transparent! font-mono text-xs! leading-5 shadow-none [field-sizing:fixed]" />
          </div>
          <p className="text-xs text-muted-foreground">{t("p4.manual.hint")}</p>
        </> : !error ? <div role="status" className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />{t("p4.loadingResolve")}</div> : null}
        {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => close("back")}>{t("p4.manual.back")}</Button>
          {!view && error ? <Button variant="outline" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>{t("common.retry")}</Button> : null}
          <Button variant="outline" disabled={busy} onClick={() => close("close")}>{t("common.cancel")}</Button>
          <Button disabled={!view || busy || workspaceBusy} onClick={() => void apply()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : <GitMergeIcon />}{t("p4.manual.apply")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={discard !== null} onOpenChange={(open) => { if (!open) setDiscard(null); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{t("p4.manual.discardTitle")}</DialogTitle><DialogDescription>{t("p4.manual.discardHint")}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={() => setDiscard(null)}>{t("common.cancel")}</Button><Button variant="destructive" onClick={() => { if (discard === "back") onBack(); else onClose(); }}>{t("p4.manual.discard")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
