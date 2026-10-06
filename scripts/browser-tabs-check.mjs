// Real Electron and local HTTP servers. No model calls or user credentials.
import { _electron as electron } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-browser-tabs-'));
const servers = [1, 2].map((n) =>
  http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><title>Proyecto ${n}</title><h1>Servidor ${n}</h1><input aria-label="Nota"><button onclick="document.querySelector('p').textContent=document.querySelector('input').value">Mostrar</button><p>Sin cambios</p><a href="/popup" target="_blank">Otra ventana</a>`,
    );
  }),
);
for (const server of servers)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const urls = servers.map((server) => `http://127.0.0.1:${server.address().port}/`);
let app, page;
const errors = [];
const call = (action) => page.evaluate((action) => window.desk.invoke(action), action);
const snap = () => call({ type: 'snapshot' });
const poll = async (check) => {
  for (let i = 0; i < 180; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Estado no alcanzado');
};
const tabAction = (tabId, input) => call({ type: 'browserTab', tabId, input });
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
  await page.emulateMedia({ colorScheme: 'dark' });
}
async function project(name) {
  const folder = path.join(root, name);
  await fs.mkdir(folder);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await call({ type: 'addProject' });
  const state = await snap();
  return { projectId: state.selectedProject, sessionId: state.selectedSession };
}
try {
  await launch();
  await call({ type: 'addAccount', kind: 'claude', name: 'Personal' });
  const first = await project('Uno');
  await page.getByRole('button', { name: 'Ahorro de tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Intenso', exact: true }).click();
  await page.getByRole('button', { name: 'Modelo', exact: true }).click();
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  assert.deepEqual((await snap()).profiles[0].optimization, { level: 3, autoModel: true });
  assert.equal(await page.locator('.token-policy-hint').count(), 0);
  await page.getByRole('button', { name: 'Modelo', exact: true }).click();
  assert.equal(await page.locator('.composer .popover small').count(), 0);
  await page.getByRole('button', { name: 'Por defecto', exact: true }).click();
  await poll(async () => !(await snap()).profiles[0].optimization.autoModel);
  const a = await call({
    type: 'browser',
    sessionId: first.sessionId,
    input: { action: 'navigate', url: urls[0] },
  });
  const info = await tabAction(a.id, { action: 'inspect' });
  const input = info.elements.find((e) => e.label === 'Nota');
  await tabAction(a.id, { action: 'fill', ref: input.ref, text: 'Estado conservado' });
  const second = await project('Dos');
  const b = await call({
    type: 'browser',
    sessionId: second.sessionId,
    input: { action: 'navigate', url: urls[1] },
  });
  assert.notEqual(a.id, b.id);
  assert.equal((await snap()).browsers.length, 2);
  await page.getByRole('tab', { name: new URL(urls[0]).host, exact: true }).click();
  const original = await tabAction(a.id, { action: 'inspect' });
  await tabAction(a.id, {
    action: 'click',
    ref: original.elements.find((e) => e.label === 'Mostrar').ref,
  });
  assert.match((await tabAction(a.id, { action: 'inspect' })).text, /Estado conservado/);
  await assert.rejects(
    call({
      type: 'browser',
      sessionId: second.sessionId,
      input: { action: 'inspect', tabId: a.id },
    }),
    /no pertenece/,
  );
  await page.getByRole('combobox', { name: 'Zoom del navegador' }).selectOption('0.75');
  await poll(async () => (await snap()).browsers.find((t) => t.id === a.id).zoom === 0.75);
  const realZoom = await app.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((w) => w.getURL() === url)
        .getZoomFactor(),
    urls[0],
  );
  assert.ok(Math.abs(realZoom - 0.75) < 0.001);
  await page.getByRole('button', { name: 'Ocultar navegador', exact: true }).click();
  assert.equal((await snap()).browsers.length, 2);
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  await page.getByRole('button', { name: 'Suspender pestaña', exact: true }).click();
  await poll(async () => (await snap()).browsers.find((t) => t.id === a.id).suspended);
  assert.equal(
    await app.evaluate(
      ({ webContents }, url) => webContents.getAllWebContents().some((w) => w.getURL() === url),
      urls[0],
    ),
    false,
  );
  await poll(
    async () => (await snap()).browsers.find((t) => t.id === a.id).hostStatus === 'online',
  );
  await page.getByRole('button', { name: 'Reanudar pestaña', exact: true }).click();
  await poll(async () => !(await snap()).browsers.find((t) => t.id === a.id).suspended);
  // Third-party browsing and popup stays in this app.
  const external = await call({
    type: 'browserNew',
    projectId: second.projectId,
    url: 'https://example.com/',
  });
  const externalPage = await tabAction(external.id, { action: 'inspect' });
  assert.equal(new URL(externalPage.url).hostname, 'example.com');
  assert.ok(externalPage.text.length > 20);
  await tabAction(external.id, { action: 'suspend' });
  const popupInfo = await tabAction(a.id, { action: 'inspect' });
  await tabAction(a.id, {
    action: 'click',
    ref: popupInfo.elements.find((e) => e.label === 'Otra ventana').ref,
  });
  await poll(async () => (await snap()).browsers.length === 4);
  // A URL printed in another project's terminal is detected without replacing existing tabs.
  await call({ type: 'openProjectTerminal', projectId: second.projectId });
  await call({
    type: 'terminalWrite',
    sessionId: `shell:${second.projectId}`,
    data: `echo '${urls[0]}'\r`,
  });
  await poll(async () =>
    (await snap()).browsers.some(
      (t) => t.sessionId === `shell:${second.projectId}` && t.url === urls[0],
    ),
  );
  await call({ type: 'select', ...first });
  assert.ok((await snap()).browsers.length >= 5);
  await page.getByRole('button', { name: 'Plegar proyectos' }).click();
  assert.equal((await page.locator('.sidebar').boundingBox()).width, 40);
  await fs.mkdir('artifacts', { recursive: true });
  const screenshot = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'),
  );
  await fs.writeFile('artifacts/browser-tabs-global.png', Buffer.from(screenshot, 'base64'));
  await new Promise((resolve) => servers[1].close(resolve));
  await poll(
    async () => (await snap()).browsers.find((t) => t.id === b.id).hostStatus === 'offline',
  );
  const before = (await snap()).browsers;
  await app.close();
  app = undefined;
  await launch();
  const restored = (await snap()).browsers;
  assert.deepEqual(
    restored.map((t) => t.id),
    before.map((t) => t.id),
  );
  assert.ok(restored.every((t) => t.suspended));
  assert.equal(restored.find((t) => t.id === a.id).zoom, 0.75);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Auto/ahorro compactos, pestañas entre proyectos, estado conservado, zoom real, suspensión libera WebContents, hosts online/offline, HTTPS externo, popup, detección de terminal y reinicio ligero.',
  );
} finally {
  await app?.close().catch(() => {});
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(root, { recursive: true, force: true });
}
