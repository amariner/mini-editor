// Full renderer against the running dev server, with synthetic state and no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
});
try {
  await fs.mkdir('artifacts/chat-calm', { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 850 },
      colorScheme,
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ protocol }) => {
        const code = Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`).join('\n');
        const long =
          'Los cambios están listos. El formulario conserva los datos y explica qué falta antes de continuar.\n\n' +
          Array.from(
            { length: 8 },
            (_, i) =>
              `Detalle ${i + 1}: Se ha comprobado la navegación por teclado, el guardado y la recuperación después de un error. Las acciones siguen disponibles sin recargar la conversación de controles.`,
          ).join('\n\n') +
          '\n\n```ts\n' +
          code +
          '\n```';
        const state = {
          runtime: { protocol },
          profiles: [{ id: 'claude-1', kind: 'claude', name: 'Personal' }],
          defaultProfile: 'claude-1',
          accounts: { 'claude-1': { status: 'signedIn', label: 'Cuenta de prueba' } },
          tools: {},
          coordination: [],
          dataDir: '/tmp/calm-fixture',
          projects: [{ id: 'p', name: 'Estudio', path: '/tmp/calm-fixture' }],
          selectedProject: 'p',
          selectedSession: 's0',
          theme: 'system',
          sessions: [
            {
              id: 's0',
              projectId: 'p',
              profile: 'claude-1',
              title: 'Una conversación más tranquila',
              mode: 'chat',
              status: 'ready',
              approvals: [],
              messages: [
                { id: 'u0', role: 'user', text: 'Revisa el formulario.' },
                { id: 'a0', role: 'assistant', text: 'El formulario permite guardar los datos.' },
                {
                  id: 'u1',
                  role: 'user',
                  text: 'Hazlo más fácil de usar y comprueba todos los detalles.',
                },
                { id: 'a1', role: 'assistant', text: long },
              ],
            },
            {
              id: 's1',
              projectId: 'p',
              profile: 'claude-1',
              title: 'Revisión en curso',
              mode: 'chat',
              status: 'working',
              approvals: [],
              messages: [
                { id: 'u2', role: 'user', text: 'Comprueba los espacios.' },
                { id: 'a2', role: 'assistant', text: 'Primero reviso el formulario.' },
                {
                  id: 't',
                  role: 'tool',
                  text: 'Leído',
                  tool: { kind: 'read', status: 'completed', path: 'form.tsx' },
                },
                { id: 'a3', role: 'assistant', text: 'Estoy comprobando el espaciado y el foco.' },
              ],
            },
          ],
        };
        const listeners = new Set();
        window.fixture = {
          state,
          code,
          long,
          actions: [],
          publish: () =>
            listeners.forEach((fn) => fn({ type: 'state', state: structuredClone(state) })),
        };
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async (text) => {
              window.fixture.copied = text;
            },
          },
        });
        window.desk = {
          subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          invoke: async (action) => {
            window.fixture.actions.push(action);
            if (action.type === 'snapshot') return structuredClone(state);
            if (action.type === 'diff') return { repository: false };
            if (action.type === 'select') {
              state.selectedProject = action.projectId;
              state.selectedSession = action.sessionId;
            }
            window.fixture.publish();
            return true;
          },
        };
      },
      { protocol },
    );
    await page.goto(process.env.SOURCE_DEV_URL || 'http://127.0.0.1:5173');
    const chat = page.locator('#conversation-content');
    await chat.getByRole('button', { name: 'Ver respuesta completa', exact: true }).waitFor();
    assert.equal(
      await chat
        .locator('.md')
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
      '15px',
    );
    const contrasts = await page.evaluate(() => {
      const luminance = (color) => {
        const rgb = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const background = luminance(getComputedStyle(document.body).backgroundColor);
      return ['#conversation-content .md', '.response-expand'].map((selector) => {
        const foreground = luminance(getComputedStyle(document.querySelector(selector)).color);
        return (
          (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
        );
      });
    });
    assert.ok(
      contrasts.every((value) => value >= 4.5),
      'primary and secondary text retain readable contrast',
    );
    await page.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).isVisible(),
      true,
    );
    await page.getByRole('button', { name: 'Ocultar herramientas', exact: true }).click();
    assert.equal(await chat.getByRole('button', { name: 'Copiar código', exact: true }).count(), 0);
    await page.screenshot({ path: `artifacts/chat-calm/chat-${colorScheme}.png` });
    const last = chat.locator('.response-group').last();
    await last.hover();
    await last.getByRole('button', { name: 'Copiar respuesta', exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.fixture.copied === window.fixture.long),
      true,
      'copy keeps the full response',
    );
    await last.getByRole('button', { name: 'Ver respuesta completa', exact: true }).click();
    const code = last.locator('.md-code');
    assert.equal((await code.locator('pre').innerText()).includes('value59'), false);
    await code.hover();
    await code.getByRole('button', { name: 'Copiar código', exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.fixture.copied === window.fixture.code),
      true,
      'copy keeps all code lines',
    );
    await code.getByRole('button', { name: /Mostrar código completo/ }).click();
    assert.match(await code.locator('pre').innerText(), /value59/);
    await code.getByRole('button', { name: 'Mostrar menos código', exact: true }).click();
    await last.getByRole('button', { name: 'Mostrar menos', exact: true }).click();
    await page.setViewportSize({ width: 560, height: 720 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: `artifacts/chat-calm/compact-${colorScheme}.png` });
    await page.setViewportSize({ width: 1200, height: 850 });
    await page.getByRole('button', { name: 'Multichat', exact: true }).click();
    const card = page.locator('.multichat-card[data-session-id="s0"]');
    assert.equal(await card.locator('.response-group').count(), 1);
    assert.equal(
      await card.getByText('El formulario permite guardar los datos.', { exact: true }).count(),
      0,
    );
    await card.getByRole('button', { name: 'Ver mensajes anteriores', exact: true }).click();
    assert.equal(await card.locator('.response-group').count(), 2);
    await page.screenshot({ path: `artifacts/chat-calm/grid-${colorScheme}.png` });
    const active = page.locator('.multichat-card[data-session-id="s1"]');
    assert.equal(await active.locator('.progress-message').count(), 1);
    await active.getByRole('button', { name: 'Ver progreso', exact: true }).click();
    assert.match(
      await active.locator('.activity-log').innerText(),
      /Primero reviso/,
      'earlier narration remains in activity',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: warm light/dark, 15px chat, direct attachment, full-response and code disclosures, intact clipboard, compact viewport, latest-result cards, history and activity access.',
  );
} finally {
  await browser.close();
}
