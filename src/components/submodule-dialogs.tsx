import { ChoiceSelect } from "@/components/ui/choice-select";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, InfoIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { formatBytes, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverTip } from "@/components/ui/tooltip";
import { createExclusiveAction, createLatestRequest } from "@/lib/async-scope";
import { errorMessage, gitApi } from "@/lib/git";
import { useGitPick } from "@/state/git-context";
import type { SubmoduleInfo, SubmoduleRemovalKind, SubmoduleUpdateOptions } from "@/types/git";

export type SubmoduleDialogAction =
  | { kind: "edit"; module: SubmoduleInfo }
  | { kind: "update"; paths: string[]; remote: boolean }
  | { kind: "remove"; module: SubmoduleInfo; mode: SubmoduleRemovalKind };
type Mutation = ReturnType<typeof createExclusiveAction>;

function useResource<T>(key: string, load: () => Promise<T>) {
  const [request] = useState(createLatestRequest);
  const [epoch, setEpoch] = useState(0);
  const current = `${key}:${epoch}`;
  const [data, setData] = useState<{ key: string; value: T } | null>(null);
  const [failure, setFailure] = useState<{ key: string; value: string } | null>(null);
  useEffect(() => request.run(load, value => setData({ key: current, value }), error => setFailure({ key: current, value: errorMessage(error) })), [current, load, request]);
  const value = data?.key === current ? data.value : null;
  const error = failure?.key === current ? failure.value : null;
  return { value, error, loading: !value && !error, reload: () => setEpoch(value => value + 1) };
}

function useSave(mutation: Mutation, onClose: () => void) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function run(action: () => Promise<boolean>) {
    void mutation.run(async () => {
      setBusy(true); setError(null);
      try { const ok = await action(); if (mounted.current) { if (ok) onClose(); else setError(t("git.submodule.failed")); } }
      catch (caught) { if (mounted.current) setError(errorMessage(caught)); }
      finally { if (mounted.current) setBusy(false); }
    });
  }
  return { busy, error, run, clearError: () => setError(null) };
}

function Frame({ title, description, busy, error, onClose, children, footer, reload, background = false }: { title: string; description: string; busy: boolean; error: string | null; onClose: () => void; children: ReactNode; footer: ReactNode; reload?: () => void; background?: boolean }) {
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  return <DialogContent ref={content} className="flex max-h-[88vh] flex-col gap-4 sm:max-w-xl" showCloseButton={!busy} onOpenAutoFocus={event => {
    if (!content.current?.querySelector("form input:not([disabled]), form select:not([disabled])")) { event.preventDefault(); content.current?.focus(); }
  }}>
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
    <ScrollArea className="min-h-0 flex-1 -mx-1 px-1"><div className="space-y-4 pb-1">{error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}{children}</div></ScrollArea>
    <DialogFooter className="items-center sm:justify-between">
      {reload ? <HoverTip label={t("git.submodule.reload")}><Button size="icon-sm" variant="ghost" aria-label={t("git.submodule.reload")} disabled={busy} onClick={reload}><RefreshCwIcon /></Button></HoverTip> : <span />}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy && !background} onClick={onClose}>{t(busy && background ? "git.submodule.background" : "common.cancel")}</Button>{footer}</div>
    </DialogFooter>
  </DialogContent>;
}

function Loading() {
  const { t } = useTranslation();
  return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />{t("git.submodule.loading")}</p>;
}

export function AddSubmoduleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { snapshot } = useGitPick(["snapshot"]);
  const [mutation] = useState(createExclusiveAction);
  const repoPath = snapshot?.repo.path;
  return <Dialog open={open} onOpenChange={value => { if (!mutation.busy) onOpenChange(value); }}>{open && repoPath ? <AddForm key={repoPath} repoPath={repoPath} mutation={mutation} onClose={() => onOpenChange(false)} /> : null}</Dialog>;
}

