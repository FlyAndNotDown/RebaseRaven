import { useEffect, useMemo, useRef, useState } from "react";
import { GitMergeIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { ConflictTextEditor } from "@/components/conflict-editor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { depotBase } from "@/lib/p4";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { hasConflictMarkers, threeWayText } from "@/lib/three-way-text";
import { useP4 } from "@/state/p4-context";
import type { P4ManualResolve } from "@/types/p4";

const displayError = (error: unknown) => p4DisplayError(errorMessage(error));

export function P4ManualResolve({ path, onClose, onBack, external = false }: { path: string; onClose: () => void; onBack: () => void; external?: boolean }) {
  const { t } = useTranslation();
  const { manualResolveView, manualResolveApply, manualResolveExternal, busy: workspaceBusy } = useP4();
  const [view, setView] = useState<P4ManualResolve | null>(null);
  const [externalResult, setExternalResult] = useState<string | null>(null);
  const [externalUsed, setExternalUsed] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState<"close" | "back" | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  const externalStarted = useRef(false);
  const initial = useMemo(() => view ? threeWayText(view.base, view.yours, view.theirs).replace(/\r\n/g, "\n") : "", [view]);
  const text = edited ?? externalResult ?? initial;
  const dirty = text !== initial;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await manualResolveView(path);
        if (live) setView(next);
      } catch (caught) { if (live) setError(displayError(caught)); }
    })();
    return () => { live = false; };
  }, [path, manualResolveView, attempt]);

  useEffect(() => {
    if (!view || !external || externalStarted.current) return;
    externalStarted.current = true;
    running.current = true;
    setBusy(true);
    void manualResolveExternal(path, initial, view.fingerprint)
      .then((result) => {
        if (!mounted.current) return;
        const next = result.replace(/\r\n/g, "\n");
        setExternalResult(next);
        setEdited(next);
        setExternalUsed(true);
      })
      .catch((caught: unknown) => { if (mounted.current) setError(displayError(caught)); })
      .finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  }, [view, external, path, initial, manualResolveExternal]);

  function close(destination: "close" | "back") {
    if (running.current || workspaceBusy) return;
    if (dirty) setDiscard(destination);
    else if (destination === "back") onBack();
    else onClose();
  }

  async function save() {
    if (!view || hasConflictMarkers(text) || running.current || workspaceBusy) return;
    running.current = true; setBusy(true); setError(null);
    try {
      await manualResolveApply(path, view.yours.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text, view.fingerprint);
      onClose();
    } catch (caught) { setError(displayError(caught)); }
    finally { running.current = false; setBusy(false); }
  }

  async function runExternal(text: string) {
    if (!view || running.current || workspaceBusy) return;
    running.current = true; setBusy(true); setError(null);
    try { const result = await manualResolveExternal(path, text, view.fingerprint); setExternalUsed(true); return result; }
    finally { running.current = false; setBusy(false); }
  }

  return <>
    <Dialog open onOpenChange={(open) => { if (!open) close("close"); }}>
      <DialogContent className="flex h-[min(52rem,92dvh)] w-[96vw] flex-col sm:max-w-[min(88rem,96vw)]" showCloseButton={!busy && !workspaceBusy}>
        <DialogHeader>
          <DialogTitle>{t("p4.manual.title", { file: depotBase(path) })}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={path}>{path}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
          {view ? <ConflictTextEditor path={path} key={`${view.fingerprint}:${externalResult !== null}`} initialText={externalResult ?? initial} current={t("p4.manual.yours")} incoming={t("p4.manual.theirs")} onExternal={runExternal} disabled={busy || workspaceBusy} onTextChange={setEdited} displayError={displayError} />
            : !error ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />{t(busy ? "p4.manual.externalWaiting" : "p4.loadingResolve")}</div> : <p role="alert" className="p-4 text-sm text-destructive">{error}</p>}
        </div>
        {view && error ? <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p> : null}
        <p className="shrink-0 text-xs text-muted-foreground">{t(externalUsed ? "p4.manual.externalConfirmHint" : "p4.manual.hint")}</p>
        <DialogFooter>
          <Button variant="ghost" className="mr-auto" disabled={busy || workspaceBusy} onClick={() => close("back")}>{t("p4.manual.back")}</Button>
          {!view && error ? <Button variant="outline" disabled={busy || workspaceBusy} onClick={() => { setError(null); setAttempt((value) => value + 1); }}>{t("common.retry")}</Button> : null}
          <Button variant="outline" disabled={busy || workspaceBusy} onClick={() => close("close")}>{t("common.cancel")}</Button>
          <Button disabled={!view || busy || workspaceBusy || hasConflictMarkers(text)} onClick={() => void save()}>
            {busy ? <LoaderCircleIcon className="animate-spin" /> : <GitMergeIcon />}
            {t(externalUsed ? "p4.manual.confirmExternal" : "p4.manual.apply")}
          </Button>
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
