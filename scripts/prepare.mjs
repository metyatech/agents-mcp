import { spawnSync } from 'node:child_process';

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) process.exit(res.status);
}

function runNpm(args, env) {
  const res = spawnSync('npm', args, {
    stdio: 'inherit',
    env,
    // On Windows, `npm` is typically a .cmd shim, which requires a shell.
    shell: process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) process.exit(res.status);
}

// `npm install -g git+...` runs lifecycle scripts with global config enabled.
// Force a project-local install so build tools (tsc, types) are available.
const env = {
  ...process.env,
  npm_config_global: 'false',
  npm_config_location: 'project',
};

runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], env);
runNpm(['run', 'build'], env);
