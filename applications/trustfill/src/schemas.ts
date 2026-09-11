import { z } from "zod"

export const SufficiencySchema = z.enum([
  "SUFFICIENT",
  "INSUFFICIENT",
  "CONFLICTING",
  "OUT_OF_SCOPE",
])

export const CitationSchema = z.object({
  document: z.string().min(1),
  quote: z.string().min(1),
})

export const DraftSchema = z
  .object({
    sufficiency: SufficiencySchema,
    answer: z.string().nullable(),
    citations: z.array(CitationSchema),
    reasoning: z.string(),
  })
  // A model that abstains and then answers anyway has contradicted itself.
  // Shipping that answer is the exact failure this product exists to prevent,
  // so it is a schema violation rather than something to reconcile downstream.
  .refine((d) => d.sufficiency === "SUFFICIENT" || d.answer === null, {
    path: ["answer"],
    message: "must abstain: answer must be null unless sufficiency is SUFFICIENT",
  })
  .refine((d) => d.sufficiency !== "SUFFICIENT" || (d.answer?.trim().length ?? 0) > 0, {
    path: ["answer"],
    message: "answer is required when sufficiency is SUFFICIENT",
  })

export type Draft = z.infer<typeof DraftSchema>

export const ClaimSchema = z.object({
  claim: z.string().min(1),
  /** Is this claim what the question actually asked for, or volunteered context? */
  essential: z.boolean(),
  /** Do the cited quotes establish this specific claim? */
  supported: z.boolean(),
  /**
   * Exact substring of the drafted answer this claim came from. Trimming locates
   * spans by substring match, so an empty value would match everywhere and
   * silently gut the answer — reject it at the edge rather than defend downstream.
   */
  sourceText: z.string().min(1),
})

export const VerificationSchema = z.object({
  claims: z.array(ClaimSchema),
})

export type Verification = z.infer<typeof VerificationSchema>

export type Citation = z.infer<typeof CitationSchema>
export type Claim = z.infer<typeof ClaimSchema>
