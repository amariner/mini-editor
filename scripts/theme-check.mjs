// Electron check for the interface theme: no accounts, agents or model calls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-theme-'));
const launch = () =>
  electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  // Playwright emulates a light colour scheme by default; let Electron's own theme through.
  await page.emulateMedia({ colorScheme: null });
  await page.waitForFunction(() => !!window.desk);
  const native = () => app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  const dark = () => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
  assert.equal((await call({ type: 'snapshot' })).theme, 'system');
  const systemDark = await native();
  await call({ type: 'setTheme', theme: 'light' });
  await page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
  assert.equal(await native(), false);
  assert.equal((await call({ type: 'snapshot' })).theme, 'light');
  await call({ type: 'setTheme', theme: 'dark' });
  await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  assert.equal(await native(), true);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgb(27, 27, 27)',
  );
  await assert.rejects(call({ type: 'setTheme', theme: 'sepia' }));
  // Save the opposite of the system theme, so the restart proves it is not just following macOS.
  const opposite = systemDark ? 'light' : 'dark';
  await call({ type: 'setTheme', theme: opposite });
  const saved = JSON.parse(await fs.readFile(path.join(root, 'data', 'appearance.json'), 'utf8'));
  assert.deepEqual(saved, { theme: opposite });
  await app.close();
  // The window opens directly in the saved theme.
  app = await launch();
  page = await app.firstWindow();
  await page.emulateMedia({ colorScheme: null });
  await page.waitForFunction(() => !!window.desk);
  assert.equal(await native(), !systemDark);
  assert.equal(await dark(), !systemDark);
  assert.equal((await call({ type: 'snapshot' })).theme, opposite);
  await call({ type: 'setTheme', theme: 'system' });
  assert.equal((await call({ type: 'snapshot' })).theme, 'system');
  console.log(
    'PASS: tema claro/oscuro/sistema aplicado por Electron, validado, guardado y restaurado al arrancar.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
