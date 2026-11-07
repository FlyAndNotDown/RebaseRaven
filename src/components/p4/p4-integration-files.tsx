import { LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { relativeToRoot } from "@/lib/p4";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import type { P4ReconcilePreview } from "@/types/p4";

export function P4IntegrationFiles({files,root,previewed,loading}: {files:P4ReconcilePreview["files"];root:string;previewed:boolean;loading:boolean}) {
  const {t} = useTranslation();
  const {viewportRef,start,end,before,after} = useWindowedRows(files.length,32);
  return <div className="flex min-h-24 flex-col overflow-hidden rounded-md border">
    <p className="border-b bg-muted/30 px-3 py-2 text-xs font-medium">{t("p4.streams.preview",{count:files.length})}</p>
    {files.length ? <div ref={viewportRef} className="max-h-[25vh] overflow-auto" style={{height:Math.min(240,files.length*32)}}><div aria-hidden style={{height:before}} />{files.slice(start,end).map(file => <div key={file.path} className="flex h-8 items-center gap-3 border-b px-3 text-xs last:border-0"><span className="w-20 shrink-0 truncate text-muted-foreground">{t(`p4.integration.actions.${file.action.replace(/\//g,"_")}`,{defaultValue:file.action})}</span><span className="min-w-0 truncate font-mono" title={file.depotPath}>{relativeToRoot(root,file.path)||file.depotPath}</span></div>)}<div aria-hidden style={{height:after}} /></div> : <p role="status" className="flex items-center justify-center gap-2 p-5 text-xs text-muted-foreground">{loading ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}{t(previewed ? "p4-operations.noChanges" : loading ? "p4-operations.previewing" : "p4-operations.previewRequired")}</p>}
  </div>;
}
