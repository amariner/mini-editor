// No authentication or inference: verify the installed official CLI's ACP handshake only.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-acp-check-'));
const child = spawn(
  path.resolve('node_modules/.bin/gemini'),
  ['--acp', '--approval-mode', 'default'],
  {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GEMINI_CLI_HOME: dir,
      GEMINI_TELEMETRY_ENABLED: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  },
);
let buffer = '',
  stderr = '';
child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-4000)));
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('ACP timeout')), 45000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`ACP exited ${code}: ${stderr}`));
    });
    child.stdout.on('data', (data) => {
      buffer += data;
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const m = JSON.parse(line);
          if (m.id === 1) {
            clearTimeout(timer);
            if (m.error) reject(Error(JSON.stringify(m.error)));
            else resolve(m.result);
          }
        } catch {}
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'agent-desk-check', version: '1' },
        },
      }) + '\n',
    );
  });
  assert.equal(result.protocolVersion, 1);
  assert.ok(result.authMethods.some((m) => m.id === 'oauth-personal'));
  assert.equal(result.agentCapabilities.loadSession, true);
  console.log(
    'PASS: official Gemini CLI ACP v1, Google login capability and session resume advertised. No login or inference performed.',
  );
} finally {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await new Promise((r) => child.once('close', r));
  await fs.rm(dir, { recursive: true, force: true });
}
