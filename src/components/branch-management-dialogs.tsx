import { useEffect, useState } from "react";
import { InfoIcon, Loader2Icon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { HoverTip } from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { errorMessage, gitApi } from "@/lib/git";
import { createExclusiveAction } from "@/lib/async-scope";
import type { BranchInfo, RemoteInfo, RemotePushSettings } from "@/types/git";

function useDialogSave(onDone: () => void) {
  const [mutation] = useState(createExclusiveAction);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  function save(action: () => Promise<boolean>) {
    void mutation.run(async () => {
      setBusy(true);
      setFailed(false);
      try {
        if (await action()) onDone();
        else setFailed(true);
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    });
  }
  return { mutation, busy, failed, setFailed, save };
}

export function RenameBranchDialog({branch,...props}: {
  branch:BranchInfo;
  existingNames:string[];
  onOpenChange:(open:boolean)=>void;
  onRename:(name:string,newName:string)=>Promise<boolean>;
}) { return <RenameGitItemDialog originalName={branch.name} kind="branch" {...props} />; }

export function RenameRemoteDialog(props: {
  name:string;
  existingNames:string[];
  onOpenChange:(open:boolean)=>void;
  onRename:(name:string,newName:string)=>Promise<boolean>;
}) { return <RenameGitItemDialog originalName={props.name} kind="remote" {...props} />; }

function RenameGitItemDialog({originalName,kind,existingNames,onOpenChange,onRename}: {
  originalName:string;
  kind:"branch"|"remote";
  existingNames:string[];
  onOpenChange:(open:boolean)=>void;
  onRename:(name:string,newName:string)=>Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(originalName);
  const { mutation, busy, failed, setFailed, save } = useDialogSave(() => onOpenChange(false));
  const next = name.trim();
  const taken = next !== originalName && existingNames.includes(next);
  return (
    <Dialog open onOpenChange={(open) => { if (!mutation.busy) onOpenChange(open); }}>
      <DialogContent>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!next || next === originalName || taken || busy) return;
          save(() => onRename(originalName, next));
        }}>
          <DialogHeader>
            <DialogTitle>{t(`git.${kind}.renameTitle`)}</DialogTitle>
            <DialogDescription>{t(`git.${kind}.renameDescription`, { name: originalName })}</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-2">
            <Label htmlFor="rename-git-item-name">{t(`git.${kind}.newName`)}</Label>
            <Input id="rename-git-item-name" autoFocus className="font-mono" value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setFailed(false); }} />
            {taken ? <p role="alert" className="text-xs text-destructive">{t(`git.${kind}.nameTaken`, { name: next })}</p> : null}
            {failed ? <p role="alert" className="text-xs text-destructive">{t(`git.${kind}.renameFailed`)}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={!next || next === originalName || taken || busy}>
              {busy ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={busy ? "status" : undefined}>{t(busy ? `git.${kind}.renamingLabel` : `git.${kind}.rename`)}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BranchUpstreamDialog({ branch, remoteBranches, onOpenChange, onSave }: {
  branch: BranchInfo;
  remoteBranches: BranchInfo[];
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, upstream: string | null) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [upstream, setUpstream] = useState(branch.upstream ?? "");
  const { mutation, busy, failed, setFailed, save } = useDialogSave(() => onOpenChange(false));
  const names = remoteBranches.map((item) => item.name);
  const missing = Boolean(upstream && !names.includes(upstream));
  return (
    <Dialog open onOpenChange={(open) => { if (!mutation.busy) onOpenChange(open); }}>
      <DialogContent>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (busy || missing || upstream === (branch.upstream ?? "")) return;
          save(() => onSave(branch.name, upstream || null));
        }}>
          <DialogHeader>
            <DialogTitle>{t("git.branch.upstreamTitle")}</DialogTitle>
            <DialogDescription>{t("git.branch.upstreamDescription", { name: branch.name })}</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-2">
            <Label htmlFor="branch-upstream">{t("git.branch.upstream")}</Label>
            <select id="branch-upstream" autoFocus className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={upstream} disabled={busy} onChange={(event) => { setUpstream(event.target.value); setFailed(false); }}>
              <option value="">{t("git.branch.noUpstream")}</option>
              {missing ? <option value={upstream}>{upstream} {t("git.branch.missingUpstream")}</option> : null}
              {names.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            {names.length === 0 ? <p className="text-xs text-muted-foreground">{t("git.branch.noRemoteBranches")}</p> : null}
            {failed ? <p role="alert" className="text-xs text-destructive">{t("git.branch.upstreamFailed")}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={busy || missing || upstream === (branch.upstream ?? "")}>
              {busy ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={busy ? "status" : undefined}>{t(busy ? "git.branch.saving" : "common.save")}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditRemoteDialog({ remote, repoPath, onOpenChange, onSave }: {
  remote: RemoteInfo;
  repoPath: string;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, url: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(remote.url ?? "");
  const { mutation, busy, failed, setFailed, save } = useDialogSave(() => onOpenChange(false));
  const [probeAction] = useState(createExclusiveAction);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const next = url.trim();
  async function test() {
    if (!next || mutation.busy) return;
    await probeAction.run(async () => {
      setTesting(true);
      setProbe(null);
      try {
        const result = await gitApi.probeRemoteUrl(repoPath, next);
        setProbe({ ok: true, message: t("git.remote.reachable", { count: result.heads }) });
      } catch (error) {
        setProbe({ ok: false, message: errorMessage(error) });
      } finally {
        setTesting(false);
      }
    });
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!mutation.busy) onOpenChange(open); }}>
      <DialogContent>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!next || next === remote.url || busy || probeAction.busy) return;
          save(() => onSave(remote.name, next));
        }}>
          <DialogHeader>
            <DialogTitle>{t("git.remote.editTitle", { name: remote.name })}</DialogTitle>
            <DialogDescription>{t("git.remote.editDescription")}</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-2">
            <Label htmlFor="edit-remote-url">{t("git.remote.url")}</Label>
            <Input id="edit-remote-url" autoFocus className="font-mono" value={url} disabled={busy || testing} onChange={(event) => { setUrl(event.target.value); setProbe(null); setFailed(false); }} />
            {remote.pushUrl && remote.pushUrl !== remote.url ? <p className="break-all text-xs text-muted-foreground">{t("git.remote.explicitPushUrl", { url: remote.pushUrl })}</p> : null}
            {probe ? <p role={probe.ok ? "status" : "alert"} className={probe.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{probe.message}</p> : null}
            {failed ? <p role="alert" className="text-xs text-destructive">{t("git.remote.saveFailed")}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" className="sm:mr-auto" disabled={!next || busy || testing} onClick={() => void test()}>
              {testing ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={testing ? "status" : undefined}>{t(testing ? "git.remote.testing" : "git.remote.test")}</span>
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={!next || next === remote.url || busy || testing}>
              {busy ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : null}
              <span role={busy ? "status" : undefined}>{t(busy ? "git.branch.saving" : "common.save")}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemotePushUrlsDialog({repoPath,name,onOpenChange,onSave}: {
  repoPath:string;
  name:string;
  onOpenChange:(open:boolean)=>void;
  onSave:(name:string,urls:string[],fingerprint:string)=>Promise<boolean>;
}) {
  const {t} = useTranslation();
  const [loaded,setLoaded] = useState<RemotePushSettings|null>(null);
  const [text,setText] = useState("");
  const [error,setError] = useState("");
  const [attempt,setAttempt] = useState(0);
  const {mutation,busy,failed,setFailed,save} = useDialogSave(() => onOpenChange(false));
  useEffect(() => {
    let live = true;
    void gitApi.remotePushSettings(repoPath,name).then(value => {
      if (live) {setLoaded(value); setText(value.urls.join("\n")); setError("");}
    }).catch((caught:unknown) => {if (live) setError(errorMessage(caught));});
    return () => {live = false;};
  }, [repoPath,name,attempt]);
  const urls = text.split(/\r?\n/).filter(line => line.length > 0);
  const dirty = loaded && JSON.stringify(urls) !== JSON.stringify(loaded.urls);
  function reload() {setLoaded(null); setError(""); setFailed(false); setAttempt(value => value + 1);}
  return <Dialog open onOpenChange={open => {if (!mutation.busy) onOpenChange(open);}}><DialogContent className="sm:max-w-xl">
    <form onSubmit={event => {event.preventDefault(); if (loaded && dirty && !loaded.inherited && !mutation.busy) save(() => onSave(name,urls,loaded.fingerprint));}}>
      <DialogHeader><DialogTitle>{t("git.remote.editPushUrls")}</DialogTitle><DialogDescription className="font-mono">{name}</DialogDescription></DialogHeader>
      <div className="my-4 grid gap-3">
        {loaded ? <><div className="flex items-center gap-2"><Label htmlFor="remote-push-urls">{t("git.remote.pushUrls")}</Label><HoverTip label={t(loaded.inherited ? "git.remote.inheritedPushHint" : "git.remote.pushUrlsHint")}><InfoIcon className="size-3.5 text-muted-foreground" /></HoverTip>{loaded.inherited ? <span className="ml-auto rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("git.remote.inherited")}</span> : null}</div><Textarea id="remote-push-urls" autoFocus spellCheck={false} value={text} readOnly={loaded.inherited} disabled={busy} className="h-32 min-h-32 resize-none whitespace-pre-wrap break-all font-mono text-xs [field-sizing:fixed]" onChange={event => {setText(event.target.value); setFailed(false);}} />{!urls.length && loaded.fallbackUrls.length ? <div className="grid gap-1 text-xs text-muted-foreground"><span>{t("git.remote.usingFetchUrls")}</span><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{loaded.fallbackUrls.join("\n")}</pre></div> : null}</> : !error ? <div className="flex min-h-32 items-center justify-center"><Loader2Icon className="size-5 animate-spin text-muted-foreground" /></div> : null}
        {error || failed ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{error || t("git.remote.pushSaveFailed")}</p> : null}
      </div>
      <DialogFooter>{error || failed ? <Button variant="outline" className="mr-auto" disabled={busy} onClick={reload}>{t("git.remote.reload")}</Button> : null}<Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={busy || !loaded || loaded.inherited || !dirty}>{busy ? <Loader2Icon className="animate-spin" /> : null}{t("common.save")}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
