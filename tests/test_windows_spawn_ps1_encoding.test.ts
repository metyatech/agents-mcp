import { describe, test, expect } from "vitest";
import { buildWindowsSpawnPs1 } from "../src/agents.js";

describe("buildWindowsSpawnPs1", () => {
  test("base64-encodes arguments so smart quotes cannot break PowerShell parsing", () => {
    const smartQuotePrompt = "it\u2019s\nmultiline\nprompt";
    const cmd = [
      "codex",
      "exec",
      "--model",
      "gpt-5.2-codex",
      "--sandbox",
      "workspace-write",
      smartQuotePrompt,
      "--json"
    ];

    const stdoutPath = "C:\\Temp\\stdout.log";
    const workingDirectory = "D:\\repo\\project";
    const ps1 = buildWindowsSpawnPs1(cmd, stdoutPath, workingDirectory);

    // Regression assertion: old implementation embedded raw argument text (including U+2019).
    expect(ps1).not.toContain(smartQuotePrompt);
    expect(ps1).not.toContain("\u2019");

    // New implementation uses base64 decoding in PowerShell.
    expect(ps1).toContain("FromBase64String");
    expect(ps1).toContain("ArgumentList.Add");

    const expectedB64 = Buffer.from(smartQuotePrompt, "utf8").toString("base64");
    expect(ps1).toContain(expectedB64);
  });
});
