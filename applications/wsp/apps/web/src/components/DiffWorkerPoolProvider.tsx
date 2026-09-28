// Adapted from pingdotgg/t3code apps/web/src/components/DiffWorkerPoolProvider.tsx at 57a66608 (MIT).
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, type ReactNode } from "react";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";

type DiffWorkerOperation = "create-worker" | "get-render-options" | "set-render-options";

export class DiffWorkerError extends Error {
  readonly operation: DiffWorkerOperation;
  readonly themeName: DiffThemeName;
  constructor(input: { operation: DiffWorkerOperation; themeName: DiffThemeName; cause: unknown }) {
    super(`Diff worker operation ${input.operation} failed for theme ${input.themeName}.`, { cause: input.cause });
    this.operation = input.operation;
    this.themeName = input.themeName;
  }
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    let operation: DiffWorkerOperation = "get-render-options";
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) {
          return;
        }

        operation = "set-render-options";
        await workerPool.setRenderOptions({
          ...current,
          theme: themeName,
        });
      } catch (cause) {
        console.error(new DiffWorkerError({ operation, themeName, cause }));
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({ theme, children }: { theme: "light" | "dark"; children?: ReactNode }) {
  const diffThemeName = resolveDiffThemeName(theme);
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => {
          try {
            return new DiffsWorker();
          } catch (cause) {
            throw new DiffWorkerError({
              operation: "create-worker",
              themeName: diffThemeName,
              cause,
            });
          }
        },
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: diffThemeName,
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      }}
    >
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContextProvider>
  );
}
