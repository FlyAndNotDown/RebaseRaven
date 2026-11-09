import { SyntaxLine } from "@/components/syntax-text";
import { useFileSyntax } from "@/lib/use-file-syntax";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { DiffSkeleton } from "@/components/skeletons";
import { AuthorName } from "@/components/revision-meta";
import { ChangeBadge } from "@/components/p4/change-badge";
import { errorMessage } from "@/lib/git";
import { p4DisplayError } from "@/lib/p4-operation-preview";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import { textColumns } from "@/lib/diff-text";
import { useP4 } from "@/state/p4-context";
import type { P4BlameLine, P4Revision } from "@/types/p4";

export function P4Blame({ revision, openChange }: { revision: P4Revision; openChange: (change: string) => void }) {
  const { t } = useTranslation();
  const { annotate } = useP4();
  const key = `${revision.depotPath}#${revision.rev}`;
  const [result, setResult] = useState<{ key: string; lines?: P4BlameLine[]; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void annotate(revision.depotPath, revision.rev).then((lines) => {
      if (active) setResult({ key, lines });
    }).catch((caught: unknown) => { if (active) setResult({ key, error: p4DisplayError(errorMessage(caught)) }); });
    return () => { active = false; };
  }, [annotate, key, revision.depotPath, revision.rev, attempt]);
  const current = result?.key === key ? result : null;
  const lines = current?.lines;
  const texts = useMemo(() => lines?.map((line) => line.content) ?? null, [lines]);
  const syntax = useFileSyntax(revision.depotPath, texts);
  const widest = useMemo(() => lines?.reduce((width, line) => Math.max(width, textColumns(line.content)), 0) ?? 0, [lines]);
  const { viewportRef, start, end, before, after } = useWindowedRows(lines?.length ?? 0, 24);
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground"><span className="truncate font-mono" title={revision.depotPath}>{revision.depotPath}#{revision.rev}</span><HoverTip label={t("p4.history.blameHint")}><span className="ml-auto shrink-0">{t("p4.history.blame")}</span></HoverTip></div>
    {current?.error ? <div className="p-3"><p role="alert" className="mb-2 text-xs text-destructive">{current.error}</p><Button variant="outline" size="xs" onClick={() => setAttempt((value) => value + 1)}>{t("common.retry")}</Button></div> : !lines ? <div className="relative min-h-0 flex-1"><DiffSkeleton fill /></div> : !lines.length ? <p className="p-4 text-xs text-muted-foreground">{t("p4.noTextDifferences")}</p> : <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ minWidth: `calc(19rem + ${widest}ch)` }}>
        <div aria-hidden style={{ height: before }} />
        {lines.slice(start, end).map((line, offset) => {
          const group = line.change !== lines[start + offset - 1]?.change || offset === 0;
          return <div key={line.line} className="flex h-6 items-center hover:bg-muted/40">
            <div className="sticky left-0 flex h-full w-64 shrink-0 items-center gap-2 border-r bg-background px-2">
              {group ? <><HoverTip label={`${line.user} · ${line.time}`}><button type="button" className="shrink-0 rounded hover:ring-1 hover:ring-ring" aria-label={t("p4.history.openChange") + ` #${line.change}`} onClick={() => openChange(line.change)}><ChangeBadge id={line.change} /></button></HoverTip><span className="min-w-0 truncate"><AuthorName vcs="perforce" name={line.user} /></span></> : null}
            </div>
            <span className="w-12 shrink-0 px-2 text-right font-mono text-[11px] text-muted-foreground tabular-nums">{line.line}</span><code className="whitespace-pre px-2 font-mono text-xs [tab-size:4]"><SyntaxLine text={line.content || " "} ranges={syntax?.[start + offset]} /></code>
          </div>;
        })}
        <div aria-hidden style={{ height: after }} />
      </div>
    </div>}
  </div>;
}
