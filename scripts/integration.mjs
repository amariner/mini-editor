// Current integration suite; each check owns isolated data and temporary projects.
import { spawn } from 'node:child_process';
for (const script of [
  'concurrency-check.mjs',
  'workspace-check.mjs',
  'tabs-check.mjs',
  'browser-check.mjs',
  'profiles-check.mjs',
  'navigation-check.mjs',
  'usage-images-check.mjs',
]) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}`], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) {
    process.exitCode = code ?? 1;
    break;
  }
}
