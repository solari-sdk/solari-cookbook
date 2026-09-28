export type Mode = "same" | "changed";
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
export interface Sandbox {
  id: string;
  connect(): Promise<void>;
  close(): void;
  kill(): Promise<void>;
  files: { write(path: string, data: string | Uint8Array): Promise<void>; read?(path:string):Promise<Uint8Array> };
  commands: {
    run(
      command: string,
      options: { args: string[]; timeoutMs: number },
    ): Promise<CommandResult>;
  };
}
export interface Compute {
  create(options: {
    template: string;
    cpu: number;
    memMb: number;
    timeoutMs: number;
    lifecycle: { onTimeout: "kill" };
  }): Promise<Sandbox>;
  get(id: string): Promise<{ state: string }>;
}
export type Termination = { terminated: boolean; basis: string; id: string };
export type Evidence = {
  mode: Mode;
  result: "PASS" | "PARTIAL" | "FAIL";
  sessions: { label: string; id?: string; termination?: Termination }[];
  checkpoint?: unknown;
  takeover?: any;
  errors: string[];
  scope: string;
};
