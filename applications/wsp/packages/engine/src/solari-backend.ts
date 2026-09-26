import { machineUnreachableLine, moveTimedOutLine, providerRoadRetryLine, RESUME_UNANSWERED, type Capabilities } from "@wsp/protocol";
import { ExecFailedError, MachineUnreachableError, MoveUnansweredError, NapRefusedError, NotFirstLifeError, ResumeUnansweredError, ROAD_TRIES, abort, backoffMs, classify, isCapped, isMissing, isNetworkError, realRetryClock, roadBackoffMs, roadCode, shouldRetry, type RetryClock, type WspError } from "./errors.js";
import { INLINE_EXEC_MS, execDetached } from "./exec-detached.js";
import { EXEC_ENV } from "./golden-import.js";
import type { BackendPricing, ExecResult, Lifecycle, Machine, MachineBackend, MachineKind, MachineLife, MachineShape, MachineSpec, MachineState, PreviewReach, RunOptions, SnapshotRow, SnapshotStoragePricing, TemplateRow } from "./machine.js";
import { BUILDER_DISK_GB } from "./tool-sizes.js";

type Fetch = typeof globalThis.fetch;

export interface SolariBackendOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  /** The clock the retries sleep on; tests hand in one that costs nothing. */
  clock?: RetryClock;
  /** How long a pause gets in all, the cap on one resume call, and the bound on one read of a machine's state after
   * a call that did not answer; the measured defaults when absent (tests shrink them to milliseconds). */
  budgets?: Partial<MoveBudgets>;
}

/** The budgets a pause and a resume run on here, in milliseconds. */
export interface MoveBudgets {
  pauseMs: number;
  resumeCapMs: number;
  stateReadMs: number;
}

interface SandboxView {
  sandboxId: string;
  kind: MachineKind;
  state: "starting" | "running" | "paused" | "archived" | "releasing" | "gone";
  metadata?: Record<string, string>;
  cpu?: number;
  memMb?: number;
  /** The provisioned root in GiB; on GET and the listing only, never on the create reply
   * (measured 2026-09-04). */
  diskGb?: number;
  createdAt?: string;
}

interface TemplateView {
  templateId: string;
  name: string;
  status: TemplateRow["status"];
  /** Null, not absent, on a custom template that has not failed (the reference's own listing example). */
  error?: string | null;
  /** On a promoted or built template; the provider's built-ins list without one. */
  createdAt?: string | null;
}

const templateRowOf = (t: TemplateView): TemplateRow => ({ id: t.templateId, name: t.name, status: t.status, ...(t.error !== undefined && t.error !== null ? { error: t.error } : {}), ...(t.createdAt !== undefined && t.createdAt !== null ? { createdAt: t.createdAt } : {}) });

const STATE_MAP: Record<SandboxView["state"], MachineState> = {
  starting: "starting",
  running: "running",
  paused: "paused",
  archived: "gone",
  releasing: "gone",
  gone: "gone",
};

/** A state word the table never learned reads running: a delete that read it as gone would leave a machine billing
 * with nobody watching it. */
const stateOf = (state: string): MachineState => STATE_MAP[state as SandboxView["state"]] ?? "running";

/** Solari changelog 2026-09-04: snapshot storage is billed from 2026-10-01, 10 GB free per organization, then $0.05 per GB-month pro-rated daily. */
export const SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" };

/** Measured 2026-09-07: Solari's replies carry no request id header, so requestId stays unset; the common name is read should one appear. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Solari's published Starter pricing: per vCPU-hour plus per GB-hour (2 vCPU, 4 GB comes to about $0.11/hr). */
const rateUsdPerHour = (size: { cpu: number; memMb: number }): number => size.cpu * 0.035 + (size.memMb / 1024) * 0.01;

/** The Starter plan clamps every sandbox to 2 vCPU, so the rows differ by memory alone. 4 GB is the shape of every
 * machine measured so far; 8 GB is the next value the create API takes and has not been measured on this account. */
