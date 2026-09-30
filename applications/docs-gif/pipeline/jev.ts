async function evaluate(state: string, questions: Record<string, unknown>) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
  });
  if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${await res.text()}`);
  return (await res.json()) as { answers: Record<string, any> };
}

const ROLES = ["link", "button", "textbox", "checkbox", "combobox", "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "option"];
const INTERACTIVE = new RegExp(`^(${ROLES.join("|")})$`);
export const MAX_STEPS = 10;

// What this agent can do, for whoever plans its goals. Update alongside the code in this file.
export const CAPABILITIES = `The browser agent can only click elements of these kinds: ${ROLES.join(", ")}, and gets at most ${MAX_STEPS} clicks per goal. It cannot type text, press keys, scroll, drag, or hover.`;

export function choicesFromTree(tree: string): Record<string, string> {
  return Object.fromEntries(
    [...tree.matchAll(/^\s*- (\w+) "([^"]*)".*\[ref=(\w+)\]/gm)]
      .filter(([, role]) => INTERACTIVE.test(role!))
      .map(([, role, label, ref]) => [ref, `${role} "${label}"`]),
  );
}

// history: clicks so far, so the agent knows the steps are already done and answers "done" instead of looping.
export async function nextClick(goal: string, tree: string, history: string[] = []) {
  const choices = choicesFromTree(tree);
  const { answers } = await evaluate(
    `Goal: ${goal}\n\nClicks made so far, in order: ${history.length ? history.join(" → ") : "none yet"}\n\nCurrent page (accessibility tree):\n${tree}`,
    {
      next: {
        type: "choice",
        instructions: "Which element should be clicked next to reach the goal? Answer done if the page already shows the goal reached, or if the clicks made so far already completed the steps. Never repeat a sequence that has already been performed.",
        criteria: { done: "the goal is already reached, stop", ...choices },
      },
    },
  );
  const ref: string = answers.next.choice;
  return { ref, label: choices[ref] ?? ref };
}
