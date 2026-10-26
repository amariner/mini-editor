// Isolated details drawer transition and reuse checks; no account or provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatDetails, ChatDetailsContent } from './src/chat-details';
      const session = {
        id: 's', projectId: 'p', profile: 'claude-1', title: 'Fixture',
        status: 'working', activity: 'Revisando archivos', approvals: [], messages: [],
        pendingInputs: [{ id: 'next', status: 'pending' }],
      };
      createRoot(document.getElementById('root')).render(
        <div className="app">
          <div className="conversation" style={{ position: 'relative', width: 600, height: 500 }}>
            <ChatDetails session={session} project="Proyecto" root="/tmp/details-fixture" />
          </div>
          <section id="embedded"><ChatDetailsContent session={session} project="Proyecto" /></section>
        </div>
      );
    `,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  outdir: '/tmp/agent-desk-details-motion',
  write: false,
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content: (
      await Promise.all(
        ['src/style.css', 'src/chat-details.css'].map((file) => fs.readFile(file, 'utf8')),
      )
    ).join('\n'),
  });
  await page.addScriptTag({
    content: fixture.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const trigger = page.getByRole('button', { name: 'Detalles del chat', exact: true });
  const panel = page.locator('.chat-details');
  const close = page.getByRole('button', { name: 'Cerrar detalles del chat', exact: true });
  await trigger.click();
  await page.waitForFunction(
    () => document.querySelector('.chat-details')?.dataset.open === 'true',
  );
  assert.equal(await panel.getAttribute('aria-hidden'), 'false');
  assert.equal(await panel.evaluate((element) => element === document.activeElement), true);
  assert.equal(await panel.locator('.chat-details-status').innerText(), 'Trabajando');
  assert.match(await panel.innerText(), /Revisando archivos.*1 mensaje en cola/s);
  assert.equal(
    await panel.evaluate((element) => getComputedStyle(element).transitionDuration),
    '0.18s, 0.18s',
  );

  // Closing removes it from interaction immediately but leaves time for the exit transition.
  await close.evaluate((element) => element.click());
  await page.waitForFunction(
    () => document.querySelector('.chat-details')?.getAttribute('aria-hidden') === 'true',
  );
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.evaluate((element) => element.inert), true);
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  await panel.waitFor({ state: 'detached' });

  // Reopening before the closing timer ends must cancel the old removal.
  await trigger.click();
  await page.waitForFunction(
    () => document.querySelector('.chat-details')?.dataset.open === 'true',
  );
  await page.evaluate(() => {
    document.querySelector('button[aria-label="Cerrar detalles del chat"]').click();
  });
  await trigger.evaluate((element) => element.click());
  await page.waitForFunction(
    () => document.querySelector('.chat-details')?.dataset.open === 'true',
  );
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.chat-details')).opacity === '1',
  );
  assert.equal(await panel.count(), 1);
  await panel.focus();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await panel.waitFor();
  assert.equal(
    await panel.evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
  );
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).transform), 'none');
  await close.click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#embedded .chat-details').count(), 0);
  assert.equal(await page.locator('#embedded .chat-details-content').count(), 1);
  assert.equal(await page.locator('#embedded .chat-details-status').innerText(), 'Trabajando');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: details content reuse, animated entry/exit, inert closing panel, focus restoration, rapid reopen and reduced motion.',
  );
} finally {
  await browser?.close();
}