const SIZES: readonly { cpu: number; memMb: number }[] = [
  { cpu: 2, memMb: 4096 },
  { cpu: 2, memMb: 8192 },
];

/** The price table, readable with no key: the Starter clamp doubles as the assumed shape for specs that never named a
 * size, and the setup screen says what a machine costs before any key is typed. */
export const SOLARI_PRICING: BackendPricing = {
  rateUsdPerHour,
  defaultSize: SIZES[0]!,
  snapshotStorage: SNAPSHOT_STORAGE,
  builderDiskGb: BUILDER_DISK_GB,
};

/** How long one resume the provider has not taken is waited on. Measured 2026-09-10 on this account: every read of
 * a paused machine answered in 0.4 s while POST resume answered nothing for the 30 s a curl gave it, so a wake that
 * sits on the call tells the person nothing for as long as it sits; nothing else holds a wake's clock. */
export const RESUME_CAP_MS = 30_000;
/** How long a pause gets in all: about 75 s live, and its call can hang at the HTTP level while the operation lands
 * (measured 2026-09-10), so the call is sent twice at most inside four minutes. */
export const PAUSE_MS = 4 * 60_000;
/** One read of the state after a call that did not answer; the client sets no request timeout of its own. */
export const STATE_READ_MS = 30_000;

/** The longest idleTimeoutMs the create API has taken from us: six hours, the golden builder's. */
export const IDLE_TIMEOUT_MAX_MS = 6 * 60 * 60_000;

/** The longest one exec may ask the provider for: "timeoutMs must be at most 26000 for a dedicated sandbox" (400 on
 * 26001, measured 2026-09-23), so anything longer runs detached on the guest instead. */
export const SOLARI_INLINE_MAX_MS = 26_000;

/** The provider's answer to a command on a machine it has lost the road to while its state read still says running
 * (seen 2026-09-23). Matched on the words alone: the status it rode on was never recorded. */
const SANDBOX_UNREACHABLE = "Sandbox is not reachable";

/** The provider's 502 to a command on a machine its state read says running (seen 2026-09-23); status and words both recorded. */
const EXEC_FAILED = "exec failed";

/** The provider's 409 to a pause of a machine whose memory and disk together pass about 10 GB (measured 2026-09-23). */
const NOT_PAUSABLE = "Not pausable";

// Frozen: one shared object every SolariBackend hands out, so nothing shrinks a budget for everyone by accident.
export const SOLARI_LIFECYCLE: Lifecycle = Object.freeze({
  budgets: Object.freeze({
    // A resume can land a zombie on a fresh host at default size; one re-pause and resume clears it, a second never has.
    wakeAttempts: 2,
    // The daemon answers about a second after a wake and after a fork.
    daemonAnswersMs: 30_000,
    // Thirty minutes of asking, once a minute, so a provider that comes back inside its own outage wakes the machine
    // with nobody watching. Both are wall time from the first ask: a resume that sits on its cap spends half of its
    // own minute, and counting the cadence after the cap made thirty asks span 45 minutes (seen live 2026-09-10).
    resumeAsks: Object.freeze({ everyMs: 60_000, forMs: 30 * 60_000 }),
  }),
});

/** Measured: the pt_token exp claim is 60 minutes from mint. */
export const PREVIEW_TTL_MS = 60 * 60_000;

/** Epoch-ms expiry of a preview token. Not a 3-part JWT: base64url(JSON claims) + "." + signature, and the sandboxId
 * claim embeds literal dots, so cut at the last dot first and fall back to decoding the whole string. */
export function previewTokenExpiry(token: string, now = Date.now()): number {
  for (const cut of [token.lastIndexOf("."), token.length]) {
    if (cut <= 0) continue;
    const decoded = Buffer.from(token.slice(0, cut), "base64url").toString("utf8");
    const exp = /"exp":(\d+)/.exec(decoded)?.[1];
    if (exp !== undefined) return Number(exp);
  }
  return now + PREVIEW_TTL_MS;
}

