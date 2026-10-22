// Isolated real-browser component checks; no providers, credentials or application data.
// Run explicitly: node scripts/chat-interactions-check.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Composer } from './src/chat';
      import { Multichat } from './src/multichat';
      import { useTextDrafts, useImageDrafts, initializeDraftLifetime } from './src/chat-drafts';
      import { IPC_VERSION } from './src/runtime';
      const session = { id: 'chat', projectId: 'project', profile: 'claude-1', title: 'Prueba',
        status: 'ready', mode: 'chat', approvals: [], messages: [{id:'u', role:'user', text:'Anterior'}],
        info: { models: [], commands: [], tools: [], mcpServers: [], skills: [], plugins: [], agents: [] }
      };
      const state = { sessions: [session], projects: [{id:'project', name:'Proyecto', path:'/tmp'}],
        profiles: [{ id:'claude-1', kind:'claude', name:'Prueba' }], accounts: {}, tools: {},
        runtime: { protocol: IPC_VERSION }, selectedSession:'chat', selectedProject:'project' };
      window.sendCalls = [];
      window.actionCalls = [];
      window.sendMode = 'pending';
      window.desk = { subscribe: () => () => {}, invoke: async (action) => {
        window.actionCalls.push(action);
        if (action.type === 'listFiles') return ['src/uno.ts', 'src/dos.ts'];
        if (action.type === 'diff') return { repository: false };
        if (action.type === 'dropImages') return action.images.map((image, index) => ({
          id:'drop-'+index, name:image.name, mediaType:'text/plain', size:2 }));
        if (action.type === 'pickImages') return new Promise((resolve, reject) => {
          window.finishPicker = resolve; window.rejectPicker = reject;
        });
        return true;
      }};
      initializeDraftLifetime('browser-test');
      function Fixture() {
        const [drafts, setDrafts] = useTextDrafts();
        const [images, setImages] = useImageDrafts();
        const [visible, setVisible] = useState(true);
        const [grid, setGrid] = useState(false);
        const setDraft = (action) => setDrafts(current => ({...current,
          chat: typeof action === 'function' ? action(current.chat ?? '') : action }));
        const setAttachments = (action) => setImages(current => ({...current,
          chat: typeof action === 'function' ? action(current.chat ?? []) : action }));
        const send = async (text, attachments) => {
          window.sendCalls.push({text, attachments});
          if (window.sendMode === 'throw') throw Error('offline');
          if (window.sendMode === 'false') return false;
          return new Promise(resolve => { window.finishSend = resolve; });
        };
        window.controls = { setDraft, setAttachments, setVisible, setGrid,
          draft: drafts.chat ?? '', images: images.chat ?? [] };
        return <div className="conversation">{visible && (grid ? <Multichat
          state={state} visible disabled={false} open={() => {}} openDev={() => {}}
          actionsFor={() => ({})} dismissed={[]} toggleHidden={() => {}} close={() => {}}
          drafts={drafts} setDrafts={setDrafts} images={images} setImages={setImages} busy={{}}
          run={window.desk.invoke} send={(_session, text, attachments) => send(text, attachments)}
        /> : <Composer session={session} accountName="Prueba" draft={drafts.chat ?? ''}
          setDraft={setDraft} images={images.chat ?? []} setImages={setAttachments}
          run={window.desk.invoke} onSend={send} onLocalCommand={() => false} />)}</div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `,
  },
  write: false,
  bundle: true,
  // This behaviour-only fixture does not render app styles.
  loader: { '.css': 'empty' },
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const html = `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>${outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route('http://drafts.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://drafts.test/');
  const box = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await box.waitFor();

  await page.evaluate(() => {
    window.sendMode = 'throw';
  });
  await box.fill('  Borrador con espacios\nsegunda línea  ');
  await box.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Tu borrador se conserva' }).waitFor();
  assert.equal(await box.inputValue(), '  Borrador con espacios\nsegunda línea  ');

  await page.evaluate(() => {
    window.sendMode = 'pending';
    window.sendCalls = [];
  });
  await box.fill('primer envío');
  await page.evaluate(() =>
    window.controls.setAttachments([
      { id: 'sent', name: 'enviado.txt', size: 2, mediaType: 'text/plain' },
    ]),
  );
  await box.press('Enter');
  await box.press('Enter');
  assert.equal(await page.evaluate(() => window.sendCalls.length), 1);
  assert.equal(await box.inputValue(), 'primer envío');
  await page.evaluate(() => {
    window.controls.setVisible(false);
    window.controls.setDraft('borrador recuperado en otra vista');
    window.controls.setAttachments((current) => [
      ...current,
      { id: 'new', name: 'nuevo.txt', size: 2, mediaType: 'text/plain' },
    ]);
  });
  await page.evaluate(() => window.finishSend(true));
  await page.waitForFunction(() => window.controls.images.length === 1);
  assert.equal(
    await page.evaluate(() => window.controls.draft),
    'borrador recuperado en otra vista',
  );
  assert.deepEqual(await page.evaluate(() => window.controls.images.map((a) => a.id)), ['new']);

  await page.evaluate(() => {
    window.controls.setVisible(true);
    window.controls.setAttachments([]);
  });
  await box.fill('@src/');
  const menu = page.getByRole('listbox');
  await menu.waitFor();
  const before = await page.evaluate(() => window.sendCalls.length);
  await box.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    ),
  );
  assert.equal(await box.inputValue(), '@src/');
  assert.equal(await page.evaluate(() => window.sendCalls.length), before);
  assert.equal(await box.getAttribute('aria-controls'), await menu.getAttribute('id'));
  assert.equal(
    await box.getAttribute('aria-activedescendant'),
    await menu.getByRole('option').first().getAttribute('id'),
  );
  await box.press('Enter');
  assert.equal(await box.inputValue(), '@src/uno.ts ');

  // Quota fallback survives ordinary renders and propagates to another native-window equivalent.
  await page.evaluate(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException('full', 'QuotaExceededError');
    };
  });
  await box.fill('Texto conservado sin espacio en disco');
  await page.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
  assert.equal(await box.inputValue(), 'Texto conservado sin espacio en disco');
  const second = await context.newPage();
  second.on('pageerror', (error) => errors.push(error.message));
  await second.addInitScript(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException('full', 'QuotaExceededError');
    };
  });
  await second.goto('http://drafts.test/');
  const secondBox = second.getByRole('textbox', { name: 'Mensaje', exact: true });
  await secondBox.waitFor();
  await box.fill('Actualización entre ventanas con cuota llena');
  await second.waitForFunction(
    () => window.controls.draft === 'Actualización entre ventanas con cuota llena',
  );
  await secondBox.fill('Respuesta desde la otra ventana');
  await page.waitForFunction(() => window.controls.draft === 'Respuesta desde la otra ventana');
  await second.close();

  // Picking in one view preserves attachments that arrive while the native dialog is open.
  await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).click();
  await page.waitForFunction(() => !!window.finishPicker);
  await page.evaluate(() => {
    window.controls.setAttachments([
      { id: 'incoming', name: 'entrante.txt', mediaType: 'text/plain', size: 2 },
    ]);
    window.finishPicker([{ id: 'picked', name: 'elegido.txt', mediaType: 'text/plain', size: 2 }]);
  });
  await page.waitForFunction(() => window.controls.images.length === 2);
  assert.deepEqual(await page.evaluate(() => window.controls.images.map((a) => a.id)), [
    'incoming',
    'picked',
  ]);

  await page.evaluate(() => {
    window.controls.setAttachments([]);
    window.controls.setGrid(true);
  });
  const gridBox = page.getByRole('textbox', { name: 'Mensaje para Prueba' });
  await gridBox.waitFor();
  await gridBox.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File(['ok'], 'pegado.txt', { type: 'text/plain' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    );
  });
  await page.waitForFunction(() => window.controls.images.some((a) => a.name === 'pegado.txt'));
  await page.locator('.multichat-card').evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['ok'], 'soltado.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await page.waitForFunction(() => window.controls.images.some((a) => a.name === 'soltado.txt'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: send failure, duplicate submit guard, late send across views, IME, suggestions, storage quota, cross-window drafts, concurrent attachments, multichat paste and drop.',
  );
  await context.close();
} finally {
  await browser.close();
}
