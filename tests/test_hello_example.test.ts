import { test, expect } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("examples hello-world prints hello world", async () => {
  const workspaceRoot = path.resolve(__dirname, "..");
  const scriptPath = path.join(workspaceRoot, "examples", "hello-world.ts");
  const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(tsxBin, [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      expect(stderr.trim()).toBe("");
      expect(stdout.trim()).toBe("hello world");
      resolve(code ?? 1);
    });
  });
  expect(exitCode).toBe(0);
});
