import { t, useTranslation } from "@/i18n";
import { memo, useMemo } from "react";
import { XIcon } from "lucide-react";
import { DiffSearchBar, DiffSearchScope } from "@/components/diff-search";
import { DiffCode, type DiffLineActions } from "@/components/diff-code";
import { ConflictEditor } from "@/components/conflict-editor";
import { ImageDiff, isImagePath } from "@/components/image-diff";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { DiffToolbar } from "@/components/diff-toolbar";
import { useGitPick, useGitSelect } from "@/state/git-context";
import type { FileDiff, FileSource } from "@/types/git";

export type { DiffLineActions } from "@/components/diff-code";
export type DiffSource = "changes" | "history" | "stash";

/** File kinds whose diff lines can be staged one by one. */
const LINE_KINDS = new Set(["modified", "added", "untracked"]);

export function DiffViewer({ source }: { source: DiffSource }) {
  useTranslation();
  const {
    changeSelection,
    historySelection,
    stashSelection,
    changeDiff,
    historyDiff,
    stashDiff,
    commitDetails,
    stashDetails,
    snapshot,
    comparison,
    prefs,
    applyLines,
    closeFile,
  } = useGitPick([
    "changeSelection",
    "historySelection",
    "stashSelection",
    "changeDiff",
    "historyDiff",
    "stashDiff",
    "commitDetails",
    "stashDetails",
    "snapshot",
    "comparison",
    "prefs",
    "applyLines",
    "closeFile",
  ]);
  const ignoreWhitespace = prefs.diffIgnoreWhitespace;
  const comparing = source === "history" && comparison != null;
  const selection = comparing
    ? comparison.path
      ? { type: "commit" as const, id: comparison.head.rev, path: comparison.path }
      : null
    : source === "changes"
      ? changeSelection
      : source === "stash"
        ? stashSelection
        : historySelection;
  const diff = source === "changes" ? changeDiff : source === "stash" ? stashDiff : historyDiff;
  const title =
    selection?.type === "change"
      ? selection.path
      : selection?.path
        ? selection.path
        : t("git-files.diff");
  const changeFile =
    source === "changes" && changeSelection
      ? (changeSelection.staged ? snapshot?.status.staged : snapshot?.status.unstaged)?.find(
          (file) => file.path === changeSelection.path,
        )
      : undefined;
  const conflicted = changeFile?.kind === "conflicted";
  const changePath = changeSelection?.path;
  const changeStaged = changeSelection?.staged ?? false;
  const changeKind = changeFile?.kind;
  const fingerprint = changeDiff?.fingerprint;
  const lineActions = useMemo<DiffLineActions | undefined>(() => {
    // A whitespace-blind diff cannot be turned back into a patch that applies.
    if (!fingerprint || ignoreWhitespace || !changePath || !changeKind || !LINE_KINDS.has(changeKind)) return undefined;
    return {
      staged: changeStaged,
      allowDiscard: !changeStaged && changeKind !== "untracked",
      onApply: (action, lines) => applyLines(changePath, changeStaged, action, lines, fingerprint),
    };
  }, [applyLines, changeKind, changePath, changeStaged, fingerprint, ignoreWhitespace]);
  const textual = Boolean(diff && !diff.binary && !conflicted);
  let fileSource: FileSource | null = null;
  if (diff && selection) {
    if (selection.type === "change") {
      fileSource = { kind: "workdir", path: selection.path, staged: selection.staged };
    } else if (comparing && comparison.path) {
      fileSource = {
        kind: "compare",
        base: comparison.base.rev,
        head: comparison.head.rev,
        path: comparison.path,
        oldPath: diff.oldPath,
      };
    } else if (selection.type === "stash" && selection.path) {
      fileSource = { kind: "stash", oid: selection.id, path: selection.path };
    } else if (selection.type === "commit" && selection.path) {
      fileSource = { kind: "commit", oid: selection.id, path: selection.path, oldPath: diff.oldPath };
    }
  }
  const imageSource = diff?.binary && isImagePath(diff.path) ? fileSource : null;

  if (source === "stash") {
    if (!stashSelection) {
      return (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("git-files.selectStash")}
        </div>
      );
    }
    if (!stashDetails || stashDetails.id !== stashSelection.id) {
      return <DiffSkeleton fill label={t("git-files.loadingFiles")} />;
    }
    if (!stashSelection.path) {
      return (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {stashDetails.files.length === 0 ? t("git-files.emptyStash") : t("git-files.selectDiff")}
        </div>
      );
    }
  } else if (comparing && comparison.files === null) {
    return <DiffSkeleton fill label={t("git-files.loadingFiles")} />;
  } else if (comparing && !comparison.path) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {comparison.files?.length ? t("git-files.selectDiff") : t("git-files.noDifferences")}
      </div>
    );
  } else if (!selection || (selection.type === "commit" && !selection.path)) {
    const loadingFiles =
      selection?.type === "commit" &&
      (!commitDetails || commitDetails.commit.id !== selection.id);
    if (loadingFiles) return <DiffSkeleton fill label={t("git-files.loadingFiles")} />;
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {t("git-files.selectDiff")}
      </div>
    );
  }

  if (!selection) return null;

  return (
    <DiffSearchScope lines={diff?.lines.map(line => line.kind === "hunk" ? "" : line.content.replace(/\r/g, "")) ?? []} enabled={textual} className="absolute inset-0">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm">{title}</div>
          {diff?.oldPath ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {t("git-files.renamedFrom", { path: diff.oldPath })}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {selection.type === "change" ? (
            <span className="mr-1 text-[11px] text-muted-foreground">
              {selection.staged ? t("git-files.staged") : t("git-files.unstaged")}
            </span>
          ) : null}
          <DiffToolbar textual={textual} source={fileSource && snapshot?.repo.path ? {kind: "git", repoPath: snapshot.repo.path, source: fileSource} : null} line={diff?.lines.find(item => item.newLineno)?.newLineno ?? null} allowExternalDiff={!conflicted} />
          <HoverTip label={t("git-files.close")}>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("git-files.close")}
              onClick={() => closeFile(source)}
            >
              <XIcon />
            </Button>
          </HoverTip>
        </div>
      </div>
      {textual ? <DiffSearchBar /> : null}
      {conflicted && selection.type === "change" ? (
        <ConflictEditor
          key={`${snapshot?.repo.path ?? ""}:${selection.path}`}
          repoPath={snapshot?.repo.path ?? ""}
          path={selection.path}
          rebasing={snapshot?.repo.operation?.kind === "rebase"}
        />
      ) : imageSource ? (
        <ImageDiff repoPath={snapshot?.repo.path ?? ""} source={imageSource} refreshIdentity={diff} />
      ) : diff?.binary ? (
        <p className="p-4 text-sm text-muted-foreground">{t("git-files.binaryFile")}</p>
      ) : !diff ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <DiffSkeleton fill />
        </div>
      ) : diff.lines.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t("git-files.noTextDiff")}</p>
      ) : (
        <DiffLines
          key={`${source}:${title}`}
          diff={diff}
          lineActions={source === "changes" ? lineActions : undefined}
        />
      )}
    </DiffSearchScope>
  );
}

export const DiffLines = memo(function DiffLines({ diff, lineActions, split }: {
  diff: FileDiff;
  lineActions?: DiffLineActions;
  split?: boolean;
}) {
  const preferredSplit = useGitSelect((state) => state.prefs.diffSplit);
  return <DiffCode diff={diff} lineActions={lineActions} split={split ?? preferredSplit} />;
});
