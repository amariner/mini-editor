// Renderer-only supervision fixture: sixteen chats, no accounts or provider processes.
import { chromium } from 'playwright';
import { preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const card0Dismiss = (page) =>
  page
    .locator('[data-session-id="s0"]')
    .getByRole('button', { name: 'Retirar Tarea 1 del grid', exact: true })
    .isDisabled();
const card0Key = (page) => page.locator('[data-session-id="s0"] .multichat-key').innerText();
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const state = {
      profiles: [{ id: 'claude-1', kind: 'claude', name: 'Personal' }],
      accounts: {},
      devServers: [
        { projectId: 'p0', sessionId: 's0', url: 'http://localhost:3000/', port: 3000 },
        { projectId: 'p0', sessionId: 's0', url: 'http://localhost:5173/', port: 5173 },
        { projectId: 'p1', sessionId: 's4', url: 'http://localhost:4000/', port: 4000 },
      ],
      projects: Array.from({ length: 4 }, (_, i) => ({
        id: `p${i}`,
        name: `Proyecto ${i + 1}`,
        path: `/tmp/grid-${i}`,
      })),
      sessions: Array.from({ length: 16 }, (_, i) => ({
        id: `s${i}`,
        projectId: `p${Math.floor(i / 4)}`,
        profile: 'claude-1',
        mode: 'chat',
        title: `Tarea ${i + 1}`,
        status: 'working',
        approvals: [],
        messages: [
          { id: `u${i}`, role: 'user', text: `Petición ${i + 1}` },
          {
            id: `a${i}`,
            role: 'assistant',
            text: `Respuesta ${i + 1}\n${'Detalle del trabajo en curso.\n'.repeat(20)}`,
          },
        ],
      })),
      selectedSession: 's0',
      selectedProject: 'p0',
      runtime: { protocol: 31 },
      tools: {},
      coordination: [],
    };
    state.accounts['claude-1'] = { status: 'signedIn', label: 'ana@example.test', plan: 'Pro' };
    state.profiles.push({ id: 'claude-2', kind: 'claude', name: 'Trabajo' });
    state.accounts['claude-2'] = { status: 'signedIn', label: 'bruno@example.test', plan: 'Max' };
    state.sessions[4].profile = 'claude-2';
    state.sessions[4].account = 'bruno@example.test · Max';
    state.sessions[0].info = {
      model: 'fixture-sonnet',
      models: [{ value: 'fixture-sonnet', displayName: 'Sonnet fixture' }],
      commands: [],
      tools: [],
      mcpServers: [],
      skills: [],
      plugins: [],
      agents: [],
      outputStyles: [],
    };
    state.sessions[0].activity = 'Pensando…';
    state.sessions[0].messages[1].blocks = [
      {
        type: 'tool_use',
        id: 'read-live',
        name: 'Read',
        input: { file_path: '/tmp/grid-0/src/main.tsx' },
        done: false,
      },
    ];
    state.sessions[0].messages[1].blocks.unshift({
      type: 'text',
      text: state.sessions[0].messages[1].text,
      final: true,
    });
    state.sessions[2].messages.push({
      id: 'command-live',
      role: 'tool',
      text: '',
      tool: { kind: 'command', status: 'inProgress', command: 'npm run build' },
    });
    state.sessions[1].status = 'waiting';
    state.sessions[1].approvals = [
      {
        id: 'approval',
        method: 'provider/read-external',
        params: {},
        input: { path: '/tmp/fixture.txt', directory: '/tmp' },
        title: 'Permiso',
      },
    ];
    // Chats finished before a reload stay finished, like sessions restored from disk.
    for (const id of JSON.parse(sessionStorage.getItem('fixture-ready') ?? '[]'))
      state.sessions.find((s) => s.id === id).status = 'ready';
    const listeners = new Set();
    window.fixture = {
      state,
      actions: [],
      publish() {
        for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
      },
    };
    window.desk = {
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async invoke(a) {
        window.fixture.actions.push(a);
        if (a.type === 'snapshot') return structuredClone(state);
        if (a.type === 'select') {
          state.selectedProject = a.projectId;
          state.selectedSession =
            a.sessionId ?? state.sessions.filter((s) => s.projectId === a.projectId).at(-1)?.id;
          return true;
        }
        if (a.type === 'rename') {
          state.sessions.find((s) => s.id === a.sessionId).title = a.title;
          return true;
        }
        if (a.type === 'setAccountColor') {
          const profile = state.profiles.find((p) => p.id === a.profile);
          if (a.color === null) delete profile.color;
          else profile.color = a.color;
          return true;
        }
        if (a.type === 'send') {
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (a.text === 'fallo simulado') throw new Error('Fallo de envío simulado');
          const session = state.sessions.find((s) => s.id === a.sessionId);
          session.messages.push({
            id: `new-${session.messages.length}`,
            role: 'user',
            text: a.text,
          });
          session.messages.push({
            id: `new-${session.messages.length}`,
            role: 'assistant',
            text: `Respuesta a: ${a.text}`,
          });
          session.status = 'ready';
          return true;
        }
        if (a.type === 'pickImages')
          return [{ id: `file-${a.sessionId}`, name: 'nota.txt', kind: 'file' }];
        if (a.type === 'approve') {
          state.sessions.find((s) => s.id === a.sessionId).approvals = [];
          return true;
        }
        if (a.type === 'interrupt') {
          state.sessions.find((s) => s.id === a.sessionId).status = 'ready';
          return true;
        }
        if (a.type === 'diff')
          return {
            repository: true,
            branch: 'main',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
            branches: ['main'],
            files: [],
            counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
            status: '',
            staged: '',
            unstaged: '',
            lines: { added: 0, removed: 0 },
            commits: [],
          };
        if (a.type === 'listFiles') return [];
        return true;
      },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  const grid = page.locator('.multichat');
  const toolbar = page.locator('.topbar .multichat-toolbar');
  const layoutButton = page.getByRole('button', { name: 'Distribución del grid', exact: true });
  const setLayout = async (columns, rows) => {
    await layoutButton.click();
    await page
      .getByRole('button', {
        name: `${columns} ${columns === 1 ? 'columna' : 'columnas'} × ${rows} ${rows === 1 ? 'fila' : 'filas'}`,
        exact: true,
      })
      .click();
  };
  await page.waitForFunction(() => document.querySelectorAll('.multichat-card').length === 16);
  assert.equal(await grid.locator('.multichat-card.attention').count(), 1);
  const activityCard = grid.locator('[data-session-id="s0"]');
  assert.equal(await activityCard.locator('.multichat-account').innerText(), 'Personal');
  assert.equal(
    await grid.locator('[data-session-id="s4"] .multichat-account').innerText(),
    'Trabajo',
  );
  assert.equal(await grid.getByText(/ana@example.test|bruno@example.test|Modelo:/).count(), 0);
  await page.waitForFunction(() =>
    document.querySelector('[data-session-id="s0"] .multichat-git')?.textContent.includes('main'),
  );
  const info = await activityCard.locator('.multichat-info-line').innerText();
  assert.match(info, /Personal[\s\S]*Proyecto 1[\s\S]*main[\s\S]*↑1/);
  // A clean, synced branch shows no zero counters.
  assert.doesNotMatch(info, /Sin cambios|↓0|\+0|−0|archivos/);
  assert.equal(await toolbar.isVisible(), true);
  assert.equal(await grid.locator('.multichat-toolbar').count(), 0);
  assert.match(await toolbar.innerText(), /16 chats[\s\S]*15 trabajando[\s\S]*1 requiere atención/);
  assert.match(await layoutButton.innerText(), /Auto\s*4 × 4/);
  assert.equal(await grid.locator('.multichat-card.attention .multichat-approvals').count(), 1);
  assert.equal(await card0Dismiss(page), true, 'a working chat cannot be retired from the grid');
  assert.equal(await activityCard.locator('.multichat-server').count(), 2);
  assert.equal(await grid.locator('[data-session-id="s4"] .multichat-server').count(), 1);
  assert.equal(await grid.locator('[data-session-id="s3"] .multichat-server').count(), 0);
  assert.equal(
    await activityCard.evaluate((el) => {
      const worlds = el.querySelectorAll('.multichat-server');
      const expand = el.querySelector('.multichat-expand');
      return [...worlds].every(
        (world) => !!(world.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
    }),
    true,
  );
  assert.equal(
    await activityCard.evaluate((el) => {
      const info = el.querySelector('.multichat-info-line').getBoundingClientRect();
      const activity = el.querySelector('.compact-activity').getBoundingClientRect();
      const messages = el.querySelector('.multichat-preview').getBoundingClientRect();
      return info.bottom <= activity.top && activity.bottom <= messages.top;
    }),
    true,
  );
  assert.match(
    await activityCard.locator('.activity-current-text').innerText(),
    /Leyendo src\/main.tsx/,
  );
  assert.match(await activityCard.locator('.activity-count').innerText(), /1 paso/);
  assert.equal(await grid.locator('.activity-esc').count(), 0);
  await activityCard.getByRole('button', { name: 'Ver progreso', exact: true }).click();
  await activityCard.locator('.activity-log').waitFor();
  assert.match(await activityCard.locator('.activity-log').innerText(), /src\/main.tsx/);
  await activityCard.getByRole('button', { name: 'Ver progreso', exact: true }).click();
  assert.match(
    await grid.locator('[data-session-id="s2"] .activity-current-text').innerText(),
    /Ejecutando npm run build/,
  );
  const order = await grid.locator('.multichat-title strong').allTextContents();
  const columns = () =>
    page
      .locator('.multichat-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  await toolbar.getByRole('button', { name: '1 requiere atención', exact: true }).click();
  assert.equal(
    await page.evaluate(() => document.activeElement.closest('.multichat-card')?.dataset.sessionId),
    's1',
  );
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await grid.locator('.multichat-key').first().waitFor();
  assert.match(await card0Key(page), /^(⌘|Ctrl\+)1$/);
  await page.screenshot({ path: 'artifacts/multichat-shortcuts.png' });
  await page.keyboard.up(modifier);
  await grid.locator('.multichat-key').first().waitFor({ state: 'hidden' });
  await page.keyboard.press('ControlOrMeta+3');
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
    'Mensaje para Tarea 3',
  );
  await setLayout(4, 4);
  assert.match(await layoutButton.innerText(), /^4 × 4/);
  await layoutButton.click();
  await page.getByRole('button', { name: '3 columnas × 2 filas', exact: true }).hover();
  await page.screenshot({ path: 'artifacts/multichat-layout-menu.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Automática' }).waitFor({ state: 'detached' });
  assert.match(await layoutButton.innerText(), /^4 × 4/);
  await page.getByRole('button', { name: 'Proyecto 2', exact: true }).click();
  await grid.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), 's7');
  assert.equal(
    await page
      .locator('.session-tab.selected')
      .innerText()
      .then((s) => s.trim()),
    'Tarea 8',
  );
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  await page.getByRole('button', { name: 'Proyecto 2', exact: true }).click();
  await grid.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  assert.equal(await columns(), 4);
  assert.ok(
    await grid
      .locator('.multichat-card')
      .evaluateAll((els) => els.every((e) => e.getBoundingClientRect().bottom <= innerHeight)),
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/multichat-16-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/multichat-16-dark.png' });
  await page.evaluate(() => {
    window.fixture.state.sessions[0].messages[1].blocks.find((b) => b.type === 'tool_use').done =
      true;
    window.fixture.publish();
  });
  await page.waitForFunction(() =>
    document
      .querySelector('[data-session-id="s0"] .activity-current-text')
      .textContent.includes('Último paso: Leyó src/main.tsx'),
  );
  await page.evaluate(() => {
    const s = window.fixture.state.sessions[15];
    s.status = 'stopped';
    s.messages[1].text = 'Resultado terminado y conservado';
    window.fixture.publish();
  });
  await grid.getByText('Resultado terminado y conservado', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.fixture.state.sessions[0].messages[1].blocks.find((b) => b.type === 'text').text +=
      '\nTexto nuevo en directo';
    window.fixture.publish();
  });
  await grid.getByText('Texto nuevo en directo', { exact: false }).waitFor();
  assert.deepEqual(await grid.locator('.multichat-title strong').allTextContents(), order);
  await page.getByRole('button', { name: 'Ampliar Tarea 16', exact: true }).click();
  await page.getByRole('button', { name: 'Volver al grid' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.state.selectedProject), 'p3');
  await page.locator('.composer textarea').fill('Borrador conservado desde Multichat');
  await page.keyboard.press('Escape');
  await grid.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.actions.filter((a) => a.type === 'interrupt' || a.type === 'stop').length,
    ),
    0,
  );
  await page.getByRole('button', { name: 'Ampliar Tarea 16', exact: true }).click();
  assert.equal(
    await page.locator('.composer textarea').inputValue(),
    'Borrador conservado desde Multichat',
  );
  await page.getByRole('button', { name: 'Volver al grid' }).click();
  await grid.getByRole('button', { name: 'Retirar Tarea 16 del grid', exact: true }).click();
  assert.equal(await grid.locator('.multichat-card').count(), 15);
  await page.evaluate(() => {
    window.fixture.state.sessions[15].status = 'working';
    window.fixture.publish();
  });
  await page.waitForFunction(() => document.querySelectorAll('.multichat-card').length === 16);
  const height4 = await grid
    .locator('.multichat-card')
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  await setLayout(2, 2);
  assert.equal(await columns(), 2);
  assert.ok(
    (await grid
      .locator('.multichat-card')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height)) >
      height4 * 1.7,
  );
  await page.setViewportSize({ width: 900, height: 800 });
  assert.equal(await columns(), 2);
  await setLayout(4, 2);
  assert.equal(await columns(), 4);
  assert.ok(
    await grid.locator('.multichat-scroll').evaluate((el) => el.scrollWidth > el.clientWidth),
  );
  await page.screenshot({ path: 'artifacts/multichat-narrow.png' });
  await page.setViewportSize({ width: 600, height: 800 });
  await setLayout(1, 2);
  assert.equal(await columns(), 1);
  await page.setViewportSize({ width: 1600, height: 1050 });
  await setLayout(2, 2);
  const card = (id) => grid.locator(`[data-session-id="${id}"]`);
  const mini = card('s8').getByRole('textbox');
  await mini.fill('Borrador del mini chat');
  await card('s8').getByRole('button', { name: 'Ampliar Tarea 9', exact: true }).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Borrador del mini chat');
  await page.getByRole('button', { name: 'Volver al grid' }).click();
  assert.equal(await mini.inputValue(), 'Borrador del mini chat');
  await mini.fill('Mensaje desde el grid');
  await mini.press('Shift+Enter');
  await mini.press('End');
  assert.match(await mini.inputValue(), /\n/);
  await card('s8').getByRole('button', { name: 'Adjuntar a Tarea 9', exact: true }).click();
  await card('s8').getByRole('button', { name: 'Quitar nota.txt', exact: true }).waitFor();
  await mini.press('Enter');
  await page.waitForFunction(() => window.fixture.actions.some((a) => a.type === 'send'));
  await card('s8').getByText('Respuesta a: Mensaje desde el grid', { exact: true }).waitFor();
  assert.equal(await mini.inputValue(), '');
  const sent = await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'send'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 's8');
  assert.deepEqual(sent[0].attachmentIds, ['file-s8']);
  await mini.fill('fallo simulado');
  await mini.press('Enter');
  await card('s8').getByText('No se pudo enviar. Tu borrador se conserva.').waitFor();
  assert.equal(await mini.inputValue(), 'fallo simulado');
  await page.getByRole('button', { name: 'Cerrar error', exact: true }).click();
  await card('s1').getByRole('button', { name: 'Permitir una vez', exact: true }).click();
  await page.waitForFunction(() => window.fixture.actions.some((a) => a.type === 'approve'));
  assert.equal(
    await page.evaluate(() => window.fixture.actions.find((a) => a.type === 'approve').sessionId),
    's1',
  );
  await card('s3').getByRole('button', { name: 'Interrumpir Tarea 4', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.fixture.actions.find((a) => a.type === 'interrupt').sessionId),
    's3',
  );
  await setLayout(4, 4);
  const beforeDrag = await grid.locator('.multichat-title strong').allTextContents();
  // The title itself drags the card: no separate grip.
  await card('s0')
    .getByRole('button', { name: 'Renombrar Tarea 1', exact: true })
    .dragTo(card('s5'));
  await page.waitForFunction(
    () => document.querySelector('.multichat-title strong').textContent === 'Tarea 2',
  );
  const reordered = await grid.locator('.multichat-title strong').allTextContents();
  assert.notDeepEqual(reordered, beforeDrag);
  assert.equal(reordered[5], 'Tarea 1');
  await card('s0')
    .getByRole('button', { name: 'Renombrar Tarea 1', exact: true })
    .press('Alt+ArrowLeft');
  const keyboardOrder = await grid.locator('.multichat-title strong').allTextContents();
  assert.equal(keyboardOrder[4], 'Tarea 1');
  assert.equal(await card('s8').getByRole('textbox').inputValue(), 'fallo simulado');
  // A chat that finishes while you look at another card stays marked until you touch it.
  await card('s10').getByRole('textbox').focus();
  await page.evaluate(() => {
    const s = window.fixture.state.sessions[6];
    s.status = 'ready';
    sessionStorage.setItem('fixture-ready', JSON.stringify([s.id]));
    window.fixture.publish();
  });
  await card('s6').and(page.locator('.unseen')).waitFor();
  const unseenButton = toolbar.getByRole('button', {
    name: '1 terminado sin revisar',
    exact: true,
  });
  await unseenButton.click();
  await unseenButton.waitFor({ state: 'detached' });
  assert.equal(await card('s6').evaluate((el) => el.classList.contains('unseen')), false);
  await page.screenshot({ path: 'artifacts/multichat-mini-chats.png' });
  await grid.getByRole('button', { name: 'Retirar Tarea 7 del grid', exact: true }).click();
  await setLayout(2, 2);
  await page.reload();
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  assert.deepEqual(
    await grid.locator('.multichat-title strong').allTextContents(),
    keyboardOrder.filter((title) => title !== 'Tarea 7'),
  );
  await toolbar.getByRole('button', { name: 'Mostrar 1 retirado', exact: true }).click();
  assert.deepEqual(await grid.locator('.multichat-title strong').allTextContents(), keyboardOrder);
  assert.match(await layoutButton.innerText(), /^2 × 2/);
  await grid
    .locator('[data-session-id="s0"]')
    .getByRole('button', { name: 'Abrir puerto 5173 de Tarea 1', exact: true })
    .click();
  await page.waitForFunction(() =>
    window.fixture.actions.some((a) => a.type === 'openDevInChrome'),
  );
  const opened = await page.evaluate(() =>
    window.fixture.actions.find((a) => a.type === 'openDevInChrome'),
  );
  assert.deepEqual(opened, { type: 'openDevInChrome', sessionId: 's0', port: 5173 });
  assert.equal(await grid.isVisible(), true);
  assert.equal(
    await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'browserNew').length),
    0,
  );
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const personal = page.getByRole('region', { name: 'Cuenta Personal', exact: true });
  await personal.getByLabel('Color de Personal', { exact: true }).fill('#193652');
  await personal.getByRole('button', { name: 'Guardar color', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  assert.equal(
    await grid
      .locator('[data-session-id="s0"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(25, 54, 82)',
  );
  assert.equal(
    await grid
      .locator('[data-session-id="s8"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(25, 54, 82)',
  );
  assert.notEqual(
    await grid
      .locator('[data-session-id="s4"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(25, 54, 82)',
  );
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const work = page.getByRole('region', { name: 'Cuenta Trabajo', exact: true });
  await work.getByLabel('Color de Trabajo', { exact: true }).fill('#e6c98b');
  await work.getByRole('button', { name: 'Guardar color', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  assert.equal(
    await grid
      .locator('[data-session-id="s4"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(230, 201, 139)',
  );
  for (const id of ['s4', 's0']) {
    const appearance = await grid.locator(`[data-session-id="${id}"]`).evaluate((el) => ({
      title: getComputedStyle(el.querySelector('.multichat-title strong')).color,
      body: getComputedStyle(el.querySelector('.row.assistant .md p')).color,
      bodyVariable: getComputedStyle(el).getPropertyValue('--multichat-body').trim(),
    }));
    assert.equal(appearance.body, appearance.bodyVariable);
    assert.notEqual(appearance.title, appearance.body);
  }
  await page.screenshot({ path: 'artifacts/multichat-account-colors.png' });
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page
    .getByRole('region', { name: 'Cuenta Personal', exact: true })
    .getByRole('button', { name: 'Sin color', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  assert.notEqual(
    await grid
      .locator('[data-session-id="s0"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(25, 54, 82)',
  );
  await page.evaluate(() => {
    window.fixture.state.devServers = window.fixture.state.devServers.filter(
      (s) => s.port !== 3000,
    );
    window.fixture.publish();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-session-id="s0"] .multichat-server').length === 1,
  );
  await page.evaluate(() => {
    const s = window.fixture.state.sessions[4];
    s.status = 'ready';
    s.messages[1].text = [
      '**El gestor ha cambiado de puerto.** Ahora usa `5174`.',
      '',
      '| Servicio | URL |',
      '| --- | --- |',
      '| Gestor | [Abrir gestor](http://localhost:5174/admin/) |',
      '',
      '- Primer paso',
      '- Segundo paso',
      '',
      '```sh',
      'npm run dev',
      '```',
      '',
      'Entrega: [Informe](./report.md)',
    ].join('\n');
    window.fixture.publish();
  });
  const rich = grid.locator('[data-session-id="s4"]');
  await rich
    .locator('.md strong')
    .getByText('El gestor ha cambiado de puerto.', { exact: true })
    .waitFor();
  assert.equal(await rich.locator('.md-table tr').count(), 2);
  assert.equal(await rich.locator('.md ul li').count(), 2);
  assert.equal(await rich.locator('.md-code').count(), 1);
  assert.equal(await rich.getByRole('link', { name: 'Abrir gestor', exact: true }).count(), 1);
  assert.equal(await rich.getByRole('link', { name: 'Informe', exact: true }).count(), 1);
  assert.equal(
    await rich.getByRole('button', { name: 'Copiar respuesta', exact: true }).count(),
    1,
  );
  const formatted = await rich.locator('.row.assistant .md').last().innerHTML();
  await rich.getByRole('button', { name: 'Ampliar Tarea 5', exact: true }).click();
  assert.equal(
    await page.locator('#conversation-content .row.assistant .md').last().innerHTML(),
    formatted,
  );
  await page.getByRole('button', { name: 'Volver al grid' }).click();
  await rich.getByRole('link', { name: 'Informe', exact: true }).click();
  const revealed = await page.evaluate(() =>
    window.fixture.actions.filter((a) => a.type === 'openPath').at(-1),
  );
  assert.deepEqual(revealed, {
    type: 'openPath',
    projectId: 'p1',
    path: './report.md',
    reveal: true,
  });
  await rich.getByRole('link', { name: 'Abrir gestor', exact: true }).click();
  await page.waitForFunction(() => window.fixture.actions.some((a) => a.type === 'browserNew'));
  const openedBrowser = await page.evaluate(() =>
    window.fixture.actions.filter((a) => a.type === 'browserNew').at(-1),
  );
  assert.deepEqual(openedBrowser, {
    type: 'browserNew',
    projectId: 'p1',
    sessionId: 's4',
    url: 'http://localhost:5174/admin/',
  });
  await page.getByRole('button', { name: 'Volver al grid' }).click();
  await layoutButton.click();
  await page.getByRole('button', { name: 'Automática' }).click();
  await page.evaluate(() => {
    window.fixture.state.sessions = window.fixture.state.sessions.filter((s) =>
      ['s4', 's8'].includes(s.id),
    );
    window.fixture.publish();
  });
  await page.waitForFunction(() => document.querySelectorAll('.multichat-card').length === 2);
  assert.match(await layoutButton.innerText(), /Auto\s*2 × 1/);
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/multichat-rich-text.png' });
  const renameCard = grid.locator('[data-session-id="s8"]');
  await renameCard
    .getByRole('textbox', { name: 'Mensaje para Tarea 9', exact: true })
    .fill('Borrador intacto al renombrar');
  const beforeRenameActions = await page.evaluate(
    () => window.fixture.actions.filter((a) => a.type === 'select').length,
  );
  await renameCard.getByRole('button', { name: 'Renombrar Tarea 9', exact: true }).click();
  assert.equal(await grid.isVisible(), true);
  await page.waitForTimeout(550);
  await renameCard.getByRole('button', { name: 'Renombrar Tarea 9', exact: true }).dblclick();
  await renameCard
    .getByRole('textbox', { name: 'Nombre de Tarea 9', exact: true })
    .fill('Resumen del despliegue');
  await renameCard.getByRole('textbox', { name: 'Nombre de Tarea 9', exact: true }).press('Enter');
  await renameCard
    .getByRole('button', { name: 'Renombrar Resumen del despliegue', exact: true })
    .waitFor();
  assert.equal(
    await renameCard
      .getByRole('textbox', { name: 'Mensaje para Resumen del despliegue', exact: true })
      .inputValue(),
    'Borrador intacto al renombrar',
  );
  assert.equal(
    await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'select').length),
    beforeRenameActions,
  );
  await renameCard
    .getByRole('button', { name: 'Renombrar Resumen del despliegue', exact: true })
    .dblclick();
  await renameCard
    .getByRole('textbox', { name: 'Nombre de Resumen del despliegue', exact: true })
    .fill('Nombre cancelado');
  await renameCard
    .getByRole('textbox', { name: 'Nombre de Resumen del despliegue', exact: true })
    .press('Escape');
  await renameCard
    .getByRole('button', { name: 'Renombrar Resumen del despliegue', exact: true })
    .waitFor();
  await page.screenshot({ path: 'artifacts/multichat-title-hierarchy.png' });
  await page.evaluate(() => {
    window.fixture.state.sessions = [];
    window.fixture.publish();
  });
  await grid.getByRole('heading', { name: 'No hay chats en marcha' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Multichat: 16 chats, cross-project expansion, Esc, retention, restart, responsive layout, mini-chat sends, attachments, drafts, failures, permissions, interrupt, drag and keyboard reordering, saved order, detailed activity, tool log, account nickname, Git header, per-chat dev ports, Chrome action, account colors, shared rich text, response links, project sidebar navigation, saved and automatic layout, attention and unseen jumps, numbered shortcuts, saved dismissals, title renaming and empty state passed.',
  );
} finally {
  await browser?.close();
  await server.httpServer.close();
}
