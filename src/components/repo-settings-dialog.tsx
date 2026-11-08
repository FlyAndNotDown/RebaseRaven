import { useState } from "react";
import { useTranslation } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RepositorySettingsForm } from "@/components/repository-settings-form";
import { useGitPick } from "@/state/git-context";

export function RepoSettingsDialog({open,onOpenChange}: {open:boolean;onOpenChange:(open:boolean)=>void}) {
  const {snapshot,setOpenPanel}=useGitPick(["snapshot","setOpenPanel"]);
  const repoPath=snapshot?.repo.path;
  return <RepoSettingsContent key={repoPath ?? ""} open={open} onOpenChange={onOpenChange} repoPath={repoPath} onSparse={()=>{onOpenChange(false);setOpenPanel("sparse-checkout");}} onLfs={()=>{onOpenChange(false);setOpenPanel("lfs");}} />;
}

function RepoSettingsContent({open,onOpenChange,repoPath,onSparse,onLfs}: {open:boolean;onOpenChange:(open:boolean)=>void;repoPath:string|undefined;onSparse:()=>void;onLfs:()=>void}) {
  const {t}=useTranslation();
  const [busy,setBusy]=useState(false);
  return <Dialog open={open} onOpenChange={value=>{if(!busy)onOpenChange(value);}}>
    <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
      <DialogHeader><DialogTitle>{t("git.ui.repository_settings")}</DialogTitle><DialogDescription>{t(repoPath ? "git.signingSettings.description" : "git.ui.open_a_repository_to_edit_its_identity")}</DialogDescription></DialogHeader>
      {open && repoPath ? <RepositorySettingsForm repoPath={repoPath} onClose={()=>onOpenChange(false)} onBusyChange={setBusy} onSparse={onSparse} onLfs={onLfs} /> : null}
    </DialogContent>
  </Dialog>;
}
