// Real composer with delayed synthetic catalog/configuration responses; no inference.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {Composer} from './src/chat';
      function Fixture() {
        const [session, setSession] = useState({id:'s', projectId:'p', profile:'codex', status:'ready',
          title:'Modelos', mode:'chat', approvals:[], messages:[],
          codexConfig:{model:'one', effort:'high'},
          info:{models:[{value:'one', displayName:'Modelo Uno', supportedEffortLevels:['low','high']},
            {value:'two', displayName:'Modelo Dos', supportedEffortLevels:['low','high']}]}});
        const [draft, setDraft] = useState('');
        const [images, setImages] = useState([]);
        const run = async action => {
          window.actions.push(action);
          if (['configureCodex','configureProvider'].includes(action.type)) return new Promise(resolve => {
            window.finishModel = ok => {
              if(ok) setSession(s => ({...s, [action.type === 'configureCodex' ? 'codexConfig' : 'providerConfig']:action.config}));
              resolve(ok);
            };
          });
          return true;
        };
        window.controls = {setSession, setDraft};
        return <div className="app"><div className="conversation"><div className="desk-input">
          <Composer session={session} accountName="Prueba" draft={draft} setDraft={setDraft}
            images={images} setImages={setImages} run={run} onSend={async()=>{window.sent++;return true;}} onLocalCommand={()=>false}/>
        </div></div></div>;
      }
      window.actions = [];
      window.sent = 0;
      window.desk = {invoke:async()=>[], subscribe:()=>()=>{}};
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  loader: { '.css': 'empty' },
});
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 650 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content:
      (
        await Promise.all(
          ['src/style.css', 'src/chat-polish.css', 'src/composer-dock.css'].map((p) =>
            fs.readFile(p, 'utf8'),
          ),
        )
      ).join('\n') +
      `
    .conversation {position:fixed;inset:24px;min-width:0;}
    .desk-input {position:absolute;bottom:8px;width:100%;}
  `,
  });
  await page.addScriptTag({ content: fixture.outputFiles[0].text });
  const trigger = page.getByRole('button', { name: 'Modelo de Codex', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Modelo de Codex', exact: true });
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Modelo Uno');
  await page.keyboard.press('ArrowRight');
  let side = page.getByRole('dialog', { name: 'Intensidad · Modelo Uno' });
  await side.waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    'High',
    'focus the existing intensity',
  );
  await page.keyboard.press('ArrowLeft');
  await side.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Modelo Uno');
  await menu.getByRole('button', { name: 'Modelo Dos', exact: true }).click();
  side = page.getByRole('dialog', { name: 'Intensidad · Modelo Dos' });
  await side.getByRole('button', { name: 'Volver a modelos' }).click();
  assert.equal(await side.count(), 0);
  await menu.getByRole('button', { name: 'Modelo Dos', exact: true }).click();
  await side.getByRole('button', { name: 'High', exact: true }).evaluate((el) => {
    el.click();
    el.click();
  });
  assert.equal(
    await page.evaluate(() => window.actions.filter((a) => a.type === 'configureCodex').length),
    1,
    'one configuration while pending',
  );
  assert.equal(await side.getByRole('button', { name: 'High', exact: true }).isDisabled(), true);
  const draft = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await page.evaluate(() => window.controls.setDraft('Conserva el modelo elegido'));
  assert.equal(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled(), true);
  await draft.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
  assert.equal(
    await page.evaluate(() => window.sent),
    0,
    'wait for the chosen model before sending',
  );
  await side.getByRole('button', { name: 'Volver a modelos' }).focus();
  await page.evaluate(() => window.finishModel(false));
  await page.waitForFunction(
    () => !document.querySelector('.popover-side button:last-child').disabled,
  );
  assert.equal(await side.isVisible(), true, 'failed model change keeps options available');
  await side.getByRole('button', { name: 'High', exact: true }).click();
  await page.evaluate(() => window.finishModel(true));
  await menu.waitFor({ state: 'detached' });
  assert.match(await trigger.innerText(), /Modelo Dos/);
  await trigger.click();
  const before = await menu.boundingBox();
  await page.evaluate(() =>
    window.controls.setSession((s) => ({
      ...s,
      info: {
        models: Array.from({ length: 30 }, (_, i) => ({
          value: 'm' + i,
          displayName: 'Catálogo ' + i,
        })),
      },
    })),
  );
  await page.waitForFunction(
    (height) => document.querySelector('.popover').getBoundingClientRect().height > height + 20,
    before.height,
  );
  const after = await menu.boundingBox();
  assert.ok(
    after.y >= 24 && after.y + after.height <= 626,
    'loaded catalog stays within its conversation',
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    window.controls.setSession((s) => ({
      ...s,
      profile: 'openrouter-1',
      providerConfig: { model: 'two' },
      info: {
        models: [
          { value: 'one', displayName: 'Modelo Uno' },
          { value: 'two', displayName: 'Modelo Dos' },
        ],
      },
    })),
  );
  await page.getByRole('button', { name: 'Modelo', exact: true }).click();
  const providerMenu = page.getByRole('dialog', { name: 'Modelo', exact: true });
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    'Modelo Dos',
    'connected providers focus the selected model',
  );
  await providerMenu.getByRole('button', { name: 'Modelo Uno', exact: true }).click();
  await page.evaluate(() => window.finishModel(false));
  assert.equal(await providerMenu.isVisible(), true, 'provider failures do not dismiss the menu');
  await providerMenu.getByRole('button', { name: 'Modelo Uno', exact: true }).click();
  await page.evaluate(() => window.finishModel(true));
  await providerMenu.waitFor({ state: 'detached' });
  assert.match(
    await page.getByRole('button', { name: 'Modelo', exact: true }).innerText(),
    /Modelo Uno/,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: model/intensity keyboard, selected provider model, delayed catalog sizing, duplicate changes, failure/retry and successful commit.',
  );
} finally {
  await browser.close();
}
