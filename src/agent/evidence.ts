import { writeFile, mkdir } from "node:fs/promises";

export interface PatchEvidence {
  diff: string;
}

export interface EvidenceData {
  bugReport: unknown;
  analysis: unknown;
  patch: PatchEvidence;
  verification: unknown;
}

export async function saveEvidence(
  evidence: EvidenceData
): Promise<void> {
  const directory = "artifacts";

  await mkdir(directory, {
    recursive: true,
  });

  await writeFile(
    `${directory}/bug-report.json`,
    JSON.stringify(evidence.bugReport, null, 2)
  );

  await writeFile(
    `${directory}/analysis.json`,
    JSON.stringify(evidence.analysis, null, 2)
  );

  await writeFile(
    `${directory}/patch.diff`,
    evidence.patch.diff
  );

  await writeFile(
    `${directory}/verification.json`,
    JSON.stringify(
      evidence.verification,
      null,
      2
    )
  );

  console.log("");
  console.log("📦 Evidence artifacts saved:");
  console.log("  📄 artifacts/bug-report.json");
  console.log("  📄 artifacts/analysis.json");
  console.log("  📄 artifacts/patch.diff");
  console.log("  📄 artifacts/verification.json");
}