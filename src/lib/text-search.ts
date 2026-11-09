export interface TextMatch {
  id: number;
  line: number;
  start: number;
  end: number;
}

/** Literal Unicode-aware matching keeps offsets in the original displayed text. */
export function findText(lines: string[], query: string, matchCase = false): TextMatch[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
  const matches: TextMatch[] = [];
  lines.forEach((text, line) => {
    for (const match of text.matchAll(pattern)) {
      matches.push({ id: matches.length, line, start: match.index, end: match.index + match[0].length });
    }
  });
  return matches;
}

/** Search marks can cross syntax tokens and character-change spans. */
export function searchSpans<T extends { text: string }>(spans: T[], matches: TextMatch[]) {
  const result: (T & { match: number | null })[] = [];
  let offset = 0;
  let next = 0;
  for (const span of spans) {
    const end = offset + span.text.length;
    let cursor = offset;
    while (cursor < end) {
      while (next < matches.length && matches[next].end <= cursor) next += 1;
      const match = matches[next];
      const inside = match && match.start <= cursor;
      const stop = inside ? Math.min(end, match.end) : Math.min(end, match?.start ?? end);
      result.push({ ...span, text: span.text.slice(cursor - offset, stop - offset), match: inside ? match.id : null });
      cursor = stop;
    }
    offset = end;
  }
  return result;
}
