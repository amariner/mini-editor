// End-to-end main/renderer/browser tools: consent, authenticated downloads, uploads and dialogs.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-web-workflows-')));
const project = path.join(root, 'project');
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'document.txt'), 'USER_SELECTED_REPORT_CONTENT');
let submitted = '';
const server = http.createServer((req, res) => {
  if (req.url === '/report') {
    if (!req.headers.cookie?.includes('consent=yes')) {
      res.writeHead(403);
      res.end('Necesitas aceptar');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Disposition': 'attachment; filename="informe.txt"',
    });
    res.end('AUTHENTICATED_REPORT');
    return;
  }
  if (req.url === '/upload') {
    req.on('data', (chunk) => {
      submitted += chunk;
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Recibido</title><h1>Archivo recibido</h1>');
    });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Flujos completos</title><style>body{font:15px system-ui;padding:24px}button,input{margin:8px;padding:10px}label{display:block}</style>
    <label><input id="consent" type="checkbox" aria-label="Acepto las condiciones" onchange="document.cookie=this.checked?'consent=yes;path=/':'consent=no;path=/'">Acepto las condiciones</label>
    <a href="/report" download>Descargar informe</a>
    <button id="export" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['BLOB_EXPORT']));a.download='exportacion.txt';a.click()">Exportar archivo</button>
    <button onclick="document.querySelector('#result').textContent=confirm('¿Aceptar estas condiciones?')?'Confirmado':'Cancelado'">Confirmación</button>
    <button onclick="document.querySelector('#result').textContent=prompt('Nombre del informe','Original')||'Sin nombre'">Nombre del informe</button>
    <button onclick="alert('Proceso terminado')">Aviso</button><p id="result">Pendiente</p>
    <form action="/upload" method="post" enctype="multipart/form-data"><input aria-label="Documento" type="file" name="document" hidden><button>Enviar documento</button></form>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}/`;
let app, page;
const call = (action) => page.evaluate((value) => window.desk.invoke(value), action);
const poll = async (check, message = 'Estado pendiente') => {
  for (let i = 0; i < 160; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
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
  app.context().on('page', (target) => target.on('dialog', () => {}));
  for (const target of app.context().pages()) target.on('dialog', () => {});
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.desk);
  await call({ type: 'addAccount', kind: 'claude', name: 'Prueba de navegador' });
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  await call({ type: 'addProject' });
  const initial = await call({ type: 'snapshot' });
  const tab = await call({
    type: 'browserNew',
    projectId: initial.selectedProject,
    sessionId: initial.selectedSession,
    url,
  });
  const act = (input) => call({ type: 'browserTab', tabId: tab.id, input });
  let info;
  const inspect = async () => {
    info = await act({ action: 'inspect' });
    return info;
  };
  const ref = (label) => {
    const found = info.elements.find((item) => item.label === label);
    assert.ok(found, label);
    return found.ref;
  };
  await inspect();
  await act({ action: 'check', ref: ref('Acepto las condiciones'), checked: true });
  await act({ action: 'check', ref: ref('Acepto las condiciones'), checked: true });
  assert.equal(
    (await inspect()).elements.find((item) => item.label === 'Acepto las condiciones').checked,
    true,
  );
  await act({ action: 'click', ref: ref('Descargar informe') });
  const report = await poll(
    async () =>
      (await act({ action: 'downloads' })).downloads.find(
        (item) => item.fileName === 'informe.txt' && item.state === 'completed',
      ),
    'Descarga autenticada',
  );
  assert.equal(await fs.readFile(report.path, 'utf8'), 'AUTHENTICATED_REPORT');
  assert.ok(report.path.startsWith(root));
  await page.getByRole('region', { name: 'Descargas del navegador' }).waitFor();
  await page.getByRole('button', { name: 'Mostrar informe.txt en Finder' }).waitFor();
  await app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    globalThis.webFlowErrors = [];
    wc.on('console-message', (details) => webFlowErrors.push(details.message));
    wc.session.webRequest.onErrorOccurred((details) =>
      webFlowErrors.push({ url: details.url, error: details.error, type: details.resourceType }),
    );
  }, url);
  await inspect();
  await act({ action: 'click', ref: ref('Exportar archivo') });
  const blob = await poll(
    async () =>
      (await act({ action: 'downloads' })).downloads.find(
        (item) => item.fileName === 'exportacion.txt' && item.state === 'completed',
      ),
    'Exportación Blob',
  ).catch(async (error) => {
    console.log(
      'blob diagnostics',
      await app.evaluate(() => webFlowErrors),
      (await call({ type: 'snapshot' })).browsers,
    );
    throw error;
  });
  assert.equal(await fs.readFile(blob.path, 'utf8'), 'BLOB_EXPORT');
  await page.getByRole('button', { name: 'Mostrar exportacion.txt en Finder' }).waitFor();
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/browser-downloads-panel.png' });
  await app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
    await wc.executeJavaScript(
      'void Notification.requestPermission().then(value=>window.notificationDecision=value)',
      true,
    );
  }, url);
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await poll(
    async () =>
      !(await call({ type: 'snapshot' })).browsers.find((item) => item.id === tab.id).permissions
        .length,
  );

  // The same dialog is visible to tools and app UI; responding never waits behind its click.
  await inspect();
  await act({ action: 'click', ref: ref('Confirmación') });
  let dialog = await poll(
    async () =>
      (await call({ type: 'snapshot' })).browsers.find((item) => item.id === tab.id).dialog,
    'Confirm pendiente',
  );
  assert.equal((await inspect()).dialog.id, dialog.id);
  await act({ action: 'dialog', dialogId: dialog.id, accept: true });
  await poll(async () => (await inspect()).text.includes('Confirmado'));
  await act({ action: 'click', ref: ref('Nombre del informe') });
  dialog = await poll(
    async () =>
      (await call({ type: 'snapshot' })).browsers.find((item) => item.id === tab.id).dialog,
    'Prompt pendiente',
  );
  assert.equal(dialog.type, 'prompt');
  await page.getByRole('textbox', { name: 'Respuesta al diálogo' }).fill('Informe completo');
  await page.getByRole('button', { name: 'Aceptar', exact: true }).click();
  await poll(async () => (await inspect()).text.includes('Informe completo'));
  await act({ action: 'click', ref: ref('Aviso') });
  await page.getByRole('button', { name: 'Cerrar aviso' }).click();
  await poll(
    async () =>
      !(await call({ type: 'snapshot' })).browsers.find((item) => item.id === tab.id).dialog,
  );
  await inspect();
  await act({ action: 'upload', ref: ref('Documento'), paths: ['document.txt'] });
  await inspect();
  assert.deepEqual(
    info.elements.find((item) => item.label === 'Documento').files.map((file) => file.name),
    ['document.txt'],
  );
  await act({ action: 'click', ref: ref('Enviar documento') });
  await poll(async () => (await inspect()).text.includes('Archivo recibido'));
  assert.ok(submitted.includes('USER_SELECTED_REPORT_CONTENT'));
  assert.ok(submitted.includes('filename="document.txt"'));
  await act({ action: 'close' });
  assert.equal(
    (await call({ type: 'snapshot' })).browserDownloads.filter((item) => item.state === 'completed')
      .length,
    2,
    'Las descargas sobreviven al cierre de la pestaña',
  );
  assert.ok(await page.getByRole('button', { name: 'Mostrar informe.txt en Finder' }).isVisible());
  console.log(
    'PASS: IPC/browser/UI consent, authenticated download, Blob export, confirm/prompt/alert, project file upload with multipart submit, and downloads retained after tab closure.',
  );
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
