import { chromium } from 'playwright';
import { preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const session = (id, title, parentId, projectId = 'p') => ({
      id,
      title,
      parentId,
      projectId,
      profile: 'claude-1',
      mode: 'chat',
      status: 'ready',
      approvals: [],
      messages: [{ id: id + '-u', role: 'user', text: 'Trabaja en el proyecto' }],
    });
    const state = {
      profiles: [{ id: 'claude-1', kind: 'claude', name: 'Personal' }],
      accounts: {},
      projects: [
        { id: 'p', name: 'Logic', path: '/tmp/logic' },
        { id: 'p2', name: 'Reservas', path: '/tmp/reservas' },
      ],
      sessions: [
        session('root', 'Coordinador Medel'),
        session('c1', 'Alinear estancias', 'root'),
        session('c2', 'Alinear reservas', 'root', 'p2'),
        session('outside', 'Chat independiente'),
      ],
      selectedSession: 'root',
      selectedProject: 'p',
      tools: {},
      coordination: [],
      runtime: { protocol: 40 },
    };
    state.profiles.push({ id: 'codex', kind: 'codex', name: 'Codex' });
    state.sessions[0].profile = 'codex';
    state.sessions[0].status = 'working';
    const listeners = new Set();
    window.fixture = { state, actions: [] };
    window.desk = {
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      invoke: async (a) => {
        window.fixture.actions.push(a);
        if (a.type === 'snapshot') return structuredClone(state);
        if (a.type === 'select') {
          state.selectedProject = a.projectId;
          state.selectedSession = a.sessionId;
        }
        if (a.type === 'deleteSession') {
          state.sessions = state.sessions.filter((s) => s.id !== a.sessionId);
          if (state.selectedSession === a.sessionId) state.selectedSession = undefined;
        }
        if (a.type === 'stop') state.sessions.find((s) => s.id === a.sessionId).status = 'stopped';
        if (a.type === 'send') {
          const target = state.sessions.find((s) => s.id === a.sessionId);
          target.messages.push({ id: `u-${target.messages.length}`, role: 'user', text: a.text });
        }
        if (a.type === 'team' && a.input.operation === 'spawn')
          state.sessions.push(
            session(`new-${state.sessions.length}`, a.input.title, a.sessionId, a.input.projectId),
          );
        if (a.type === 'linkSubchat')
          state.sessions.find((s) => s.id === a.childId).parentId = a.sessionId;
        if (a.type === 'team' && a.input.operation === 'send')
          state.sessions.find((s) => s.id === a.input.targetId).teamMessages = [
            { id: 'mail', from: a.sessionId, text: a.input.text, at: Date.now(), status: 'queued' },
          ];
        for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
        return true;
      },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.project-subchats').waitFor();
  await page
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Me equivoqué: los valores son 10 y 20');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Cuando termines súbelo a GitHub');
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).press('Enter');
  assert.equal(
    await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'send').length),
    2,
  );
  assert.equal(
    await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'interrupt')),
    false,
  );
  assert.equal(await page.locator('.project-subchats .project-chat').count(), 2);
  await page.getByRole('button', { name: 'Plegar subchats de Coordinador Medel' }).click();
  assert.equal(await page.locator('.project-subchats .project-chat').count(), 0);
  await page.getByRole('button', { name: 'Expandir subchats de Coordinador Medel' }).click();
  assert.equal(await page.locator('.team-panel').count(), 0);
  const header = page.locator('.session-tabs-bar');
  await header.getByRole('button', { name: 'Ver equipo: 3 chats' }).click();
  await page
    .locator('.team-popover:popover-open')
    .getByRole('button', { name: /Alinear reservas/ })
    .click();
  assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), 'c2');
  await page.locator('.project-chat').filter({ hasText: 'Chat independiente' }).click();
  assert.equal(await header.locator('.team-indicator').count(), 0);
  await page.locator('.project-chat').filter({ hasText: 'Coordinador Medel' }).click();
  for (let i = 0; i < 6; i++)
    await page.evaluate(
      (i) =>
        window.desk.invoke({
          type: 'team',
          sessionId: 'root',
          input: {
            operation: 'spawn',
            title: `Agente ${i}`,
            projectId: 'p',
            text: 'Tarea delegada',
          },
        }),
      i,
    );
  await header.getByRole('button', { name: 'Ver equipo: 9 chats' }).waitFor();
  const height = await page
    .locator('.project-subchats .project-chat')
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(height >= 28 && height <= 36, `Altura cómoda de navegación: ${height}`);
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/team-check.png' });
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  const grid = page.locator('.multichat-grid');
  const rootCard = grid.locator('[data-session-id="root"]');
  await rootCard.getByRole('textbox').fill('Además revisa los tests');
  await rootCard.getByRole('button', { name: 'Enviar a Coordinador Medel', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'send').length),
    3,
  );
  assert.equal(
    await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'interrupt')),
    false,
  );
  await grid.locator('.team-indicator').first().click();
  await page.locator('.team-popover:popover-open').waitFor();
  assert.ok((await grid.locator('.team-indicator').first().boundingBox()).width >= 28);
  assert.equal(await grid.locator('.team-indicator').first().innerText(), '9');
  assert.equal(
    await grid.locator('.team-indicator').first().getAttribute('aria-label'),
    'Ver equipo: 9 chats',
  );
  assert.ok(
    (await page.locator('.team-popover:popover-open .team-member').first().boundingBox()).width >
      200,
  );
  await page.screenshot({ path: 'artifacts/team-popover-check.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.team-popover:popover-open').count(), 0);
  await page.screenshot({ path: 'artifacts/team-grid-check.png' });
  const child = grid.locator('[data-session-id="c2"]');
  await child.getByRole('button', { name: 'Opciones de Alinear reservas', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Ocultar Alinear reservas en el grid', exact: true })
    .click();
  await child.waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('.project-chat').filter({ hasText: 'Alinear reservas' }).count(),
    1,
  );
  assert.equal(
    await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'stop')),
    false,
  );
  await page.getByRole('button', { name: 'Ver chats ocultos', exact: true }).click();
  await child.getByRole('button', { name: 'Opciones de Alinear reservas', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Mostrar Alinear reservas en el grid', exact: true })
    .click();
  await child.waitFor();
  await child.getByRole('button', { name: 'Opciones de Alinear reservas', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Eliminar Alinear reservas', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Eliminar conversación', exact: true })
    .getByRole('button', { name: 'Detener y eliminar', exact: true })
    .click();
  await child.waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => window.fixture.state.sessions.some((s) => s.id === 'c2')),
    false,
  );
  assert.equal(
    await page.locator('.project-chat').filter({ hasText: 'Alinear reservas' }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Ver chats ocultos', exact: true }).click();
  assert.equal(await child.count(), 0);
  await page.locator('[data-project-id="p2"] .project-name').click();
  assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), null);
  assert.deepEqual(errors, []);
  console.log(
    'Equipo UI: filas compactas, indicador superior dinámico, sin bloque vacío, navegación y popover en grid correctos.',
  );
} finally {
  await browser?.close();
  await server.close();
}
