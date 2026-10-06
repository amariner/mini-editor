// Isolated settings UI and persistence check; no credentials or model requests.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-optimization-ui-'));
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: root,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  await page.emulateMedia({ colorScheme: 'dark' });
}
try {
  await launch();
  await call({ type: 'addAccount', kind: 'claude', name: 'Personal' });
  await call({ type: 'addAccount', kind: 'codex', name: 'Trabajo' });
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const account = page.getByRole('region', { name: 'Cuenta Personal', exact: true });
  await account.getByLabel('Ahorro de tokens', { exact: true }).selectOption('2');
  await account.getByRole('switch', { name: 'Modelo auto' }).check();
  await page.waitForFunction(
    async () =>
      (await window.desk.invoke({ type: 'snapshot' })).profiles[0].optimization?.autoModel,
  );
  assert.deepEqual((await call({ type: 'snapshot' })).profiles[0].optimization, {
    level: 2,
    autoModel: true,
  });
  assert.equal((await call({ type: 'snapshot' })).profiles[1].optimization, undefined);
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ahorro-tokens.png' });
  await app.close();
  await launch();
  assert.deepEqual((await call({ type: 'snapshot' })).profiles[0].optimization, {
    level: 2,
    autoModel: true,
  });
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const restored = page.getByRole('region', { name: 'Cuenta Personal', exact: true });
  assert.equal(await restored.getByLabel('Ahorro de tokens', { exact: true }).inputValue(), '2');
  assert.equal(await restored.getByRole('switch', { name: 'Modelo auto' }).isChecked(), true);
  await restored.getByLabel('Ahorro de tokens', { exact: true }).selectOption('0');
  await restored.getByRole('switch', { name: 'Modelo auto' }).uncheck();
  await page.waitForFunction(
    async () =>
      !(await window.desk.invoke({ type: 'snapshot' })).profiles[0].optimization?.autoModel,
  );
  assert.deepEqual((await call({ type: 'snapshot' })).profiles[0].optimization, {
    level: 0,
    autoModel: false,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: ajustes por cuenta, tres niveles, modo automático, persistencia y desactivación.',
  );
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
