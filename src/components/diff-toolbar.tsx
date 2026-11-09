import { Columns2Icon, ExternalLinkIcon, PilcrowIcon, SquarePenIcon } from "lucide-react";
import { toast } from "sonner";
import { DiffSearchButton } from "@/components/diff-search";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { t, useTranslation } from "@/i18n";
import { openDiffEditor, openExternalDiff, type DiffToolSource } from "@/lib/diff-tools";
import { errorMessage } from "@/lib/git";
import { useGitPick } from "@/state/git-context";

export function DiffToolbar({ textual, source, line = null, split, allowExternalDiff = true }: {
  textual: boolean;
  source?: DiffToolSource | null;
  line?: number | null;
  split?: boolean;
  allowExternalDiff?: boolean;
}) {
  useTranslation();
  const { prefs, setDiffOptions } = useGitPick(["prefs", "setDiffOptions"]);
  const sideBySide = split ?? prefs.diffSplit;
  const ignoreWhitespace = prefs.diffIgnoreWhitespace;
  const report = (operation: Promise<unknown>) => { void operation.catch(error => toast.error(errorMessage(error))); };
  return <div className="flex shrink-0 items-center gap-1">
    {textual ? <>
      <DiffSearchButton />
      <HoverTip label={t("git-files.sideBySide")}><Button type="button" size="icon-xs" variant={sideBySide ? "secondary" : "ghost"} aria-pressed={sideBySide} aria-label={t("git-files.sideBySide")} onClick={() => void setDiffOptions({ split: !sideBySide })}><Columns2Icon /></Button></HoverTip>
      <HoverTip label={ignoreWhitespace ? t("git-files.whitespaceHint") : t("git-files.hideWhitespace")}><Button type="button" size="icon-xs" variant={ignoreWhitespace ? "secondary" : "ghost"} aria-pressed={ignoreWhitespace} aria-label={t("git-files.hideWhitespace")} onClick={() => void setDiffOptions({ ignoreWhitespace: !ignoreWhitespace })}><PilcrowIcon /></Button></HoverTip>
    </> : null}
    {source && allowExternalDiff ? <HoverTip label={t("git-files.openDiffTool")}><Button type="button" size="icon-xs" variant="ghost" aria-label={t("git-files.openDiffTool")} onClick={() => report(openExternalDiff(source))}><ExternalLinkIcon /></Button></HoverTip> : null}
    {source ? <HoverTip label={t("git-files.openEditor")}><Button type="button" size="icon-xs" variant="ghost" aria-label={t("git-files.openEditor")} onClick={() => report(openDiffEditor(source, line))}><SquarePenIcon /></Button></HoverTip> : null}
  </div>;
}
