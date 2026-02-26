import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type PackageJson = {
  scripts?: Record<string, string>;
};

describe("package scripts", () => {
  test("prepare script resolves husky via npm exec for clean environments", () => {
    const packageJsonPath = join(process.cwd(), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
    const prepareScript = packageJson.scripts?.prepare;

    expect(prepareScript).toBe("npm exec --yes -- husky");
  });
});
