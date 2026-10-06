import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-usage-images-'));
const project = path.join(root, 'Proyecto visual');
await fs.mkdir(project);
let app;
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => !!window.desk);
  const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
  const snap = () => call({ type: 'snapshot' });
  const until = async (fn) => {
    for (let i = 0; i < 150; i++) {
      if (await fn()) return;
      await page.waitForTimeout(100);
    }
    throw Error('Timeout');
  };
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await call({ type: 'addProject' });
  let state = await snap();
  const sid = state.selectedSession;
  const image = path.join(root, 'muestra.png');
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(
        Buffer.from([80, 120, 180, 255, 110, 160, 210, 255, 180, 200, 220, 255, 60, 80, 100, 255]),
        { width: 2, height: 2 },
      )
      .toPNG()
      .toString('base64'),
  );
  await fs.writeFile(image, Buffer.from(png, 'base64'));
  await app.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, image);
  await page.getByRole('button', { name: 'Adjuntar imágenes', exact: true }).click();
  await page.locator('.attachment-thumb img').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enviar', exact: true }).isEnabled(), true);
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Revisa esta imagen');
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
  await page.locator('.attachment-thumb').waitFor({ state: 'detached' });
  const second = (await snap()).selectedSession;
  await call({ type: 'select', projectId: state.selectedProject, sessionId: sid });
  await page.locator('.attachment-thumb').waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Revisa esta imagen',
  );
  const selected = await call({ type: 'pickImages', sessionId: sid });
  await assert.rejects(
    call({ type: 'send', sessionId: second, text: 'No enviar', attachmentIds: [selected[0].id] }),
    /no pertenece/,
  );
  await call({ type: 'discardImages', sessionId: sid, attachmentIds: selected.map((i) => i.id) });
  await page.getByRole('button', { name: 'Quitar muestra.png', exact: true }).click();
  assert.equal(await page.locator('.attachment-thumb').count(), 0);
  await page.getByRole('button', { name: 'Adjuntar imágenes', exact: true }).click();
  await page.locator('.attachment-thumb').waitFor();
  const header = await page.locator('.topbar').boundingBox(),
    switcher = await page.locator('.usage-switcher').boundingBox();
  assert.ok(Math.abs(switcher.x + switcher.width / 2 - header.x - header.width / 2) < 2);
  assert.ok(switcher.width <= 560);
  const tools = await page.locator('.top-actions').boundingBox();
  assert.ok(switcher.x + switcher.width < tools.x);
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/47-uso-adjuntos.png' });
  // Query real official tools without authentication or a model turn.
  await until(async () => !Object.values((await snap()).accounts).some((a) => a.busy));
  await call({ type: 'start', sessionId: sid });
  await call({ type: 'refreshUsage', profile: 'claude-1' });
  state = await snap();
  assert.equal(state.accounts['claude-1'].usage?.windows?.length ?? 0, 0);
  assert.equal(await page.locator('.usage-fill').count(), 0);
  await call({ type: 'stop', sessionId: sid });
  await page.getByRole('combobox', { name: 'Cuenta del proyecto' }).selectOption('codex');
  await until(async () => !Object.values((await snap()).accounts).some((a) => a.busy));
  await call({ type: 'refreshUsage', profile: 'codex' });
  assert.equal((await snap()).accounts.codex.usage?.windows?.length ?? 0, 0);
  await page.getByRole('button', { name: 'Adjuntar imágenes', exact: true }).click();
  await page.locator('.attachment-thumb').waitFor();
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await page.getByRole('button', { name: 'Gestionar cuenta en Ajustes', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cerrar error', exact: true }).click();
  assert.equal(await page.locator('.attachment-thumb').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Enviar', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Plegar proyectos' }).click();
  await page.setViewportSize({ width: 900, height: 620 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'artifacts/48-uso-adjuntos-compacto.png' });
  assert.deepEqual(await fs.readdir(project), []);
  assert.equal((await fs.readFile(image)).toString('base64'), png);
  console.log(
    'PASS: native image picker, previews/removal, per-chat drafts, capability isolation, image-only send retained after real Codex auth rejection, real empty-profile usage queries for Claude/Codex, no invented quota, centered selector, compact layout. No inference calls.',
  );
} finally {
  await app?.close();
}