export function SubmoduleDialogs({ repoPath, action, onClose }: { repoPath: string; action: SubmoduleDialogAction; onClose: () => void }) {
  const [mutation] = useState(createExclusiveAction);
  return <Dialog open onOpenChange={open => { if (!open && !mutation.busy) onClose(); }}>
    {action.kind === "edit" ? <EditForm repoPath={repoPath} path={action.module.path} mutation={mutation} onClose={onClose} /> : action.kind === "update" ? <UpdateForm paths={action.paths} remote={action.remote} mutation={mutation} onClose={onClose} /> : <RemoveForm repoPath={repoPath} path={action.module.path} mode={action.mode} mutation={mutation} onClose={onClose} />}
  </Dialog>;
}

function AddForm({ repoPath, mutation, onClose }: { repoPath: string; mutation: Mutation; onClose: () => void }) {
  const { t } = useTranslation();
  const { changeSubmodule } = useGitPick(["changeSubmodule"]);
  const load = useCallback(() => gitApi.submoduleCatalog(repoPath), [repoPath]);
  const resource = useResource(repoPath, load);
  const save = useSave(mutation, onClose);
  const [url, setUrl] = useState(""); const [path, setPath] = useState(""); const [branch, setBranch] = useState("");
  const [name, setName] = useState(""); const [depth, setDepth] = useState(""); const [force, setForce] = useState(false);
  const inheritedBranch = branch.trim() === ".";
  const validDepth = !depth || (/^[1-9]\d*$/.test(depth) && Number(depth) <= 2147483647);
  const blocked = save.busy || resource.loading;
  const duplicate = resource.value?.modules.some(module => module.path === path || module.name === (name.trim() || path));
  const ready = Boolean(resource.value && !resource.error && url.trim() && path && validDepth && !inheritedBranch && !duplicate && !blocked);
  function submit() { if (ready && resource.value) save.run(() => changeSubmodule({ kind: "add", request: { url, path, branch: branch.trim() || null, name: name.trim() || null, depth: depth ? Number(depth) : null, force }, fingerprint: resource.value!.fingerprint })); }
  return <Frame background title={t("git.submodule.addTitle")} description={t("git.submodule.addDescription")} busy={save.busy} error={save.error ?? resource.error} onClose={onClose} reload={() => { save.clearError(); resource.reload(); }} footer={<Button form="add-submodule" type="submit" disabled={!ready}>{save.busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t("git.submodule.add")}</Button>}>
    {resource.loading ? <Loading /> : null}
    {resource.value ? <form id="add-submodule" className="space-y-4" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="space-y-2"><Label htmlFor="add-submodule-url">{t("git.submodule.url")}</Label><Input id="add-submodule-url" autoFocus className="font-mono" value={url} disabled={blocked} placeholder={t("git.submodule.urlPlaceholder")} onChange={event => setUrl(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="submodule-path">{t("git.submodule.path")}</Label><Input id="submodule-path" className="font-mono" value={path} disabled={blocked} placeholder={t("git.submodule.pathPlaceholder")} onChange={event => setPath(event.target.value)} />{duplicate ? <p role="alert" className="text-xs text-destructive">{t("git.submodule.duplicate")}</p> : null}</div>
      <BranchField adding value={branch} disabled={blocked} onChange={setBranch} />
      {inheritedBranch ? <p role="alert" className="text-xs text-destructive">{t("git.submodule.addBranchHelp")}</p> : null}
      <details className="group rounded-md border p-3"><summary className="flex cursor-pointer items-center justify-between text-sm font-medium">{t("git.submodule.options")}<ChevronDownIcon className="size-4 group-open:rotate-180" /></summary><div className="mt-3 space-y-4">
        <div className="space-y-2"><Label htmlFor="submodule-name">{t("git.submodule.name")}</Label><Input id="submodule-name" className="font-mono" value={name} disabled={blocked} placeholder={t("git.submodule.namePlaceholder")} onChange={event => setName(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="submodule-depth">{t("git.submodule.depth")}</Label><Input id="submodule-depth" inputMode="numeric" className="font-mono" value={depth} disabled={blocked} placeholder={t("git.submodule.fullHistory")} aria-invalid={!validDepth} onChange={event => setDepth(event.target.value)} /></div>
        <HoverTip label={t("git.submodule.forceAddHelp")}><label className="flex w-fit items-center gap-2 text-sm"><Checkbox checked={force} disabled={blocked} onCheckedChange={value => setForce(value === true)} />{t("git.submodule.forceAdd")}</label></HoverTip>
      </div></details>
    </form> : null}
  </Frame>;
}

function BranchField({ value, disabled, onChange, adding = false }: { value: string; disabled: boolean; onChange: (value: string) => void; adding?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="space-y-2"><div className="flex items-center gap-2"><Label htmlFor={id}>{t("git.submodule.branch")}</Label><HoverTip label={t(adding ? "git.submodule.addBranchHelp" : "git.submodule.branchHelp")}><InfoIcon className="size-3.5 text-muted-foreground" tabIndex={0} /></HoverTip></div><Input id={id} className="font-mono" aria-invalid={adding && value.trim() === "."} value={value} disabled={disabled} placeholder={t("git.submodule.remoteDefault")} onChange={event => onChange(event.target.value)} /></div>;
}

function EditForm({ repoPath, path, mutation, onClose }: { repoPath: string; path: string; mutation: Mutation; onClose: () => void }) {
  const { t } = useTranslation();
  const { changeSubmodule } = useGitPick(["changeSubmodule"]);
  const load = useCallback(() => gitApi.submoduleSettings(repoPath, path), [repoPath, path]);
  const resource = useResource(JSON.stringify([repoPath, path]), load);
  const save = useSave(mutation, onClose);
  const [draft, setDraft] = useState<{ fingerprint: string; url: string; branch: string } | null>(null);
  const settings = resource.value;
  const current = draft && draft.fingerprint === settings?.fingerprint ? draft : { fingerprint: settings?.fingerprint ?? "", url: settings?.module.url ?? "", branch: settings?.module.branch ?? "" };
  const blocked = save.busy || resource.loading;
  const changed = current.url.trim() !== (settings?.module.url ?? "") || (current.branch.trim() || null) !== settings?.module.branch;
  const ready = Boolean(settings && !resource.error && current.url.trim() && changed && !blocked);
  return <Frame title={t("git.submodule.editTitle")} description={path} busy={save.busy} error={save.error ?? resource.error} onClose={onClose} reload={() => { save.clearError(); resource.reload(); }} footer={<Button form="edit-submodule" type="submit" disabled={!ready}>{save.busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t("common.save")}</Button>}>
    {resource.loading ? <Loading /> : null}
    {settings ? <form id="edit-submodule" className="space-y-4" onSubmit={event => { event.preventDefault(); if (ready) save.run(() => changeSubmodule({ kind: "edit", path, url: current.url, branch: current.branch.trim() || null, fingerprint: current.fingerprint })); }}>
      <div className="space-y-2"><Label htmlFor="submodule-url">{t("git.submodule.url")}</Label><Input id="submodule-url" autoFocus className="font-mono" value={current.url} disabled={blocked} onChange={event => setDraft({ ...current, url: event.target.value })} /></div>
      <BranchField value={current.branch} disabled={blocked} onChange={branch => setDraft({ ...current, branch })} />
      <p className="text-xs text-muted-foreground">{t("git.submodule.editHelp")}</p>
    </form> : null}
  </Frame>;
}

function UpdateForm({ paths, remote, mutation, onClose }: { paths: string[]; remote: boolean; mutation: Mutation; onClose: () => void }) {
  const { t } = useTranslation();
  const { updateSubmodules } = useGitPick(["updateSubmodules"]);
  const [fromRemote, setFromRemote] = useState(remote);
  const [strategy, setStrategy] = useState<SubmoduleUpdateOptions["strategy"]>("checkout");
  const [recursive, setRecursive] = useState(true);
  const save = useSave(mutation, onClose);
  return <Frame background title={t("git.submodule.updateTitle")} description={paths.length === 1 ? paths[0] : t("git.submodule.all")} busy={save.busy} error={save.error} onClose={onClose} footer={<Button form="update-submodule" type="submit" disabled={save.busy}>{save.busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t("git.submodule.update")}</Button>}>
    <form id="update-submodule" className="space-y-4" onSubmit={event => { event.preventDefault(); save.run(() => updateSubmodules(paths, { remote: fromRemote, recursive, fetch: true, strategy })); }}>
      <div className="space-y-2"><Label htmlFor="submodule-source">{t("git.submodule.source")}</Label><ChoiceSelect id="submodule-source" value={fromRemote ? "remote" : "recorded"} disabled={save.busy} onValueChange={value => setFromRemote(value === "remote")} options={[{value:"recorded",label:t("git.submodule.recorded")},{value:"remote",label:t("git.submodule.remote")}]} /></div>
      <div className="space-y-2"><Label htmlFor="submodule-strategy">{t("git.submodule.strategy")}</Label><ChoiceSelect id="submodule-strategy" value={strategy} disabled={save.busy} onValueChange={setStrategy} options={[{value:"checkout",label:t("git.submodule.checkout")},{value:"merge",label:t("git.submodule.merge")},{value:"rebase",label:t("git.submodule.rebase")}]} /></div>
      <label className="flex w-fit items-center gap-2 text-sm"><Checkbox checked={recursive} disabled={save.busy} onCheckedChange={value => setRecursive(value === true)} />{t("git.submodule.recursive")}</label>
    </form>
  </Frame>;
}

function RemoveForm({ repoPath, path, mode, mutation, onClose }: { repoPath: string; path: string; mode: SubmoduleRemovalKind; mutation: Mutation; onClose: () => void }) {
  const { t } = useTranslation();
  const { changeSubmodule } = useGitPick(["changeSubmodule"]);
  const [force, setForce] = useState(false);
  const load = useCallback(() => gitApi.previewSubmoduleRemoval(repoPath, path, mode, force), [repoPath, path, mode, force]);
  const resource = useResource(JSON.stringify([repoPath, path, mode, force]), load);
  const save = useSave(mutation, onClose);
  const preview = resource.value;
  return <Frame title={t(mode === "deinit" ? "git.submodule.deinitTitle" : "git.submodule.removeTitle")} description={t(mode === "deinit" ? "git.submodule.deinitDescription" : "git.submodule.removeDescription")} busy={save.busy} error={save.error ?? resource.error} onClose={onClose} reload={() => { save.clearError(); resource.reload(); }} footer={<Button variant="destructive" disabled={save.busy || !preview || Boolean(resource.error) || (preview.dirty && !force)} onClick={() => { if (preview) save.run(() => changeSubmodule({ kind: "remove", path, mode, force, fingerprint: preview.fingerprint })); }}>{save.busy ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : null}{t(mode === "deinit" ? "git.submodule.deinit" : "git.submodule.remove")}</Button>}>
    {resource.loading ? <Loading /> : null}
    <p className="break-all font-mono text-sm">{path}</p>
    {preview ? <div className="flex flex-wrap gap-2"><Badge variant="outline">{t("git.submodule.fileCount", { count: preview.files })}</Badge><Badge variant="outline">{formatBytes(preview.bytes)}</Badge>{preview.dirty ? <Badge variant="outline">{t("git.submodule.localChanges")}</Badge> : null}</div> : null}
    <HoverTip label={t("git.submodule.forceRemoveHelp")}><label className="flex w-fit items-center gap-2 text-sm"><Checkbox checked={force} disabled={save.busy} onCheckedChange={value => setForce(value === true)} />{t("git.submodule.forceRemove")}</label></HoverTip>
    <p className="text-xs text-muted-foreground">{t("git.submodule.historyKept")}</p>
  </Frame>;
}
