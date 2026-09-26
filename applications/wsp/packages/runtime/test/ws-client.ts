import WebSocket from "ws";
import { openFrame, type Seal } from "@wsp/keys";

export interface WireMsg {
  id?: string | number | null;
  ok?: boolean;
  type?: string;
  [k: string]: unknown;
}

/** Minimal protocol client for tests: auth via first message, then request/reply. */
export class WsClient {
  private nextId = 1;
  private pending = new Map<number, (m: WireMsg) => void>();
  readonly events: WireMsg[] = [];
  /** Set once a place's handshake agreed a key: every frame this client sends from then on rides inside it and
   * every frame it reads is opened with it, which is what a computer on a place link does. */
  seal: Seal | undefined;
  /** Whoever is reading every frame this socket is pushed. One socket opens each frame once, since a seal counts
   * the frames it opens: a second reader unsealing the same bytes would put the two counters out of step. */
  private readonly readers: ((m: WireMsg) => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", raw => {
      const m = JSON.parse(openFrame(this.seal, raw)) as WireMsg;
      for (const read of this.readers) read(m);
      // A frame carrying an op is one the host sent this socket, and its id is the host's own numbering: it is
      // never the answer to a request made here, however that number lines up with one still waiting.
      if (typeof m.op === "string") {
        this.events.push(m);
        return;
      }
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.type) {
        this.events.push(m);
      }
    });
  }

  static connect(port: number, opts: { token?: string; ticket?: string; headers?: Record<string, string> } = {}): Promise<WsClient> {
    const qs = opts.ticket ? `/?ticket=${encodeURIComponent(opts.ticket)}` : "/";
    return WsClient.connectTo(`ws://127.0.0.1:${port}${qs}`, opts);
  }

  /** The same dial at a URL the caller spells out, for the runtime served on an HTTP server's own port and path.
   * `headers` ride the upgrade, which is where a request's road is read. */
  static async connectTo(url: string, opts: { token?: string; headers?: Record<string, string> } = {}): Promise<WsClient> {
    const ws = new WebSocket(url, opts.headers === undefined ? undefined : { headers: opts.headers });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const client = new WsClient(ws);
    if (opts.token !== undefined) {
      const res = await client.request("auth", { token: opts.token });
      if (!res.ok) throw new Error(`auth failed: ${String(res["error"])}`);
    }
    return client;
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<WireMsg> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      const text = JSON.stringify({ id, op, ...params });
      this.ws.send(this.seal === undefined ? text : this.seal.seal(text));
    });
  }

  /** Reads every frame the other end sends, opened with the seal where the handshake agreed one: what a fake
   * computer answers the host's frames from. */
  onFrame(read: (m: WireMsg) => void): void {
    this.readers.push(read);
  }

  /** One frame out, sealed where the handshake agreed a key. */
  say(payload: Record<string, unknown>): void {
    const text = JSON.stringify(payload);
    this.ws.send(this.seal === undefined ? text : this.seal.seal(text));
  }

  closed(): Promise<number> {
    return new Promise(resolve => this.ws.once("close", code => resolve(code)));
  }

  close(): void {
    this.ws.close();
  }
}

/** One-shot: connect, auth, send a single request, return the reply. */
export async function wsRequest(
  port: number,
  token: string,
  req: { op: string } & Record<string, unknown>,
): Promise<WireMsg> {
  const c = await WsClient.connect(port, { token });
  const { op, ...params } = req;
  const res = await c.request(op, params);
  c.close();
  return res;
}

let wired = 0;

/** A project over the wire and a workspace of it. A test about the frames is not about the project, and a
 * workspace is one project's copy, so this is the one line that makes both: a fresh repo on the computer this
 * host forks at, since one source on one computer is one project. */
export async function createOverWire(c: Pick<WsClient, "request">, name: string, body: Record<string, unknown> = {}): Promise<WireMsg> {
  const answer = await c.request("projects.add", { source: `https://github.com/wsp/wire-${++wired}.git`, on: "default" });
  const project = (answer["project"] as { id: string } | undefined)?.id;
  return c.request("workspaces.create", { ...(project !== undefined ? { project } : {}), name, ...body });
}
