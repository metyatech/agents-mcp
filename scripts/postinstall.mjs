import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function isTruthy(value) {
  if (!value) return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function runNpm(cwd, extraEnv = {}) {
  const res = spawnSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        // Ensure this nested npm is a project-local install even when we're inside `npm install -g`.
        npm_config_global: "false",
        npm_config_location: "project",
        ...extraEnv
      },
      shell: process.platform === "win32"
    }
  );
  return res.status === 0;
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = path.join(src, ent.name);
    const destPath = path.join(dest, ent.name);

    if (ent.name === ".git") continue;
    if (ent.isDirectory()) {
      await copyDir(srcPath, destPath);
      continue;
    }
    if (ent.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  if (process.platform !== "win32") return;
  if (!isTruthy(process.env.npm_config_global)) return;

  const prefix = process.env.npm_config_prefix;
  if (!prefix) return;

  const thisFile = fileURLToPath(import.meta.url);
  const moduleRoot = path.resolve(path.dirname(thisFile), "..");

  // Only self-heal for global git installs where npm links the package to its cache tmp dir,
  // then cleans the tmp dir (breaking the global install).
  if (
    !moduleRoot
      .toLowerCase()
      .includes(`${path.sep}npm-cache${path.sep}_cacache${path.sep}tmp${path.sep}git-clone`)
  ) {
    return;
  }

  const linkPath = path.join(prefix, "node_modules", "@metyatech", "agents-mcp");

  // If the global install is already a real directory, nothing to do.
  const real = await fs.realpath(linkPath).catch(() => null);
  if (real && path.resolve(real) === path.resolve(linkPath)) return;

  // Ensure the cache-linked moduleRoot at least has the files we need to make a durable copy.
  const hasPkg = await pathExists(path.join(moduleRoot, "package.json"));
  const hasDist = await pathExists(path.join(moduleRoot, "dist", "index.js"));
  if (!hasPkg || !hasDist) return;

  const parent = path.dirname(linkPath);
  await fs.mkdir(parent, { recursive: true });
  const tmpDest = path.join(parent, `.agents-mcp-heal-${process.pid}-${Date.now()}`);

  // Copy everything except node_modules/.git to a durable location under the global prefix.
  await copyDir(moduleRoot, tmpDest);

  // Replace the junction/symlink with a real directory.
  // Removing the linkPath removes the junction but not the moduleRoot target.
  await fs.rm(linkPath, { recursive: true, force: true });
  await fs.rename(tmpDest, linkPath);

  // Ensure runtime dependencies exist in the durable location.
  // Some npm+Windows+git global installs end up with no dependency tree under the healed directory.
  const needsDeps = !(await pathExists(
    path.join(linkPath, "node_modules", "@modelcontextprotocol", "sdk", "package.json")
  ));
  if (needsDeps) {
    runNpm(linkPath);
  }
}

main().catch(() => {
  // Best-effort: never fail installation due to self-heal issues.
});
