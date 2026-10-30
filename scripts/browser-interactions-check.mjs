// Real Chromium helpers: consent state, trusted HTML/pointer drag, hidden/shadow/frame uploads.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'desk-browser-interactions-')),
);
const entry = path.join(root, 'helpers.ts');
const helper = path.join(root, 'helpers.cjs');
await fs.writeFile(
  entry,
  ['browser-dom', 'browser-upload', 'browser-drag']
    .map((name) => `export * from ${JSON.stringify(path.resolve('electron', name + '.ts'))};`)
    .join('\n'),
);
await build({
  entryPoints: [entry],
  outfile: helper,
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
await fs.writeFile(path.join(root, 'report.txt'), 'Upload evidence 2026');
let received = '';
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/upload') {
    for await (const chunk of req) received += chunk.toString();
    return res.end('<title>Subida completa</title><p>Archivo recibido</p>');
  }
  if (req.url === '/frame') return res.end('<input type="file" aria-label="Archivo del marco">');
  res.end(`<!doctype html><title>Interacciones completas</title><style>
  body{font:16px system-ui;padding:20px}button{padding:12px;margin:8px}#drag,#drop{display:inline-block;width:140px;height:70px;border:1px solid;padding:16px;margin:10px}#slider{height:40px;width:350px;background:#ddd}iframe{height:60px;width:500px;display:block}</style>
  <form action="/upload" method="post" enctype="multipart/form-data">
  <label><input type="checkbox" name="terms" aria-label="Acepto las condiciones"> Acepto las condiciones</label>
  <input type="file" name="asset" aria-label="Adjuntar informe" style="display:none"><button>Enviar archivo</button></form>
  <button role="switch" aria-label="Avisos" aria-checked="false" onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')==='true'?'false':'true')">Avisos</button>
  <div id="drag" draggable="true" aria-label="Tarjeta">Tarjeta</div><div id="drop" role="button" aria-label="Destino">Suelta aquí</div>
  <div id="slider" role="slider" aria-label="Deslizador"></div><p id="result">Pendiente</p>
  <div id="shadow"></div><iframe src="/frame"></iframe>
  <script>
  document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input type="file" aria-label="Archivo sombra">';
  drag.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','tarjeta'));
  drop.addEventListener('dragover',e=>e.preventDefault());
  drop.addEventListener('drop',e=>{e.preventDefault();result.textContent=e.isTrusted&&e.dataTransfer.getData('text/plain')==='tarjeta'?'Arrastre fiable':'Arrastre incorrecto'});
  slider.addEventListener('pointerdown',e=>{slider.setPointerCapture(e.pointerId);slider.dataset.dragging='true'});
  slider.addEventListener('pointermove',e=>{if(slider.dataset.dragging==='true')slider.dataset.x=String(e.clientX)});
  slider.addEventListener('pointerup',()=>delete slider.dataset.dragging);
  </script>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}/`;
let app;
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
  await app.firstWindow();
  await app.evaluate(
    async ({ BrowserWindow }, { url, helper, root }) => {
      const modules = process.getBuiltinModule('module').createRequire(helper)(helper);
      const win = new BrowserWindow({
        width: 1000,
        height: 900,
        show: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await win.loadURL(url);
      const wc = win.webContents;
      let sequence = 0;
      const dom = (input) =>
        wc.executeJavaScriptInIsolatedWorld(
          1001,
          [{ code: `(${modules.browserDOM.toString()})(${JSON.stringify(input)})` }],
          true,
        );
      const inspect = () => dom({ action: 'inspect', sequence: ++sequence });
      globalThis.interactions = { wc, dom, inspect, root, ...modules };
    },
    { url, helper, root },
  );
  let info = await app.evaluate(() => globalThis.interactions.inspect());
  for (
    let attempts = 0;
    !info.elements.some((e) => e.label === 'Archivo del marco') && attempts < 20;
    attempts++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    info = await app.evaluate(() => globalThis.interactions.inspect());
  }
  const ref = (label) => {
    const target = info.elements.find((e) => e.label === label);
    assert.ok(target, label);
    return target.ref;
  };
  assert.equal(info.elements.find((e) => e.label === 'Adjuntar informe').hidden, true);
  const check = (ref, checked) =>
    app.evaluate(
      async ({}, { ref, checked }) => {
        const { wc, dom } = globalThis.interactions;
        const state = await dom({ action: 'check', ref, checked });
        if (state.needsClick) {
          wc.debugger.attach('1.3');
          try {
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: state.x,
              y: state.y,
              button: 'left',
              clickCount: 1,
            });
            await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: state.x,
              y: state.y,
              button: 'left',
              clickCount: 1,
            });
          } finally {
            wc.debugger.detach();
          }
        }
        return dom({ action: 'check', ref, checked });
      },
      { ref, checked },
    );
  assert.equal((await check(ref('Acepto las condiciones'), true)).checked, true);
  assert.equal((await check(ref('Acepto las condiciones'), true)).needsClick, false);
  assert.equal((await check(ref('Acepto las condiciones'), false)).checked, false);
  assert.equal((await check(ref('Acepto las condiciones'), true)).checked, true);
  assert.equal((await check(ref('Avisos'), true)).checked, true);
  const upload = (ref, paths) =>
    app.evaluate(
      ({}, { ref, paths }) => {
        const { wc, root, uploadBrowserFiles } = globalThis.interactions;
        return uploadBrowserFiles(wc, ref, paths, root);
      },
      { ref, paths },
    );
  for (const label of ['Adjuntar informe', 'Archivo sombra', 'Archivo del marco']) {
    const result = await upload(ref(label), ['report.txt']);
    assert.equal(result.files[0].name, 'report.txt');
  }
  await upload(ref('Archivo sombra'), []);
  const drag = (fromRef, toRef) =>
    app.evaluate(
      async ({}, { fromRef, toRef }) => {
        const { wc, dom, dragBrowserPointer } = globalThis.interactions;
        const from = await dom({ action: 'point', ref: fromRef });
        const to = await dom({ action: 'point', ref: toRef });
        return dragBrowserPointer(wc, from, to);
      },
      { fromRef, toRef },
    );
  assert.equal((await drag(ref('Tarjeta'), ref('Destino'))).kind, 'html');
  assert.match(
    (await app.evaluate(() => globalThis.interactions.inspect())).text,
    /Arrastre fiable/,
  );
  await app.evaluate(async () => {
    const { wc, dom, dragBrowserPointer } = globalThis.interactions;
    const info = await globalThis.interactions.inspect();
    const slider = info.elements.find((e) => e.label === 'Deslizador');
    const from = { x: slider.rect.x + 5, y: slider.rect.y + 20 };
    const to = { x: slider.rect.x + 300, y: slider.rect.y + 20 };
    await dragBrowserPointer(wc, from, to);
    const x = await wc.executeJavaScript('Number(slider.dataset.x)');
    if (Math.abs(x - to.x) > 2) throw new Error('El arrastre de puntero no movió el deslizador');
    await wc.executeJavaScript('document.querySelector("form").requestSubmit()');
  });
  for (let i = 0; !received && i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(received, /name="terms"/);
  assert.match(received, /filename="report.txt"/);
  assert.match(received, /Upload evidence 2026/);
  console.log(
    'PASS: idempotent native consent, ARIA switch, hidden/shadow/frame uploads, file clearing, real multipart upload, native HTML drag and pointer slider drag.',
  );
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
