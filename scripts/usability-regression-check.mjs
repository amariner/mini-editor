// Isolated UI failures and recovery: no credentials, providers or persistent app data.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {NetworkSettings} from './src/network-settings';
import {CodeBlock} from './src/markdown';
import {ActivityDock} from './src/chat';
window.fixture = { calls: [], mode: 'pending', hidden: false, ticks: 0, clipboardFails: true };
Object.defineProperty(document, 'hidden', {get: () => window.fixture.hidden});
const originalInterval = window.setInterval;
window.setInterval = (callback, delay) => originalInterval(() => {
  window.fixture.ticks++;
  callback();
}, delay);
Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {
  if(window.fixture.clipboardFails) throw Error('denied');
  window.fixture.copied = text;
}}});
const run = async action => {
  window.fixture.calls.push(action);
  if(window.fixture.mode === 'throw') throw Error('No hay conexión con el servicio.');
  if(window.fixture.mode === 'undefined') return undefined;
  if(window.fixture.mode === 'failure') return {ok:false,message:'No se pudo guardar.'};
  if(window.fixture.mode === 'success') return {ok:true,message:'Configuración guardada.'};
  return new Promise(resolve => window.fixture.resolve = resolve);
};
const session = { id:'audit',projectId:'p',profile:'claude',title:'Auditoría',mode:'chat',
  status:'working',approvals:[],messages:[{id:'u',role:'user',text:'Trabajar',at:Date.now()-1000}] };
createRoot(document.getElementById('root')).render(<div className="app">
  <NetworkSettings compatible snapshot={{enabled:true,mode:'manual',protocol:'http',host:'proxy.test',port:8080,username:'test',caFile:'',hasPassword:false,secureStorage:true}} run={run}/>
  <CodeBlock code="const answer = 42;" lang="ts"/>
  <ActivityDock session={session} kind="claude"/>
</div>);
`,
  },
  write: false,
  bundle: true,
  format: 'iife',
  loader: { '.css': 'empty' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  // Password inputs deliberately have no implicit textbox role.
  const secret = page.getByLabel('Contraseña del proxy');
  await secret.fill('test-secret');
  const form = page.locator('form');
  await form.evaluate((element) => {
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(
    await page.evaluate(() => window.fixture.calls.length),
    1,
    'repeated submit saves once',
  );
  assert.equal(await form.getAttribute('aria-busy'), 'true');
  await page.evaluate(() => window.fixture.resolve({ ok: false, message: 'No se pudo guardar.' }));
  await page.getByRole('status').filter({ hasText: 'No se pudo guardar.' }).waitFor();
  assert.equal(await secret.inputValue(), 'test-secret', 'failed saves preserve credentials');
  for (const mode of ['throw', 'undefined']) {
    await page.evaluate((mode) => (window.fixture.mode = mode), mode);
    await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('form').getAttribute('aria-busy') === 'false',
    );
    assert.ok(await form.getByRole('status').innerText());
    assert.equal(await secret.inputValue(), 'test-secret');
  }
  await page.evaluate(() => (window.fixture.mode = 'success'));
  await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[type="password"]').value === '');
  await page.evaluate(() => (window.fixture.mode = 'undefined'));
  await page.getByText('Certificado corporativo', { exact: true }).click();
  await page.getByRole('button', { name: 'Elegir…', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('form').getAttribute('aria-busy') === 'false',
  );
  assert.equal(
    await form.getByRole('status').count(),
    0,
    'cancelling a file picker is not an error',
  );
  await page.getByRole('button', { name: 'Copiar código', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'No se pudo copiar' }).waitFor();
  assert.equal(await page.locator('pre').innerText(), 'const answer = 42;');
  await page.evaluate(() => (window.fixture.clipboardFails = false));
  await page.getByRole('button', { name: 'Copiar código', exact: true }).click();
  await page.getByRole('button', { name: 'Copiado', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.copied), 'const answer = 42;');
  await page.waitForFunction(() => window.fixture.ticks > 0);
  const ticks = await page.evaluate(() => {
    window.fixture.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    return window.fixture.ticks;
  });
  await page.waitForTimeout(1200);
  assert.equal(
    await page.evaluate(() => window.fixture.ticks),
    ticks,
    'hidden windows stop activity timer',
  );
  await page.evaluate(() => {
    window.fixture.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction((ticks) => window.fixture.ticks > ticks, ticks);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: duplicate submissions, local error feedback, password recovery, clipboard failure/retry, hidden activity timers and resume.',
  );
} finally {
  await browser.close();
}
