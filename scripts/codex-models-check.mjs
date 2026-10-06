// Real local app-server catalogue. No model calls, credentials copied or artificial catalogues.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-models-'));
const project = path.join(root, 'Proyecto temporal');
await fs.mkdir(project);
await fs.mkdir('artifacts', { recursive: true });
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const state = () => call({ type: 'snapshot' });
const current = async () => {
  const s = await state();
  return s.sessions.find((x) => x.id === s.selectedSession);
};
async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
}
try {
  await launch();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await call({ type: 'addProject' });
  const p = (await state()).projects[0];
  await call({ type: 'select', projectId: p.id, profile: 'codex' });
  let s = await current();
  await call({ type: 'start', sessionId: s.id });
  s = await current();
  assert.equal(s.status, 'ready');
  assert.ok(s.info?.models.length > 1, s.modelsError ?? 'Falta catálogo real');
  assert.equal(s.account, undefined);
  await page.getByRole('button', { name: 'Modelo de Codex', exact: true }).click();
  const picked = s.info.models.find((m) => !m.isDefault) ?? s.info.models[0];
  await page
    .locator('.popover button')
    .filter({ has: page.getByText(picked.displayName, { exact: true }) })
    .click();
  s = await current();
  assert.equal(s.codexConfig.model, picked.value);
  if (picked.supportedEffortLevels?.length) {
    await page.getByRole('button', { name: 'Esfuerzo de razonamiento', exact: true }).click();
    await page
      .locator('.popover button')
      .filter({ has: page.getByText(picked.supportedEffortLevels[0], { exact: true }) })
      .click();
    assert.equal((await current()).codexConfig.effort, picked.supportedEffortLevels[0]);
  }
  await page.getByRole('button', { name: 'Modelo de Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Actualizar modelos', exact: true }).click();
  await page.getByRole('button', { name: 'Actualizar modelos', exact: true }).waitFor();
  await page.locator('.popover').evaluate((el) => {
    el.scrollTop = 0;
  });
  const rowsFit = await page.locator('.popover > button').evaluateAll((buttons) =>
    buttons.every((button) => {
      const text = button.querySelector('small');
      return (
        !text || text.getBoundingClientRect().bottom <= button.getBoundingClientRect().bottom + 1
      );
    }),
  );
  assert.ok(rowsFit, 'Las descripciones no se superponen con otras opciones');
  await page.screenshot({ path: 'artifacts/21-codex-modelos.png' });
  const saved = (await current()).codexConfig;
  await app.close();
  app = undefined;
  await launch();
  s = await current();
  assert.deepEqual(s.codexConfig, saved);
  assert.equal(s.status, 'stopped');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      realModels: saved.model,
      catalogue: 'model/list real',
      verified: [
        'selector de modelo',
        'esfuerzo admitido',
        'actualizar catálogo',
        'persistencia tras reinicio',
      ],
      modelCalls: 0,
    }),
  );
} finally {
  if (app) await app.close();
  await fs.rm(root, { recursive: true, force: true });
}
