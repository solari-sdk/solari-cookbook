export interface TestResult {
    passed: boolean;
    output: string;
    error: string;
  }
  
  export async function runTests(
    sandbox: any,
    workspace: string
  ): Promise<TestResult> {
    console.log("🧪 Running tests...");
  
    const result = await sandbox.commands.run("npm", {
      args: ["test"],
      cwd: workspace,
    });
  
    const output = result.stdout ?? "";
    const error = result.stderr ?? "";
  
    if (result.exitCode === 0) {
      console.log("✅ Tests passed");
  
      return {
        passed: true,
        output,
        error,
      };
    }
  
    console.log("❌ Tests failed");
  
    return {
      passed: false,
      output,
      error,
    };
  }