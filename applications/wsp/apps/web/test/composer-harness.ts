// SPDX-License-Identifier: AGPL-3.0-only
// Drives the Lexical prompt editor the way a person does in jsdom: a click
// puts the caret at the end unless the focused editor already holds it (a DOM
// range plus the selectionchange the browser would fire), text arrives as a
// paste since jsdom has no beforeinput text insertion, a paste that does not
// land is clicked and pasted once more with a warning and throws the second
// time, and every step waits for the editor's microtask commit and React's
// render before returning.
import { act, fireEvent, screen } from "@testing-library/react";

export function composerEditor(): HTMLElement {
  return screen.getByTestId("composer-editor");
}

const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

export function clickIntoEditor(editor: HTMLElement): void {
  // A caret the editor already owns stays where it is (after Shift+Enter it sits between the two
  // line-break elements); a stale DOM selection left inside an editor that was not focused is not one.
  const alreadyFocused = document.activeElement === editor;
  editor.focus();
  const selection = window.getSelection();
  if (!selection) throw new Error("jsdom has no selection");
  if (alreadyFocused && selection.rangeCount > 0 && selection.anchorNode !== null && editor.contains(selection.anchorNode)) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  // jsdom never fires selectionchange itself, so the editor's "ignore the echo of my own
  // selection write" flag can still be armed from its last update and swallow one event.
  document.dispatchEvent(new Event("selectionchange"));
  document.dispatchEvent(new Event("selectionchange"));
}

async function paste(editor: HTMLElement, text: string): Promise<boolean> {
  const before = editor.textContent;
  fireEvent.paste(editor, { clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  await settle();
  return editor.textContent !== before || text.trim() === "" || !isEditable(editor);
}

export async function typeInto(editor: HTMLElement, text: string): Promise<void> {
  clickIntoEditor(editor);
  if (await paste(editor, text)) return;
  // Under load jsdom sometimes hands the editor a selectionchange it has not yet synced, and the
  // paste finds no range; a second click and paste is what a person would do. A third miss is real.
  const sel = window.getSelection();
  const state = `active=${document.activeElement === editor} anchor=${sel?.anchorNode?.nodeName ?? "none"}/${sel?.anchorOffset} html=${editor.innerHTML}`;
  console.warn(`typeInto: paste of ${JSON.stringify(text)} did not land (${state}); clicking again`);
  (document.activeElement as HTMLElement | null)?.blur();
  clickIntoEditor(editor);
  if (await paste(editor, text)) return;
  throw new Error(`typeInto: paste of ${JSON.stringify(text)} did not land twice; ${state}`);
}

export async function press(editor: HTMLElement, key: string, init: Omit<KeyboardEventInit, "key"> = {}): Promise<void> {
  fireEvent.keyDown(editor, { key, ...init });
  await settle();
}

export function isEditable(editor: HTMLElement): boolean {
  return editor.getAttribute("contenteditable") !== "false";
}
