import { z } from "zod";
import type { MergeLabConfig } from "./types.js";

const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const browserConfigSchema = z.object({
  enabled: z.union([z.boolean(), z.literal("auto")]),
  startCommand: z.string().min(1),
  port: z.number().int().positive(),
  readyPath: z.string().min(1),
  readyTimeoutMs: z.number().int().positive(),
  testFile: z.string().min(1),
  viewport: viewportSchema,
});

const configSchema = z.object({
  version: z.literal(1),
  install: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().positive(),
  }),
  checks: z.array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      timeoutMs: z.number().int().positive(),
      required: z.boolean(),
    }),
  ),
  browser: browserConfigSchema.optional(),
});

export function validateConfig(value: unknown): MergeLabConfig {
  const parsed = configSchema.parse(value);

  const names = new Set<string>();
  for (const check of parsed.checks) {
    if (names.has(check.name)) {
      throw new Error(`Duplicate check name: ${check.name}`);
    }
    names.add(check.name);
  }

  return parsed;
}

export function sanitizeConfigForLogging(config: MergeLabConfig): MergeLabConfig {
  // Config contains no secrets by design, but this is the hook for redaction.
  return config;
}
