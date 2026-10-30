// Real sandboxed Chromium: trusted input, hidden tabs, shadow roots and iframe controls.
import { _electron as electron } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-browser-control-'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/frame')
    return res.end(
      '<input aria-label="Dentro del marco"><button onclick="this.textContent=event.isTrusted?\'Marco fiable\':\'No fiable\'">Botón del marco</button>',
    );
  res.end(`<!doctype html><title>Control real</title><style>body{font:16px system-ui;padding:20px}button,input,select{padding:12px;margin:4px}#scroller{height:70px;width:300px;overflow:auto;border:1px solid}#scroller div{height:500px;width:600px}iframe{display:block;width:600px;height:90px}#editor{border:1px solid;padding:10px}</style>
  <button id="trusted">Activar</button><button id="hover">Pasa por encima</button><p id="status">Pendiente</p>
  <select aria-label="País"><option value="es">España</option><option value="pt">Portugal</option></select>
  <input aria-label="Nombre"><input aria-label="Contraseña" type="password" value="secret-not-readable">
  <div id="editor" contenteditable="true" aria-label="Editor">Viejo</div>
  <div id="scroller" tabindex="0" aria-label="Panel desplazable"><div>Contenido largo</div></div>
  <div id="shadow"></div><iframe title="Formulario" src="/frame"></iframe>
  <script>
  document.querySelector('#trusted').addEventListener('pointerdown', e => document.querySelector('#status').textContent=e.isTrusted?'Puntero fiable':'No fiable');
  document.querySelector('#hover').addEventListener('pointerenter', e => document.querySelector('#status').textContent=e.isTrusted?'Hover fiable':'No fiable');
  const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<label>Campo sombra<input aria-label="Campo sombra"></label><button>Sombra</button>';
  shadow.querySelector('button').onclick=e=>document.querySelector('#status').textContent=e.isTrusted?'Sombra fiable':'No fiable';
  </script>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}/`;
let app, page;
const call = (action) => page.evaluate((action) => window.desk.invoke(action), action);
const poll = async (check) => {
  for (let i = 0; i < 80; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timeout');
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
  await page.waitForFunction(() => !!window.desk);
  const tab = await call({ type: 'browserNew', url });
  const act = (input) => call({ type: 'browserTab', tabId: tab.id, input });
  // Deliberately keep the native guest hidden: background control must still be trustworthy.
  await call({
    type: 'browserPresent',
    tabId: tab.id,
    visible: false,
    bounds: { x: 0, y: 0, width: 1000, height: 720 },
  });
  let info = await poll(async () => {
    const info = await act({ action: 'inspect' });
    return info.elements.some((e) => e.label === 'Botón del marco') && info;
  });
  assert.ok(!JSON.stringify(info).includes('secret-not-readable'));
  const ref = (label) => {
    const el = info.elements.find((e) => e.label === label);
    assert.ok(el, label);
    return el.ref;
  };
  assert.ok(info.viewport.width > 100, JSON.stringify(info.viewport));
  assert.ok(info.frames.some((frame) => frame.accessible));
  await act({ action: 'click', ref: ref('Activar') });
  assert.match((await act({ action: 'inspect' })).text, /Puntero fiable/);
  info = await act({ action: 'inspect' });
  await act({ action: 'hover', ref: ref('Pasa por encima') });
  assert.match((await act({ action: 'inspect' })).text, /Hover fiable/);
  const cursorShot = await act({ action: 'screenshot' });
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/browser-agent-cursor.png', Buffer.from(cursorShot.image, 'base64'));
  info = await act({ action: 'inspect' });
  await act({ action: 'fill', ref: ref('Campo sombra'), text: 'Funciona en shadow DOM' });
  await act({ action: 'click', ref: ref('Sombra') });
  assert.match((await act({ action: 'inspect' })).text, /Sombra fiable/);
  info = await act({ action: 'inspect' });
  await act({ action: 'fill', ref: ref('Dentro del marco'), text: 'Marco escrito' });
  await act({ action: 'click', ref: ref('Botón del marco') });
  assert.match((await act({ action: 'inspect' })).text, /Marco fiable/);
  info = await act({ action: 'inspect' });
  await act({ action: 'select', ref: ref('País'), value: 'pt' });
  const scroll = await act({
    action: 'scroll',
    ref: ref('Panel desplazable'),
    deltaY: 250,
    deltaX: 100,
  });
  assert.equal(scroll.scrollTop, 250);
  assert.equal(scroll.scrollLeft, 100);
  await act({ action: 'fill', ref: ref('Editor'), text: 'Edición real' });
  await assert.rejects(
    act({ action: 'fill', ref: ref('Contraseña'), text: 'blocked' }),
    /intervención del usuario/,
  );
  const stale = ref('Nombre');
  info = await act({ action: 'inspect' });
  await assert.rejects(act({ action: 'click', ref: stale }), /Referencia caducada/);
  await act({ action: 'fill', ref: ref('Nombre'), text: 'Seleccionar todo' });
  await act({
    action: 'press',
    key: 'a',
    modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
  });
  await act({ action: 'press', key: 'Backspace' });
  const values = await app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    return wc.executeJavaScript(
      `({name:document.querySelector('input').value,select:document.querySelector('select').value,editor:document.querySelector('#editor').textContent,shadow:document.querySelector('#shadow').shadowRoot.querySelector('input').value,frame:document.querySelector('iframe').contentDocument.querySelector('input').value,cursor:!!document.querySelector('[data-agent-desk-cursor]')})`,
    );
  }, url);
  assert.deepEqual(values, {
    name: '',
    select: 'pt',
    editor: 'Edición real',
    shadow: 'Funciona en shadow DOM',
    frame: 'Marco escrito',
    cursor: true,
  });
  await act({ action: 'zoom', factor: 0.75 });
  info = await act({ action: 'inspect' });
  const target = info.elements.find((e) => e.label === 'Activar').rect;
  await act({ action: 'click', x: target.x + target.width / 2, y: target.y + target.height / 2 });
  assert.match((await act({ action: 'inspect' })).text, /Puntero fiable/);
  await assert.rejects(act({ action: 'move', x: 50000, y: 50000 }), /fuera de la ventana/);
  const shot = await act({ action: 'screenshot' });
  assert.ok(shot.viewport.width > 100 && shot.imageSize.width > 100);
  assert.deepEqual(
    shot.viewport,
    (await act({ action: 'inspect' })).viewport,
    'Screenshot and pointer coordinates must use the same CSS viewport at non-default zoom',
  );
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/browser-control-native.png', Buffer.from(shot.image, 'base64'));
  await act({ action: 'suspend' });
  await act({ action: 'inspect' });
  assert.equal(
    await app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((w) => w.getURL() === url)
          .debugger.isAttached(),
      url,
    ),
    false,
    'Resumed hidden tabs release their private debugger after the action',
  );
  const snapshot = await call({ type: 'snapshot' });
  assert.equal(snapshot.browsers.find((t) => t.id === tab.id).activity.phase, 'done');
  console.log(
    'PASS: trusted background pointer/hover, shadow DOM, same-origin iframe, select, nested scrolling, contenteditable, key modifiers, stale refs, password redaction, zoom coordinates, cursor overlay and screenshot dimensions.',
  );
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
