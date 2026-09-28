// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstRun } from "./FirstRun.js";
import { FIRST_RUN_WORDS } from "../sidebar/words.js";
import { onAddProjectRequest } from "./shellRequests.js";

const k = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-k=${name}]`)!;

afterEach(cleanup);

describe("the first run", () => {
  it("is an empty state: the title, what a project is, and one button, with no field of its own", () => {
    render(<FirstRun />);
    expect(k("title").textContent).toBe(FIRST_RUN_WORDS.title);
    expect(k("sentence").textContent).toBe(FIRST_RUN_WORDS.sentence);
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(k("add-project").textContent).toBe(FIRST_RUN_WORDS.add);
    expect(document.body.textContent).not.toMatch(/image|account|sign in|size/i);
  });

  it("asks for the Add a project dialog on a click, which the sidebar answers", () => {
    const heard = vi.fn();
    const off = onAddProjectRequest(heard);
    render(<FirstRun />);
    fireEvent.click(k("add-project"));
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });
});
