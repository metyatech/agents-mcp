import { test, expect } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runScript(
  scriptPath: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
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
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

test("hello script prints hello world", async () => {
  const repoRoot = path.resolve(__dirname, "..");
  const scriptPath = path.join(repoRoot, "src", "hello.ts");
  const { exitCode, stdout, stderr } = await runScript(scriptPath);
  expect(exitCode).toBe(0);
  expect(stderr.trim()).toBe("");
  expect(stdout.trim()).toBe("hello world");
});

test("hello-world script prints hello world once", async () => {
  const repoRoot = path.resolve(__dirname, "..");
  const scriptPath = path.join(repoRoot, "src", "hello-world.ts");
  const { exitCode, stdout, stderr } = await runScript(scriptPath);
  expect(exitCode).toBe(0);
  expect(stderr.trim()).toBe("");
  expect(stdout.trim()).toBe("hello world");
});
