// Real Electron IPC/renderer/Chrome workflow with temporary app data and a local web fixture.
// Never attaches to personal Chrome or installs anything into the user's Applications folder.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-apps-chrome-')));
const project = path.join(root, 'Proyecto de prueba');
await fs.mkdir(project);
let authenticatedDownloads = 0;
const server = http.createServer((req, res) => {
  const consent = req.headers.cookie?.includes('consent=yes') ?? false;
  if (req.url === '/report') {
    if (!consent) {
      res.writeHead(403);
      res.end('Falta consentimiento');
      return;
    }
    authenticatedDownloads++;
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="informe-chrome.txt"',
    });
    res.end('AUTHENTICATED_CHROME_REPORT');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="es"><title>Chrome conectado</title><style>
    body{padding:35px;font:15px system-ui;background:#faf9f6;color:#242424}
    h1{font-size:30px;letter-spacing:-1px;font-weight:550}label{display:block;margin:24px 0}
    input{margin-right:9px}a{display:inline-block;padding:11px 16px;color:white;background:#315ae8;text-decoration:none;border-radius:8px}
    small{color:#73736b}article{max-width:520px;border:1px solid #deded9;padding:24px;border-radius:14px}
    </style><small>PRUEBA LOCAL · CHROME GESTIONADO</small><h1>Una sesión que continúa.</h1><article>
    <p>El editor controla esta ventana de Chrome y conserva el acceso al reconectar.</p>
    <label><input type="checkbox" aria-label="Acepto las condiciones" ${consent ? 'checked' : ''}
      onchange="document.cookie='consent='+(this.checked?'yes':'no')+'; Max-Age=3600; path=/'">Acepto las condiciones</label>
    <a href="/report" download>Descargar informe</a>
    <p>${consent ? 'Consentimiento conservado' : 'Pendiente de consentimiento'}</p></article></html>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}/`;
let app, page;
const errors = [];
const call = (action) => page.evaluate((value) => window.desk.invoke(value), action);
const snapshot = () => call({ type: 'snapshot' });
const poll = async (check, message = 'Estado pendiente') => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.desk);
  await call({ type: 'addAccount', kind: 'claude', name: 'Prueba local de Chrome' });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await call({ type: 'addProject' });
  const initial = await snapshot();
  assert.ok(initial.selectedSession, 'El proyecto de prueba debe tener un chat');
  const internal = await call({
    type: 'browserNew',
    projectId: initial.selectedProject,
    sessionId: initial.selectedSession,
    url,
  });
  await page.getByRole('button', { name: 'Conexiones de Chrome', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir Chrome gestionado', exact: true }).click();
  const connection = await poll(async () => {
    const connections = (await snapshot()).chromeConnections;
    const connection = connections.find((item) => item.mode === 'managed');
    if (connection?.status === 'error') throw new Error(connection.error);
    return connection?.status === 'connected' && connection;
  }, 'Conexión real con Chrome gestionado');
  assert.ok(connection.profilePath.startsWith(root), 'Chrome usa solo el perfil temporal');
  await page.locator('.chrome-page-card').waitFor();
  let chromeTab = (await snapshot()).browsers.find((item) => item.connectionId === connection.id);
  assert.ok(chromeTab);
  const act = (input) =>
    call({
      type: 'browser',
      sessionId: initial.selectedSession,
      input: { ...input, tabId: chromeTab.id },
    });
  const combined = await call({
    type: 'browser',
    sessionId: initial.selectedSession,
    input: { action: 'list' },
  });
  assert.ok(combined.tabs.some((tab) => tab.id === internal.id));
  assert.ok(combined.tabs.some((tab) => tab.id === chromeTab.id));
  await act({ action: 'navigate', url });
  let info = await act({ action: 'inspect' });
  assert.equal(info.title, 'Chrome conectado');
  const consent = info.elements.find((item) => item.label === 'Acepto las condiciones');
  assert.ok(consent);
  await act({ action: 'check', ref: consent.ref, checked: true });
  info = await act({ action: 'inspect' });
  assert.equal(info.elements.find((item) => item.label === 'Acepto las condiciones').checked, true);
  const screenshot = await act({ action: 'screenshot' });
  assert.equal(screenshot.mimeType, 'image/png');
  assert.ok(Buffer.from(screenshot.image, 'base64').length > 1000);
  await act({
    action: 'click',
    ref: info.elements.find((item) => item.label === 'Descargar informe').ref,
  });
  const download = await poll(
    async () =>
      (await act({ action: 'downloads' })).downloads.find(
        (item) => item.fileName === 'informe-chrome.txt' && item.state === 'completed',
      ),
    'Descarga autenticada desde Chrome',
  );
  assert.equal(authenticatedDownloads, 1);
  assert.ok(download.path.startsWith(root));
  assert.equal(await fs.readFile(download.path, 'utf8'), 'AUTHENTICATED_CHROME_REPORT');
  await page.getByRole('button', { name: 'Mostrar informe-chrome.txt en Finder' }).waitFor();
  await page.getByRole('button', { name: 'Capturar vista', exact: true }).click();
  await page.locator('.chrome-page-card img').waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.some(
        (view) => 'webContents' in view && view.getVisible(),
      ),
    ),
    false,
    'La vista interna queda oculta al seleccionar Chrome',
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.getByRole('button', { name: 'Conexiones de Chrome', exact: true }).click();
  await page.screenshot({ path: 'artifacts/chrome-main-panel.png' });
  await page.getByRole('button', { name: 'Conexiones de Chrome', exact: true }).click();

  await page.getByRole('button', { name: 'Desconectar Chrome gestionado' }).click();
  await poll(
    async () =>
      (await snapshot()).chromeConnections.find((item) => item.id === connection.id)?.status ===
      'disconnected',
    'Chrome desconectado',
  );
  assert.equal(
    (await snapshot()).browsers.some((item) => item.connectionId === connection.id),
    false,
  );
  await page.getByRole('button', { name: 'Reconectar', exact: true }).click();
  await poll(
    async () =>
      (await snapshot()).chromeConnections.find((item) => item.id === connection.id)?.status ===
      'connected',
    'Chrome reconectado',
  );
  chromeTab = (await snapshot()).browsers.find((item) => item.connectionId === connection.id);
  assert.ok(chromeTab);
  await act({ action: 'navigate', url });
  info = await act({ action: 'inspect' });
  assert.ok(info.text.includes('Consentimiento conservado'), 'Las cookies persisten al reconectar');

  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('tab', { name: 'Aplicaciones', exact: true }).click();
  const applications = page.getByRole('region', { name: 'Aplicaciones del equipo' });
  await applications.waitFor();
  const inventory = await poll(async () => {
    const inventory = (await snapshot()).applications;
    return inventory?.updatedAt && !inventory.busy && inventory;
  }, 'Inventario de aplicaciones');
  assert.ok(inventory.items.some((item) => item.name.includes('Chrome') && item.kind === 'app'));
  assert.ok(inventory.items.some((item) => item.kind === 'cli'));
  await applications.getByRole('button', { name: 'Actualizar', exact: true }).click();
  await poll(async () => {
    const refreshed = (await snapshot()).applications;
    return !refreshed.busy && refreshed.updatedAt >= inventory.updatedAt;
  });
  await applications.getByRole('searchbox', { name: 'Buscar aplicaciones' }).fill('Chrome');
  await applications.getByRole('button', { name: 'Abrir Google Chrome', exact: true }).waitFor();
  await app.evaluate(({ dialog }) => {
    globalThis.installChooserCalls = 0;
    dialog.showOpenDialog = async () => {
      globalThis.installChooserCalls++;
      return { canceled: true, filePaths: [] };
    };
  });
  await applications.getByRole('button', { name: 'Elegir aplicación', exact: true }).click();
  await poll(async () => (await app.evaluate(() => globalThis.installChooserCalls)) === 1);
  assert.equal(
    (await snapshot()).applications.lastInstalled,
    undefined,
    'Cancelar no instala nada',
  );
  await page.screenshot({ path: 'artifacts/applications-settings.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS Electron applications + Chrome: managed connection UI, combined agent tab list, native consent, authenticated download, screenshot, isolated profile, disconnect/reconnect with persisted cookies, application discovery/filter/refresh and cancelled installer.',
  );
} catch (error) {
  if (page) {
    console.error(
      'Integration diagnostics:',
      JSON.stringify(
        await snapshot()
          .then(({ chromeConnections, browsers, applications }) => ({
            chromeConnections,
            browsers,
            applications: applications && {
              busy: applications.busy,
              error: applications.error,
              count: applications.items.length,
            },
          }))
          .catch(() => null),
      ),
    );
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
