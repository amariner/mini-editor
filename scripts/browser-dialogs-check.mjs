// Real Chromium dialogs in a WebContentsView, answered from the host renderer UI.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-dialogs-'));
const moduleFile = path.join(root, 'dialogs.cjs');
const mainFile = path.join(root, 'main.cjs');
const preload = path.join(root, 'preload.cjs');
const guestPreload = path.join(root, 'guest-preload.cjs');
await build({
  entryPoints: ['electron/browser-preload.ts'],
  outfile: guestPreload,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
await build({
  entryPoints: ['electron/browser-dialogs.ts'],
  outfile: moduleFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
await fs.writeFile(
  preload,
  `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{respond:(accept,text)=>ipcRenderer.invoke('respond-dialog',{accept,text}),subscribe:fn=>ipcRenderer.on('pending-dialog',(_e,d)=>fn(d))});`,
);
const html = `<!doctype html><title>Diálogos</title><button id="confirm" onclick="document.body.dataset.confirmed=confirm('Aceptar condiciones')">Aceptar condiciones</button><button id="prompt" onclick="document.body.dataset.answer=window.prompt('Nombre del informe','Borrador')">Nombre</button><button id="alert" onclick="window.alert('Descarga preparada');document.body.dataset.alerted='yes'">Aviso</button>`;
const host = `<!doctype html><title>Host de prueba</title><div id="message">Sin diálogo</div><input id="text" aria-label="Respuesta"><button id="accept" onclick="fixture.respond(true,window.pendingType==='prompt'?document.querySelector('#text').value:undefined)">Aceptar en la app</button><button id="cancel" onclick="fixture.respond(false)">Cancelar en la app</button><script>fixture.subscribe(d=>{window.pendingType=d?.type;document.querySelector('#message').textContent=d?.message||'Sin diálogo';document.querySelector('#text').value=d?.defaultPrompt||''})</script>`;
await fs.writeFile(
  mainFile,
  `const {app,BrowserWindow,WebContentsView,dialog,ipcMain}=require('electron');const {BrowserDialogs}=require(${JSON.stringify(moduleFile)});app.setPath('userData',${JSON.stringify(path.join(root, 'data'))});globalThis.nativeDialogCalls=0;dialog.showMessageBox=async()=>{nativeDialogCalls++;return {response:1,checkboxChecked:false}};app.whenReady().then(async()=>{
  globalThis.testWindow=new BrowserWindow({width:900,height:650,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(preload)}}});
  await testWindow.loadURL(${JSON.stringify('data:text/html,' + encodeURIComponent(host))});
  globalThis.guest=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(guestPreload)}}});testWindow.contentView.addChildView(guest);guest.setBounds({x:0,y:100,width:900,height:550});
  globalThis.dialogs=new BrowserDialogs(guest.webContents,d=>testWindow.webContents.send('pending-dialog',d));
  ipcMain.handle('respond-dialog',(_event,value)=>dialogs.respond(dialogs.current?.id,value.accept,value.text));
  await guest.webContents.loadURL(${JSON.stringify('data:text/html,' + encodeURIComponent(html))});globalThis.fixtureReady=true;
});`,
);
let app;
try {
  app = await electron.launch({ args: [mainFile], timeout: 15000 });
  app.context().on('page', (target) => target.on('dialog', () => {}));
  for (const target of app.context().pages()) target.on('dialog', () => {});
  const page = await app.firstWindow({ timeout: 10000 });
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => globalThis.fixtureReady)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await app.evaluate(() => dialogs.supported), true);
  const click = (selector) =>
    app.evaluate(async (_electron, selector) => {
      const wc = guest.webContents;
      await globalThis.dialogOperation;
      const point = await wc.executeJavaScript(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      const attached = wc.debugger.isAttached();
      if (!attached) wc.debugger.attach('1.3');
      globalThis.dialogOperation = (async () => {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        return { done: true };
      })().finally(() => {
        if (!attached && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
      });
      const result = await dialogs.race(globalThis.dialogOperation);
      if (result.dialog) return result;
      for (let i = 0; i < 40; i++) {
        if (dialogs.current) return { dialog: dialogs.current };
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return result;
    }, selector);
  const value = (key) =>
    app.evaluate(
      (_electron, key) =>
        guest.webContents.executeJavaScript(`document.body.dataset[${JSON.stringify(key)}]`),
      key,
    );
  const first = await click('#confirm');
  assert.equal(first.dialog.type, 'confirm');
  await page.getByRole('button', { name: 'Aceptar en la app', exact: true }).click();
  assert.equal(await value('confirmed'), 'true');
  await click('#confirm');
  await page.getByRole('button', { name: 'Cancelar en la app', exact: true }).click();
  assert.equal(await value('confirmed'), 'false');
  const prompt = await click('#prompt');

  assert.equal(prompt.dialog.defaultPrompt, 'Borrador');
  await page.getByRole('textbox', { name: 'Respuesta' }).fill('Informe listo');
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/browser-dialog-host.png' });
  await page.getByRole('button', { name: 'Aceptar en la app', exact: true }).click();
  assert.equal(await value('answer'), 'Informe listo');
  await click('#prompt');
  await page.getByRole('textbox', { name: 'Respuesta' }).fill('');
  await page.getByRole('button', { name: 'Aceptar en la app', exact: true }).click();
  assert.equal(await value('answer'), '');
  await click('#prompt');
  await page.getByRole('button', { name: 'Cancelar en la app', exact: true }).click();
  assert.equal(await value('answer'), 'null');
  const alert = await click('#alert');
  assert.equal(alert.dialog.type, 'alert');
  await page.getByRole('button', { name: 'Aceptar en la app', exact: true }).click();
  assert.equal(await value('alerted'), 'yes');
  await assert.rejects(
    app.evaluate((_electron, id) => dialogs.respond(id, true), alert.dialog.id),
    /ya no está abierto/,
  );
  assert.equal(
    await app.evaluate(() => nativeDialogCalls),
    0,
    'Native modal sheets must never be created for managed tabs',
  );
  console.log(
    'PASS: actual host UI answers confirm accept/cancel, prompt text/default/empty/cancel, alert; native sheets suppressed, click queue released and stale responses rejected.',
  );
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
