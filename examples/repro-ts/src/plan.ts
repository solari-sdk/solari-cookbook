import { spawnSync } from "node:child_process"

export interface ReproductionPlan {
  issueSummary: string
  confidence: "low" | "medium" | "high"
  assumptions: string[]
  setupCommands: string[]
  reproductionCommands: string[]
  expectedEvidence: string
  successCriteria: string[]
  notes: string[]
}

export class PlanContentValidationError extends Error {
  override readonly name = "PlanContentValidationError"
}

const COMMAND_MAX_LENGTH = 2_000

const boundedStringArray = (maxItems: number, maxLength = 1_000, minItems = 0) => ({
  type: "array",
  minItems,
  maxItems,
  items: {
    type: "string",
    minLength: 1,
    maxLength,
  },
})

export const reproductionPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "issueSummary",
    "confidence",
    "assumptions",
    "setupCommands",
    "reproductionCommands",
    "expectedEvidence",
    "successCriteria",
    "notes",
  ],
  properties: {
    issueSummary: { type: "string", minLength: 1, maxLength: 1_000 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    assumptions: boundedStringArray(5),
    setupCommands: boundedStringArray(6, COMMAND_MAX_LENGTH),
    reproductionCommands: boundedStringArray(5, COMMAND_MAX_LENGTH, 1),
    expectedEvidence: { type: "string", minLength: 1, maxLength: 1_000 },
    successCriteria: boundedStringArray(5),
    notes: boundedStringArray(5),
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, maxLength = 1_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new PlanContentValidationError(`Generated reproduction plan has an invalid ${field}`)
  }
  return value
}

function requireStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength = 1_000,
  minItems = 0,
): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    throw new PlanContentValidationError(`Generated reproduction plan has an invalid ${field}`)
  }

  return value.map((item, index) => requireString(item, `${field}[${index}]`, maxLength))
}

export function validateReproductionPlan(value: unknown): ReproductionPlan {
  if (!isRecord(value)) {
    throw new PlanContentValidationError("OpenAI returned an invalid reproduction plan")
  }

  const confidence = value.confidence
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new PlanContentValidationError("Generated reproduction plan has an invalid confidence")
  }

  return {
    issueSummary: requireString(value.issueSummary, "issueSummary"),
    confidence,
    assumptions: requireStringArray(value.assumptions, "assumptions", 5),
    setupCommands: requireStringArray(value.setupCommands, "setupCommands", 6, COMMAND_MAX_LENGTH),
    reproductionCommands: requireStringArray(
      value.reproductionCommands,
      "reproductionCommands",
      5,
      COMMAND_MAX_LENGTH,
      1,
    ),
    expectedEvidence: requireString(value.expectedEvidence, "expectedEvidence"),
    successCriteria: requireStringArray(value.successCriteria, "successCriteria", 5),
    notes: requireStringArray(value.notes, "notes", 5),
  }
}

const BLOCKED_COMMAND_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "sudo", pattern: /\bsudo\b/i },
  { name: "system shutdown", pattern: /\b(?:shutdown|reboot)\b/i },
  { name: "filesystem formatting", pattern: /\bmkfs(?:\.[A-Za-z0-9_-]+)?\b/i },
  { name: "Docker", pattern: /\bdocker\b/i },
  {
    name: "destructive device access",
    pattern: /\b(?:dd|rm|shred|wipefs)\b[^;\n]*\/dev\//i,
  },
  {
    name: "destructive device redirection",
    pattern: />{1,2}\s*\/dev\/(?!null(?:\s|$))/i,
  },
  { name: "unbounded loop", pattern: /\bwhile\s+(?:true\b|:)|\bfor\s*\(\s*;\s*;\s*\)/i },
]

const PLAN_FIELD_NAME_ARTIFACTS = new Set([
  "issueSummary",
  "confidence",
  "assumptions",
  "setupCommands",
  "reproductionCommands",
  "expectedEvidence",
  "successCriteria",
  "notes",
])

function shellSyntaxError(command: string): string | undefined {
  const result = spawnSync("sh", ["-n", "-c", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (result.error) {
    throw new Error(`Unable to validate generated shell command: ${result.error.message}`)
  }
  if (result.status !== 0) {
    return result.stderr.trim() || "invalid shell syntax"
  }

  // POSIX sh may accept an unterminated heredoc at EOF. An invalid token must
  // fail parsing unless an open heredoc incorrectly consumes it as body text.
  const heredocProbe = spawnSync("sh", ["-n", "-c", `${command}\n) __REPRO_HEREDOC_PROBE__`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (heredocProbe.error) {
    throw new Error(`Unable to validate generated shell command: ${heredocProbe.error.message}`)
  }
  if (heredocProbe.status === 0) {
    return "unterminated heredoc"
  }

  return undefined
}

export function validatePlanCommands(plan: ReproductionPlan): void {
  const commandGroups = [
    ["setupCommands", plan.setupCommands],
    ["reproductionCommands", plan.reproductionCommands],
  ] as const

  for (const [field, commands] of commandGroups) {
    for (const [index, command] of commands.entries()) {
      if (/[\r\n]/.test(command)) {
        throw new PlanContentValidationError(
          `Generated reproduction plan contains a multiline command in ${field}[${index}]`,
        )
      }
      if (command.trim().length === 0) {
        throw new PlanContentValidationError(
          `Generated reproduction plan contains an empty command in ${field}[${index}]`,
        )
      }
      if (PLAN_FIELD_NAME_ARTIFACTS.has(command.trim())) {
        throw new PlanContentValidationError(
          `Generated reproduction plan contains a schema-field fragment in ${field}[${index}]`,
        )
      }

      const syntaxError = shellSyntaxError(command)
      if (syntaxError) {
        throw new PlanContentValidationError(
          `Generated reproduction plan contains incomplete shell syntax in ${field}[${index}]: ${syntaxError}`,
        )
      }

      const blocked = BLOCKED_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))
      if (blocked) {
        throw new PlanContentValidationError(
          `Generated reproduction plan contains blocked operation: ${blocked.name}`,
        )
      }
    }
  }
}
