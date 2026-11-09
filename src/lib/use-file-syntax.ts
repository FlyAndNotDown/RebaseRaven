import { startTransition, useEffect, useState } from "react";
import { languageFor, type TokenRange } from "@/lib/diff-text";

type TextHighlighter = (lines: string[], language: string) => TokenRange[][] | null;
let loadedTextHighlighter: TextHighlighter | null = null;

export function useFileSyntax(path: string, lines: string[] | null) {
  const language = lines == null ? null : languageFor(path);
  const [highlighter, setHighlighter] = useState<TextHighlighter | null>(() => loadedTextHighlighter);
  const [paint, setPaint] = useState<{ source: string[]; language: string; ranges: TokenRange[][] } | null>(null);
  useEffect(() => {
    if (!language || highlighter) return;
    let live = true;
    void import("@/lib/highlight").then((module) => {
      loadedTextHighlighter = module.highlightText;
      if (live) setHighlighter(() => module.highlightText);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [highlighter, language]);
  // Paint text immediately; defer tokenization so loading a file stays responsive.
  useEffect(() => {
    if (!language || !highlighter || lines == null) return;
    let cancelled = false;
    const source = lines;
    const run = () => {
      if (cancelled) return;
      const next = highlighter(source, language);
      if (cancelled || !next) return;
      startTransition(() => {
        if (!cancelled) setPaint({ source, language, ranges: next });
      });
    };
    const idle = window.requestIdleCallback?.(run, { timeout: 150 });
    const timer = idle == null ? window.setTimeout(run, 1) : undefined;
    return () => {
      cancelled = true;
      if (idle != null) window.cancelIdleCallback(idle);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [highlighter, language, lines]);
  return paint && paint.source === lines && paint.language === language ? paint.ranges : null;
}
