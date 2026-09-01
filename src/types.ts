export type PulseMode = "browser" | "sandbox" | "desktop";

export interface StageEvent {
  type: "stage";
  stage: string;
  ms: number;
}

export interface DoneEvent {
  type: "done";
  totalMs: number;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type PulseEvent = StageEvent | DoneEvent | ErrorEvent;

export type EmitFn = (event: PulseEvent) => void;
