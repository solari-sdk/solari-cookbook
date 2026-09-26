// SPDX-License-Identifier: AGPL-3.0-only
// One pick in the app's select under jsdom, which takes a click on an item
// only once a key has highlighted it.
import { act, fireEvent, screen } from "@testing-library/react";

/** Opens the select, picks the option by its name and answers every option it offered, each as it read. */
export async function pickOption(trigger: Element, name: string | RegExp): Promise<string[]> {
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name });
  await act(async () => void (await new Promise(r => setTimeout(r, 0))));
  const offered = screen.getAllByRole("option").map(o => o.textContent ?? "");
  fireEvent.keyDown(option, { key: "Enter" });
  fireEvent.click(option);
  return offered;
}
