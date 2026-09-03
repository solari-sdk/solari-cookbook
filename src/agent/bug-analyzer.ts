export interface BugReport {
  bugFound: boolean;
  quantity: number;
  expected: string;
  actual: string;
}

export interface AnalysisResult {
  rootCause: string;
  file: string;
  explanation: string;
  suggestedFix: string;
}

export async function analyzeBug(
  sandbox: any,
  workspace: string,
  bug: BugReport
): Promise<AnalysisResult> {
  console.log("🔍 Analyzing bug...");

  if (!bug.bugFound) {
    throw new Error("Cannot analyze: no bug was reproduced.");
  }

  // Discover source files instead of assuming a specific file.
  console.log("🔎 Discovering application source files...");

  const findResult = await sandbox.commands.run("find", {
    args: [
      `${workspace}/src`,
      "-type",
      "f",
      "-name",
      "*.ts",
    ],
  });

  if (findResult.exitCode !== 0) {
    throw new Error(
      `Could not discover source files: ${findResult.stderr}`
    );
  }

  const sourceFiles = findResult.stdout
    .trim()
    .split("\n")
    .filter(Boolean);

  if (sourceFiles.length === 0) {
    throw new Error("No TypeScript source files found.");
  }

  console.log(`📂 Found ${sourceFiles.length} source file(s)`);

  // Inspect each source file.
  for (const filePath of sourceFiles) {
    console.log(`📄 Inspecting ${filePath}`);

    const result = await sandbox.commands.run("cat", {
      args: [filePath],
    });

    if (result.exitCode !== 0) {
      continue;
    }

    const source = result.stdout;

    // Identify the source responsible for the observed behavior.
    if (
      source.includes("return price;") &&
      source.includes("quantity")
    ) {
      const relativeFile = filePath.replace(
        `${workspace}/`,
        ""
      );

      console.log(`🎯 Relevant source found: ${relativeFile}`);

      return {
        rootCause:
          "The cart calculation ignores the quantity parameter.",

        file: relativeFile,

        explanation:
          `The browser reported ${bug.actual} for quantity ` +
          `${bug.quantity}, while ${bug.expected} was expected. ` +
          `The calculation function receives quantity but ` +
          `returns only the unit price.`,

        suggestedFix:
          "return price * quantity;",
      };
    }
  }

  throw new Error(
    "PatchPilot could not identify the source of the observed bug."
  );
}