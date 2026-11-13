export type MappingKind = "include" | "exclude" | "overlay" | "ditto";
export interface MappingRule { kind: MappingKind; source: string; target: string; comment: string }

const prefixes: Record<MappingKind, string> = { include: "", exclude: "-", overlay: "+", ditto: "&" };

/** Preserve quoted paths and comments; unsupported syntax stays in the text editor. */
export function parseMappings(lines: string[], overrides: boolean): MappingRule[] | null {
  const rules: MappingRule[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const tokens: string[] = [];
    let text = "", quoted = false, started = false, comment = "";
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (!quoted && line.slice(i, i + 2) === "##") { comment = line.slice(i); break; }
      if (char === '"') { quoted = !quoted; started = true; }
      else if (!quoted && /\s/.test(char)) {
        if (started) tokens.push(text);
        text = ""; started = false;
      } else { text += char; started = true; }
    }
    if (started) tokens.push(text);
    if (quoted || tokens.length !== (overrides ? 1 : 2)) return null;
    const mark = tokens[0][0];
    const kind: MappingKind = mark === "-" ? "exclude" : mark === "+" ? "overlay" : mark === "&" ? "ditto" : "include";
    const source = kind === "include" ? tokens[0] : tokens[0].slice(1);
    if (!source.startsWith("//") || (!overrides && !tokens[1].startsWith("//")) || (overrides && (kind === "overlay" || kind === "ditto"))) return null;
    rules.push({kind, source, target: tokens[1] ?? "", comment});
  }
  return rules;
}

export function mappingLines(rules: MappingRule[], overrides: boolean): string[] {
  const quote = (path: string) => !path || /\s/.test(path) ? `"${path}"` : path;
  return rules.map(rule => [
    quote(prefixes[rule.kind] + rule.source),
    ...(overrides ? [] : [quote(rule.target)]),
    ...(rule.comment ? [rule.comment] : []),
  ].join(" "));
}
