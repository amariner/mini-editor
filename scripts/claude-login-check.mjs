// Isolated lifecycle checks: no real accounts, browser navigation or model calls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-claude-login-'));
const modePath = path.join(root, 'mode');
const binary = path.join(root, 'claude-fixture');
const data = path.join(root, 'data');
await fs.mkdir(data);
await fs.writeFile(modePath, 'success');
await fs.writeFile(
  binary,
  `#!${process.execPath}
const fs = require('fs');
const mode = fs.readFileSync(${JSON.stringify(modePath)}, 'utf8');
if (process.argv[3] === 'status') {
  if (mode === 'broken-status') { process.stderr.write('fixture failure'); process.exit(42); }
  const loggedIn = fs.existsSync('authenticated');
  console.log(JSON.stringify({loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', email: loggedIn ? 'fixture@example.test' : null}));
  process.exit(loggedIn ? 0 : 1);
}
if (process.argv[3] === 'login' && mode === 'success') {
  console.log('Completa el acceso oficial');
  setTimeout(() => { fs.writeFileSync('authenticated', 'fixture'); process.exit(0); }, 150);
} else {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
`,
  { mode: 0o700 },
);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [{ id: 'claude-1', kind: 'claude', name: 'Prueba' }],
    projects: [],
    sessions: [],
    tools: { claude: binary },
  }),
);
let app;
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  const call = (action) => page.evaluate((action) => window.desk.invoke(action), action);
  async function poll(predicate) {
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      const account = (await call({ type: 'snapshot' })).accounts['claude-1'];
      if (predicate(account)) return account;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Account did not settle within the deadline');
  }
  const settled = () => poll((account) => !account.busy);
  await poll((account) => account.status === 'signedOut' && !account.busy);
  await call({ type: 'accountLogin', profile: 'claude-1', stopSessions: false });
  let account = await settled();
  assert.equal(account.status, 'signedIn');
  assert.equal(account.label, 'fixture@example.test');
  await fs.writeFile(modePath, 'silent');
  await call({ type: 'accountLogin', profile: 'claude-1', stopSessions: false });
  assert.equal((await call({ type: 'snapshot' })).accounts['claude-1'].loginStarting, true);
  const start = Date.now();
  await call({ type: 'accountCancel', profile: 'claude-1' });
  account = await settled();
  assert.ok(Date.now() - start < 3500, 'Cancellation should not start another status query');
  assert.equal(account.status, 'unknown');
  assert.equal(account.error, undefined);
  await call({ type: 'accountLogin', profile: 'claude-1', stopSessions: false });
  account = await settled();
  assert.match(account.error, /no ha iniciado el acceso en 60 segundos/);
  assert.equal(account.cancellable, false);
  assert.equal(account.terminalId, undefined);
  await fs.writeFile(modePath, 'broken-status');
  await assert.rejects(call({ type: 'accountRefresh', profile: 'claude-1' }), /código 42/);
  await fs.writeFile(modePath, 'success');
  await call({ type: 'accountLogin', profile: 'claude-1', stopSessions: false });
  assert.equal((await settled()).status, 'signedIn');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: login verified through official status shape, silent startup released after 60s, cancellation without rechecking, precise exit error and successful retry. Fixtures only.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
