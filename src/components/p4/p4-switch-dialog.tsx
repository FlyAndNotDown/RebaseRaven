import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { P4StreamSelect } from "@/components/p4/p4-stream-select";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4StreamOption } from "@/types/p4";

export function P4SwitchDialog({ initialTarget, onClose }: { initialTarget: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { connection, busy: workspaceBusy, listStreams, applySwitch } = useP4();
  const [streams, setStreams] = useState<P4StreamOption[] | null>(null);
  const [target, setTarget] = useState(initialTarget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    void listStreams().then(value => { if (active) setStreams(value); })
      .catch(caught => { if (active) setError(p4DisplayError(errorMessage(caught))); });
    return () => { active = false; };
  }, [listStreams, attempt]);
  const blocked = busy || workspaceBusy;
  async function apply() {
    if (blocked || running.current || !target || target === connection?.stream) return;
    running.current = true; setBusy(true); setError(null);
    try { await applySwitch({ target }); }
    catch (caught) { if (live.current) setError(p4DisplayError(errorMessage(caught))); }
    finally { running.current = false; if (live.current) setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{t("p4.switchStream.title")}</DialogTitle><DialogDescription className="font-mono text-xs">{connection?.client}</DialogDescription></DialogHeader>
      <div className="grid gap-2 rounded-lg border p-3">
        <Label className="text-xs text-muted-foreground">{t("p4.switchStream.current")}</Label>
        <span className="truncate font-mono text-xs" title={connection?.stream ?? ""}>{connection?.stream}</span>
        <ArrowDownIcon className="my-1 size-4 text-muted-foreground" />
        <Label className="text-xs text-muted-foreground">{t("p4.switchStream.target")}</Label>
        <P4StreamSelect streams={streams?.filter(stream => stream.path !== connection?.stream) ?? null} value={target} onChange={value => { setTarget(value); setError(null); }} disabled={blocked} label={t("p4.switchStream.target")} />
      </div>
      {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
      <DialogFooter>
        {!streams && error ? <Button variant="ghost" className="mr-auto" onClick={() => { setError(null); setAttempt(value => value + 1); }}>{t("common.retry")}</Button> : null}
        <Button variant="outline" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={blocked || !target || target === connection?.stream} onClick={() => void apply()}>{busy ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4.switchStream.apply")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function P4SwitchUpdateDialog({ stream, disabled, onClose, onUpdate }: {
  stream: string; disabled: boolean; onClose: () => void; onUpdate: () => void;
}) {
  const { t } = useTranslation();
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{t("p4.switchStream.updateTitle")}</DialogTitle><DialogDescription>{t("p4.switchStream.updateHint")}</DialogDescription></DialogHeader>
      <p className="truncate font-mono text-xs" title={stream}>{stream}</p>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t("p4.switchStream.notNow")}</Button>
        <Button disabled={disabled} onClick={onUpdate}>{t("p4.getLatest")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
