// Adapted from pingdotgg/t3code apps/web/src/hooks/useCopyToClipboard.ts at 57a66608 (MIT).
import * as React from "react";

export class ClipboardApiUnavailableError extends Error {
  constructor(readonly target: string) {
    super(`Clipboard API is unavailable while copying ${target}.`);
    this.name = "ClipboardApiUnavailableError";
  }
}

export class ClipboardWriteError extends Error {
  constructor(
    readonly target: string,
    readonly cause: unknown,
  ) {
    super(`Failed to copy ${target} to the clipboard.`);
    this.name = "ClipboardWriteError";
  }
}

export class ClipboardReadUnavailableError extends Error {
  constructor(readonly target: string) {
    super(`Clipboard API is unavailable while reading ${target}.`);
    this.name = "ClipboardReadUnavailableError";
  }
}

export class ClipboardReadError extends Error {
  constructor(
    readonly target: string,
    readonly cause: unknown,
  ) {
    super(`Failed to read ${target} from the clipboard.`);
    this.name = "ClipboardReadError";
  }
}

export async function writeTextToClipboard(value: string, target = "text") {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.writeText
  ) {
    throw new ClipboardApiUnavailableError(target);
  }

  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (cause) {
    throw new ClipboardWriteError(target, cause);
  }
}

export async function readTextFromClipboard(target = "text"): Promise<string> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.clipboard?.readText
  ) {
    throw new ClipboardReadUnavailableError(target);
  }

  try {
    return await navigator.clipboard.readText();
  } catch (cause) {
    throw new ClipboardReadError(target, cause);
  }
}

export function useCopyToClipboard<TContext = void>({
  timeout = 2000,
  target = "text",
  onCopy,
  onError,
}: {
  timeout?: number;
  target?: string;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const targetRef = React.useRef(target);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  targetRef.current = target;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void writeTextToClipboard(value, targetRef.current).then(
      (didCopy) => {
        if (!didCopy) return;
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        console.error(error);
        onErrorRef.current?.(error, ctx);
      },
    );
  }, []);

  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
