import { spawnSync } from 'node:child_process';

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    // On Windows, `npm` is typically a .cmd shim, which requires a shell.
    shell: process.platform === 'win32' && cmd === 'npm',
  });
  if (res.error) throw res.error;
  if (typeof res.status === 'number' && res.status !== 0) process.exit(res.status);
}

run('npm', ['run', 'build']);
run('git', ['diff', '--exit-code', 'dist']);

