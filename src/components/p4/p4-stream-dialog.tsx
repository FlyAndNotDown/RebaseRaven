import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, GitMergeIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { P4StreamSelect } from "@/components/p4/p4-stream-select";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { errorMessage } from "@/lib/git";
import { P4IntegrationFiles } from "@/components/p4/p4-integration-files";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4StreamOption, P4StreamPreview, P4StreamRequest } from "@/types/p4";

export function P4StreamDialog({ onClose, initial }: { onClose: () => void; initial?: Pick<P4StreamRequest,"mode"|"source"> | null }) {
  const { t } = useTranslation();
  const p4 = useP4();
  const listStreams = p4.listStreams;
  const [streams, setStreams] = useState<P4StreamOption[] | null>(null);
  const [mode, setMode] = useState<P4StreamRequest["mode"]>(initial?.mode ?? "merge");
  const [child, setChild] = useState(initial?.mode === "copy" ? initial.source : "");
  const [changeId, setChangeId] = useState(p4.selectedChange);
  const [preview, setPreview] = useState<{ key: string; value: P4StreamPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const running = useRef(false);
  const target = p4.connection?.stream ?? "";
  const current = streams?.find((stream) => stream.path === target);
  const children = streams?.filter((stream) => stream.parent === target) ?? [];
  const source = mode === "merge" ? current?.parent?.startsWith("//") ? current.parent : "" : child || children[0]?.path || "";
  const request: P4StreamRequest = { mode, source, changeId };
  const key = JSON.stringify([p4.connection, request]);
  const approved = preview?.key === key && preview.value.files.length > 0;
  const blocked = busy !== null || p4.busy;

  useEffect(() => {
    mounted.current = true;
    void listStreams().then((next) => {
      if (!mounted.current) return;
      setStreams(next);
      if (!initial) setMode(next.find((stream) => stream.path === target)?.parent?.startsWith("//") ? "merge" : "copy");
    }).catch((caught: unknown) => { if (mounted.current) setError(p4DisplayError(errorMessage(caught))); });
    return () => { mounted.current = false; };
  }, [listStreams, target, attempt, initial]);

  function edit(update: () => void) { setPreview(null); setError(null); update(); }

  async function inspect() {
    if (!source || blocked || running.current) return;
    running.current = true; setBusy("preview"); setError(null); setPreview(null);
    try {
      const value = await p4.previewStream(request);
      if (mounted.current) setPreview({ key, value });
    } catch (caught) { if (mounted.current) setError(p4DisplayError(errorMessage(caught))); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  async function apply() {
    if (!approved || !preview || blocked || running.current) return;
    running.current = true; setBusy("apply"); setError(null);
    try { await p4.applyStream(request, preview.value); onClose(); }
    catch (caught) { if (mounted.current) { setError(p4DisplayError(errorMessage(caught))); setPreview(null); } }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && busy !== "apply") onClose(); }}>
    <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl" showCloseButton={busy !== "apply"}>
      <DialogHeader><DialogTitle>{t("p4.streams.title")}</DialogTitle><DialogDescription className="truncate font-mono text-xs">{p4.connection?.client}</DialogDescription></DialogHeader>
      <SegmentedControl label={t("p4.streams.operation")} value={mode} disabled={blocked || !streams} onChange={(value) => edit(() => setMode(value))} options={[{ value: "merge", label: t("p4.streams.merge") }, { value: "copy", label: t("p4.streams.copy") }]} />
      <div className="grid gap-2 rounded-lg border p-3">
        <Label className="text-xs text-muted-foreground">{t("p4.streams.source")}</Label>
        {mode === "copy" && children.length ? <P4StreamSelect streams={children} value={source} onChange={(value) => edit(() => setChild(value))} disabled={blocked} label={t("p4.streams.source")} /> : <p className="break-all font-mono text-xs">{source || t(streams ? "p4.streams.noSource" : "p4.streams.loading")}</p>}
        <ArrowDownIcon className="size-4 text-muted-foreground" />
        <Label className="text-xs text-muted-foreground">{t("p4.streams.target")}</Label><p className="break-all font-mono text-xs">{target}</p>
      </div>
      <div className="flex items-center justify-between gap-3"><Label>{t("p4-operations.pendingChange")}</Label><P4ChangeSelect value={changeId} onChange={(value) => edit(() => setChangeId(value))} disabled={blocked} /></div>
      <P4IntegrationFiles root={p4.connection?.root ?? ""} files={preview?.value.files ?? []} previewed={Boolean(preview)} loading={busy === "preview"} />
      <p className="text-xs text-muted-foreground">{t(mode === "merge" ? "p4.streams.mergeHint" : "p4.streams.copyHint")}</p>
      {error ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error}</p> : null}
      <DialogFooter>
        {!streams && error ? <Button variant="ghost" className="mr-auto" onClick={() => { setError(null); setAttempt((value) => value + 1); }}>{t("common.retry")}</Button> : null}
        <Button variant="outline" disabled={busy === "apply"} onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="outline" disabled={blocked || !source} onClick={() => void inspect()}>{busy === "preview" ? <LoaderCircleIcon className="animate-spin" /> : null}{t("p4-operations.preview")}</Button>
        <Button disabled={blocked || !approved} onClick={() => void apply()}>{busy === "apply" ? <LoaderCircleIcon className="animate-spin" /> : <GitMergeIcon />}{t(mode === "merge" ? "p4.streams.merge" : "p4.streams.copy")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
