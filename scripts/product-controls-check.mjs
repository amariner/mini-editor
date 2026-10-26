// Isolated component interactions: no accounts, model calls or application data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Zap } from 'lucide-react';
      import { Popover } from './src/chat-popover';
      import { ChatDetails } from './src/chat-details';
      import { CodexConfigPanel } from './src/config';
      function Fixture() {
        const [view, setView] = useState('menu');
        const [position, setPosition] = useState('bottom');
        const [revision, setRevision] = useState(0);
        const [session, setSession] = useState({
          id: 'fixture', projectId: 'project', title: 'Revisar producto', profile: 'codex',
          status: 'ready', mode: 'chat', approvals: [], messages: [],
          codexConfig: { model: 'default' },
          info: { models: [
            { value: 'gpt-test', displayName: 'GPT Test', supportedEffortLevels: ['low', 'high'] },
            { value: 'gpt-fast-test', displayName: 'GPT Fast Test' },
          ] },
        });
        window.controls = { setView, setPosition, setSession, refresh: () => setRevision((v) => v + 1) };
        const run = async (action) => {
          window.actions.push(action);
          if (action.type === 'configureCodex')
            setSession((value) => ({ ...value, codexConfig: { ...value.codexConfig, ...action.config } }));
          return true;
        };
        return <div className="app" data-revision={revision}>
          <div className="conversation fixture-boundary">
            {view === 'menu' ? <div className="fixture-anchor composer" style={{
              top: position === 'top' ? 16 : 'auto', bottom: position === 'bottom' ? 16 : 'auto',
            }}>
              <Popover label="Sonnet" title="Modelo de prueba" icon={Zap}>
                {(close) => <>
                  <button onClick={close}>Por defecto</button>
                  <button onClick={close}>GPT</button>
                  <button disabled>Modelo desactivado</button>
                  <button onClick={close}>Opus</button>
                  <button className="on" onClick={close}>Sonnet</button>
                </>}
              </Popover>
              <button id="outside">Fuera del menú</button>
            </div> : view === 'details' ?
              <ChatDetails session={session} project="Proyecto" root="/tmp/product-controls" /> :
              <CodexConfigPanel session={session} run={run} close={() => {}} live={false} />}
          </div>
        </div>;
      }
      window.actions = [];
      createRoot(document.getElementById('root')).render(<Fixture />);
    `,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  outdir: '/tmp/agent-desk-product-controls',
  write: false,
});
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  const page = await browser.newPage({ viewport: { width: 700, height: 560 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content:
      (
        await Promise.all(
          ['src/style.css', 'src/chat-polish.css', 'src/chat-details.css'].map((file) =>
            fs.readFile(file, 'utf8'),
          ),
        )
      ).join('\n') +
      `
      .fixture-boundary { position: fixed; inset: 24px; min-width: 0; min-height: 0; }
      .fixture-anchor { position: absolute; left: 12px; display: flex; padding: 0; }
      .fixture-anchor .popover-host { flex: none; }
    `,
  });
  await page.addScriptTag({
    content: fixture.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const trigger = page.getByRole('button', { name: 'Modelo de prueba', exact: true });
  const menu = page.getByRole('dialog', { name: 'Modelo de prueba', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await menu.waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    'Sonnet',
    'opening starts at the current choice',
  );
  assert.equal(await menu.getAttribute('data-placement'), 'top');
  await page.keyboard.press('g');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'GPT');
  await page.keyboard.press('ArrowDown');
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    'Opus',
    'disabled choices are skipped',
  );
  await page.evaluate(() => window.controls.refresh());
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    'Opus',
    'streaming rerenders preserve focus',
  );
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Por defecto');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Sonnet');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  await page.keyboard.press('ArrowDown');
  await menu.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Por defecto');
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('#outside').evaluate((element) => element === document.activeElement),
    true,
  );

  await page.evaluate(() => window.controls.setPosition('top'));
  await trigger.click();
  await menu.waitFor();
  assert.equal(
    await menu.getAttribute('data-placement'),
    'bottom',
    'top controls open into available space',
  );
  const bounds = await menu.boundingBox();
  assert.ok(
    bounds.y >= 24 && bounds.y + bounds.height <= 536,
    'menu fits the conversation vertically',
  );
  await page.setViewportSize({ width: 220, height: 560 });
  await page.waitForFunction(
    () => document.querySelector('.popover').getBoundingClientRect().right <= innerWidth - 8,
  );
  const narrow = await menu.boundingBox();
  assert.ok(
    narrow.x >= 24 && narrow.x + narrow.width <= 196,
    'narrow menu remains inside its conversation',
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 700, height: 560 });

  await page.evaluate(() => window.controls.setView('details'));
  await page.getByRole('button', { name: 'Detalles del chat', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar detalles del chat' }).waitFor();
  assert.equal(await page.locator('.chat-details-status').innerText(), 'Listo');
  await page.evaluate(() =>
    window.controls.setSession((value) => ({
      ...value,
      status: 'working',
      activity: 'Revisando cambios',
      pendingInputs: [
        { id: 'p1', status: 'pending' },
        { id: 'p2', status: 'failed' },
      ],
    })),
  );
  await page.waitForFunction(
    () => document.querySelector('.chat-details-status').textContent === 'Trabajando',
  );
  assert.match(await page.locator('.chat-details-activity').innerText(), /Revisando cambios/);
  assert.match(await page.locator('.chat-details-activity').innerText(), /1 mensaje en cola/);
  assert.match(await page.locator('.chat-details-activity').innerText(), /1 mensaje sin enviar/);
  await page.getByRole('button', { name: 'Cerrar detalles del chat' }).click();
  await page.locator('.chat-details').waitFor({ state: 'detached' });
  assert.equal(
    await page
      .getByRole('button', { name: 'Detalles del chat', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );

  await page.evaluate(() => window.controls.setView('config'));
  const models = page.getByRole('radiogroup', { name: 'Modelo', exact: true });
  await models.getByRole('radio', { checked: true }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.actions.length === 1);
  assert.equal(await models.getByRole('radio', { checked: true }).innerText(), 'GPT Test');
  assert.deepEqual(await page.evaluate(() => window.actions[0]), {
    type: 'configureCodex',
    sessionId: 'fixture',
    config: { model: 'gpt-test', effort: undefined },
  });
  await page.keyboard.press('End');
  await page.waitForFunction(() => window.actions.length === 2);
  assert.equal(await models.getByRole('radio', { checked: true }).innerText(), 'GPT Fast Test');
  await page.keyboard.press('Space');
  assert.equal(
    await page.evaluate(() => window.actions.length),
    2,
    'selecting the current model does not reconfigure the agent',
  );
  assert.equal(await models.locator('[tabindex="0"]').count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: popover focus, typeahead, keyboard, placement, compact bounds; task status/queue and close; model configuration by keyboard.',
  );
} finally {
  await browser?.close();
}
