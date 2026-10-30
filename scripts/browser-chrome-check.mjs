// Run with: node --import tsx scripts/browser-chrome-check.mjs
// Uses only temporary owned Chrome profiles; never attaches to the user's Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { ChromeBrowser, installedChrome } from '../electron/chrome-browser.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-chrome-check-'));
const fixture = `<!doctype html><meta charset="utf-8"><title>Chrome workflow</title>
<label><input type="checkbox" id="terms">Aceptar condiciones</label>
<input aria-label="Nombre" id="name"><button id="confirm" onclick="document.querySelector('#result').textContent=confirm('Continuar?')?'accepted':'rejected'">Confirmar</button>
<button id="prompt" onclick="document.querySelector('#result').textContent=prompt('Nombre?', 'base')">Prompt</button>
<a href="/download" download>Descargar autenticado</a><a href="/slow-download" download>Descargar lento</a><button id="blob" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['blob-content']));a.download='blob.txt';a.click()">Exportar Blob</button>
<form method="post" action="/upload" enctype="multipart/form-data"><input type="file" name="asset" aria-label="Archivo"><button>Subir archivo</button></form>
<button onclick="window.open('/popup')">Abrir popup</button><div id="result"></div>
<script>document.querySelector('#terms').addEventListener('click',e=>window.trusted=e.isTrusted)</script>`;
let uploaded = '';
const server = http.createServer((req, res) => {
  if (req.url === '/slow-download') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="lento.bin"',
      'Content-Length': 10485760,
    });
    let sent = 0;
    const interval = setInterval(() => {
      res.write(Buffer.alloc(65536));
      sent += 65536;
      if (sent >= 10485760) {
        clearInterval(interval);
        res.end();
      }
    }, 50);
    res.on('close', () => clearInterval(interval));
    return;
  }
  if (req.url === '/download') {
    if (!req.headers.cookie?.includes('desk=authorized')) {
      res.writeHead(403).end();
      return;
    }
    res
      .writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="autenticado.txt"',
      })
      .end('authenticated-content');
    return;
  }
  if (req.url === '/upload') {
    req.on('data', (data) => {
      uploaded += data;
    });
    req.on('end', () => {
      res.end('<title>Uploaded</title>Archivo recibido');
    });
    return;
  }
  res
    .writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': 'desk=authorized; Path=/; Max-Age=600; SameSite=Lax',
    })
    .end(fixture);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}`;
const projectRoot = path.join(root, 'project');
await fs.mkdir(projectRoot);
await fs.writeFile(path.join(projectRoot, 'asset.txt'), 'uploaded-content');
const backend = new ChromeBrowser({
  root: path.join(root, 'data'),
  downloadsRoot: path.join(root, 'downloads'),
  changed() {},
  projectRoot: async () => projectRoot,
  headless: true,
});
let personal, host;
async function until(fn, label) {
  for (let n = 0; n < 120; n++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
try {
  await backend.connect('managed', 'project', 'session');
  const connection = backend.connections()[0];
  assert.equal(connection.status, 'connected');
  const tab = backend.snapshot()[0];
  const act = (input) => backend.action(tab.id, input);
  const inspect = () => act({ action: 'inspect' });
  const ref = async (label) =>
    (await inspect()).elements.find((element) => element.label === label)?.ref;
  await act({ action: 'navigate', url });
  await act({ action: 'check', ref: await ref('Aceptar condiciones'), checked: true });
  await act({ action: 'check', ref: await ref('Aceptar condiciones'), checked: true });
  assert.equal(
    (await inspect()).elements.find((e) => e.label === 'Aceptar condiciones').checked,
    true,
  );
  await act({ action: 'fill', ref: await ref('Nombre'), text: 'Agente' });
  const modal = await act({ action: 'click', ref: await ref('Confirmar') });
  assert.equal(modal.dialog.type, 'confirm');
  await act({ action: 'dialog', dialogId: modal.dialog.id, accept: true });
  assert.match((await inspect()).text, /accepted/);
  const prompt = await act({ action: 'click', ref: await ref('Prompt') });
  await act({
    action: 'dialog',
    dialogId: prompt.dialog.id,
    accept: true,
    promptText: 'Texto nativo',
  });
  assert.match((await inspect()).text, /Texto nativo/);
  await act({ action: 'click', ref: await ref('Descargar autenticado') });
  await until(() => backend.downloadSnapshot().some((d) => d.state === 'completed'), 'download');
  const download = backend.downloadSnapshot()[0];
  assert.equal(
    await fs.readFile(await backend.revealDownload(tab.id, download.id), 'utf8'),
    'authenticated-content',
  );
  assert.equal(download.canPause, false);
  await act({ action: 'click', ref: await ref('Exportar Blob') });
  await until(
    () => backend.downloadSnapshot().filter((d) => d.state === 'completed').length === 2,
    'blob download',
  ).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(backend.downloadSnapshot())}`);
  });
  await act({ action: 'click', ref: await ref('Descargar lento') });
  await until(
    () => backend.downloadSnapshot().some((d) => d.state === 'progress' && d.receivedBytes > 0),
    'download progress',
  );
  const slow = backend.downloadSnapshot().find((d) => d.fileName === 'lento.bin');
  await backend.controlDownload(tab.id, slow.id, 'cancel');
  assert.equal(backend.downloadSnapshot().find((d) => d.id === slow.id).state, 'cancelled');
  await act({ action: 'upload', ref: await ref('Archivo'), paths: ['asset.txt'] });
  await act({ action: 'click', ref: await ref('Subir archivo') });
  await until(() => uploaded.includes('uploaded-content'), 'upload');
  const screenshot = await act({ action: 'screenshot' });
  assert.equal(screenshot.mimeType, 'image/png');
  assert.ok(screenshot.image.length > 100);
  await backend.disconnect(connection.id);
  assert.equal(backend.connections()[0].status, 'disconnected');
  assert.equal(backend.snapshot().length, 0);
  await backend.reconnect(connection.id);
  assert.equal(backend.connections()[0].profilePath, connection.profilePath);
  assert.equal(backend.connections()[0].status, 'connected');
  await backend.disconnect(connection.id);

  // A second owned browser represents a user's live Chrome. The test uses a temporary
  // port descriptor; production connects only through Chrome's consent-enabled descriptor.
  const personalProfile = path.join(root, 'owned-personal-fixture');
  const personalDownloads = path.join(root, 'native-personal-downloads');
  await fs.mkdir(path.join(personalProfile, 'Default'), { recursive: true });
  await fs.mkdir(personalDownloads);
  await fs.writeFile(
    path.join(personalProfile, 'Default/Preferences'),
    JSON.stringify({
      download: { default_directory: personalDownloads, prompt_for_download: false },
    }),
  );
  host = await chromium.launchPersistentContext(personalProfile, {
    executablePath: await installedChrome(),
    headless: true,
    chromiumSandbox: true,
    args: ['--remote-debugging-port=0'],
  });
  const userPage = host.pages()[0];
  userPage.on('dialog', () => {});
  await userPage.goto(url);
  personal = new ChromeBrowser({
    root: path.join(root, 'personal-data'),
    downloadsRoot: path.join(root, 'personal-downloads'),
    personalProfile,
    changed() {},
  });
  await personal.connect('personal', 'project', 'session');
  assert.equal(personal.connections()[0].status, 'connected');
  await personal.action(personal.snapshot()[0].id, { action: 'inspect' });
  const personalTab = personal.snapshot()[0];
  const personalInspection = await personal.action(personalTab.id, { action: 'inspect' });
  await personal.action(personalTab.id, {
    action: 'click',
    ref: personalInspection.elements.find((e) => e.label === 'Descargar autenticado').ref,
  });
  await until(
    () => personal.downloadSnapshot().some((d) => d.state === 'completed'),
    'personal native download',
  );
  const nativeDownload = personal.downloadSnapshot()[0];
  assert.equal(path.dirname(nativeDownload.path), personalDownloads);
  assert.equal(await fs.readFile(nativeDownload.path, 'utf8'), 'authenticated-content');
  // Chrome's own UI (represented by another CDP client) may answer a dialog.
  const userClient = await host.newCDPSession(userPage);
  await userClient.send('Page.enable');
  const manualRef = (await personal.action(personalTab.id, { action: 'inspect' })).elements.find(
    (e) => e.label === 'Prompt',
  ).ref;
  const manual = await personal.action(personalTab.id, { action: 'click', ref: manualRef });
  assert.equal(manual.dialog.type, 'prompt');
  await userClient.send('Page.handleJavaScriptDialog', {
    accept: true,
    promptText: 'Respuesta manual',
  });
  await until(() => !personal.snapshot()[0]?.dialog, 'manual dialog state cleared');
  assert.match(
    (await personal.action(personalTab.id, { action: 'inspect' })).text,
    /Respuesta manual/,
  );
  // A dirty user tab must remain open when beforeunload is declined.
  await userPage.evaluate(() => {
    window.onbeforeunload = () => 'Unsaved';
  });
  await personal.action(personalTab.id, { action: 'close' });
  await until(() => personal.snapshot()[0]?.dialog?.type === 'beforeunload', 'beforeunload');
  await personal.action(personalTab.id, {
    action: 'dialog',
    dialogId: personal.snapshot()[0].dialog.id,
    accept: false,
  });
  assert.equal(userPage.isClosed(), false);
  await userPage.evaluate(() => {
    window.onbeforeunload = null;
  });
  await personal.disconnect(personal.connections()[0].id);
  assert.equal(userPage.isClosed(), false);
  assert.equal(await userPage.title(), 'Chrome workflow');

  // Stopping a connection during launch waits for its owned process to close,
  // and a later reconnect creates a fresh session instead of returning the stale task.
  const pendingLaunch = backend.connect('managed', 'pending-project', 'pending-session');
  const pendingConnection = backend
    .connections()
    .find((item) => item.projectId === 'pending-project');
  await backend.disconnect(pendingConnection.id);
  await pendingLaunch;
  assert.equal(
    backend.connections().find((item) => item.id === pendingConnection.id).status,
    'disconnected',
  );
  assert.equal(backend.snapshot().length, 0);
  await backend.reconnect(pendingConnection.id);
  assert.equal(
    backend.connections().find((item) => item.id === pendingConnection.id).status,
    'connected',
  );
  await backend.disconnect(pendingConnection.id);
  const shutdownLaunch = backend.connect('managed', 'shutdown-project', 'shutdown-session');
  await backend.closeAll();
  await shutdownLaunch;
  assert.equal(backend.snapshot().length, 0);
  for (const connection of backend.connections()) {
    assert.notEqual(connection.status, 'connected');
    if (connection.profilePath)
      await assert.rejects(fs.lstat(path.join(connection.profilePath, 'SingletonLock')), {
        code: 'ENOENT',
      });
  }
  await backend.removeProject('pending-project');
  const restored = new ChromeBrowser({
    root: path.join(root, 'data'),
    downloadsRoot: path.join(root, 'downloads'),
    changed() {},
  });
  assert.equal(
    restored.connections().some((item) => item.projectId === 'pending-project'),
    false,
  );
  assert.equal(
    restored.connections().every((item) => item.status === 'disconnected'),
    true,
  );
  await restored.closeAll();
  console.log(
    'Chrome workflows PASS: consent, native dialogs/manual response/beforeunload, authenticated and Blob downloads, real progress/cancel, scoped upload, screenshot, reconnect, native personal download preferences, personal detach preserves browser, pending-launch and shutdown cleanup.',
  );
} finally {
  await personal?.closeAll();
  await host?.close();
  await backend.closeAll();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
