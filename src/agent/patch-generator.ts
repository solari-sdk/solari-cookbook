export interface PatchResult {
  file: string;
  before: string;
  after: string;
  diff: string;
  applied: boolean;
}

export async function generateAndApplyPatch(
  sandbox: any,
  workspace: string,
  file: string,
  suggestedFix: string
): Promise<PatchResult> {
  console.log("🔧 Generating code patch...");

  const filePath = `${workspace}/${file}`;

  const result = await sandbox.commands.run("cat", {
    args: [filePath],
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read ${file}: ${result.stderr}`
    );
  }

  const before = result.stdout;

  if (!before.includes("return price;")) {
    throw new Error(
      `Expected buggy code was not found in ${file}.`
    );
  }

  const after = before.replace(
    "return price;",
    suggestedFix
  );

  console.log("✍️ Applying patch...");

  await sandbox.files.write(
    filePath,
    after
  );

  const diff = [
    `--- ${file}`,
    `+++ ${file}`,
    `- return price;`,
    `+ ${suggestedFix}`,
  ].join("\n");

  console.log("");
  console.log("📝 CODE DIFF");
  console.log(diff);

  console.log("");
  console.log(`✅ Patch applied to ${file}`);

  return {
    file,
    before,
    after,
    diff,
    applied: true,
  };
}