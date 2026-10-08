// Isolated Electron UI test: broken CLI fixtures, no real accounts or model calls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-remove-ui-'));
const dataDir = path.join(root, 'data');
await fs.mkdir(dataDir);
const stuckClaude = path.join(root, 'stuck-claude');
await fs.writeFile(
  stuckClaude,
  `#!${process.execPath}\nrequire('fs').writeFileSync('checking-pid', String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
  { mode: 0o700 },
);
await fs.writeFile(
  path.join(dataDir, 'state.json'),
  JSON.stringify({
    profiles: [
      { id: 'claude-1', kind: 'claude', name: 'Antigua' },
      { id: 'codex', kind: 'codex', name: 'Otra' },
    ],
    projects: [],
    sessions: [],
    tools: { claude: stuckClaude, codex: '/usr/bin/false' },
  }),
);
let app;
const errors = [];
async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: dataDir,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  // Use a recoverable test trash directory, avoiding the user's actual macOS Trash.
  await app.evaluate(async ({ shell }, root) => {
    const fs = process.getBuiltinModule('fs').promises;
    const path = process.getBuiltinModule('path');
    await fs.mkdir(path.join(root, 'trash'), { recursive: true });
    shell.trashItem = async (dir) => fs.rename(dir, path.join(root, 'trash', path.basename(dir)));
  }, root);
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  return page;
}
try {
  let page = await launch();
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const oldCard = page.getByRole('region', { name: 'Cuenta Antigua', exact: true });
  await oldCard.getByText('Comprobando cuenta…', { exact: true }).waitFor();
  assert.equal(
    await oldCard.getByRole('button', { name: 'Eliminar cuenta Antigua', exact: true }).isEnabled(),
    true,
  );
  await page.getByRole('button', { name: 'Eliminar cuenta Antigua', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Confirmar eliminación de cuenta' });
  await confirmation.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await page.locator('.account-card').count(), 2);
  await page.getByRole('button', { name: 'Eliminar cuenta Antigua', exact: true }).click();
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/eliminar-cuenta-confirmacion.png' });
  await confirmation.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await page
    .getByRole('region', { name: 'Cuenta Antigua', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(await page.locator('.account-card').count(), 1);
  await page.getByRole('button', { name: 'Eliminar cuenta Otra', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await page.getByText('No hay cuentas. Pulsa «Añadir cuenta» para crear la primera.').waitFor();
  await page
    .getByRole('dialog', { name: 'Ajustes', exact: true })
    .getByRole('button', { name: 'Añadir cuenta', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Nombre de la nueva cuenta' }).fill('Nueva');
  await page.getByRole('button', { name: 'Crear perfil', exact: true }).click();
  await page.getByRole('region', { name: 'Cuenta Nueva', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/eliminar-cuenta-nueva.png' });
  let state = await page.evaluate(() => window.desk.invoke({ type: 'snapshot' }));
  assert.equal(state.profiles[0].id, 'claude-2');
  assert.deepEqual(state.removedProfiles, ['claude-1', 'codex']);
  assert.deepEqual((await fs.readdir(path.join(root, 'trash'))).sort(), ['claude-1', 'codex']);
  await app.close();
  app = undefined;
  page = await launch();
  state = await page.evaluate(() => window.desk.invoke({ type: 'snapshot' }));
  assert.deepEqual(
    state.profiles.map((p) => p.name),
    ['Nueva'],
  );
  assert.deepEqual(state.removedProfiles, ['claude-1', 'codex']);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: delete enabled during stuck check, confirmation/cancel, delete broken Claude and Codex profiles, delete last account, create fresh profile, recoverable local trash and restart persistence. No real accounts touched.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
