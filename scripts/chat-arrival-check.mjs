// Synthetic chat: validates entrance, streaming, restored history and reduced motion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationMessages} from './src/chat';
const initial = {id:'chat',projectId:'project',profile:'claude',title:'Prueba',mode:'chat',
 status:'ready',approvals:[],messages:[{id:'u0',role:'user',text:'Anterior'},
 {id:'a0',role:'assistant',text:'Respuesta ya leída.'}]};
window.sentenceArrivals = 0;
document.addEventListener('animationstart', event => {
 if(event.animationName === 'chat-sentence-arrive') window.sentenceArrivals++;
});
function Fixture(){
 const [session,setSession]=useState(initial);
 const [animate,setAnimate]=useState(true);
 window.fixture={setSession,setAnimate};
 return <div className="app"><div className="conversation">
   <ConversationMessages session={session} kind="claude" animateReplies={animate}/>
 </div></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
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
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<!doctype html><div id="root"></div>');
  await page.addStyleTag({ content: await fs.readFile('src/motion.css', 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByText('Respuesta ya leída.', { exact: true }).waitFor();
  assert.equal(await page.locator('.chat-sentence').count(), 0, 'history is immediate');
  const update = async (text, status = 'working') =>
    page.evaluate(
      ({ text, status }) => {
        window.fixture.setSession((s) => ({
          ...s,
          status,
          messages: [
            ...s.messages.filter((m) => !['u1', 'a1'].includes(m.id)),
            { id: 'u1', role: 'user', text: 'Prepara el resultado' },
            { id: 'a1', role: 'assistant', text },
          ],
        }));
      },
      { text, status },
    );
  await update('La frase todavía');
  await page.waitForTimeout(1400);
  assert.equal(
    await page.locator('.calm-response .md').innerText(),
    '',
    'never show partial phrases',
  );
  await update('La frase todavía está completa. La siguiente');
  await page.waitForFunction(
    () =>
      document.querySelector('.calm-response .md')?.textContent.trim() ===
      'La frase todavía está completa.',
  );
  await page.waitForFunction(() => window.sentenceArrivals === 1);
  const first = await page.locator('.chat-sentence').first().elementHandle();
  assert.equal(
    await first.evaluate((el) => el.getAnimations()[0].effect.getTiming().duration),
    900,
  );
  await page.waitForTimeout(1400);
  assert.equal(
    await page.locator('.calm-response .md').innerText(),
    'La frase todavía está completa.',
  );
  await update('La frase todavía está completa. La siguiente también. Último fragmento');
  await page.waitForFunction(() => window.sentenceArrivals === 2);
  assert.equal(await first.evaluate((el) => el === document.querySelector('.chat-sentence')), true);
  assert.ok(!(await page.locator('.calm-response .md').innerText()).includes('Último'));
  await update('La frase todavía está completa. La siguiente también. Último fragmento', 'ready');
  await page.waitForFunction(() =>
    document.querySelector('.calm-response .md')?.textContent.endsWith('Último fragmento'),
  );
  assert.equal(
    await first.evaluate((el) => el === document.querySelector('.chat-sentence')),
    true,
    'completion keeps the original sentence',
  );
  await page.waitForFunction(() => window.sentenceArrivals === 3);
  assert.equal(await page.locator('.chat-word').count(), 0);
  await page.waitForTimeout(1000);
  assert.equal(await first.evaluate((el) => getComputedStyle(el).opacity), '1');

  await update('Una. Dos. Tres. Cuatro. Cinco.', 'ready');
  await page.getByRole('button', { name: 'Mostrar todo ahora' }).click();
  assert.equal(
    await page.locator('.calm-response .md').innerText(),
    'Una. Dos. Tres. Cuatro. Cinco.',
  );
  await page.evaluate(() => window.fixture.setSession((s) => ({ ...s, id: 'other-chat' })));
  await page.waitForFunction(() => !document.querySelector('.calm-response'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() =>
    window.fixture.setSession((s) => ({
      ...s,
      status: 'working',
      messages: [
        ...s.messages,
        { id: 'u2', role: 'user', text: 'Otra' },
        { id: 'a2', role: 'assistant', text: 'Sin movimiento.' },
      ],
    })),
  );
  await page.waitForFunction(
    () => document.querySelector('.calm-response .md')?.textContent === 'Sin movimiento.',
  );
  assert.equal(
    await page.locator('.chat-sentence').evaluate((el) => getComputedStyle(el).animationName),
    'none',
  );
  await page.evaluate(() =>
    window.fixture.setSession((s) => ({
      ...s,
      status: 'working',
      messages: [
        ...s.messages,
        { id: 'u3', role: 'user', text: 'Flujo continuo' },
        { id: 'a3', role: 'assistant', text: 'Primera frase. Todavía' },
      ],
    })),
  );
  for (let i = 0; i < 36; i++) {
    await page.evaluate(() =>
      window.fixture.setSession((s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === 'a3' ? { ...m, text: m.text + ' más' } : m)),
      })),
    );
    await page.waitForTimeout(45);
  }
  assert.equal(
    await page.locator('.calm-response').last().locator('.md').innerText(),
    'Primera frase.',
    'continuous deltas must not postpone an already complete sentence',
  );
  await page.evaluate(() => window.fixture.setSession((s) => ({ ...s, status: 'ready' })));
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.calm-response .md')].at(-1)?.textContent.includes('Todavía'),
  );
  await page.evaluate(() =>
    window.fixture.setSession((s) => ({
      ...s,
      status: 'working',
      messages: [
        ...s.messages,
        { id: 'u4', role: 'user', text: 'Código' },
        { id: 'a4', role: 'assistant', text: '```ts\nconst value = 1;\n' },
      ],
    })),
  );
  await page.waitForTimeout(1300);
  assert.equal(await page.locator('.calm-response').last().locator('.md').innerText(), '');
  await page.evaluate(() =>
    window.fixture.setSession((s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === 'a4' ? { ...m, text: m.text + '```' } : m)),
    })),
  );
  await page.locator('.calm-response').last().locator('pre').waitFor();
  assert.equal(
    await page.locator('.calm-response').last().locator('code').innerText(),
    'const value = 1;',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: complete phrases only, 1200ms pacing, 900ms fade, stable read text through completion, final tail, immediate reveal, restored history, reduced motion.',
  );
} finally {
  await browser.close();
}
