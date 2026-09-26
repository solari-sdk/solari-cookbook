// SPDX-License-Identifier: AGPL-3.0-only
// A WebSocket the tests script: auth is answered at once, every other frame
// goes through the static reply function, and a test can drop the socket or
// keep the runtime down to play a wsp restart. Replies land on a microtask,
// the way a real socket never answers inside send().
export type Frame = Record<string, unknown>;

export class ScriptedSocket {
  static instances: ScriptedSocket[] = [];
  static reply: (frame: Frame) => Frame | undefined = () => undefined;
  static authOk = true;
  /** false plays a runtime that is down: every new socket closes before it opens. */
  static serverUp = true;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    ScriptedSocket.instances.push(this);
    queueMicrotask(() => (ScriptedSocket.serverUp ? this.onopen?.() : this.drop(1006)));
  }
  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    if (frame["op"] === "auth") {
      const reply = ScriptedSocket.authOk ? { id: frame["id"], ok: true } : { id: frame["id"], ok: false, error: "unauthorized" };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
      if (!ScriptedSocket.authOk) queueMicrotask(() => this.drop(4401));
      return;
    }
    const reply = ScriptedSocket.reply(frame);
    if (reply) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
  }
  /** The server side going away, as a wsp restart looks from the tab. */
  drop(code: number): void {
    this.onclose?.({ code });
  }
  close(): void {
    this.drop(1000);
  }
  frames(op: string): Frame[] {
    return this.sent.filter(f => f["op"] === op);
  }
}
