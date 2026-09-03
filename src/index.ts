import { createSandbox } from "./solari/sandbox.js";
import { reproduceCartBug } from "./solari/browser.js";
import { analyzeBug } from "./agent/bug-analyzer.js";
import { generateAndApplyPatch } from "./agent/patch-generator.js";
import { runTests } from "./tools/run-tests.js";
import { readFile } from "node:fs/promises";
import { saveEvidence } from "./agent/evidence.js";

async function main() {
  console.log("🚀 PatchPilot starting...");
  console.log("");

  const sandbox = await createSandbox();

  try {
    await sandbox.commands.connect();

    const workspace = "/tmp/patchpilot";

    // --------------------------------------------------
    // 1. CREATE WORKSPACE
    // --------------------------------------------------

    console.log("📁 Creating workspace...");

    await sandbox.commands.run("mkdir", {
      args: ["-p", `${workspace}/src`, `${workspace}/tests`],
    });

    // --------------------------------------------------
    // 2. UPLOAD DEMO APPLICATION
    // --------------------------------------------------

    const files = [
      ["demo-app/package.json", `${workspace}/package.json`],
      ["demo-app/src/server.ts", `${workspace}/src/server.ts`],
      ["demo-app/src/cart.ts", `${workspace}/src/cart.ts`],
      ["demo-app/src/index.html", `${workspace}/src/index.html`],
      ["demo-app/tests/cart.test.ts", `${workspace}/tests/cart.test.ts`],
    ];

    console.log("📤 Uploading demo app...");

    for (const [localPath, remotePath] of files) {
      const content = await readFile(localPath, "utf-8");

      await sandbox.files.write(remotePath, content);

      console.log(`  ✅ ${localPath}`);
    }

    // --------------------------------------------------
    // 3. INSTALL DEPENDENCIES
    // --------------------------------------------------

    console.log("");
    console.log("📦 Installing dependencies...");

    const install = await sandbox.commands.run("npm", {
      args: ["install", "--no-audit", "--no-fund"],
      cwd: workspace,
    });

    if (install.stdout) {
      console.log(install.stdout);
    }

    if (install.exitCode !== 0) {
      throw new Error(
        `Dependency installation failed:\n${install.stderr}`
      );
    }

    console.log("✅ Dependencies installed");

    // --------------------------------------------------
    // 4. START BUGGY APPLICATION
    // --------------------------------------------------

    console.log("");
    console.log("🚀 Starting buggy application...");

    await sandbox.commands.start("npm", {
      args: ["start"],
      cwd: workspace,
      env: {
        PORT: "3000",
      },
    });

    console.log("✅ Buggy application started");

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const preview = await sandbox.previewUrl(3000);

    console.log("");
    console.log("🌐 Buggy application URL:");
    console.log(preview.url);

    // --------------------------------------------------
    // 5. BUG DISCOVERY
    // --------------------------------------------------

    console.log("");
    console.log("════════════════════════════════════");
    console.log("        PHASE 1 — BUG DISCOVERY");
    console.log("════════════════════════════════════");

    const bugReport = await reproduceCartBug(preview.url);

    if (bugReport.verified) {
      console.log("");
      console.log("✅ No bug detected.");
      console.log("🛑 PatchPilot has nothing to fix.");
      return;
    }

    console.log("");
    console.log("🐛 BUG REPRODUCED");
    console.log(`Quantity: ${bugReport.quantity}`);
    console.log(`Expected: ${bugReport.expected}`);
    console.log(`Actual:   ${bugReport.actual}`);

    // --------------------------------------------------
    // 6. ROOT-CAUSE ANALYSIS
    // --------------------------------------------------

    console.log("");
    console.log("════════════════════════════════════");
    console.log("       PHASE 2 — ROOT CAUSE");
    console.log("════════════════════════════════════");

    const analysis = await analyzeBug(
      sandbox,
      workspace,
      {
        bugFound: !bugReport.verified,
        quantity: bugReport.quantity,
        expected: bugReport.expected,
        actual: bugReport.actual,
      }
    );

    console.log("");
    console.log("🎯 ROOT CAUSE IDENTIFIED");
    console.log(`File: ${analysis.file}`);
    console.log(`Cause: ${analysis.rootCause}`);
    console.log(`Explanation: ${analysis.explanation}`);
    console.log(`Suggested fix: ${analysis.suggestedFix}`);

    // --------------------------------------------------
    // 7. APPLY PATCH
    // --------------------------------------------------

    console.log("");
    console.log("════════════════════════════════════");
    console.log("         PHASE 3 — PATCH");
    console.log("════════════════════════════════════");

    const patch = await generateAndApplyPatch(
      sandbox,
      workspace,
      analysis.file,
      analysis.suggestedFix
    );

    console.log("");
    console.log("✍️ PATCH APPLIED");
    console.log(`File: ${patch.file}`);
    console.log(`Applied: ${patch.applied}`);
    
    console.log("");
    console.log("📝 CODE CHANGE");
    console.log(patch.diff);

    // --------------------------------------------------
    // 8. RUN TESTS
    // --------------------------------------------------

    console.log("");
    console.log("════════════════════════════════════");
    console.log("        PHASE 4 — TESTING");
    console.log("════════════════════════════════════");

    const testResult = await runTests(
      sandbox,
      workspace
    );

    if (!testResult.passed) {
      console.log("");
      console.log("❌ PATCH FAILED TESTS");

      if (testResult.output) {
        console.log(testResult.output);
      }

      if (testResult.error) {
        console.error(testResult.error);
      }

      throw new Error(
        "Autonomous patch failed validation tests."
      );
    }

    console.log("");
    console.log("✅ PATCH PASSED TESTS");

    // --------------------------------------------------
    // 9. START PATCHED APPLICATION ON PORT 3001
    // --------------------------------------------------

    console.log("");
    console.log("════════════════════════════════════");
    console.log("     PHASE 5 — PATCHED APPLICATION");
    console.log("════════════════════════════════════");

    console.log("🚀 Starting patched application...");

    await sandbox.commands.run("sed", {
      args: [
        "-i",
        "s/const PORT = 3000;/const PORT = Number(process.env.PORT ?? 3000);/",
        `${workspace}/src/server.ts`,
      ],
    });

    await sandbox.commands.start("npm", {
      args: ["start"],
      cwd: workspace,
      env: {
        PORT: "3001",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const patchedPreview = await sandbox.previewUrl(3001);

    console.log("🌐 Patched application URL:");
    console.log(patchedPreview.url);

    // --------------------------------------------------
    // 10. INDEPENDENT BROWSER VERIFICATION
    // --------------------------------------------------

    console.log("");
    console.log("════════════════════════════════════");
    console.log("     PHASE 6 — BROWSER VERIFICATION");
    console.log("════════════════════════════════════");

    console.log("🤖 Opening patched application in a fresh browser...");

    const verification = await reproduceCartBug(
      patchedPreview.url
    );

    if (!verification.verified) {
      console.log("");
      console.log("❌ FIX VERIFICATION FAILED");
      console.log(`Expected: ${verification.expected}`);
      console.log(`Actual:   ${verification.actual}`);

      throw new Error(
        "Patch passed tests but failed independent browser verification."
      );
    }

    console.log("");
    console.log("🎉 FIX VERIFIED");
    console.log(`Expected: ${verification.expected}`);
    console.log(`Actual:   ${verification.actual}`);
    
    await saveEvidence({
      bugReport,
      analysis,
      patch,
      verification,
    });

    // --------------------------------------------------
    // 11. FINAL RESULT
    // --------------------------------------------------

    console.log("");
    console.log("════════════════════════════════════");
    console.log("          PATCHPILOT RESULT");
    console.log("════════════════════════════════════");

    console.log(`🐛 Bug: ${analysis.rootCause}`);
    console.log(`📄 File: ${patch.file}`);
    console.log(`🔧 Fix: ${analysis.suggestedFix}`);
    console.log("🧪 Tests: PASSED");
    console.log("🌐 Browser verification: PASSED");
    console.log("🏆 Autonomous fix: VERIFIED");

    console.log("════════════════════════════════════");
    console.log("");
    console.log(
      "🚀 PatchPilot successfully found, fixed, tested, and verified the bug."
    );

  } catch (error) {
    console.error("");
    console.error("❌ PatchPilot failed:", error);

    try {
      await sandbox.kill();
    } catch {
      // Ignore cleanup errors.
    }

    process.exit(1);
  }
}

main();