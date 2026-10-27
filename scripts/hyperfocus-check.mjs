// Full renderer on the running dev server. All data and provider replies are synthetic.
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
  await fs.mkdir('artifacts/hyperfocus', { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 850 },
      colorScheme,
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((protocol) => {
      const state = {
        runtime: { protocol },
        theme: 'system',
        tools: {},
        coordination: [],
        dataDir: '/tmp/hyperfocus-fixture',
        profiles: [{ id: 'codex', kind: 'codex', name: 'Personal' }],
        accounts: { codex: { status: 'signedIn' } },
        defaultProfile: 'codex',
        projects: [{ id: 'p', name: 'Estudio', path: '/tmp/hyperfocus-fixture' }],
        selectedProject: 'p',
        selectedSession: 's',
        browsers: [],
        terminals: [],
        sessions: [
          {
            id: 's',
            projectId: 'p',
            profile: 'codex',
            title: 'Una idea a la vez',
            status: 'ready',
            mode: 'chat',
            account: 'fixture',
            approvals: [],
            codexConfig: { model: 'fixture', effort: 'high' },
            modelsFetchedAt: Date.now(),
            info: {
              models: [{ value: 'fixture', displayName: 'Modelo de prueba' }],
              tools: [],
              commands: [],
              mcpServers: [],
            },
            messages: [
              {
                id: 'old-u',
                role: 'user',
                text: 'Este mensaje anterior no debe verse en hiperfocus.',
              },
              { id: 'old-a', role: 'assistant', text: 'Esta respuesta anterior tampoco.' },
              { id: 'u', role: 'user', text: '¿Y si nos quedamos solo con lo esencial?' },
              {
                id: 'a',
                role: 'assistant',
                text: 'Un espacio tranquilo para pensar. Tu idea, una respuesta y nada más.\n\nEscribe cuando quieras continuar.',
              },
            ],
          },
        ],
      };
      const listeners = new Set();
      const publish = () =>
        listeners.forEach((fn) => fn({ type: 'state', state: structuredClone(state) }));
      window.fixture = { state, publish, actions: [], failSend: false };
      window.desk = {
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        invoke: async (action) => {
          window.fixture.actions.push(action);
          if (action.type === 'snapshot') return structuredClone(state);
          if (action.type === 'diff') return { repository: false };
          if (action.type === 'dropImages')
            return action.images.map((image, i) => ({
              id: 'file-' + i,
              name: image.name,
              mediaType: image.mediaType || 'text/plain',
              size: 12,
            }));
          if (action.type === 'send') {
            if (window.fixture.failSend) throw Error('Sin conexión de prueba');
            const session = state.sessions[0];
            session.messages.push({ id: 'new-u', role: 'user', text: action.text });
            session.status = 'working';
            publish();
            return true;
          }
          return true;
        },
      };
    }, protocol);
    await page.goto(process.env.SOURCE_DEV_URL || 'http://127.0.0.1:5173');
    const enter = page.getByRole('button', { name: 'Entrar en hiperfocus', exact: true });
    const normal = page.getByRole('textbox', { name: 'Mensaje', exact: true });
    await normal.fill('Borrador conservado');
    await page.getByRole('button', { name: 'Panel de trabajo', exact: true }).click();
    await page.locator('.workspace-tools').waitFor();
    await enter.click();
    const focus = page.getByRole('main', { name: 'Hiperfocus' });
    await focus.waitFor();
    const input = focus.getByRole('textbox', { name: 'Mensaje', exact: true });
    assert.equal(await input.inputValue(), 'Borrador conservado');
    assert.equal(await input.evaluate((el) => el === document.activeElement), true);
    assert.equal(
      await page.getByRole('button').count(),
      1,
      'only the return control is accessible',
    );
    assert.equal(await page.locator('.topbar,.sidebar,.workspace-tools,.activity-dock').count(), 0);
    assert.doesNotMatch(
      await page.locator('body').innerText(),
      /Este mensaje anterior|Esta respuesta anterior/,
    );
    assert.match(await focus.innerText(), /Un espacio tranquilo/);
    await input.fill('');
    await input.press('ArrowUp');
    assert.equal(await input.inputValue(), '', 'focus does not recall older messages');
    await input.fill('/');
    assert.equal(await page.getByRole('listbox').count(), 0, 'no command palette in focus');
    await input.fill('');
    const box = await input.boundingBox();
    assert.ok(
      box.y > 250 && box.y < 600,
      'composer sits near the center instead of the bottom edge',
    );
    await page.screenshot({ path: `artifacts/hyperfocus/${colorScheme}.png` });
    const composer = focus.locator('.composer');
    const fixedBox = await composer.boundingBox();
    const assertFixed = async (message) => {
      const bounds = await composer.boundingBox();
      assert.ok(Math.abs(bounds.y - fixedBox.y) < 1, message);
      assert.ok(Math.abs(bounds.x - fixedBox.x) < 1);
    };
    await input.fill('Texto largo\n'.repeat(20));
    await assertFixed('multiline drafting keeps the writing box anchored');
    await input.fill('');
    const originalAnswer = await page.evaluate(
      () => window.fixture.state.sessions[0].messages.at(-1).text,
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.evaluate(() => {
      window.fixture.state.sessions[0].messages.at(-1).text =
        'Una nueva respuesta aparece con calma.';
      window.fixture.publish();
    });
    await page.waitForFunction(() => {
      const turn = document.querySelector('.hyperfocus-turn');
      const opacity = Number(getComputedStyle(turn).opacity);
      return turn.getAnimations().length && opacity > 0 && opacity < 1;
    });
    await assertFixed('fading the old exchange never moves the writing box');
    await page.waitForFunction(() => {
      const turn = document.querySelector('.hyperfocus-turn');
      const opacity = Number(getComputedStyle(turn).opacity);
      return (
        turn.textContent.includes('Una nueva respuesta aparece con calma.') &&
        opacity > 0 &&
        opacity < 1
      );
    });
    await assertFixed('the new exchange fades in without moving the writing box');
    assert.equal(
      await focus.locator('.hyperfocus-turn').count(),
      1,
      'no overlapping copies of the exchange',
    );
    // A rapid update while fading must win; turning reduced motion on settles immediately.
    await page.evaluate(() => {
      window.fixture.state.sessions[0].messages.at(-1).text = 'La versión más reciente.';
      window.fixture.publish();
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await focus.getByText('La versión más reciente.', { exact: true }).waitFor();
    assert.equal(
      await focus.locator('.hyperfocus-turn').evaluate((el) => getComputedStyle(el).opacity),
      '1',
    );
    await page.evaluate((text) => {
      window.fixture.state.sessions[0].messages.at(-1).text = text;
      window.fixture.publish();
    }, originalAnswer);
    await focus.getByText('Escribe cuando quieras continuar.', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Volver al modo normal', exact: true }).click();
    await enter.waitFor();
    await page.locator('.workspace-tools').waitFor();
    assert.equal(await enter.evaluate((el) => el === document.activeElement), true);
    assert.match(await page.locator('#conversation-content').innerText(), /Este mensaje anterior/);
    await enter.click();
    await input.fill('Una línea');
    await input.press('Shift+Enter');
    assert.equal(await input.inputValue(), 'Una línea\n');
    assert.equal(
      await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'send').length),
      0,
    );
    const data = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['Documento de prueba'], 'notas.txt', { type: 'text/plain' }));
      return transfer;
    });
    await focus.dispatchEvent('drop', { dataTransfer: data });
    await focus.getByText('notas.txt', { exact: true }).waitFor();
    await assertFixed('attachments keep the box anchored');
    assert.equal(await page.getByRole('button').count(), 1);
    await input.press('Enter');
    await page.waitForFunction(() => window.fixture.actions.some((a) => a.type === 'send'));
    assert.deepEqual(
      await page.evaluate(
        () => window.fixture.actions.find((a) => a.type === 'send').attachmentIds,
      ),
      ['file-0'],
    );
    await page.evaluate(() => {
      window.fixture.state.sessions[0].messages.push({
        id: 'progress',
        role: 'assistant',
        text: 'Estoy razonando y revisando archivos.',
      });
      window.fixture.publish();
    });
    assert.doesNotMatch(await focus.innerText(), /Estoy razonando|Un espacio tranquilo/);
    await assertFixed('pending turns keep the box anchored');
    const userBeforeAnswer = await focus.locator('.hyperfocus-user').boundingBox();
    assert.equal(
      await page.evaluate(
        () => window.fixture.actions.find((a) => a.type === 'send').responseStyle,
      ),
      'study',
    );
    const loading = focus.getByRole('status', { name: 'Preparando respuesta', exact: true });
    await loading.waitFor();
    assert.equal(
      await loading.locator('i').evaluate((el) => getComputedStyle(el).animationName),
      'none',
      'reduced motion keeps the loading mark still',
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.hyperfocus-loading > i')).animationName ===
        'hyperfocus-breath',
    );
    const loadingBox = await loading.boundingBox();
    assert.ok(loadingBox.width <= 20 && loadingBox.height <= 4, 'loading stays tiny');
    await assertFixed('loading never shifts the composer');
    await page.screenshot({ path: `artifacts/hyperfocus/loading-${colorScheme}.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.evaluate(() => {
      const session = window.fixture.state.sessions[0];
      session.messages.push({ id: 'tool', role: 'tool', text: 'Salida interna' });
      session.messages.push({
        id: 'final',
        role: 'assistant',
        text: 'Respuesta **final**, sin distracciones.',
      });
      session.status = 'ready';
      window.fixture.publish();
    });
    await focus.getByText('Respuesta final, sin distracciones.', { exact: true }).waitFor();
    await assertFixed('completed turns keep the box anchored');
    const userAfterAnswer = await focus.locator('.hyperfocus-user').boundingBox();
    assert.ok(
      Math.abs(userBeforeAnswer.y - userAfterAnswer.y) < 1,
      'user phrase stays anchored when the answer arrives',
    );
    assert.equal(
      await focus
        .locator('.hyperfocus-answer strong')
        .evaluate((el) => getComputedStyle(el).textDecorationLine),
      'underline',
    );
    assert.equal(await loading.count(), 0, 'loading ends when the answer is ready');
    assert.doesNotMatch(await focus.innerText(), /Estoy razonando|Salida interna/);
    await page.evaluate(() => {
      const s = window.fixture.state.sessions[0];
      s.approvals = [
        {
          id: 'permission',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'echo prueba' },
        },
      ];
      s.status = 'waiting';
      window.fixture.publish();
    });
    await page
      .getByRole('button', { name: 'Volver al modo normal' })
      .getByText('Revisar solicitud')
      .waitFor();
    assert.equal(await page.getByRole('button').count(), 1);
    assert.equal(await loading.count(), 0, 'an approval is not presented as ongoing generation');
    await input.press('Escape');
    await page.getByRole('region', { name: 'Solicitud de Codex' }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        window.fixture.actions.some((a) => a.type === 'interrupt' || a.type === 'approve'),
      ),
      false,
    );
    await page.evaluate(() => {
      const s = window.fixture.state.sessions[0];
      s.approvals = [];
      s.status = 'ready';
      window.fixture.publish();
    });
    await enter.click();
    await page.evaluate(() => {
      window.fixture.failSend = true;
    });
    await input.fill('No pierdas este borrador');
    await input.press('Enter');
    await focus.getByText('No se pudo enviar. Tu borrador se conserva.', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), 'No pierdas este borrador');
    await page.evaluate(() => {
      window.fixture.failSend = false;
      const s = window.fixture.state.sessions[0];
      s.messages.at(-1).text =
        Array.from(
          { length: 50 },
          (_, i) =>
            'Párrafo ' + i + ': ' + 'Una respuesta extensa sigue siendo legible. '.repeat(6),
        ).join('\n\n') +
        '\n\n```js\n' +
        'const ejemplo = true;\n'.repeat(60) +
        '```';
      window.fixture.publish();
    });
    await page.setViewportSize({ width: 480, height: 520 });
    const reader = focus.getByRole('region', { name: 'Última respuesta', exact: true });
    await page.waitForFunction(
      () => document.querySelector('.hyperfocus-answer')?.dataset.below === 'true',
    );
    const reading = await reader.evaluate((el) => ({
      height: el.clientHeight,
      line: Number.parseFloat(getComputedStyle(el).lineHeight),
      scroll: el.scrollTop,
    }));
    assert.ok(
      reading.height <= reading.line * 3 + 21,
      'the answer shows at most three lines, independently of its full length',
    );
    assert.equal(reading.scroll, 0, 'new answers start at the beginning');
    assert.equal(await reader.getAttribute('data-above'), 'false', 'the first line stays readable');
    await page.screenshot({ path: `artifacts/hyperfocus/reading-${colorScheme}.png` });
    await reader.evaluate((el) => {
      el.scrollTop = el.clientHeight / 2;
    });
    await page.waitForFunction(
      () => document.querySelector('.hyperfocus-answer')?.dataset.above === 'true',
    );
    assert.equal(await reader.getAttribute('data-below'), 'true');
    await reader.focus();
    await reader.press('End');
    await page.waitForFunction(
      () => document.querySelector('.hyperfocus-answer')?.dataset.below === 'false',
    );
    assert.match(
      await reader.innerText(),
      /Párrafo 49/,
      'the complete answer stays available by scrolling',
    );

    assert.equal(await page.getByRole('button').count(), 1, 'long code has no extra controls');
    const geometry = await input.boundingBox();
    assert.ok(
      geometry.x >= 0 && geometry.x + geometry.width <= 480 && geometry.y + geometry.height <= 520,
    );
    assert.ok(await reader.evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `artifacts/hyperfocus/compact-${colorScheme}.png` });
    await input.press('Escape');
    assert.equal(await normal.inputValue(), 'No pierdas este borrador');
    await page.evaluate(() => {
      window.fixture.state.sessions[0].messages = [];
      window.fixture.publish();
    });
    await enter.click();
    assert.equal(await focus.locator('.hyperfocus-messages:visible').count(), 0);
    assert.equal(await page.getByRole('button').count(), 1);
    await input.fill('');
    assert.ok(
      Math.abs((await composer.boundingBox()).y - 520 * 0.6) < 1,
      'empty chats use the same anchor as long answers',
    );
    const emptyBox = await input.boundingBox();
    assert.ok(emptyBox.y > 150 && emptyBox.y < 350, 'empty chat keeps the input near the center');
    await page.screenshot({ path: `artifacts/hyperfocus/empty-${colorScheme}.png` });
    assert.equal(
      await page.evaluate(() =>
        window.fixture.actions.some((a) =>
          ['configureCodex', 'configure', 'configureProvider', 'configureOptimization'].includes(
            a.type,
          ),
        ),
      ),
      false,
      'entering focus never changes the selected model or permissions',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: limited reading window, scroll edge fades, subtle loading/ready/approval states, fixed composer, soft exit/entrance, rapid replacement, reduced motion, hyperfocus entry/exit, last pair only, hidden reasoning/tools, preserved history/drafts, keyboard, drag attachments, permissions, send errors and long/compact layouts in both themes.',
  );
} finally {
  await browser.close();
}
