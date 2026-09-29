const SECRET_REFERENCE = /^\{\{SECRET:([A-Z][A-Z0-9_]*)\}\}$/

export type TypeOperation = {
  target: string
  text: string
}

type ResolveSecret = (name: string) => string

export function planTypeOperations(
  target: string,
  text: string,
  resolveSecret: ResolveSecret,
): TypeOperation[] {
  const secretMatch = SECRET_REFERENCE.exec(text)
  const targets = target
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)

  if (!secretMatch) {
    if (targets.length !== 1 || targets[0] !== target) {
      throw new Error("Multiple type targets require an allowlisted secret.")
    }
    return [{ target, text }]
  }

  const secretName = secretMatch[1]
  if (!secretName) {
    throw new Error("The secure-input reference is invalid.")
  }

  const secret = resolveSecret(secretName)
  if (targets.length === 1) {
    return [{ target: targets[0]!, text: secret }]
  }
  if (secret.length !== targets.length) {
    throw new Error(
      "The secure input length does not match the segmented target count.",
    )
  }

  return targets.map((segmentTarget, index) => ({
    target: segmentTarget,
    text: secret[index]!,
  }))
}
