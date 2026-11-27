import { DiffToolbar } from "@/components/diff-toolbar";
import { PathLabel } from "@/components/path-label";
import { useMemo } from "react";
import { useP4Pick } from "@/state/p4-context";
import type { TextPair, DiffToolSource } from "@/lib/diff-tools";
import { t, useTranslation } from "@/i18n";
import { DiffLines } from "@/components/diff-viewer";
import { DiffSearchBar, DiffSearchScope } from "@/components/diff-search";
import { P4ImageDiff } from "@/components/p4/p4-image-diff";
import { isImagePath } from "@/components/image-diff";
import type { P4FileSource, P4OpenedDiff } from "@/types/p4";
import { toast } from "sonner";
import { DiffSkeleton } from "@/components/skeletons";
import { cn } from "@/lib/utils";
import { useGitSelect } from "@/state/git-context";
import { p4ComparisonDiff } from "@/lib/p4-comparison";
import { p4DisplayError } from "@/lib/p4-operation-preview";

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
  diff: preview,
  loading: originalLoading,
  empty,
  captions,
  chrome = true,
  fileSource,
  textSource,
}: {
  diff: P4OpenedDiff | null;
  loading: boolean;
  empty: string;
  captions?: [string, string];
  chrome?: boolean;
  fileSource?: P4FileSource;
  textSource?: TextPair;
}) {
  const { t } = useTranslation();
  const originalDiff = preview && "unavailable" in preview ? null : preview;
  const prefs = useGitSelect(state => state.prefs);
  const { connection } = useP4Pick(["connection"]);
  const source: Exclude<DiffToolSource, {kind:"git"}> | null = textSource ? {kind:"text", ...textSource} : fileSource && connection ? {kind:"perforce", connection, source:fileSource} : null;
  const before = textSource?.before;
  const after = textSource?.after;
  const path = textSource?.path;
  const { diff, error } = useMemo(() => {
    if (!prefs.diffIgnoreWhitespace || !originalDiff || originalDiff.binary ||
        path === undefined || before === undefined || after === undefined) {
      return { diff: originalDiff, error: null };
    }
    try {
      return { diff: p4ComparisonDiff({ kind: "text", path, before, after }, true), error: null };
    } catch (caught) {
      return { diff: originalDiff, error: p4DisplayError(caught) };
    }
  }, [prefs.diffIgnoreWhitespace, originalDiff, path, before, after]);
  const loading = originalLoading;

  const sideBySide = prefs.diffSplit;
  const image = Boolean(fileSource && diff && isImagePath(diff.path));
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
        {preview && "unavailable" in preview ? t(`p4.previewUnavailable.${preview.unavailable}`) : empty}
      </div>
    );
  }
  return (
    <DiffSearchScope lines={diff.lines.map(line => line.kind === "hunk" ? "" : line.content.replace(/\r/g, ""))} enabled={!loading && !error && !diff.binary && !image} className={frame}>
      {chrome ? (
        <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
          <button
            type="button"
            className="min-w-0 text-left font-mono text-sm hover:underline"
            onClick={() => void copyPath(diff.path)}
          >
            {diff.path ? <PathLabel path={diff.path} /> : t("p4.diff")}
          </button>
          <DiffToolbar textual={!diff.binary && !image} source={source} line={diff.lines.find(line => line.newLineno)?.newLineno ?? null} split={sideBySide} />
        </div>
      ) : <div className="flex h-8 shrink-0 items-center justify-end border-b px-2"><DiffToolbar textual={!diff.binary && !image} source={source} split={sideBySide} /></div>}
      <DiffSearchBar />
      {captions && sideBySide && !diff.binary && !image ? (
        <div className="grid shrink-0 grid-cols-2 border-b text-xs text-muted-foreground">
          <PathLabel path={captions[0]} className="px-3 py-1.5 font-sans" />
          <PathLabel path={captions[1]} className="border-l px-3 py-1.5 font-sans" />
        </div>
      ) : null}
      {error ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p> : loading ? <div className="relative min-h-0 flex-1"><DiffSkeleton fill /></div> : fileSource && image ? <P4ImageDiff source={fileSource} refreshIdentity={diff} captions={captions} /> : diff.binary ? (
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
