import type { Machine, MachineSpec, PreviewReach } from "./machine.js";
import { GuestUnusableError, isMissing } from "./errors.js";
import { DAEMON_PORT, refreshPreviewToken } from "./preview.js";

export interface WorkspaceHooks {
  goldenSnapshot: string;
  /** How many times a wake may resume and check the machine before a fresh fork replaces it: the backend's number,
   * read off its lifecycle by whoever builds the hooks. */
  wakeAttempts: number;
  /** Fresh fork from the golden image; used when a paused machine vanished or on upgrade. */
  resurrect?: (spec?: Partial<MachineSpec>) => Promise<Machine>;
  /** Export durable state (vault) off a machine before it is replaced; `drop` names guest paths the archive leaves
   * behind, so what stands at each on the replacement is left alone. */
  vaultExport?: (m: Machine, drop?: readonly string[]) => Promise<Buffer>;
  /** Restore durable state (vault) onto a replacement machine. */
  vaultImport?: (m: Machine, payload: Buffer) => Promise<void>;
  /** Runs before every pause: keep a copy of the vault the machine may never hand back. */
  stashVault?: (m: Machine) => Promise<void>;
  /** Puts the last stashed vault onto a machine that replaced one that never came back. */
  restoreVault?: (m: Machine) => Promise<void>;
  /** Judges a resumed machine; undefined means healthy, a string names the fault. */
  wakeCheck?: (m: Machine) => Promise<string | undefined>;
  /** Carries out one provider move on the machine given, so the caller can hand a resume the person's stop and say
   * on its row what a typed failure means; the backend settles the move itself. Absent, the machine's own call is
   * awaited. */
  move?: (m: Machine, move: ProviderMove) => Promise<void>;
  /** Stops a machine a replacement took over from, resolving once the provider takes the ask. Absent, the machine's
   * own kill is awaited. */
  retire?: (m: Machine) => Promise<void>;
}

/** The two provider calls a backend settles on its own budgets. */
export type ProviderMove = "pause" | "resume";

export type WorkspacePhase = "running" | "napping" | "waking";

export interface WakeResult {
  resurrected: boolean;
  /** Present when the wake did not go straight through: every fault met on the way, in order. */
  reason?: string;
}

export class Workspace {
  private machine: Machine;
  private phase: WorkspacePhase = "running";
  // Whether this machine was ever resumed, handed to every snapshot: the backend decides whether that matters.
  private firstLife = true;
  // Keyed by port under one machine id: a resurrect or upgrade replaces the machine and voids them all, and a wake
  // drops them too, since no provider promises the route minted before a nap still stands after it.
  private preview: { machineId: string; byPort: Map<number, PreviewReach> } = { machineId: "", byPort: new Map() };

  constructor(
    machine: Machine,
    private readonly hooks: WorkspaceHooks,
    initial?: { phase?: WorkspacePhase; firstLife?: boolean },
  ) {
    this.machine = machine;
    this.phase = initial?.phase ?? "running";
    this.firstLife = initial?.firstLife ?? true;
  }

  get machineId(): string {
    return this.machine.id;
  }

  get currentPhase(): WorkspacePhase {
    return this.phase;
  }

  get isFirstLife(): boolean {
    return this.firstLife;
  }

  get goldenSnapshot(): string {
    return this.hooks.goldenSnapshot;
  }

  /** Reach for the in-guest daemon: the :7070 route through portReach. */
  async daemonReach(): Promise<PreviewReach> {
    return this.portReach(DAEMON_PORT);
  }

  /** Public route to one guest port, reusing the cached one while it is fresh. Whether anything listens there is
   * not checked here. */
  async portReach(port: number): Promise<PreviewReach> {
    if (this.preview.machineId !== this.machine.id) this.preview = { machineId: this.machine.id, byPort: new Map() };
    const reach = await refreshPreviewToken(this.machine, port, this.preview.byPort.get(port));
    this.preview.byPort.set(port, reach);
    return reach;
  }

  /** Drops one port's cached route and mints it again, for a token the edge
   * refused before its hour was up; the other ports keep theirs. */
  async remintPortReach(port: number): Promise<PreviewReach> {
    if (this.preview.machineId === this.machine.id) this.preview.byPort.delete(port);
    return this.portReach(port);
  }

  async nap(): Promise<void> {
    if (this.phase === "napping") return;
    await this.hooks.stashVault?.(this.machine);
    await this.move("pause");
    this.phase = "napping";
  }

  private move(move: ProviderMove): Promise<void> {
    return this.hooks.move ? this.hooks.move(this.machine, move) : this.machine[move]();
  }


  /** The provider paused this machine outside a nap (its own idle timer, a console click): the phase follows the fact, so the next wake resumes. No vault was stashed. */
  notePaused(): void {
    this.phase = "napping";
  }

