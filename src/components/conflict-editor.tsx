import { formatNumber, t, useTranslation } from "@/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon, Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  applyConflictChoice,
  conflictHunks,
  conflictSegments,
  replaceRange,
  setConflictSide,
  visibleBody,
  type ConflictSide,
} from "@/lib/conflict-text";
import { errorMessage, gitApi } from "@/lib/git";
import { hasConflictMarkers } from "@/lib/three-way-text";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";

export function ConflictEditor({ repoPath, path, rebasing }: { repoPath: string; path: string; rebasing: boolean }) {
  useTranslation();
  const { saveConflict, resolveConflict, runMergetool } = useGitPick(["saveConflict", "resolveConflict", "runMergetool"]);
  const [view, setView] = useState<{ text: string; binary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void gitApi.conflictView(repoPath, path).then((next) => { if (live) setView(next); })
      .catch((caught: unknown) => { if (live) setError(errorMessage(caught)); });
    return () => { live = false; };
  }, [repoPath, path]);
  const current = t(rebasing ? "git-files.target" : "git-files.current");
  const incoming = t(rebasing ? "git-files.replaying" : "git-files.incoming");
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
  if (!view) return <p role="status" className="p-4 text-sm text-muted-foreground">{t("git-files.loadingConflict")}</p>;
  if (view.binary) return <div className="flex flex-wrap items-center gap-2 p-4">
    <p className="w-full text-sm text-muted-foreground">{t("git-files.noMarkers")}</p>
    <Button size="xs" variant="outline" onClick={() => void resolveConflict(path, "ours")}>{t("git-files.useSide", { side: current })}</Button>
    <Button size="xs" variant="outline" onClick={() => void resolveConflict(path, "theirs")}>{t("git-files.useSide", { side: incoming })}</Button>
    <Button size="xs" variant="outline" onClick={() => void runMergetool(path)}>{t("git-files.openMergeTool")}</Button>
  </div>;
  return <ConflictTextEditor key={repoPath + path} initialText={view.text} current={current} incoming={incoming}
    onSave={async (text) => { await saveConflict(path, view.text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text); }}
    onExternal={async () => { await runMergetool(path); }} />;
}

