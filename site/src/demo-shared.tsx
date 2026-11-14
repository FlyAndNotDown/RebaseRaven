import { useTranslation } from "react-i18next";
import { useMemo, useState, type ReactNode, type Ref } from "react";
import { CheckIcon, Columns2Icon, MinusIcon, PilcrowIcon, PlusIcon, XIcon } from "lucide-react";
import { DiffCode } from "@/components/diff-code";
import { DiffSearchBar, DiffSearchButton, DiffSearchScope } from "@/components/diff-search";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { FileStatusIcon } from "@/components/p4/file-status-icon";
import { cn } from "@/lib/utils";
import type { LineAction, LineRef } from "@/types/git";
import { fileChangeIds, projectDemoDiff } from "./demo-model";
import type { DemoFile, DemoHunk } from "./demo-data";

export function PaneHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("demo-pane-header", className)}>{children}</div>;
}

export function DemoFileRow({ file, active, onSelect, action, actionLabel, onAction, selectRef, directory = true, perforce = false }: {
  file: DemoFile; active?: boolean; onSelect: () => void; action?: "stage" | "unstage";
  actionLabel?: string; onAction?: () => void; selectRef?: Ref<HTMLButtonElement>;
  directory?: boolean; perforce?: boolean;
}) {
  return <div className={cn("demo-file-row", active && "selected")}>
    <HoverTip label={file.path}><button ref={selectRef} type="button" className="demo-file-select" onClick={onSelect} aria-pressed={active}>
      {perforce ? <FileStatusIcon status={file.status === "A" ? "add" : "edit"} /> : <span className={file.status === "A" ? "demo-added" : "demo-modified"}>{file.status}</span>}
      <span className="demo-file-name">{file.path.split("/").at(-1)}</span>
      {directory && !perforce ? <span className="demo-file-directory">{file.path.slice(0, file.path.lastIndexOf("/"))}</span> : null}
    </button></HoverTip>
    {onAction ? <HoverTip label={actionLabel}><Button variant="ghost" size="icon-xs" className="demo-file-action" aria-label={actionLabel} onClick={onAction}>{action === "unstage" ? <MinusIcon /> : <PlusIcon />}</Button></HoverTip> : null}
  </div>;
}

export function DiffPane({ file, hunks = file.hunks, projection, onApply, staged = false, scopeLabel, onClose }: {
  file: DemoFile; hunks?: DemoHunk[]; staged?: boolean; projection?: ReturnType<typeof projectDemoDiff>;
  onApply?: (action: LineAction, refs: LineRef[]) => Promise<boolean>; scopeLabel?: string; onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [split, setSplit] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const diff = useMemo(() => {
    if (projection) return projection.diff;
    const source = { ...file, hunks };
    return projectDemoDiff(source, new Set(), new Set(fileChangeIds(source))).diff;
  }, [file, hunks, projection]);
  const lineActions = useMemo(() => onApply && !ignoreWhitespace ? {
    staged, allowDiscard: !staged, onApply,
  } : undefined, [ignoreWhitespace, onApply, staged]);
  return <DiffSearchScope lines={diff.lines.map(line => line.kind === "hunk" ? "" : line.content)} className="demo-diff">
    <PaneHeader className="demo-diff-header">
      <span className="demo-path" title={file.path}>{file.path}</span>
      <div className="demo-diff-actions" role="group" aria-label={t("demo.diffLayout")}>
        <span className="demo-diff-scope">{scopeLabel}</span>
        <DiffSearchButton />
        <HoverTip label={t("git-files.sideBySide")}><Button size="icon-xs" variant={split ? "secondary" : "ghost"} aria-label={t("git-files.sideBySide")} aria-pressed={split} onClick={() => setSplit(!split)}><Columns2Icon /></Button></HoverTip>
        <HoverTip label={t(ignoreWhitespace ? "git-files.whitespaceHint" : "git-files.hideWhitespace")}><Button size="icon-xs" variant={ignoreWhitespace ? "secondary" : "ghost"} aria-label={t("git-files.hideWhitespace")} aria-pressed={ignoreWhitespace} onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}><PilcrowIcon /></Button></HoverTip>
        {onClose ? <HoverTip label={t("demo.closeFile")}><Button size="icon-xs" variant="ghost" aria-label={t("demo.closeFile")} onClick={onClose}><XIcon /></Button></HoverTip> : null}
      </div>
    </PaneHeader>
    <DiffSearchBar />
    {diff.lines.length ? <DiffCode diff={diff} split={split} lineActions={lineActions} /> : <EmptyPane title={t("demo.noChanges")} detail={t("demo.selectOther")} />}
  </DiffSearchScope>;
}

export function EmptyPane({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return <div className="demo-empty"><CheckIcon /><strong>{title}</strong>{detail ? <p>{detail}</p> : null}{children}</div>;
}
