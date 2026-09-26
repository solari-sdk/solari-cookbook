// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { ARM_MS, ESCALATE_MS, IDLE, offered, press, settle, type KillState } from "../src/components/procs/kill.js";

describe("kill flow", () => {
  it("first press arms TERM, a second within two seconds sends it", () => {
    const armed = press(IDLE, 1000);
    expect(armed).toEqual({ state: { step: "armed", signal: "TERM", at: 1000 }, send: undefined });
    expect(offered(armed.state, 1500)).toEqual({ signal: "TERM", confirm: true });
    const sent = press(armed.state, 1000 + ARM_MS - 1);
    expect(sent).toEqual({ state: { step: "sent", signal: "TERM", at: 1000 + ARM_MS - 1 }, send: "TERM" });
  });

  it("an arm nobody confirms lapses after two seconds", () => {
    const armed = press(IDLE, 1000).state;
    expect(settle(armed, 1000 + ARM_MS - 1)).toBe(armed);
    expect(settle(armed, 1000 + ARM_MS)).toEqual(IDLE);
    // A press after the lapse arms again rather than sending.
    expect(press(armed, 1000 + ARM_MS)).toEqual({ state: { step: "armed", signal: "TERM", at: 1000 + ARM_MS }, send: undefined });
  });

  it("KILL is offered only after TERM did nothing for five seconds, and is itself two steps", () => {
    const sent: KillState = { step: "sent", signal: "TERM", at: 5000 };
    expect(offered(sent, 5000 + ESCALATE_MS - 1)).toBeNull();
    expect(press(sent, 5000 + ESCALATE_MS - 1)).toEqual({ state: sent, send: undefined });
    expect(offered(sent, 5000 + ESCALATE_MS)).toEqual({ signal: "KILL", confirm: false });
    const armed = press(sent, 5000 + ESCALATE_MS);
    expect(armed.state).toEqual({ step: "armed", signal: "KILL", at: 5000 + ESCALATE_MS });
    expect(offered(armed.state, 5000 + ESCALATE_MS + 100)).toEqual({ signal: "KILL", confirm: true });
    expect(press(armed.state, 5000 + ESCALATE_MS + 100).send).toBe("KILL");
    // A KILL that changed nothing is offered again after another five seconds.
    const killed: KillState = { step: "sent", signal: "KILL", at: 20_000 };
    expect(offered(killed, 20_000 + ESCALATE_MS)).toEqual({ signal: "KILL", confirm: false });
  });

  it("idle offers TERM, unconfirmed", () => {
    expect(offered(IDLE, 0)).toEqual({ signal: "TERM", confirm: false });
    expect(settle(IDLE, 99_999)).toBe(IDLE);
  });
});
