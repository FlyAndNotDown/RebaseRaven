// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SyntaxText, SyntaxTextarea } from "@/components/syntax-text";

it("keeps the native editor value, selection and scroll independent from syntax paint", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<HTMLTextAreaElement>();
  const onChange = vi.fn();
  const text = "const count = 1;\n/* comment */\n";
  try {
    await act(async () => root.render(<SyntaxTextarea ref={ref} path="app.ts" value={text} onChange={onChange} />));
    for (let attempt = 0; attempt < 40 && !container.querySelector(".tok-keyword"); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    expect(container.querySelector(".tok-keyword")?.textContent).toBe("const");
    const input = ref.current!;
    expect(input.value).toBe(text);
    input.setSelectionRange(6, 11);
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("count");
    input.scrollTop = 40;
    input.scrollLeft = 80;
    await act(async () => input.dispatchEvent(new Event("scroll")));
    expect(container.querySelector("pre")?.scrollTop).toBe(40);
    expect(container.querySelector("pre")?.scrollLeft).toBe(80);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => root.render(<SyntaxText text={text} path="unknown.data" />));
    expect(container.textContent).toBe(text);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
