import { useLayoutEffect, useMemo, useRef, type Ref, type TextareaHTMLAttributes } from "react";
import { styleSpans, type TokenRange } from "@/lib/diff-text";
import { useFileSyntax } from "@/lib/use-file-syntax";
import { cn } from "@/lib/utils";

export function SyntaxLine({ text, ranges }: { text: string; ranges?: TokenRange[] | null }) {
  return <>{styleSpans([{text, changed:false}], ranges).map((span, index) => <span key={index} className={span.cls ? `tok-${span.cls}` : undefined}>{span.text}</span>)}</>;
}

export function SyntaxText({ text, path }: { text: string; path: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const syntax = useFileSyntax(path, lines);
  return <>{lines.map((line, index) => <span key={index}><SyntaxLine text={line} ranges={syntax?.[index]} />{index < lines.length - 1 ? "\n" : null}</span>)}</>;
}

/** Keep native selection, input methods and undo while painting code beneath the field. */
export function SyntaxTextarea({ path, value, className, inputClassName, ref, onScroll, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  path: string;
  value: string;
  ref?: Ref<HTMLTextAreaElement>;
  inputClassName?: string;
}) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const paint = useRef<HTMLPreElement>(null);
  function sync() {
    if (!paint.current || !input.current) return;
    paint.current.scrollTop = input.current.scrollTop;
    paint.current.scrollLeft = input.current.scrollLeft;
  }
  useLayoutEffect(sync, [value]);
  return <div className={cn("relative overflow-hidden", className)}>
    <pre ref={paint} aria-hidden className={cn("pointer-events-none absolute inset-0 m-0 overflow-hidden border-0 bg-transparent whitespace-pre", inputClassName)}>
      <SyntaxText text={value + (value.endsWith("\n") ? " " : "")} path={path} />
    </pre>
    <textarea {...props} value={value} ref={(node) => {
      input.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    }} onScroll={(event) => {sync(); onScroll?.(event);}} className={cn("relative block bg-transparent caret-foreground", inputClassName, "text-transparent selection:bg-primary/25 disabled:opacity-100")} />
  </div>;
}
