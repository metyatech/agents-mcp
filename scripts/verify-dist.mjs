import { spawnSync } from "node:child_process";

// On Windows, `npm` is a .cmd shim that the OS cannot execute directly.
// Using `shell: true` would work but triggers Node DEP0190 in Node >=24.
// Instead, invoke cmd.exe explicitly so no shell option is needed.
function run(cmd, args) {
  let spawnCmd = cmd;
  let spawnArgs = args;
  if (process.platform === "win32" && cmd === "npm") {
    spawnCmd = "cmd.exe";
    spawnArgs = ["/c", "npm.cmd", ...args];
  }
  const res = spawnSync(spawnCmd, spawnArgs, { stdio: "inherit" });
  if (res.error) throw res.error;
  if (typeof res.status === "number" && res.status !== 0) process.exit(res.status);
}

run("npm", ["run", "build"]);
run("git", ["diff", "--exit-code", "dist"]);
