import { diffArrays } from "diff";

interface Edit { start: number; end: number; lines: string[]; side: "ours" | "theirs" }
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const normalize = (text: string) => text.replace(/\r\n/g, "\n");

function edits(base: string[], next: string[], side: Edit["side"]): Edit[] {
  const changes = diffArrays(base, next, { timeout: 250 });
  if (!changes) return [{ start: 0, end: base.length, lines: next, side }];
  const result: Edit[] = [];
  let position = 0;
  let pending: Edit | null = null;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (pending) result.push(pending);
      pending = null;
      position += change.value.length;
    } else {
      pending ??= { start: position, end: position, lines: [], side };
      if (change.added) pending.lines = pending.lines.concat(change.value);
      else { position += change.value.length; pending.end = position; }
    }
  }
  if (pending) result.push(pending);
  return result.flatMap((edit) => {
    // Equal-length substitutions can be reviewed line by line. This keeps a
    // neighboring local edit outside a conflict on a different line.
    if (edit.end - edit.start === edit.lines.length && edit.lines.length > 1) {
      return edit.lines.map((line, index) => ({ start: edit.start + index, end: edit.start + index + 1, lines: [line], side }));
    }
    return [edit];
  });
}

function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end) return b.start <= a.start && a.start <= b.end;
  if (b.start === b.end) return a.start <= b.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

function apply(base: string[], start: number, end: number, changes: Edit[]): string {
  const result: string[] = [];
  let position = start;
  for (const change of changes) {
    result.push(base.slice(position, change.start).join(""), change.lines.join(""));
    position = change.end;
  }
  result.push(base.slice(position, end).join(""));
  return result.join("");
}

/** Merge independent edits; ambiguous edits stay explicit and editable as diff3 conflicts. */
export function threeWayText(baseText: string, yoursText: string, theirsText: string): string {
  const base = normalize(baseText), yours = normalize(yoursText), theirs = normalize(theirsText);
  if (yours === theirs || theirs === base) return yours;
  if (yours === base) return theirs;
  const original = lines(base);
  const pending = [...edits(original, lines(yours), "ours"), ...edits(original, lines(theirs), "theirs")].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: string[] = [];
  let cursor = 0, index = 0;
  while (index < pending.length) {
    const group = [pending[index++]];
    while (index < pending.length && group.some((edit) => overlaps(edit, pending[index]))) group.push(pending[index++]);
    const start = group.reduce((value, edit) => Math.min(value, edit.start), group[0].start), end = group.reduce((value, edit) => Math.max(value, edit.end), group[0].end);
    result.push(original.slice(cursor, start).join(""));
    const ours = group.filter((edit) => edit.side === "ours"), incoming = group.filter((edit) => edit.side === "theirs");
    const a = apply(original, start, end, ours), b = apply(original, start, end, incoming), common = original.slice(start, end).join("");
    if (!ours.length || a === common) result.push(b);
    else if (!incoming.length || b === common || a === b) result.push(a);
    else {
      const body = (text: string) => !text || text.endsWith("\n") ? text : `${text}\n`;
      result.push(`<<<<<<< Yours\n${body(a)}||||||| Base\n${body(common)}=======\n${body(b)}>>>>>>> Theirs\n`);
    }
    cursor = end;
  }
  result.push(original.slice(cursor).join(""));
  return result.join("");
}

export function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7}|\|{7}|>{7})/m.test(text);
}
