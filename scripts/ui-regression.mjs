// Run independent component checks and retain every failure, instead of stopping at the first.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const selected = process.argv.slice(2);
const scripts = selected.length
  ? selected
  : [
      'onboarding',
      'design-audit',
      'state-sync',
      'chat-interactions',
      'ui-polish',
      'attention',
      'settings-polish',
      'multichat',
      'floating-chat',
      'floating-appearance',
      'local',
      'local-download',
      'compact-chat',
      'chat-design',
      'navigation',
      'workspace',
      'tabs',
      'browser',
      'browser-ux',
      'browser-tabs',
      'browser-auth',
      'attachments',
      'usage-images',
      'response-actions',
      'team',
      'worktree-ui',
      'git-images',
      'prechat-project',
      'accounts',
      'account-navigation',
      'profiles',
      'optimization',
      'remove-account',
      'providers',
      'interface',
      'css-editor',
      'theme',
      'codex-permissions',
      'proxy',
      'provider-proxy',
      'antigravity',
      'freebuff',
      'claude-login',
      'codex-models',
    ];
await fs.mkdir('artifacts/v20', { recursive: true });
const results = [];
for (const name of scripts) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid check: ${name}`);
  const script = path.join('scripts', `${name}-check.mjs`);
  await fs.access(script);
  const log = await fs.open(`artifacts/v20/${name}.log`, 'w');
  const start = Date.now();
  const result = await new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', log.fd, log.fd],
      detached: grouped,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // This process group belongs exclusively to this isolated test and its browser.
      if (child.pid) {
        try {
          process.kill(grouped ? -child.pid : child.pid, 'SIGTERM');
        } catch {}
      }
    }, 180_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ name, code: 1, error: error.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ name, code: code ?? 1, signal, timedOut, seconds: (Date.now() - start) / 1000 });
    });
  });
  await log.close();
  results.push(result);
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${name} (${result.seconds?.toFixed(1)}s)`);
  await fs.writeFile(
    `artifacts/v20/regression-${scripts[0]}.json`,
    JSON.stringify(results, null, 2),
  );
}
if (results.some((result) => result.code !== 0)) process.exitCode = 1;
