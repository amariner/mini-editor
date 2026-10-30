// Renderer routing checks in an isolated headless browser; never connects to personal Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-chrome-ui-'));
let browser;
const fixture = `
import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserPanel} from './src/browser-panel';
import './src/style.css';
import './src/browser-polish.css';
const base = {projectId:'p',sessionId:'s',zoom:1,loading:false,canGoBack:false,canGoForward:false};
const internal = {...base,id:'internal',url:'https://local.test/',title:'Página integrada'};
window.fixture = {actions:[],errors:[]};
window.desk = {invoke:async action=>{window.fixture.actions.push(action);}};
function Fixture(){
 const [state,setState] = useState({tabs:[internal],connections:[],downloads:[]});
 const [selected,select] = useState('internal');
 useEffect(()=>{
  window.fixture.update = (patch)=>setState(s=>({...s,...patch}));
  window.desk = {invoke: async action=>{
   window.fixture.actions.push(action);
   if(action.type==='chromeConnect' || action.type==='chromeReconnect'){
    const mode=action.mode||'managed';
    const id='connection-'+mode;
    const connection={id,mode,projectId:'p',sessionId:'s',tabCount:1,status:'connecting'};
    setState(s=>({...s,connections:[connection]}));
    await new Promise(r=>setTimeout(r,30));
    setState(s=>({...s,connections:[{...connection,status:'connected'}],tabs:[internal,{...base,id:'chrome-'+mode,backend:'chrome',connectionId:id,url:'https://example.test/',title:'Página externa'}]}));
   }
   if(action.type==='chromeDisconnect') setState(s=>({...s,tabs:[internal],connections:s.connections.map(c=>({...c,status:'disconnected',tabCount:0}))}));
   if(action.type==='chromeNewTab' || action.type==='browserNew'){
    const tab={...base,id:'new-'+window.fixture.actions.length,url:action.url||'',title:'Nueva página',...(action.type==='chromeNewTab'?{backend:'chrome',connectionId:action.connectionId}:{})};
    setState(s=>({...s,tabs:[...s.tabs,tab]}));
    return tab;
   }
   if(action.type==='browserTab' && action.input.action==='navigate') setState(s=>({...s,tabs:s.tabs.map(t=>t.id===action.tabId?{...t,url:action.input.url}:t)}));
   if(action.type==='browserTab' && action.input.action==='screenshot')return {mimeType:'image/png',image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='};
  }};
 },[]);
 return <div className="app" style={{height:'100vh',background:'var(--card)'}}><BrowserPanel tabs={state.tabs} chromeConnections={state.connections} downloads={state.downloads} selected={selected} select={select} projectId="p" sessionId="s" projects={[{id:'p',name:'Proyecto'}]} blocked={false} close={()=>{}} onError={e=>window.fixture.errors.push(e)} onCaptureSelection={async()=>{}} onCaptureContext={async()=>{}} /></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

try {
  await build({
    stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'tsx' },
    outfile: path.join(temporary, 'fixture.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await fs.writeFile(
    path.join(temporary, 'index.html'),
    '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{margin:0;height:100%}.browser-pane{height:100%;width:100%}.app{--card:#faf9f6;--tile:#eeede9;--line:#d9d8d3;--text:#252522;--text-2:#66665f;--accent:#315ae8;--muted:#88887f;--danger:#c03333;--danger-soft:#fee}</style><div id="root"></div><script src="fixture.js"></script></html>',
  );
  browser = await chromium.launch({
    ...(process.platform === 'darwin'
      ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }
      : {}),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 520, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('file://' + path.join(temporary, 'index.html'));
  await page.waitForFunction(() => !!window.fixture?.update);
  assert.equal(await page.getByRole('region', { name: 'Control de Chrome' }).count(), 0);
  await page.getByRole('button', { name: 'Conexiones de Chrome', exact: true }).click();
  await page.getByRole('region', { name: 'Control de Chrome' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('region', { name: 'Control de Chrome' }).count(), 0);
  assert.equal(
    await page
      .getByRole('button', { name: 'Conexiones de Chrome', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.getByRole('button', { name: 'Conexiones de Chrome', exact: true }).click();
  await page.getByRole('button', { name: 'Preparar mi Chrome', exact: true }).click();
  assert.ok(
    await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'chromeSetup')),
  );
  await page.getByRole('button', { name: 'Abrir Chrome gestionado', exact: true }).click();
  await page.locator('.chrome-page-card').waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.fixture.actions.some(
        (a) => a.type === 'browserPresent' && a.tabId.startsWith('chrome-'),
      ),
    ),
    false,
    'External Chrome tabs must never be mounted as Electron views',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Seleccionar elemento', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Opciones del navegador' }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Zoom del navegador' }).count(), 0);
  assert.equal(
    await page.getByRole('button', { name: 'Suspender pestaña', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Opciones del navegador' }).click();
  await page.getByRole('button', { name: 'Nueva pestaña del navegador' }).click();
  assert.ok(
    await page.evaluate(() =>
      window.fixture.actions.some(
        (a) => a.type === 'chromeNewTab' && a.connectionId === 'connection-managed',
      ),
    ),
  );
  const address = page.getByRole('textbox', { name: 'Dirección web' });
  await address.fill('https://example.test/second');
  await address.press('Enter');
  await page.getByRole('button', { name: 'Capturar vista', exact: true }).click();
  await page.locator('.chrome-page-card img').waitFor();
  await page.getByRole('button', { name: 'Mostrar Chrome', exact: true }).click();
  assert.ok(
    await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'chromeFocus')),
  );
  await page.evaluate(() =>
    window.fixture.update({
      downloads: [
        {
          id: 'd',
          tabId: 'chrome-managed',
          sessionId: 's',
          projectId: 'p',
          fileName: 'export.csv',
          state: 'progress',
          receivedBytes: 10,
          totalBytes: 100,
          startedAt: Date.now(),
          canResume: false,
          canPause: false,
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Cancelar export.csv' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Pausar export.csv' }).count(), 0);
  await page.evaluate(() => window.fixture.update({ downloads: [] }));
  await page.getByRole('button', { name: 'Conexiones de Chrome', exact: true }).click();
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/chrome-connections-panel.png' });
  await page.getByRole('button', { name: 'Desconectar Chrome gestionado' }).click();
  await page.getByRole('button', { name: 'Reconectar', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reconectar', exact: true }).click();
  await page.locator('.chrome-page-card').waitFor();
  await page.getByRole('button', { name: 'Integrado', exact: true }).click();
  await page.getByRole('button', { name: 'Seleccionar elemento', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continuar esta web', exact: true }).click();
  await page.locator('.chrome-page-card').waitFor();
  const handoffs = () =>
    page.evaluate(
      () =>
        window.fixture.actions.filter(
          (a) =>
            a.type === 'chromeNewTab' &&
            a.connectionId === 'connection-managed' &&
            a.url === 'https://local.test/',
        ).length,
    );
  assert.equal(await handoffs(), 1);
  await page.getByRole('button', { name: 'Integrado', exact: true }).click();
  await page.getByRole('button', { name: 'Continuar esta web', exact: true }).click();
  await page.locator('.chrome-page-card').waitFor();
  assert.equal(await handoffs(), 1, 'Reusing the connected tab preserves its state');
  await page.getByRole('button', { name: 'Integrado', exact: true }).click();
  await page.getByRole('button', { name: 'Opciones del navegador' }).click();
  await page.getByRole('combobox', { name: 'Zoom del navegador' }).waitFor();
  await page.setViewportSize({ width: 330, height: 760 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(await page.evaluate(() => window.fixture.errors), []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS Chrome controls: setup, connect, tab routing, native-view isolation, screenshot, focus, download controls, disconnect, reconnect and narrow layout.',
  );
} finally {
  await browser?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
