// SPDX-License-Identifier: AGPL-3.0-only
// The native context menu the page asks for through the preload: its rows
// come serialized from the page's action registries, so the template is a
// straight mapping, and the answer is the id of the row clicked or null.
import type { ContextMenuItem } from "@wsp/protocol";
import type { MenuItemConstructorOptions } from "electron";

const isItem = (raw: unknown): raw is ContextMenuItem => {
  if (typeof raw !== "object" || raw === null) return false;
  const item = raw as Record<string, unknown>;
  const optionalString = (key: string) => item[key] === undefined || typeof item[key] === "string";
  return (
    typeof item["id"] === "string" &&
    typeof item["label"] === "string" &&
    typeof item["group"] === "string" &&
    typeof item["enabled"] === "boolean" &&
    optionalString("refusal") &&
    optionalString("hint") &&
    optionalString("shortcut") &&
    optionalString("accelerator") &&
    (item["destructive"] === undefined || typeof item["destructive"] === "boolean") &&
    (item["checked"] === undefined || typeof item["checked"] === "boolean")
  );
};

/** What a row says on hover: why it cannot run, else what it does. One slot, refusal first, as every button in the
 * app reads the same pair. */
const hoverWords = (item: ContextMenuItem): string | undefined => item.refusal ?? item.hint;

/** Only the page's own shape comes off the wire; anything else is refused before a menu is built from it. */
export function parseContextMenuItems(raw: unknown): ContextMenuItem[] {
  if (!Array.isArray(raw) || !raw.every(isItem)) throw new Error("menu:context: not a list of items");
  return raw;
}

/** One row per item in the page's order, a separator where the group changes; a row that cannot run is dimmed with its
 * refusal as the hover text, a row that can run carries its hint there instead, and a row that marks a state is a
 * checkbox row with its mark. */
export function contextMenuTemplate(items: ReadonlyArray<ContextMenuItem>, choose: (id: string) => void): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  for (const [index, item] of items.entries()) {
    if (index > 0 && items[index - 1]!.group !== item.group) template.push({ type: "separator" });
    const hover = hoverWords(item);
    template.push({
      label: item.label,
      enabled: item.enabled,
      ...(hover !== undefined ? { toolTip: hover } : {}),
      ...(item.accelerator !== undefined ? { accelerator: item.accelerator } : {}),
      ...(item.checked !== undefined ? { type: "checkbox" as const, checked: item.checked } : {}),
      click: () => choose(item.id),
    });
  }
  return template;
}

/** Shows the menu and answers with the row clicked, or null once it closed on nothing. The close arrives before the
 * click on macOS, so a dismissal waits one turn for a click to claim the answer first. */
export function chooseFrom(items: ReadonlyArray<ContextMenuItem>, popup: (template: MenuItemConstructorOptions[], onClose: () => void) => void): Promise<string | null> {
  return new Promise(resolve => {
    let answered = false;
    const answer = (id: string | null): void => {
      if (answered) return;
      answered = true;
      resolve(id);
    };
    popup(contextMenuTemplate(items, answer), () => setTimeout(() => answer(null), 0));
  });
}
