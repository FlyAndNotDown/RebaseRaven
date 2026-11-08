import { useEffect, useId, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon, InfoIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { HoverTip } from "@/components/ui/tooltip";
import { createExclusiveAction, createLatestRequest } from "@/lib/async-scope";
import { errorMessage, gitApi } from "@/lib/git";
import { fileName, pathsIgnoreCase, sameRepoPath } from "@/lib/format";
import { useGitPick } from "@/state/git-context";
import type { WorktreeInfo, WorktreePreview, WorktreeRequest } from "@/types/git";

export type WorktreeDialogAction = { kind: "repairAll" } | { kind: Exclude<WorktreeRequest["kind"], "repairAll">; tree: WorktreeInfo };

export function WorktreeDialog({ repoPath, action, onClose, onDone }: {
  repoPath: string;
  action: WorktreeDialogAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { changeWorktree, openPath, tabs } = useGitPick(["changeWorktree", "openPath", "tabs"]);
  const tree = "tree" in action ? action.tree : null;
  const needsFolder = action.kind === "move" || action.kind === "repair";
  const [destination, setDestination] = useState(action.kind === "move" ? `${tree?.path}-moved` : "");
  const [reason, setReason] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [request] = useState(createLatestRequest);
  const [mutation] = useState(createExclusiveAction);
  const [result, setResult] = useState<{ key: string; value: WorktreePreview } | null>(null);
  const [failure, setFailure] = useState<{ key: string; value: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const mounted = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const formId = useId();
  const value: WorktreeRequest = { kind: action.kind, path: tree?.path ?? "", destination, reason };
  const key = JSON.stringify([repoPath, value, epoch]);
  const complete = !needsFolder || Boolean(destination);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!complete) return;
    let cancel: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      const [path, input] = JSON.parse(key) as [string, WorktreeRequest, number];
      cancel = request.run(() => gitApi.previewWorktreeChange(path, input), next => setResult({ key, value: next }), caught => setFailure({ key, value: errorMessage(caught) }));
    }, 200);
    return () => { window.clearTimeout(timer); cancel?.(); };
  }, [complete, key, request]);
  const preview = result?.key === key ? result.value : null;
  const previewError = failure?.key === key ? failure.value : null;
  const sourceTab = preview?.tree ? tabs.find(tab => tab.kind === "repo" && tab.vcs === "git" && sameRepoPath(tab.path, preview.tree!.path)) : null;
  const destinationTab = preview?.destination ? tabs.find(tab => tab.kind === "repo" && tab.vcs === "git" && sameRepoPath(tab.path, preview.destination)) : null;
  const duplicate = sourceTab && destinationTab && sourceTab.id !== destinationTab.id;
  const error = saveError ?? previewError ?? (duplicate ? t("git.worktree.duplicateTabs") : null);
  const ready = Boolean(preview && !error && !busy && !browsing);
  function reload() { setSaveError(null); setEpoch(next => next + 1); }
  async function browse() {
    setBrowsing(true);
    try {
      const chosen = await open({ defaultPath: repoPath, directory: true, multiple: false, title: t(action.kind === "move" ? "git.worktree.chooseParent" : "git.worktree.chooseRelocated") });
      if (mounted.current && typeof chosen === "string") {
        const name = fileName(tree?.path ?? "") || "worktree";
        setDestination(action.kind === "move" ? `${chosen.replace(pathsIgnoreCase() ? /[/\\]+$/ : /\/+$/, "")}/${name}` : chosen);
        setSaveError(null);
      }
    } catch (caught) { if (mounted.current) setSaveError(errorMessage(caught)); }
    finally { if (mounted.current) setBrowsing(false); }
  }
  function save() {
    if (!ready || !preview) return;
    void mutation.run(async () => {
      setBusy(true); setSaveError(null);
      try {
        if (await changeWorktree(value, preview)) {
          toast.success(t(`git.worktree.${action.kind}Done`), preview.destination ? { action: { label: t("git.ui.open"), onClick: () => void openPath(preview.destination, "git") } } : undefined);
          if (mounted.current) { onDone(); onClose(); }
        } else if (mounted.current) setSaveError(t("git.worktree.failed"));
      } catch (caught) { if (mounted.current) setSaveError(errorMessage(caught)); }
      finally { if (mounted.current) setBusy(false); }
    });
  }
  return <Dialog open onOpenChange={next => { if (!next && !mutation.busy && !browsing) onClose(); }}>
    <DialogContent ref={content} className="flex max-h-[88vh] flex-col sm:max-w-xl" showCloseButton={!busy && !browsing} onOpenAutoFocus={event => {
      event.preventDefault();
      const input = content.current?.querySelector<HTMLInputElement>("input:not([disabled])");
      if (input) { input.focus(); input.select(); } else content.current?.focus();
    }}>
      <ScrollArea className="-mx-1 min-h-0 flex-1 px-1"><form id={formId} className="space-y-4" onSubmit={event => { event.preventDefault(); save(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{t(`git.worktree.${action.kind}Title`)}<HoverTip label={t(`git.worktree.${action.kind}Help`)}><InfoIcon className="size-3.5 text-muted-foreground" tabIndex={0} /></HoverTip></DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{tree?.path ?? repoPath}</DialogDescription>
        </DialogHeader>
        {action.kind === "lock" ? <div className="space-y-2"><Label htmlFor={`${formId}-reason`}>{t("git.worktree.reason")}</Label><Input id={`${formId}-reason`} autoFocus value={reason} maxLength={4096} disabled={busy} placeholder={t("git.worktree.optionalReason")} onChange={event => { setReason(event.target.value); setSaveError(null); }} /></div> : null}
        {action.kind === "unlock" && (preview?.tree?.lockReason || tree?.lockReason) ? <p className="break-words rounded-md border p-3 text-sm text-muted-foreground">{preview?.tree?.lockReason || tree?.lockReason}</p> : null}
        {needsFolder ? <div className="space-y-2">
          <Label htmlFor={`${formId}-folder`}>{t(action.kind === "move" ? "git.worktree.destination" : "git.worktree.relocatedFolder")}</Label>
          <div className="flex items-center gap-2"><Input id={`${formId}-folder`} autoFocus value={destination} disabled={busy || browsing} spellCheck={false} className="font-mono" onChange={event => { setDestination(event.target.value); setSaveError(null); }} /><HoverTip label={t("git.worktree.browse")}><Button type="button" variant="outline" size="icon" disabled={busy || browsing} aria-label={t("git.worktree.browse")} onClick={() => void browse()}><FolderOpenIcon /></Button></HoverTip></div>
        </div> : null}
        {complete && !preview && !previewError ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />{t("git.worktree.inspecting")}</p> : null}
        {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
      </form></ScrollArea>
      <DialogFooter className="items-center sm:justify-between">
        <HoverTip label={t("git.worktree.reload")}><Button variant="ghost" size="icon-sm" disabled={busy || browsing} aria-label={t("git.worktree.reload")} onClick={reload}><RefreshCwIcon /></Button></HoverTip>
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy || browsing} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" form={formId} disabled={!ready}>{busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t(`git.worktree.${action.kind}Action`)}</Button></div>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
