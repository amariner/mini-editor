// Interaction and native compositing checks. Uses a temporary profile and local HTTP only.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-browser-ux-')));
const folder = path.join(root, 'Producto');
await fs.mkdir(folder);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="es"><title>Vista de producto</title><style>
    body{margin:0;padding:40px;font:15px system-ui;background:#faf9f6;color:#242422}
    small{color:#74746b}h1{font-size:30px;letter-spacing:-1px;font-weight:550}
    article{border:1px solid #e7e5df;border-radius:14px;padding:24px;margin:28px 0;max-width:480px}
    button{border:0;border-radius:8px;padding:10px 16px;background:#252622;color:white}
    a{color:inherit}input{padding:9px;border:1px solid #ddd;border-radius:8px}
  </style><small>VISTA PREVIA · PRODUCTO</small><h1>El trabajo, en su sitio.</h1>
  <article><p>Una página real para comprobar el navegador integrado.</p>
  <input aria-label="Nota" placeholder="Una idea para el proyecto"><button>Guardar</button></article>
  <a href="/next">Siguiente página</a><p>Ruta: ${req.url}</p></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app, page;
const errors = [];
const call = (action) => page.evaluate((value) => window.desk.invoke(value), action);
const snap = () => call({ type: 'snapshot' });
const until = async (check, message = 'Estado no alcanzado') => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
const guestGeometry = () =>
  app.evaluate(({ BrowserWindow }, origin) => {
    const host = BrowserWindow.getAllWindows()[0];
    const guest = host.contentView.children.find(
      (view) =>
        'webContents' in view && view.getVisible() && view.webContents.getURL().startsWith(origin),
    );
    return guest?.getBounds();
  }, origin);
const geometryMatches = async () => {
  const native = await guestGeometry();
  const renderer = await page.locator('.browser-viewport').boundingBox();
  return (
    native &&
    renderer &&
    ['x', 'y', 'width', 'height'].every((key) => Math.abs(native[key] - renderer[key]) <= 1)
  );
};
const capture = async (name) => {
  await fs.mkdir('artifacts', { recursive: true });
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const bytes = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'),
  );
  await fs.writeFile(`artifacts/${name}.png`, Buffer.from(bytes, 'base64'));
};
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: process.env.SOURCE_DEV_URL ?? '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.desk);
  await call({ type: 'addAccount', kind: 'claude', name: 'Prueba local' });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await call({ type: 'addProject' });
  assert.equal(await page.getByRole('button', { name: 'Navegador', exact: true }).count(), 0);
  const initial = await snap();
  await call({
    type: 'browserNew',
    projectId: initial.selectedProject,
    sessionId: initial.selectedSession,
    url: origin + '/',
  });
  await page.locator('.browser-toolbar').waitFor();
  // A blank tab can still be created inside an available browser; it does not
  // make a browser appear on an otherwise empty workspace.
  await page.getByRole('button', { name: 'Nueva pestaña del navegador', exact: true }).click();
  const address = page.getByRole('textbox', { name: 'Dirección web', exact: true });
  await page.getByText('Tu proyecto, en vivo', { exact: true }).waitFor();
  assert.equal(
    await page.locator('.browser-empty').evaluate((element) => getComputedStyle(element).opacity),
    '1',
    'El estado vacío debe conservar el contraste del texto y sus acciones',
  );
  assert.equal(await page.locator('.browser-toolbar button').count(), 6);
  assert.equal(await page.getByRole('combobox', { name: 'Zoom del navegador' }).count(), 0);
  await capture('browser-refined-empty');
  await page.getByRole('button', { name: 'Cerrar pestaña Nueva página', exact: true }).click();
  await until(async () => (await snap()).browsers.length === 1);
  await address.fill(origin + '/');
  await address.press('Enter');
  await until(async () =>
    (await snap()).browsers.some((tab) => tab.url === origin + '/' && !tab.loading),
  );
  await until(geometryMatches, 'La vista nativa no coincide con el marco');
  const tab = (await snap()).browsers.find((tab) => tab.url === origin + '/');

  // Opening secondary tools resizes the live guest; it never covers or replaces it.
  const options = page.getByRole('button', { name: 'Opciones del navegador', exact: true });
  await options.click();
  assert.equal(await options.getAttribute('aria-expanded'), 'true');
  await page.getByRole('combobox', { name: 'Zoom del navegador' }).selectOption('0.9');
  await until(async () => (await snap()).browsers.find((item) => item.id === tab.id).zoom === 0.9);
  await until(geometryMatches, 'Desajuste nativo al desplegar opciones');
  // The bridge prepares visual evidence in the original draft, without sending a task.
  const composer = page.locator('.workspace .composer textarea');
  await composer.fill('Conserva el diseño de la cabecera.');
  const messagesBefore = (await snap()).sessions.find((s) => s.id === tab.sessionId).messages;
  await page.evaluate(() => {
    window.browserTestActions = [];
    const original = window.desk.invoke.bind(window.desk);
    window.desk.invoke = (action) => {
      window.browserTestActions.push(action.type);
      return original(action);
    };
  });
  await page.getByRole('button', { name: 'Añadir página al chat', exact: true }).click();
  await page.locator('.workspace .attachment-thumb').waitFor();
  const draft = await composer.inputValue();
  assert.ok(draft.startsWith('Conserva el diseño de la cabecera.\n\n'));
  assert.ok(draft.includes('El trabajo, en su sitio.'));
  assert.ok(draft.includes(origin));
  assert.equal(await composer.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    (await snap()).sessions.find((s) => s.id === tab.sessionId).messages,
    messagesBefore,
  );
  assert.equal(await page.evaluate(() => window.browserTestActions.includes('send')), false);
  await capture('browser-context-draft');
  await page.getByRole('button', { name: 'Suspender pestaña', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await options.getAttribute('aria-expanded'), 'false');
  assert.equal(await options.evaluate((element) => element === document.activeElement), true);
  assert.equal(await page.getByRole('combobox', { name: 'Zoom del navegador' }).count(), 0);
  await until(geometryMatches);

  // The options trigger retains keyboard focus when opening. Escape must work
  // before the user tabs into the secondary controls as well as inside them.
  await options.focus();
  await options.press('Enter');
  assert.equal(await options.getAttribute('aria-expanded'), 'true');
  await options.press('Escape');
  assert.equal(await options.getAttribute('aria-expanded'), 'false');
  assert.equal(await options.evaluate((element) => element === document.activeElement), true);

  // Page navigations must not flash the native surface off/on.
  await app.evaluate(({ BrowserWindow }, origin) => {
    const guest = BrowserWindow.getAllWindows()[0].contentView.children.find(
      (view) => 'webContents' in view && view.webContents.getURL().startsWith(origin),
    );
    globalThis.browserHiddenCalls = 0;
    const original = guest.setVisible.bind(guest);
    guest.setVisible = (visible) => {
      if (!visible) globalThis.browserHiddenCalls++;
      original(visible);
    };
  }, origin);
  await call({
    type: 'browserTab',
    tabId: tab.id,
    input: { action: 'navigate', url: origin + '/next' },
  });
  await until(
    async () => (await snap()).browsers.find((item) => item.id === tab.id).url === origin + '/next',
  );
  await until(geometryMatches);
  assert.equal(
    await app.evaluate(() => globalThis.browserHiddenCalls),
    0,
    'Navegar oculta innecesariamente la página',
  );
  await address.fill('localhost:9999/borrador');
  await call({
    type: 'browserTab',
    tabId: tab.id,
    input: { action: 'navigate', url: origin + '/update' },
  });
  assert.equal(
    await address.inputValue(),
    'localhost:9999/borrador',
    'Una navegación no debe borrar una URL que se está editando',
  );
  await address.press('Escape');
  await until(
    async () => (await address.inputValue()) === origin + '/update',
    'Escape debe restaurar la URL actual tras recibir el estado de navegación',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await capture('browser-refined-dark');

  // Adjacent selection after close and keyboard tab navigation.
  await page.getByRole('button', { name: 'Nueva pestaña del navegador', exact: true }).click();
  await page.getByRole('tab', { name: 'Nueva página', exact: true }).waitFor();
  assert.equal(await address.evaluate((element) => element === document.activeElement), true);
  await page.getByRole('button', { name: 'Cerrar pestaña Nueva página', exact: true }).click();
  await until(async () => (await snap()).browsers.length === 1);
  await until(
    async () =>
      (await page
        .getByRole('tab', { name: new URL(origin).host, exact: true })
        .getAttribute('aria-selected')) === 'true',
    'Cerrar una pestaña debe seleccionar la adyacente',
  );

  // A global tab cannot accidentally inject evidence into a different project's draft.
  const globalTab = await call({ type: 'browserNew', url: origin + '/global' });
  await until(
    async () => (await snap()).browsers.find((item) => item.id === globalTab.id)?.loading === false,
  );
  await options.click();
  assert.equal(
    await page.getByRole('button', { name: 'Añadir página al chat' }).isDisabled(),
    true,
  );
  await call({ type: 'browserTab', tabId: globalTab.id, input: { action: 'close' } });
  await until(geometryMatches);

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 620),
  );
  await options.click();
  await until(geometryMatches);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const addressBounds = await address.boundingBox();
  assert.ok(addressBounds.width >= 50, 'La dirección necesita espacio utilizable');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  assert.equal(
    await page
      .locator('.browser-toolbar')
      .evaluate((element) => getComputedStyle(element).animationName),
    'none',
  );
  assert.equal(
    await page
      .locator('.browser-options')
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
  );
  await capture('browser-refined-compact-light');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: grouped controls, live native geometry, zero navigation hide/show, preserved drafts + real screenshot attachments without sends, project isolation, editable address preservation, focus/Escape, adjacent tabs, compact viewport and reduced motion.',
  );
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