export function ConflictTextEditor({ initialText, current, incoming, onSave, onExternal, disabled = false, saveLabel, onTextChange, displayError = errorMessage }: {
  initialText: string;
  current: string;
  incoming: string;
  onSave: (text: string) => Promise<void>;
  onExternal: (text: string) => Promise<string | void>;
  disabled?: boolean;
  saveLabel?: string;
  onTextChange?: (text: string) => void;
  displayError?: (error: unknown) => string;
}) {
  useTranslation();
  const [text, setText] = useState(() => initialText.replace(/\r\n/g, "\n"));
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef(text);
  const busyRef = useRef(false);
  const blocked = busy || disabled;
  useLayoutEffect(() => { busyRef.current = blocked; }, [blocked]);
  useEffect(() => { onTextChange?.(text); }, [text, onTextChange]);

  async function perform(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await operation(); }
    catch (caught) { setError(displayError(caught)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const save = () => perform(() => onSave(textRef.current));
  const runExternal = () => perform(async () => {
    const next = await onExternal(textRef.current);
    if (typeof next === "string") replaceText(next.replace(/\r\n/g, "\n"), true);
  });
  const [active, setActive] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const pendingScroll = useRef<number | null>(null);
  const hunkRefs = useRef<Array<HTMLDivElement | null>>([]);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const echo = useRef(false);
  useLayoutEffect(() => {
    textRef.current = text;
  });
  const hunks = conflictHunks(text);
  const segments = conflictSegments(text);
  const shown = hunks.length === 0 ? 0 : Math.min(active, hunks.length - 1);

  useEffect(() => {
    const index = pendingScroll.current;
    if (index == null) return;
    pendingScroll.current = null;
    hunkRefs.current[index]?.scrollIntoView({ block: "center" });
  }, [text, shown]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      echo.current = false;
    }, 0);
    return () => window.clearTimeout(id);
  }, [text]);

  function replaceText(next: string, record: boolean) {
    const currentText = textRef.current;
    if (next === currentText) return;
    if (record) {
      past.current.push(currentText);
      if (past.current.length > 200) past.current.shift();
      future.current = [];
      setCanUndo(true);
      setCanRedo(false);
    }
    echo.current = true;
    textRef.current = next;
    setText(next);
  }

  function edit(next: string) {
    if (blocked || echo.current) return;
    replaceText(next, true);
  }

  function undo() {
    const prev = past.current.pop();
    if (prev == null) return;
    future.current.push(textRef.current);
    setCanUndo(past.current.length > 0);
    setCanRedo(true);
    echo.current = true;
    textRef.current = prev;
    setText(prev);
  }

  function redo() {
    const next = future.current.pop();
    if (next == null) return;
    past.current.push(textRef.current);
    setCanUndo(true);
    setCanRedo(future.current.length > 0);
    echo.current = true;
    textRef.current = next;
    setText(next);
  }

  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  useLayoutEffect(() => {
    undoRef.current = undo;
    redoRef.current = redo;
  });

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const meta = event.ctrlKey || event.metaKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      const undoKey = key === "z" && !event.shiftKey;
      const redoKey = key === "y" || (key === "z" && event.shiftKey);
      if (!undoKey && !redoKey) return;
      if (busyRef.current) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const field = target.closest("textarea, input, select, [contenteditable='true']");
        if (field && !field.closest("[data-conflict-editor]")) return;
      }
      event.preventDefault();
      if (undoKey) undoRef.current();
      else redoRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function choose(index: number, side: ConflictSide) {
    const next = applyConflictChoice(textRef.current, index, side);
    const count = conflictHunks(next).length;
    const focus = count === 0 ? 0 : Math.min(index, count - 1);
    pendingScroll.current = focus;
    edit(next);
    setActive(focus);
  }

  function go(index: number) {
    pendingScroll.current = index;
    setActive(index);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-conflict-editor="">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-3">
        <IconButton label={t("git-files.previousConflict")} disabled={blocked || hunks.length === 0 || shown === 0} onClick={() => go(shown - 1)}>
          <ChevronUpIcon />
        </IconButton>
        <IconButton label={t("git-files.nextConflict")} disabled={blocked || hunks.length === 0 || shown >= hunks.length - 1} onClick={() => go(shown + 1)}>
          <ChevronDownIcon />
        </IconButton>
        <IconButton label={t("git-files.undo")} disabled={blocked || !canUndo} onClick={undo}>
          <Undo2Icon />
        </IconButton>
        <IconButton label={t("git-files.redo")} disabled={blocked || !canRedo} onClick={redo}>
          <Redo2Icon />
        </IconButton>
        <span className="text-xs text-muted-foreground">
          {hunks.length === 0 ? t("git-files.noConflicts") : t("git-files.conflictPosition", { position: formatNumber(shown + 1), total: formatNumber(hunks.length) })}
        </span>
        <Button type="button" size="xs" variant="ghost" className="ml-auto" disabled={blocked} onClick={() => setWhole((value) => !value)}>{t(whole ? "git-files.blockEditing" : "git-files.fullEditing")}</Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={blocked}
          onClick={() => void runExternal()}
        >
          {t("git-files.openMergeTool")}
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={blocked || hasConflictMarkers(text)}
          onClick={() => void save()}
        >
          {saveLabel ?? t("git-files.markResolved")}
        </Button>
      </div>
      {error ? <p role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {whole ? <textarea aria-label={t("git-files.fullEditing")} value={text} disabled={blocked} onChange={(event) => edit(event.target.value)} spellCheck={false} wrap="off" className="min-h-0 flex-1 resize-none p-3 font-mono text-xs leading-5 outline-none" /> : <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-w-max py-2">
          {segments.map((segment) =>
            segment.kind === "text" ? (
              <FitText
                disabled={blocked}
                key={`text-${segment.start}`}
                value={shownText(segment.text, segment.end < text.length)}
                onChange={(value) =>
                  edit(replaceRange(textRef.current, segment.start, segment.end, storedText(value, segment.end < text.length)))
                }
              />
            ) : (
              <div
                key={`conflict-${segment.index}`}
                ref={(node) => {
                  hunkRefs.current[segment.index] = node;
                }}
                className={cn(
                  "mx-2 my-1 overflow-hidden rounded-md border",
                  segment.index === shown ? "border-primary" : "border-border",
                )}
                onPointerDown={() => setActive(segment.index)}
              >
                <div className="flex flex-wrap gap-1 border-b bg-muted/40 px-2 py-1">
                  <Button type="button" size="xs" variant="outline" disabled={blocked} onClick={() => choose(segment.index, "ours")}>
                    {current}
                  </Button>
                  <Button type="button" size="xs" variant="outline" disabled={blocked} onClick={() => choose(segment.index, "theirs")}>
                    {incoming}
                  </Button>
                  <Button type="button" size="xs" variant="outline" disabled={blocked} onClick={() => choose(segment.index, "both")}>
                    {t("git-files.both")}
                  </Button>
                  <Button type="button" size="xs" variant="outline" disabled={blocked} onClick={() => choose(segment.index, "none")}>
                    {t("git-files.none")}
                  </Button>
                </div>
                <MarkerLine>{t("git-files.currentMarker", { side: current })}</MarkerLine>
                <FitText
                disabled={blocked}
                  value={visibleBody(segment.hunk.ours)}
                  className="bg-diff-del-bg text-diff-del"
                  onChange={(value) => edit(setConflictSide(textRef.current, segment.index, "ours", value))}
                />
                {segment.hunk.hasBase ? (
                  <details>
                    <summary className="cursor-pointer bg-muted/40 px-3 py-1 text-xs text-muted-foreground">{t("git-files.commonBase")}</summary>
                    <pre className="bg-muted/30 px-3 font-mono text-[12px] leading-5 whitespace-pre text-muted-foreground">
                      {visibleBody(segment.hunk.base) || " "}
                    </pre>
                  </details>
                ) : null}
                <MarkerLine>=======</MarkerLine>
                <FitText
                disabled={blocked}
                  value={visibleBody(segment.hunk.theirs)}
                  className="bg-diff-add-bg text-diff-add"
                  onChange={(value) => edit(setConflictSide(textRef.current, segment.index, "theirs", value))}
                />
                <MarkerLine>{t("git-files.incomingMarker", { side: incoming })}</MarkerLine>
              </div>
            ),
          )}
        </div>
      </div>}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-xs" variant="outline" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function shownText(text: string, hideTrailingBreak: boolean): string {
  return hideTrailingBreak && text.endsWith("\n") ? text.slice(0, -1) : text;
}

function storedText(value: string, hideTrailingBreak: boolean): string {
  if (!hideTrailingBreak || value.endsWith("\n")) return value;
  return `${value}\n`;
}

function MarkerLine({ children }: { children: string }) {
  return <div className="bg-muted/50 px-3 font-mono text-[12px] leading-5 text-muted-foreground">{children}</div>;
}

function FitText({
  value,
  onChange,
  className,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = "100%";
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 20)}px`;
    if (el.scrollWidth > el.clientWidth) el.style.width = `${el.scrollWidth}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      disabled={disabled}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      wrap="off"
      rows={1}
      onChange={(event) => {
        if (!(event.nativeEvent instanceof InputEvent) || !event.nativeEvent.inputType) return;
        if (event.target.value === value) return;
        onChange(event.target.value);
      }}
      className={cn(
        "block w-full resize-none overflow-hidden bg-transparent px-3 font-mono text-[12px] leading-5 whitespace-pre outline-none",
        className,
      )}
    />
  );
}
