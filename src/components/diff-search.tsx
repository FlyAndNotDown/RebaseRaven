import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { CaseSensitiveIcon, ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HoverTip } from "@/components/ui/tooltip";
import { findText, type TextMatch } from "@/lib/text-search";
import { formatCombo, isComposingKey } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

interface SearchState {
  open: boolean;
  query: string;
  matchCase: boolean;
  matches: TextMatch[];
  byLine: Map<number, TextMatch[]>;
  active: TextMatch | undefined;
  show: () => void;
  close: () => void;
  change: (value: string) => void;
  toggleCase: () => void;
  step: (delta: number) => void;
}

const SearchContext = createContext<SearchState | null>(null);
export const useDiffSearch = () => useContext(SearchContext);

export function DiffSearchScope({ lines, children, enabled = true, className, onOpen }: {
  lines: string[];
  children: ReactNode;
  enabled?: boolean;
  className?: string;
  onOpen?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [position, setPosition] = useState(0);
  const matches = useMemo(() => enabled && open ? findText(lines, query, matchCase) : [], [enabled, lines, open, query, matchCase]);
  const byLine = useMemo(() => {
    const map = new Map<number, TextMatch[]>();
    for (const match of matches) {
      const row = map.get(match.line) ?? [];
      row.push(match);
      map.set(match.line, row);
    }
    return map;
  }, [matches]);
  const active = matches[Math.min(position, Math.max(0, matches.length - 1))];
  const show = () => {
    onOpen?.();
    setOpen(true);
    const input = root.current?.querySelector<HTMLInputElement>('[role="search"] input');
    input?.focus();
    input?.select();
  };
  const close = () => { setOpen(false); root.current?.focus({ preventScroll: true }); };
  const step = (delta: number) => {
    if (matches.length) setPosition((value) => (Math.min(value, matches.length - 1) + delta + matches.length) % matches.length);
  };

  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isComposingKey(event) || event.altKey) return;
      const find = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "f";
      const next = open && event.key === "F3" && !event.ctrlKey && !event.metaKey;
      if (!find && !next) return;
      const node = root.current;
      if (!node || !node.getClientRects().length) return;
      const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(item => item.getClientRects().length).at(-1);
      if (dialog && !dialog.contains(node)) return;
      const scopes = Array.from((dialog ?? document).querySelectorAll<HTMLElement>("[data-diff-search]")).filter(item => item.getClientRects().length);
      const focused = event.target instanceof Element ? event.target.closest("[data-diff-search]") : null;
      if ((focused ?? scopes.at(-1)) !== node) return;
      event.preventDefault();
      event.stopPropagation();
      if (find) show();
      else step(event.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });

  return <SearchContext.Provider value={{ open: enabled && open, query, matchCase, matches, byLine, active, show, close,
    change: value => {setQuery(value); setPosition(0);}, toggleCase: () => {setMatchCase(value => !value); setPosition(0);}, step }}>
    <div ref={root} tabIndex={-1} data-diff-search={enabled ? "" : undefined} className={cn("flex min-h-0 min-w-0 flex-col outline-none", className)}>{children}</div>
  </SearchContext.Provider>;
}

export function DiffSearchButton() {
  const { t } = useTranslation();
  const search = useDiffSearch();
  if (!search) return null;
  const label = t("git-files.search.find");
  return <HoverTip label={`${label} (${formatCombo({key:"f",mod:true})})`}><Button type="button" variant={search.open ? "secondary" : "ghost"} size="icon-xs" aria-label={label} aria-pressed={search.open} onClick={search.show}><SearchIcon /></Button></HoverTip>;
}

export function DiffSearchBar() {
  const { t } = useTranslation();
  const search = useDiffSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {if (search?.open) inputRef.current?.focus();}, [search?.open]);
  if (!search?.open) return null;
  return <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/25 px-2" role="search" aria-label={t("git-files.search.find")}>
    <SearchIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground" />
    <Input ref={inputRef} value={search.query} onChange={event => search.change(event.target.value)} aria-label={t("git-files.search.find")} placeholder={t("git-files.search.placeholder")} className="h-7 min-w-16 flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0" onKeyDown={event => {
      if (isComposingKey(event.nativeEvent)) return;
      if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); search.close();}
      else if (event.key === "Enter") {event.preventDefault(); event.stopPropagation(); search.step(event.shiftKey ? -1 : 1);}
    }} />
    <span role="status" aria-live="polite" className="shrink-0 px-2 text-[11px] text-muted-foreground tabular-nums">{search.query && !search.matches.length ? t("git-files.search.noMatches") : `${search.active ? search.active.id + 1 : 0} / ${search.matches.length}`}</span>
    <SearchAction label={t("git-files.search.matchCase")} pressed={search.matchCase} onClick={search.toggleCase}><CaseSensitiveIcon /></SearchAction>
    <SearchAction label={t("git-files.search.previous")} disabled={!search.matches.length} onClick={() => search.step(-1)}><ChevronUpIcon /></SearchAction>
    <SearchAction label={t("git-files.search.next")} disabled={!search.matches.length} onClick={() => search.step(1)}><ChevronDownIcon /></SearchAction>
    <SearchAction label={t("git-files.search.close")} onClick={search.close}><XIcon /></SearchAction>
  </div>;
}

function SearchAction({ label, pressed, disabled, onClick, children }: {label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode}) {
  return <HoverTip label={label}><Button type="button" variant={pressed ? "secondary" : "ghost"} size="icon-xs" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>{children}</Button></HoverTip>;
}

/** Editable merge results use native text selection without changing their contents. */
export function DiffSearchSelection({ editor, text }: {editor: RefObject<HTMLTextAreaElement | null>; text: string}) {
  const search = useDiffSearch();
  const match = search?.active;
  useLayoutEffect(() => {
    const node = editor.current;
    if (!node || !match) return;
    const lines = text.split("\n");
    const offset = lines.slice(0, match.line).reduce((sum, line) => sum + line.length + 1, 0);
    node.setSelectionRange(offset + match.start, offset + match.end);
    node.scrollTo({top: Math.max(0, match.line * 20 - node.clientHeight / 2)});
  }, [editor, match, text]);
  return null;
}
