import { useEffect, useState } from "react";
import { useTranslation } from "@/i18n";
import { P4Blame } from "@/components/p4/p4-blame";
import { P4ImageDiff } from "@/components/p4/p4-image-diff";
import { isImagePath } from "@/components/image-diff";
import { Button } from "@/components/ui/button";
import { DiffSkeleton } from "@/components/skeletons";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useP4 } from "@/state/p4-context";
import type { P4Revision } from "@/types/p4";

/** Browse the latest submitted content independently of the selected history revision. */
export function P4FileView({ path }: { path: string }) {
  const { t } = useTranslation();
  const { filelog, selectSubmitted, setView } = useP4();
  const [result, setResult] = useState<{ path: string; attempt: number; revision?: P4Revision; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void filelog(path).then(page => {
      if (live) setResult({ path, attempt, revision: page.revisions[0] });
    }).catch((caught: unknown) => {
      if (live) setResult({ path, attempt, error: p4DisplayError(errorMessage(caught)) });
    });
    return () => { live = false; };
  }, [filelog, path, attempt]);
  const current = result?.path === path && result.attempt === attempt ? result : null;
  const revision = current?.revision;
  function openChange(change: string) { setView("submitted"); void selectSubmitted(change); }
  if (!current) return <div className="relative min-h-0 flex-1"><DiffSkeleton fill label={t("p4.filePreview.loading")} /></div>;
  if (current.error) return <div role="alert" className="p-3 text-xs text-destructive"><p>{current.error}</p><Button variant="outline" size="xs" className="mt-2" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</Button></div>;
  if (!revision) return <p className="p-4 text-xs text-muted-foreground">{t("p4.noRevisions")}</p>;
  if (["delete", "move/delete", "purge"].includes(revision.action)) return <p className="p-4 text-xs text-muted-foreground">{t("p4.filePreview.deleted")}</p>;
  if (isImagePath(revision.depotPath)) return <P4ImageDiff single source={{
    kind: "compare", request: {
      path: revision.depotPath,
      base: { kind: "revision", depotPath: revision.depotPath, revision: "0" },
      head: { kind: "revision", depotPath: revision.depotPath, revision: revision.rev },
    },
  }} refreshIdentity={revision} captions={["", `${revision.depotPath}#${revision.rev}`]} />;
  return <P4Blame revision={revision} openChange={openChange} />;
}
