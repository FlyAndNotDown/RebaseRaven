import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { BrushCleaningIcon, FolderIcon, ListChecksIcon, LoaderCircleIcon, PlusIcon, ScanSearchIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { P4ChangeSelect } from "@/components/p4/p4-change-select";
import { useTranslation } from "@/i18n";
import { sameRepoPath } from "@/lib/format";
import { errorMessage, isCancelled } from "@/lib/git";
import { relativeToRoot } from "@/lib/p4";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { addScanFolders } from "@/lib/p4-workspace-scan";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { useP4 } from "@/state/p4-context";
import type { P4CleanRequest, P4FileApproval } from "@/types/p4";

type Operation = "clean" | "reconcile";
type ScanFile = P4FileApproval & { action: string; revision?: string | null };
type ScanResult = { files: ScanFile[]; fingerprint: string };
const cleanOptions = ["restoreModified", "restoreMissing", "removeUntracked", "includeIgnored"] as const;

function ScanResults({ files, picked, onPick, operation, root, disabled }: {
  files: ScanFile[]; picked: Set<string>; onPick: (picked: Set<string>) => void;
  operation: Operation; root: string; disabled: boolean;
}) {
  const { t } = useTranslation();
  const { viewportRef, before, after, start, end } = useWindowedRows(files.length, 36, 6, 280);
  if (!files.length) return <p role="status" className="rounded-md border p-6 text-center text-sm text-muted-foreground">
    {t(operation === "clean" ? "p4.clean.empty" : "p4.reconcileReview.empty")}
  </p>;
  return <section className="flex min-h-0 flex-col gap-2">
    <label className="flex items-center gap-2 text-xs">
      <Checkbox disabled={disabled} checked={picked.size === files.length || (picked.size ? "indeterminate" : false)}
        onCheckedChange={checked => onPick(new Set(checked ? files.map(file => file.path) : []))} />
      {t("p4.reconcileReview.selected", {count: picked.size, total: files.length})}
    </label>
    <div ref={viewportRef} className="min-h-0 max-h-72 overflow-auto rounded-md border">
      <div style={{paddingTop: before, paddingBottom: after}}>
        {files.slice(start, end).map(file => {
          const label = relativeToRoot(root, file.path) || file.path;
          return <label key={file.path} className="flex h-9 cursor-pointer items-center gap-3 border-b px-3 text-xs last:border-0 hover:bg-muted/50">
            <Checkbox aria-label={label} disabled={disabled} checked={picked.has(file.path)} onCheckedChange={checked => {
              const next = new Set(picked);
              if (checked) next.add(file.path); else next.delete(file.path);
              onPick(next);
            }} />
            <span className="w-28 shrink-0 text-muted-foreground">{t(operation === "clean" ? `p4.clean.actions.${file.action}` : `p4.reconcileReview.${file.action}`)}</span>
            <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>{label}</span>
            {file.revision && <span className="font-mono text-muted-foreground" title={t("p4.clean.haveHint")}>#{file.revision}</span>}
          </label>;
        })}
      </div>
    </div>
  </section>;
}

export function P4WorkspaceScanDialog({ operation, scope, onClose }: {
  operation: Operation; scope?: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const p4 = useP4();
  const root = p4.connection?.root ?? "";
  const clean = operation === "clean";
  const [request, setRequest] = useState<P4CleanRequest>(() => ({
    scopes: scope && !sameRepoPath(root, scope) ? [scope] : [],
    restoreModified: true, restoreMissing: true, removeUntracked: true, includeIgnored: false,
  }));
  const [review, setReview] = useState<ScanResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [change, setChange] = useState(p4.selectedChange);
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [activeFolder, setActiveFolder] = useState("");
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const scanRef = useRef<AbortController | null>(null);
  const applyingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; scanRef.current?.abort(); };
  }, []);

  async function addFolders() {
    if (choosing || scanning || applying) return;
    setChoosing(true);
    try {
      const paths = await open({ directory: true, multiple: true, defaultPath: root, title: t("p4.scan.addFolders") });
      if (!paths || !mounted.current || scanRef.current) return;
      const scopes = addScanFolders(root, request.scopes, paths);
      if (!scopes) { setError(t("p4.scan.outside")); return; }
      setRequest({...request, scopes});
      setError("");
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught));
    } finally {
      if (mounted.current) setChoosing(false);
    }
  }

  const hasActions = !clean || request.restoreModified || request.restoreMissing || request.removeUntracked;
  const blocked = p4.busy || choosing || scanning || applying;
  async function scan() {
    if (blocked || scanRef.current || !request.scopes.length || !hasActions) return;
    const controller = new AbortController();
    scanRef.current = controller;
    setActiveFolder("");
    setScanning(true);
    setError("");
    try {
      const onFolder = (path: string) => {
        if (mounted.current && scanRef.current === controller && !controller.signal.aborted) setActiveFolder(path);
      };
      const result = clean ? await p4.previewClean(request, controller.signal, onFolder) : await p4.previewReconcile(request.scopes, controller.signal, onFolder);
      if (mounted.current && !controller.signal.aborted) {
        setReview(result);
        setPicked(new Set(result.files.map(file => file.path)));
      }
    } catch (caught) {
      if (mounted.current && !controller.signal.aborted && !isCancelled(caught)) setError(p4DisplayError(caught));
    } finally {
      scanRef.current = null;
      if (mounted.current) setScanning(false);
    }
  }

  async function apply() {
    if (!review || blocked || applyingRef.current || !picked.size) return;
    applyingRef.current = true;
    setApplying(true);
    setError("");
    try {
      const files = review.files.filter(file => picked.has(file.path)).map(({path, fingerprint}) => ({path, fingerprint}));
      if (clean) await p4.applyClean(request, files, review.fingerprint);
      else await p4.applyReconcile(files, change, review.fingerprint, request.scopes);
      if (mounted.current) onClose();
    } catch (caught) {
      if (mounted.current) {
        setReview(null);
        setPicked(new Set());
        setError(p4DisplayError(caught));
      }
    } finally {
      applyingRef.current = false;
      if (mounted.current) setApplying(false);
    }
  }

  function close() {
    if (applyingRef.current) return;
    scanRef.current?.abort();
    onClose();
  }
  const removed = clean ? review?.files.filter(file => file.action === "removeUntracked" && picked.has(file.path)).length ?? 0 : 0;
  const folderLabel = (path: string) => relativeToRoot(root, path) || path;
  return <Dialog open onOpenChange={value => { if (!value) close(); }}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl" showCloseButton={!applying}>
      <DialogHeader>
        <DialogTitle>{t(clean ? "p4.clean.title" : "p4.reconcileReview.title")}</DialogTitle>
        <DialogDescription className="truncate font-mono text-xs">{p4.connection?.client}</DialogDescription>
      </DialogHeader>
      {review ? <>
        <ScanResults files={review.files} picked={picked} onPick={setPicked} operation={operation} root={root} disabled={blocked} />
        {review.files.length > 0 && (clean ? <div className="space-y-1 text-xs">
          <p>{t("p4.clean.summary", {restore: picked.size - removed, remove: removed})}</p>
          <p className="text-muted-foreground">{t("p4.clean.confirmHint")}</p>
        </div> : <div className="flex items-center justify-between gap-3 text-sm">
          {t("p4-operations.pendingChange")}<P4ChangeSelect value={change} onChange={setChange} disabled={blocked} />
        </div>)}
        {!clean && review.files.length > 0 && <p className="text-xs text-muted-foreground">{t("p4.reconcileReview.hint")}</p>}
      </> : <>
        <section className="grid min-h-0 gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">{t("p4.scan.folders")}</h3>
            <Button size="sm" variant="outline" disabled={blocked} onClick={() => void addFolders()}><PlusIcon />{t("p4.scan.addFolders")}</Button>
          </div>
          <div className="max-h-40 overflow-auto rounded-md border">
            {request.scopes.length ? request.scopes.map(path => <div key={path} className="flex h-9 items-center gap-2 border-b px-3 text-xs last:border-0">
              {scanning && sameRepoPath(path, activeFolder) ? <LoaderCircleIcon aria-label={t("p4.scan.scanning")} className="size-4 shrink-0 animate-spin" /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span title={path} className="flex-1 truncate font-mono">{folderLabel(path)}</span>
              <Button variant="ghost" size="icon-xs" aria-label={t("p4.scan.remove", {folder: folderLabel(path)})} disabled={blocked}
                onClick={() => setRequest({...request, scopes: request.scopes.filter(item => item !== path)})}><XIcon /></Button>
            </div>) : <p className="px-3 py-5 text-center text-xs text-muted-foreground">{t("p4.scan.choose")}</p>}
          </div>
        </section>
        {clean && <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {cleanOptions.map(key => <label key={key} className="flex items-center gap-2 text-xs">
            <Checkbox checked={request[key]} disabled={blocked} onCheckedChange={value => setRequest({...request, [key]: value === true})} />
            {t(`p4.clean.options.${key}`)}
          </label>)}
        </div>}
      </>}
      {error && <p role="alert" className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-destructive">{error}</p>}
      <DialogFooter>
        {review && <Button variant="ghost" className="mr-auto" disabled={blocked} onClick={() => {setReview(null); setPicked(new Set());}}>{t("p4.clean.back")}</Button>}
        <Button variant="outline" disabled={applying} onClick={close}>{t("common.cancel")}</Button>
        {review ? <Button disabled={blocked || !picked.size} variant={clean ? "destructive" : "default"} onClick={() => void apply()}>
          {applying ? <LoaderCircleIcon className="animate-spin" /> : clean ? <BrushCleaningIcon /> : <ListChecksIcon />}
          {t(clean ? "p4.clean.apply" : "p4.reconcileReview.apply", {count: picked.size})}
        </Button> : <Button disabled={blocked || !request.scopes.length || !hasActions} onClick={() => void scan()}>
          {scanning ? <LoaderCircleIcon className="animate-spin" /> : <ScanSearchIcon />}
          {t(scanning ? "p4.scan.scanning" : "p4.scan.start")}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
