import { useEffect, useState } from "react";
import { diffDocumentText, type DiffToolSource } from "@/lib/diff-tools";
import { errorMessage } from "@/lib/git";
import { p4ComparisonDiff } from "@/lib/p4-comparison";
import { useGitSelect } from "@/state/git-context";
import type { FileDiff } from "@/types/git";

export function useDiffWhitespace(diff: FileDiff | null, source: Exclude<DiffToolSource, { kind: "git" }> | null) {
  const ignoreWhitespace = useGitSelect(state => state.prefs.diffIgnoreWhitespace);
  const key = source && ignoreWhitespace && diff && !diff.binary ? JSON.stringify(source) : null;
  const [result, setResult] = useState<{ key: string; original: FileDiff; diff: FileDiff | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!key || !diff) return;
    let live = true;
    const document = JSON.parse(key) as Exclude<DiffToolSource, { kind: "git" }>;
    void diffDocumentText(document).then(pair => p4ComparisonDiff({kind:"text", ...pair}, true))
      .then(value => { if (live) setResult({key, original:diff, diff:value, error:null}); })
      .catch(error => { if (live) setResult({key, original:diff, diff:null, error:errorMessage(error)}); });
    return () => { live = false; };
  }, [diff, key]);
  const current = result?.key === key && result.original === diff ? result : null;
  return { diff: key ? current?.diff ?? null : diff, loading: Boolean(key && !current), error: key ? current?.error : null };
}