  /** The provider runs this machine while the phase says napping (a nap whose pause never took, a resume nobody
   * wrote): the phase follows the fact, so the next nap pauses it for real and no wake resumes a running machine. */
  noteRunning(): void {
    this.phase = "running";
  }

  /** `landed` is a resume wsp already sent that the provider took without its call ever answering: the first attempt
   * sends no second one and goes straight to the check.
   *
   * Done when the resumed machine passes the wake check, not when resume()
   * returns: Solari has handed back a machine reporting running whose guest
   * never served again (resume fell back to a fresh host at default size).
   * Such a machine gets one more pause+resume, then a golden fork with the
   * stashed vault replaces it and the zombie is killed. */
  async wake(o: { landed?: boolean } = {}): Promise<WakeResult> {
    if (this.phase === "running") return { resurrected: false };
    this.phase = "waking";
    try {
      const faults: string[] = [];
      for (let attempt = 1; attempt <= this.hooks.wakeAttempts; attempt++) {
        // A resume that landed without its call is a resume: the check below still runs and first life still ends,
        // since what a backend's snapshot rule turns on is the machine having been resumed, not who heard about it.
        if (attempt > 1 || o.landed !== true) {
          try {
            await this.move("resume");
          } catch (e) {
            // A guest the provider left running but unusable answers nothing a second resume would mend, so it
            // takes the road a vanished machine takes: no check, no re-pause, straight to the fresh fork.
            if (e instanceof GuestUnusableError) {
              faults.push(e.message);
              break;
            }
            if (!isMissing(e)) throw e;
            // Paused machines can vanish after hours (PoC overnight-pause finding).
            faults.push(`machine ${this.machine.id} vanished while paused`);
            break;
          }
        }
        // The resumed machine is asked for its routes again before anything dials it: the check below goes through
        // daemonReach, and a route cached before the nap is nobody's promise.
        this.preview.byPort.clear();
        this.firstLife = false;
        const fault = this.hooks.wakeCheck ? await this.hooks.wakeCheck(this.machine) : undefined;
        if (fault === undefined) {
          this.phase = "running";
          return faults.length === 0 ? { resurrected: false } : { resurrected: false, reason: faults.join("; ") };
        }
        faults.push(`attempt ${attempt}: ${fault}`);
        if (attempt < this.hooks.wakeAttempts) {
          await this.move("pause").catch((e: unknown) => {
            faults.push(`re-pause failed: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      }
      const reason = faults.join("; ");
      if (!this.hooks.resurrect) throw new Error(`wake failed: ${reason}`);
      await this.replace(this.hooks.resurrect);
      this.phase = "running";
      return { resurrected: true, reason };
    } catch (e) {
      this.phase = "napping";
      throw e;
    }
  }

  /** Replace the machine with a golden fork carrying the stashed vault, then
   * kill the old one whatever it reports. For a machine the provider calls
   * running whose guest stopped serving at rest (exec and edge 502 for
   * minutes, measured twice); the phase is not moved through napping, so a
   * person sees running throughout and the idle window is untouched. */
  async rebuild(): Promise<void> {
    if (!this.hooks.resurrect) throw new Error("rebuild requires a resurrect hook");
    await this.replace(this.hooks.resurrect);
    this.phase = "running";
  }

  /** Fork first, vault second, kill last: the old machine dies only once its replacement holds the files. */
  private async replace(resurrect: NonNullable<WorkspaceHooks["resurrect"]>): Promise<void> {
    const old = this.machine;
    this.machine = await resurrect();
    this.firstLife = true;
    await this.hooks.restoreVault?.(this.machine);
    await this.retire(old).catch((e: unknown) => {
      if (!isMissing(e)) throw e;
    });
  }

  private retire(m: Machine): Promise<void> {
    return this.hooks.retire ? this.hooks.retire(m) : m.kill();
  }

  /** A snapshot of the running disk under `name`, with the life this workspace tracked; a backend that refuses one
   * of a resumed machine throws its own NotFirstLifeError. */
  async checkpoint(name: string): Promise<string> {
    return this.machine.snapshot(name, { firstLife: this.firstLife });
  }

  /** Replace the machine with a fresh golden fork under a new spec, carrying vaulted state across; `drop` names the
   * guest paths the vault leaves behind, so the replacement's own copy of each stands. */
  async upgrade(spec?: Partial<MachineSpec>, opts: { drop?: readonly string[] } = {}): Promise<void> {
    if (!this.hooks.resurrect) throw new Error("upgrade requires a resurrect hook");
    const payload = this.hooks.vaultExport ? await this.hooks.vaultExport(this.machine, opts.drop) : undefined;
    await this.retire(this.machine);
    this.machine = await this.hooks.resurrect(spec);
    if (payload !== undefined && this.hooks.vaultImport) {
      await this.hooks.vaultImport(this.machine, payload);
    }
    this.phase = "running";
    this.firstLife = true;
  }
}
