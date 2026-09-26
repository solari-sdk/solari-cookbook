// SPDX-License-Identifier: AGPL-3.0-only
// The code a sign-in's page hands back, on the build's row: the field and its
// keycap belong to the row whose road takes a code, no other row shows them,
// and what is typed goes out once and is left nowhere.
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SETUP_WORDS, initSignInOutcome, SIGN_IN_OPEN_STATE, type InitJob, type InitRow } from "@wsp/protocol";
import { SignInSlide, StageList, buildView } from "../src/settings/recipe/BuildRows.js";

const PAGE = "https://accounts.google.com/o/oauth2/auth";
const PASTED = "4/0AfakeCodeFromThePage";
const WORDS = CLOUD_SETUP_WORDS.build;
const LABEL = "Google Cloud login";

const row = (over: Partial<InitRow> = {}): InitRow => ({ id: "sign-in/gcloud", kind: "sign-in", tool: "gcloud", label: LABEL, state: SIGN_IN_OPEN_STATE, page: PAGE, ...over });

/** The build's rows as the Image card draws them, with the code submit spied on. */
function screenWith(...rows: InitRow[]) {
  const onCode = vi.fn();
  const job: InitJob = { id: "init_1", road: "manual", phase: "signing-in", keys: { solari: true }, step: 0, stoppable: true, screens: [], rows, progress: { done: 0, total: rows.length }, log: [] };
  const view = buildView(job);
  const acts = { onRetry: vi.fn(), onCode };
  render(<div data-k="build">{view.slide ? <SignInSlide view={view} acts={acts} /> : <StageList job={job} view={view} acts={acts} />}</div>);
  const build = document.querySelector<HTMLElement>("[data-k=build]");
  if (build === null) throw new Error("the build screen did not render");
  return { onCode, build };
}

const field = (root: HTMLElement): HTMLInputElement => within(root).getByLabelText(`${LABEL}: ${WORDS.codeAsk}`) as HTMLInputElement;
const submitOf = (root: HTMLElement): HTMLButtonElement => within(root).getByRole("button", { name: WORDS.codeSubmit }) as HTMLButtonElement;

afterEach(cleanup);

describe("the code field under a sign-in row", () => {
  it("is on the row whose page hands a code back, under it, with the page's own keycap still there", () => {
    const { build } = screenWith(row({ finish: "code" }));
    expect(field(build).placeholder).toBe(WORDS.codeAsk);
    expect(submitOf(build)).toBeDefined();
    expect(build.querySelector("[data-k=open]")).not.toBeNull();
    // Under the row's own line, inside the row it belongs to.
    expect(build.querySelector('[data-row="sign-in/gcloud"] [data-k=code-line] [data-k=code-field]')).not.toBeNull();
    expect(build.querySelector('[data-row="sign-in/gcloud"] > div:first-child [data-k=code-field]')).toBeNull();
  });

  it("takes what is typed to the host once, for that row's tool, and clears itself; Enter does what the keycap does", () => {
    const { onCode, build } = screenWith(row({ finish: "code" }));
    // Nothing typed, nothing to press.
    expect(submitOf(build).disabled).toBe(true);
    fireEvent.change(field(build), { target: { value: `  ${PASTED}  ` } });
    expect(submitOf(build).disabled).toBe(false);
    fireEvent.click(submitOf(build));
    expect(onCode).toHaveBeenCalledTimes(1);
    expect(onCode).toHaveBeenCalledWith({ tool: "gcloud", code: PASTED });
    // Gone from the field as it goes to the machine, so nothing on this screen holds it.
    expect(field(build).value).toBe("");
    expect(build.textContent).not.toContain(PASTED);
    fireEvent.change(field(build), { target: { value: PASTED } });
    fireEvent.keyDown(field(build), { key: "Enter" });
    expect(onCode).toHaveBeenCalledTimes(2);
    expect(onCode).toHaveBeenLastCalledWith({ tool: "gcloud", code: PASTED });
  });

  it("is nowhere else: not on the callback road, not on a row with no road, not once the row is over", () => {
    for (const over of [{ finish: "callback" as const }, {}, { finish: "code" as const, ...initSignInOutcome("signed-in", "darwin") }]) {
      const { build } = screenWith(row(over));
      expect(build.querySelector("[data-k=code-line]")).toBeNull();
      cleanup();
    }
  });

  it("two sign-ins waiting at once: the field is on the one that takes a code and not on its neighbour", () => {
    const { build } = screenWith(row({ finish: "code" }), row({ id: "sign-in/wrangler", tool: "wrangler", label: "Cloudflare login", finish: "callback" }));
    expect(build.querySelectorAll("[data-k=code-line]")).toHaveLength(1);
    expect(build.querySelector('[data-row="sign-in/gcloud"] [data-k=code-line]')).not.toBeNull();
  });
});
