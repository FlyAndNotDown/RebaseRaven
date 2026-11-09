import { t, useTranslation } from "@/i18n";
import { DiffLines } from "@/components/diff-viewer";
import { DiffSearchBar, DiffSearchButton, DiffSearchScope } from "@/components/diff-search";
import { P4ImageDiff } from "@/components/p4/p4-image-diff";
import { isImagePath } from "@/components/image-diff";
import type { P4ImageSource } from "@/types/p4";
import { Columns2Icon } from "lucide-react";
import { toast } from "sonner";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";
import type { FileDiff } from "@/types/git";

async function copyPath(value: string) {
  if (!value) {
    toast.error(t("p4.nothingToCopy"));
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success(t("p4.copiedPath"));
  } catch {
    toast.error(t("p4.couldNotCopy"));
  }
}

export function P4Diff({
  diff,
  loading,
  empty,
  split,
  captions,
  chrome = true,
  imageSource,
}: {
  diff: FileDiff | null;
  loading: boolean;
  empty: string;
  split?: boolean;
  captions?: [string, string];
  chrome?: boolean;
  imageSource?: P4ImageSource;
}) {
  useTranslation();
  const { prefs, setDiffOptions } = useGitPick(["prefs", "setDiffOptions"]);

  const sideBySide = split ?? prefs.diffSplit;
  const image = Boolean(imageSource && diff && isImagePath(diff.path));
  const frame = chrome ? "absolute inset-0" : "min-h-0 flex-1";
  if (loading && !diff) {
    return (
      <div className={chrome ? "absolute inset-0" : "relative min-h-0 flex-1"}>
        <DiffSkeleton fill />
      </div>
    );
  }
  if (!diff) {
    return (
      <div className={cn("flex items-center justify-center p-6 text-center text-sm text-muted-foreground", frame)}>
        {empty}
      </div>
    );
  }
  return (
    <DiffSearchScope lines={diff.lines.map(line => line.kind === "hunk" ? "" : line.content.replace(/\r/g, ""))} enabled={!diff.binary && !image} className={frame}>
      {chrome ? (
        <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
          <button
            type="button"
            className="min-w-0 truncate text-left font-mono text-sm hover:underline"
            onClick={() => void copyPath(diff.path)}
          >
            {diff.path || t("p4.diff")}
          </button>
          {diff.binary || image ? null : (
            <div className="flex items-center gap-1"><DiffSearchButton />
            <HoverTip label={t("p4.sideBySide")}>
              <Button
                type="button"
                size="icon-xs"
                variant={sideBySide ? "secondary" : "ghost"}
                aria-pressed={sideBySide}
                aria-label={t("p4.sideBySide")}
                onClick={() => void setDiffOptions({ split: !sideBySide })}
              >
                <Columns2Icon />
              </Button>
            </HoverTip></div>
          )}
        </div>
      ) : !diff.binary && !image ? <div className="flex h-8 shrink-0 items-center justify-end border-b px-2"><DiffSearchButton /></div> : null}
      <DiffSearchBar />
      {captions && sideBySide && !diff.binary && !image ? (
        <div className="grid shrink-0 grid-cols-2 border-b text-xs text-muted-foreground">
          <div className="px-3 py-1.5">{captions[0]}</div>
          <div className="border-l px-3 py-1.5">{captions[1]}</div>
        </div>
      ) : null}
      {imageSource && image ? <P4ImageDiff source={imageSource} refreshIdentity={diff} captions={captions} /> : diff.binary ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("p4.binaryFile")}</div>
      ) : diff.lines.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("p4.noTextDifferences")}
        </div>
      ) : (
        <DiffLines diff={diff} split={sideBySide} />
      )}
      {diff.truncated && !image ? (
        <div className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground">{t("p4.diffTruncated")}</div>
      ) : null}
    </DiffSearchScope>
  );
}