function fail(e: WspError): never {
  const message = e.message || `${e.kind} (${e.status})`;
  throw Object.assign(new Error(message), e, { message });
}

export class SolariBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: true,
    pauseMode: "memory",
    replacesMachine: true, // a fork of the golden snapshot comes up as the machine it replaces, processes and all
    previewUrls: true,
    signedUrls: true,
    callbackRelay: true, // the daemon link rides previewUrls
    diskSnapshots: true,
    images: true, // the provider keeps the snapshots and templates a fork boots from
    snapshotsAnyLife: false, // the provider answers 502 on a machine that was resumed, and the builder is consumed with it
    snapshotListing: true,
    templates: true,
    kept: false, // a fork wsp made and can rebuild in a minute: a turn that wrecks its disk costs nothing else
    copies: true, // a fork of the image with the project cloned into it
    ownNetwork: true, // the machine is its own, so its localhost and its ports are its own
    sizes: SIZES.map(size => ({ ...size, rateUsdPerHour: rateUsdPerHour(size) })),
  };

  readonly pricing = SOLARI_PRICING;

  readonly lifecycle = SOLARI_LIFECYCLE;

  readonly budgets: MoveBudgets;
  readonly clock: RetryClock;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: Fetch;

  constructor(opts: SolariBackendOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.getsolari.com";
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? realRetryClock;
    this.budgets = { pauseMs: opts.budgets?.pauseMs ?? PAUSE_MS, resumeCapMs: opts.budgets?.resumeCapMs ?? RESUME_CAP_MS, stateReadMs: opts.budgets?.stateReadMs ?? STATE_READ_MS };
  }

  /** capMs cuts the call off here when the provider has not answered it in that long, and `signal` cuts it off when
   * the caller has stopped waiting; both ride the one fetch, so no road grows a timer beside this one. */
  async request<T>(method: string, path: string, body?: unknown, capMs?: number, signal?: AbortSignal): Promise<T> {
    return (await this.call<T>(method, path, body, undefined, capMs, signal)).value;
  }

  /** keyed: the request carries an idempotency key the provider honours, so a fetch that throws (no answer at all) is
   * sent once more under it and a replay is the expected reply; without a key a lost answer is the caller's. */
  private async call<T>(method: string, path: string, body?: unknown, keyed?: { "Idempotency-Key": string }, capMs?: number, signal?: AbortSignal): Promise<{ value: T; reply: Response }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, ...keyed };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let resent = false;
    // One budget for the whole request, never reset by an answer: a counter that started over after each one would
    // let a call ping-pong between a dropped lookup and a gateway status for minutes.
    let roadRetries = 0;
    // Attempt counts answers, so a road that flapped before the first one leaves the retries of a gateway status whole.
    let attempt = 1;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetch(this.baseUrl + path, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          ...abort(capMs, signal),
        });
      } catch (e) {
        // A road that failed never carried the request out, so every call is safe to send again, keyed or not.
        const road = roadCode(e);
        if (road !== undefined) {
          if (++roadRetries >= ROAD_TRIES) throw e;
          console.warn(providerRoadRetryLine(`${method} ${path}`, road, roadRetries + 1, ROAD_TRIES));
          await this.clock.sleep(roadBackoffMs(roadRetries));
          continue;
        }
        if (keyed === undefined || resent) throw e;
        resent = true;
        await this.clock.sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) {
        const text = await res.text();
        return { value: (text ? JSON.parse(text) : {}) as T, reply: res };
      }
      // A body that is not JSON (a gateway's plain "Internal Server Error") is still the provider's words.
      const raw = (await res.text().catch(() => "")).trim();
      let errBody: { code?: string; error?: string } = {};
      try { errBody = JSON.parse(raw) as typeof errBody; } catch { errBody = raw === "" ? {} : { error: raw.slice(0, 300) }; }
      const e = classify(res.status, errBody, res.headers.get(REQUEST_ID_HEADER) ?? undefined);
      if (!shouldRetry(e, attempt)) fail(e);
      await this.clock.sleep(backoffMs(attempt));
      attempt++;
    }
  }

  async create(spec: MachineSpec): Promise<Machine> {
    // Only /sandboxes and /desktops honour the key (measured 2026-09-04); one key rides every retry of this call, so a
    // retried 5xx replays the machine the first try booted instead of booting a second.
    const { value: res, reply } = await this.call<{ sandboxId: string; kind: MachineKind; streamUrl?: string; state?: SandboxView["state"]; createdAt?: string }>(
      "POST", "/sandboxes", {
        kind: spec.kind,
        ...(spec.template ? { template: spec.template } : {}),
        ...(spec.fromSnapshot ? { fromSnapshot: spec.fromSnapshot } : {}),
        ...(spec.cpu ? { cpu: spec.cpu } : {}),
        ...(spec.memMb ? { memMb: spec.memMb } : {}),
        // camelCase: Solari honours diskGb 1 to 20 and drops disk_gb like any unknown field
        // (measured 2026-09-04).
        ...(spec.diskGb ? { diskGb: spec.diskGb } : {}),
        ...(spec.envs ? { envs: spec.envs } : {}),
        ...(spec.labels ? { metadata: spec.labels } : {}),
        ...(spec.onIdle ? { lifecycle: { onTimeout: spec.onIdle } } : {}),
        ...(spec.idleTimeoutMs ? { timeoutMs: Math.min(spec.idleTimeoutMs, IDLE_TIMEOUT_MAX_MS) } : {}),
      },
      { "Idempotency-Key": spec.idempotencyKey ?? crypto.randomUUID() },
    );
    // The create response has carried no createdAt (measured 2026-09-04); when it does, it rides on seen for information and nothing reads it.
    const seen = res.createdAt !== undefined ? { state: stateOf(res.state ?? "running"), createdAt: res.createdAt } : undefined;
    return new SolariMachine(this, res.sandboxId, res.kind ?? spec.kind, res.streamUrl, spec.labels, seen, reply.headers.get("Idempotent-Replayed") === "true");
  }

  /** The template table is the cheapest read the key opens: it is the account's own, every account has the
   * provider's built-ins in it, and it boots no machine and resets no idle clock. */
  async checkKey(): Promise<void> {
    await this.listTemplates();
  }

  async get(id: string): Promise<Machine> {
    const view = await this.request<SandboxView>("GET", `/sandboxes/${encodeURIComponent(id)}`);
    return new SolariMachine(this, view.sandboxId ?? id, view.kind ?? "sandbox", undefined, view.metadata, {
      state: stateOf(view.state),
      ...(view.createdAt !== undefined ? { createdAt: view.createdAt } : {}),
    });
  }

  async list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[]> {
    const out: { id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(labels ?? {})) params.set(`metadata.${k}`, v);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      const page = await this.request<{ sandboxes: SandboxView[]; nextCursor?: string }>(
        "GET", `/sandboxes${qs ? `?${qs}` : ""}`,
      );
      for (const s of page.sandboxes ?? []) {
        out.push({
          id: s.sandboxId,
          state: stateOf(s.state),
          labels: s.metadata ?? {},
          ...(s.cpu !== undefined && s.memMb !== undefined ? { size: { cpu: s.cpu, memMb: s.memMb } } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.request("DELETE", `/snapshots/${encodeURIComponent(id)}`);
  }

  async promoteSnapshot(id: string, name: string): Promise<string> {
    const res = await this.request<{ templateId: string }>("POST", `/snapshots/${encodeURIComponent(id)}/promote`, { name });
    return res.templateId;
  }

  async getTemplate(id: string): Promise<TemplateRow> {
    return templateRowOf(await this.request<TemplateView>("GET", `/templates/${encodeURIComponent(id)}`));
  }

  async listTemplates(): Promise<TemplateRow[]> {
    const page = await this.request<{ templates?: unknown }>("GET", "/templates");
    if (!Array.isArray(page.templates)) throw new Error("GET /templates answered without a templates array");
    return (page.templates as TemplateView[]).map(templateRowOf);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.request("DELETE", `/templates/${encodeURIComponent(id)}`);
  }

  async listSnapshots(): Promise<SnapshotRow[]> {
    const page = await this.request<{ snapshots?: unknown }>("GET", "/snapshots");
    if (!Array.isArray(page.snapshots)) throw new Error("GET /snapshots answered without a snapshots array");
    // The name is read because a snapshot carries no metadata: POST /sandboxes/:id/snapshots takes a name alone and
    // the listing answers no metadata field, so wsp's owner mark rides on the name (snapshot-names.ts).
    return (page.snapshots as { id: string; name?: string | null; sizeBytes: number; createdAt?: string; parent?: string | null }[]).map(s => ({
      id: s.id,
      ...(s.name !== undefined && s.name !== null ? { name: s.name } : {}),
      sizeBytes: s.sizeBytes,
      ...(s.createdAt !== undefined ? { createdAt: s.createdAt } : {}),
      ...(s.parent !== undefined ? { parent: s.parent } : {}),
    }));
  }
}

class SolariMachine implements Machine {
  constructor(
    private readonly backend: SolariBackend,
    readonly id: string,
    readonly kind: MachineKind,
    readonly streamUrl?: string,
    readonly labels?: Record<string, string>,
    readonly seen?: { state: MachineState; createdAt?: string },
    readonly replayed?: boolean,
  ) {}

  private path(suffix = ""): string {
    return `/sandboxes/${encodeURIComponent(this.id)}${suffix}`;
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? INLINE_EXEC_MS;
    // The detached road's own execs ask for the inline span, so they take the road below here and nothing recurses.
    if (timeoutMs > SOLARI_INLINE_MAX_MS) return execDetached(this, cmd, { deadlineMs: timeoutMs });
    // bash -c, never -lc: login shells reset PATH and lose /root/.local/bin.
    // The exec environment carries PATH and nothing else (measured 2026-09-05): HOME and USER go ahead of
    // every command, SHELL stays unset so a pty reads it off passwd.
    try {
      return await this.backend.request<ExecResult>("POST", this.path("/exec"), {
        cmd: "bash",
        args: ["-c", `${EXEC_ENV}\n${cmd}`],
        timeoutMs,
      });
    } catch (e) {
      if (e instanceof Error && e.message === SANDBOX_UNREACHABLE) throw new MachineUnreachableError(this.id, e.message, (e as { status?: number }).status ?? 0, machineUnreachableLine(e.message));
      if (e instanceof Error && (e as { status?: unknown }).status === 502 && e.message === EXEC_FAILED) throw new ExecFailedError(this.id, e.message, 502);
      throw e;
    }
  }

  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return execDetached(this, script, opts);
  }

  /** A snapshot of a machine that was ever resumed is refused with a 502, and same-host or cross-host is invisible
   * from outside (measured), so a resumed machine is refused here before any call. */
  async snapshot(name: string, life: MachineLife): Promise<string> {
    if (!life.firstLife) throw new NotFirstLifeError(this.id, `snapshot ${name}`);
    const res = await this.backend.request<{ snapshotId: string }>("POST", this.path("/snapshots"), { name });
    return res.snapshotId;
  }

  /** Returns when the provider reads the machine paused. The call hangs at the HTTP level while the operation lands
   * (measured 2026-09-10), so a call that did not answer inside its share of the budget, or that the network dropped,
   * is followed by one read of the state: paused is done, running gets the call once more with the rest of the
   * budget, and anything else, a second miss or a spent budget ends the move with the row's words. A refusal the
   * provider answered with is thrown as itself. */
  async pause(): Promise<void> {
    const { pauseMs, stateReadMs } = this.backend.budgets;
    const now = this.backend.clock.now;
    const started = now();
    const deadline = started + pauseMs;
    let unanswered: unknown;
    for (let attempt = 1; ; attempt++) {
      const left = deadline - now();
      if (left > 0) {
        try {
          // The two attempts share what is left: the first takes half, the second the rest.
          await this.backend.request("POST", this.path("/pause"), {}, attempt === 1 ? left / 2 : left);
          return;
        } catch (e) {
          if ((e as { status?: unknown }).status === 409 && e instanceof Error && e.message === NOT_PAUSABLE) throw new NapRefusedError(this.id, e.message);
          if (!isCapped(e) && !isNetworkError(e)) throw e;
          unanswered = e;
        }
      }
      const reads = await this.readState(stateReadMs);
      if (reads === "paused") return;
      if (attempt === 1 && reads === "running" && deadline > now()) continue;
      const words = moveTimedOutLine("pause", now() - started, reads);
      console.warn(`${this.id}: ${words}`);
      throw new MoveUnansweredError(words, { cause: unanswered });
    }
  }

  /** Returns when the provider reads the machine running or starting. The provider has answered nothing at all to
   * this call for half an hour at a stretch while taking the resume anyway (measured 2026-09-10), so the call is
   * cut off at its cap and the machine's own state settles it: running or starting is a resume that landed, and
   * anything else ends in ResumeUnansweredError, the one failure the host answers by asking again. `signal` is the
   * caller's own stop, whose failure is thrown as itself. */
  async resume(signal?: AbortSignal): Promise<void> {
    const { resumeCapMs, stateReadMs } = this.backend.budgets;
    try {
      await this.backend.request("POST", this.path("/resume"), {}, resumeCapMs, signal);
    } catch (e) {
      if (!isCapped(e) && !isNetworkError(e)) throw e;
      const reads = await this.readState(stateReadMs);
      if (reads === "running" || reads === "starting") return;
      console.warn(`${this.id}: ${RESUME_UNANSWERED}, which still reads ${reads ?? "nothing"}`);
      throw new ResumeUnansweredError(RESUME_UNANSWERED, { cause: e });
    }
  }

  /** The provider's word on the machine, under its own bound; undefined where the read could not be had. */
  private async readState(capMs: number): Promise<MachineState | undefined> {
    try {
      const view = await this.backend.request<SandboxView>("GET", this.path(), undefined, capMs);
      return stateOf(view.state);
    } catch (e) {
      return isMissing(e) ? "gone" : undefined;
    }
  }

  async kill(): Promise<void> {
    await this.backend.request("DELETE", this.path());
  }

  async state(): Promise<MachineState> {
    try {
      const view = await this.backend.request<SandboxView>("GET", this.path());
      return stateOf(view.state);
    } catch (e) {
      if (isMissing(e)) return "gone";
      throw e;
    }
  }

  async describe(): Promise<MachineShape> {
    const view = await this.backend.request<SandboxView>("GET", this.path());
    return {
      ...(view.cpu !== undefined ? { cpu: view.cpu } : {}),
      ...(view.memMb !== undefined ? { memMb: view.memMb } : {}),
      ...(view.diskGb !== undefined ? { diskGb: view.diskGb } : {}),
      ...(view.createdAt !== undefined ? { createdAt: view.createdAt } : {}),
    };
  }

  async metrics(): Promise<void> {
    await this.backend.request("GET", this.path("/metrics"));
  }

  async previewUrl(port: number): Promise<PreviewReach> {
    const res = await this.backend.request<{ url: string; token: string }>(
      "GET", this.path(`/ports/${port}`),
    );
    return { url: res.url, token: res.token, expiresAt: previewTokenExpiry(res.token) };
  }

  async downloadUrl(path: string): Promise<string> {
    const res = await this.backend.request<{ url: string }>(
      "GET", this.path(`/files/download-url?path=${encodeURIComponent(path)}`),
    );
    return res.url;
  }

  async uploadUrl(path: string): Promise<string> {
    const res = await this.backend.request<{ url: string }>(
      "GET", this.path(`/files/upload-url?path=${encodeURIComponent(path)}`),
    );
    return res.url;
  }
}
