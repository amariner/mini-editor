// Native DownloadItem behavior with cookies, blob downloads and cancellation; no real account.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-download-live-')));
const timers = new Set();
let authenticated = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(
      '<!doctype html><title>Descargas</title><button id="blob">Exportar Blob</button><script>document.querySelector("#blob").onclick=()=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["exportación local"],{type:"text/plain"}));a.download="exportado.txt";a.click()}</script>',
    );
  }
  if (!req.headers.cookie?.includes('signed-in=1')) {
    res.statusCode = 401;
    return res.end('Falta sesión');
  }
  authenticated++;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="informe.txt"');
  if (req.url === '/slow') {
    res.setHeader('Content-Length', 5 * 1024 * 1024);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', '"fixture-v1"');
    res.setHeader('Last-Modified', 'Thu, 29 Oct 2026 12:00:00 GMT');
    res.write(Buffer.alloc(8192, 65));
    const timer = setInterval(() => res.write(Buffer.alloc(8192, 65)), 100);
    timers.add(timer);
    res.on('close', () => {
      clearInterval(timer);
      timers.delete(timer);
    });
    return;
  }
  res.end('archivo autenticado');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const runner = path.join(root, 'runner.cjs');
await build({
  stdin: {
    contents: `import { app, BrowserWindow } from 'electron';
      import { BrowserDownloads } from ${JSON.stringify(fileURLToPath(new URL('../electron/browser-downloads.ts', import.meta.url)))};
      app.setPath('userData', ${JSON.stringify(path.join(root, 'data'))});
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        const downloads=new BrowserDownloads(${JSON.stringify(path.join(root, 'downloads'))},()=>{});
        win.webContents.session.on('will-download',(event,item,wc)=>downloads.handle(event,item,wc,{id:'tab',sessionId:'chat'}));
        globalThis.fixture={win,downloads};
        app.on('before-quit',()=>downloads.close());
        await win.webContents.session.cookies.set({url:${JSON.stringify(origin)},name:'signed-in',value:'1'});
        await win.loadURL(${JSON.stringify(origin)});
      });`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: runner,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
let app;
const list = () => app.evaluate(() => globalThis.fixture.downloads.list('tab'));
const waitFor = async (check) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('La descarga no alcanzó el estado esperado.');
};
try {
  app = await electron.launch({ args: [runner] });
  const page = await app.firstWindow();
  await page.waitForLoadState();
  await app.evaluate(
    (_electron, url) => globalThis.fixture.win.webContents.downloadURL(url),
    origin + '/download',
  );
  const first = await waitFor(async () =>
    (await list()).find((item) => item.state === 'completed'),
  );
  assert.equal(await fs.readFile(first.path, 'utf8'), 'archivo autenticado');
  await app.evaluate(
    (_electron, url) => globalThis.fixture.win.webContents.downloadURL(url),
    origin + '/download',
  );
  const second = await waitFor(async () =>
    (await list()).find((item) => item.id !== first.id && item.state === 'completed'),
  );
  assert.notEqual(second.path, first.path);
  assert.equal(await fs.readFile(first.path, 'utf8'), 'archivo autenticado');
  assert.equal(authenticated, 2);
  await page.locator('#blob').click();
  const blob = await waitFor(async () =>
    (await list()).find((item) => item.fileName === 'exportado.txt' && item.state === 'completed'),
  );
  assert.equal(await fs.readFile(blob.path, 'utf8'), 'exportación local');
  await app.evaluate(
    (_electron, url) => globalThis.fixture.win.webContents.downloadURL(url),
    origin + '/slow',
  );
  const slow = await waitFor(async () => (await list()).find((item) => item.state === 'progress'));
  const paused = await app.evaluate(
    (_electron, id) => globalThis.fixture.downloads.pause(id, 'tab'),
    slow.id,
  );
  assert.equal(paused.state, 'paused');
  assert.equal(paused.canResume, true);
  const resumed = await app.evaluate(
    (_electron, id) => globalThis.fixture.downloads.resume(id, 'tab'),
    slow.id,
  );
  assert.equal(resumed.state, 'progress');
  await app.evaluate((_electron, id) => globalThis.fixture.downloads.cancel(id, 'tab'), slow.id);
  await waitFor(async () =>
    (await list()).find((item) => item.id === slow.id && item.state === 'cancelled'),
  );
  console.log(
    'PASS: authenticated native downloads, duplicate filenames without overwrite, browser-generated Blob export, progress, pause, resume and cancellation.',
  );
} finally {
  await app?.close().catch(() => {});
  for (const timer of timers) clearInterval(timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
