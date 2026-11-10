import { act } from "react";

export async function chooseChoice(trigger: HTMLElement, value: string) {
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true,cancelable:true})));
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.dataset.choiceValue === value);
  if (!option) throw new Error(`Missing choice: ${value}`);
  await act(async () => option.click());
}
