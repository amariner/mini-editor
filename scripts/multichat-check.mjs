// Renderer-only supervision fixture: sixteen chats, no accounts or provider processes.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const card0Key = (page) => page.locator('[data-session-id="s0"] .multichat-key').innerText();
const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
// Optional isolated renderer build: stable while other UI components are being edited.
const testBuild = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-grid-'))
  : undefined;
if (testBuild) await build({ build: { outDir: testBuild, emptyOutDir: true }, logLevel: 'silent' });
const server = await preview({
  build: { outDir: testBuild ?? 'dist' },
  preview: { host: '127.0.0.1', port: 0 },
  logLevel: 'silent',
});
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ({ protocol }) => {
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
        runtime: { protocol },
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
      state.sessions[0].attempted = true;
      state.sessions[0].reference = 'fixture-reference';
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
          if (a.type === 'moveProject') {
            const from = state.projects.findIndex((p) => p.id === a.projectId),
              to = state.projects.findIndex((p) => p.id === a.targetProjectId);
            const [project] = state.projects.splice(from, 1);
            state.projects.splice(to, 0, project);
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
          if (a.type === 'newSession') {
            const session = {
              id: `new-${state.sessions.length}`,
              projectId: a.projectId,
              profile: a.profile,
              mode: 'chat',
              title: `Chat nuevo ${state.sessions.length + 1}`,
              status: 'stopped',
              approvals: [],
              messages: [],
            };
            state.sessions.push(session);
            state.selectedProject = a.projectId;
            state.selectedSession = session.id;
            return structuredClone(session);
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
          if (a.type === 'deleteSession') {
            state.sessions = state.sessions.filter((session) => session.id !== a.sessionId);
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
    },
    { protocol },
  );
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  const grid = page.locator('.multichat');
  const toolbar = page.locator('.topbar .multichat-toolbar');
  const options = async (title) => {
    await grid.getByRole('button', { name: `Opciones de ${title}`, exact: true }).click();
    return page.getByRole('menu', { name: `Opciones de ${title}`, exact: true });
  };
  const hideCard = async (title) => {
    const menu = await options(title);
    await menu.getByRole('menuitem', { name: `Ocultar ${title} en el grid`, exact: true }).click();
  };
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
  // Team popovers flip above bottom-row cards, stay anchored, and retain keyboard navigation.
  await page.evaluate(() => {
    window.fixture.state.sessions[12].subagents = Array.from({ length: 14 }, (_, i) => ({
      id: `team-agent-${i}`,
      description: `Subagente de prueba ${i + 1}`,
      summary: 'Revisando el proyecto',
    }));
    window.fixture.publish();
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await setLayout(4, 4);
  const teamCard = grid.locator('[data-session-id="s12"]');
  const teamTrigger = teamCard.locator('.team-indicator');
  const teamPopup = page.getByRole('dialog', { name: 'Equipo de Tarea 13', exact: true });
  await teamCard.scrollIntoViewIfNeeded();
  await teamTrigger.evaluate((button) => {
    button.closest('.multichat-scroll').scrollTop +=
      button.getBoundingClientRect().top - (innerHeight - 60);
  });
  const teamAnchor = await teamTrigger.boundingBox();
  await page.mouse.click(teamAnchor.x + teamAnchor.width / 2, teamAnchor.y + teamAnchor.height / 2);
  await teamPopup.waitFor();
  const teamContained = () =>
    teamPopup.evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return (
        bounds.left >= 8 &&
        bounds.top >= 8 &&
        bounds.right <= innerWidth - 8 &&
        bounds.bottom <= innerHeight - 8
      );
    });
  assert.equal(await teamContained(), true, 'Bottom-row teams must fit inside the viewport');
  let teamBounds = await teamPopup.boundingBox();
  assert.ok(teamBounds.y + teamBounds.height <= teamAnchor.y, 'Team must flip above its trigger');
  assert.ok(await teamPopup.evaluate((panel) => panel === document.activeElement));
  await page.keyboard.press('End');
  assert.ok(
    await teamPopup.evaluate(
      (panel) => panel.scrollHeight - panel.scrollTop - panel.clientHeight < 2,
    ),
    'The final subagent must remain reachable by keyboard',
  );
  await page.keyboard.press('Home');
  assert.equal(await teamPopup.evaluate((panel) => panel.scrollTop), 0);
  await teamTrigger.evaluate((button) => {
    button.closest('.multichat-scroll').scrollTop += 80;
  });
  await page.waitForTimeout(50);
  assert.equal(await teamContained(), true);
  const movedTeam = await teamPopup.boundingBox();
  assert.notEqual(movedTeam.y + movedTeam.height, teamBounds.y + teamBounds.height);
  await page.setViewportSize({ width: 900, height: 620 });
  await page.waitForTimeout(50);
  assert.equal(await teamContained(), true, 'An open team must remain bounded after resizing');
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/multichat-team-menu.png' });
  await page.keyboard.press('Escape');
  await teamPopup.waitFor({ state: 'hidden' });
  assert.ok(await teamTrigger.evaluate((button) => button === document.activeElement));
  await page.evaluate(() => {
    window.fixture.state.sessions[13].parentId = 's12';
    window.fixture.publish();
  });
  await teamTrigger.scrollIntoViewIfNeeded();
  await teamTrigger.press('ArrowUp');
  await teamPopup.waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-session-id="s12"] .team-indicator')
        ?.getAttribute('aria-expanded') === 'true',
  );
  assert.ok(
    await teamPopup
      .getByRole('button')
      .last()
      .evaluate((button) => button === document.activeElement),
  );
  await page.keyboard.press('Home');
  assert.ok(
    await teamPopup
      .getByRole('button')
      .first()
      .evaluate((button) => button === document.activeElement),
  );
  await page.keyboard.press('Shift+Tab');
  assert.ok(await teamTrigger.evaluate((button) => button === document.activeElement));
  await page.keyboard.press('ArrowDown');
  assert.ok(
    await teamPopup
      .getByRole('button')
      .first()
      .evaluate((button) => button === document.activeElement),
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await grid.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), 's13');
  await page.getByRole('button', { name: 'Volver al grid' }).click();
  await teamTrigger.click();
  await teamPopup.waitFor();
  await teamTrigger.click();
  await teamPopup.waitFor({ state: 'hidden' });
  await teamTrigger.click();
  await teamPopup.waitFor();
  await toolbar.getByText('16 chats', { exact: true }).click();
  await teamPopup.waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(
      () => window.fixture.actions.filter((a) => ['interrupt', 'stop'].includes(a.type)).length,
    ),
    0,
    'Closing a team popover must not interrupt its chat',
  );
  await page.evaluate(() => {
    delete window.fixture.state.sessions[12].subagents;
    delete window.fixture.state.sessions[13].parentId;
    window.fixture.state.selectedSession = 's0';
    window.fixture.state.selectedProject = 'p0';
    window.fixture.publish();
  });
  await page.setViewportSize({ width: 1600, height: 1050 });
  await layoutButton.click();
  await page.getByRole('button', { name: /^Automática/ }).click();
  await grid.locator('.multichat-scroll').evaluate((element) => element.scrollTo(0, 0));
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
  assert.match(await toolbar.innerText(), /16 chats/);
  assert.equal(await toolbar.locator('.working').getAttribute('aria-label'), '15 trabajando');
  assert.equal(
    await toolbar.getByRole('button', { name: '1 requiere atención', exact: true }).count(),
    1,
  );
  assert.match(await layoutButton.innerText(), /Auto\s*4 × 4/);
  assert.equal(await grid.locator('.multichat-card.attention .multichat-approvals').count(), 1);
  // Closing a working chat still needs confirmation; no process is stopped by opening the menu.
  let menu = await options('Tarea 1');
  assert.equal(await menu.locator('.multichat-server').count(), 2);
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Duplicar Tarea 1', exact: true }).isDisabled(),
    true,
  );
  await menu.getByRole('menuitem', { name: 'Eliminar Tarea 1', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Eliminar conversación', exact: true })
    .getByRole('button', { name: 'Cancelar', exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.actions.filter((a) => a.type === 'stop' || a.type === 'deleteSession')
          .length,
    ),
    0,
  );
  menu = await options('Tarea 5');
  assert.equal(await menu.locator('.multichat-server').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    'Opciones de Tarea 5',
  );
  menu = await options('Tarea 4');
  assert.equal(await menu.locator('.multichat-server').count(), 0);
  await page.keyboard.press('End');
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('multichat-dismiss')),
    true,
  );
  await page.keyboard.press('Home');
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent.includes('Renombrar')),
    true,
  );
  await page.keyboard.press('Escape');
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
      .locator('.chat-switcher-trigger')
      .innerText()
      .then((s) => s.trim()),
    'Tarea 8',
  );
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  await page.getByRole('button', { name: 'Proyecto 2', exact: true }).click();
  await grid.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  const sidebar = page.getByRole('navigation', { name: 'Proyectos', exact: true });
  const selectedBeforeOrder = await page.evaluate(() => [
    window.fixture.state.selectedProject,
    window.fixture.state.selectedSession,
  ]);
  const selectCalls = await page.evaluate(
    () => window.fixture.actions.filter((a) => a.type === 'select').length,
  );
  await sidebar
    .getByRole('button', { name: 'Proyecto 1', exact: true })
    .dragTo(sidebar.locator('[data-project-id="p2"]'));
  await page.waitForFunction(
    () => window.fixture.state.projects.map((p) => p.id).join(',') === 'p1,p2,p0,p3',
  );
  assert.deepEqual(await sidebar.locator('.project-name').allTextContents(), [
    'Proyecto 2',
    'Proyecto 3',
    'Proyecto 1',
    'Proyecto 4',
  ]);
  assert.deepEqual(
    await page.evaluate(() => [
      window.fixture.state.selectedProject,
      window.fixture.state.selectedSession,
    ]),
    selectedBeforeOrder,
  );
  assert.equal(
    await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'select').length),
    selectCalls,
  );
  assert.equal(await grid.isVisible(), true);
  await sidebar.getByRole('button', { name: 'Proyecto 1', exact: true }).press('Alt+ArrowUp');
  await page.waitForFunction(
    () => window.fixture.state.projects.map((p) => p.id).join(',') === 'p1,p0,p2,p3',
  );
  await page.keyboard.press('ControlOrMeta+b');
  await sidebar
    .getByRole('button', { name: 'Proyecto 4', exact: true })
    .dragTo(sidebar.locator('[data-project-id="p1"]'));
  await page.waitForFunction(
    () => window.fixture.state.projects.map((p) => p.id).join(',') === 'p3,p1,p0,p2',
  );
  await page.keyboard.press('ControlOrMeta+b');
  assert.equal(await grid.isVisible(), true);
  assert.equal(await columns(), 4);
  assert.ok(
    await grid
      .locator('.multichat-card')
      .evaluateAll((els) => els.every((e) => e.getBoundingClientRect().bottom <= innerHeight)),
  );
  await fs.mkdir('artifacts', { recursive: true });
  menu = await options('Tarea 16');
  assert.equal(
    await menu.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth
      );
    }),
    true,
    'menus in the last row stay within the viewport',
  );
  await page.screenshot({ path: 'artifacts/multichat-card-menu.png' });
  await page.keyboard.press('Escape');
  menu = await options('Tarea 1');
  await toolbar.getByText('16 chats', { exact: true }).click();
  await menu.waitFor({ state: 'detached' });
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
  await hideCard('Tarea 16');
  assert.equal(await grid.locator('.multichat-card').count(), 15);
  await page.evaluate(() => {
    window.fixture.state.sessions[15].status = 'working';
    window.fixture.publish();
  });
  assert.equal(
    await grid.locator('.multichat-card').count(),
    15,
    'hidden chats stay hidden while they work',
  );
  await toolbar.getByRole('button', { name: 'Ver chats ocultos', exact: true }).click();
  const restoreMenu = await options('Tarea 16');
  await restoreMenu
    .getByRole('menuitem', { name: 'Mostrar Tarea 16 en el grid', exact: true })
    .click();
  await toolbar.getByRole('button', { name: 'Ocultar chats ocultos', exact: true }).click();
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
  await hideCard('Tarea 7');
  await setLayout(2, 2);
  await page.reload();
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  assert.deepEqual(
    await grid.locator('.multichat-title strong').allTextContents(),
    keyboardOrder.filter((title) => title !== 'Tarea 7'),
  );
  await toolbar.getByRole('button', { name: 'Ver chats ocultos', exact: true }).click();
  assert.deepEqual(await grid.locator('.multichat-title strong').allTextContents(), keyboardOrder);
  assert.match(await layoutButton.innerText(), /^2 × 2/);
  menu = await options('Tarea 1');
  await menu.getByRole('menuitem', { name: 'Abrir puerto 5173 de Tarea 1', exact: true }).click();
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
  await personal.getByRole('button', { name: 'Opciones de Personal', exact: true }).click();
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
  await work.getByRole('button', { name: 'Opciones de Trabajo', exact: true }).click();
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
    .getByRole('button', { name: 'Opciones de Personal', exact: true })
    .click();
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
  menu = await options('Tarea 1');
  assert.equal(await menu.locator('.multichat-server').count(), 1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const s = window.fixture.state.sessions[4];
    s.status = 'ready';
    s.attempted = true;
    s.reference = 'fixture-work-reference';
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
  menu = await options('Tarea 5');
  await menu.getByRole('menuitem', { name: 'Duplicar Tarea 5', exact: true }).click();
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.actions.filter((action) => action.type === 'forkSession').at(-1),
    ),
    { type: 'forkSession', sessionId: 's4', isolate: true },
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
    sessionId: 's4',
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
  // A card that was following the latest response keeps it in view when made shorter.
  await page.setViewportSize({ width: 780, height: 620 });
  await page.waitForFunction(() => {
    const viewport = document.querySelector('[data-session-id="s4"] .multichat-preview');
    return (
      viewport.scrollHeight > viewport.clientHeight + 60 &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2
    );
  });
  await rich.locator('.multichat-preview').evaluate((element) => {
    element.scrollTop = 0;
  });
  const latest = rich.getByRole('button', { name: 'Ir al último mensaje de Tarea 5', exact: true });
  await latest.waitFor();
  await page.setViewportSize({ width: 780, height: 540 });
  await page.evaluate(() => {
    window.fixture.state.sessions.find((session) => session.id === 's4').messages[1].text +=
      '\n\nNueva información al final.';
    window.fixture.publish();
  });
  await rich.getByText('Nueva información al final.', { exact: true }).waitFor();
  assert.equal(
    await rich.locator('.multichat-preview').evaluate((element) => element.scrollTop),
    0,
    'resizing and streaming do not move a reader who scrolled up',
  );
  await latest.click();
  await page.waitForFunction(() => {
    const viewport = document.querySelector('[data-session-id="s4"] .multichat-preview');
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2;
  });
  await latest.waitFor({ state: 'detached' });
  await page.screenshot({ path: 'artifacts/multichat-follow-latest.png' });
  await page.setViewportSize({ width: 1600, height: 1050 });
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
  menu = await options('Tarea 9');
  await menu.getByRole('menuitem', { name: /^Renombrar/ }).click();
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
  // Supervision: plan progress, this turn's changes and subagents come before the log.
  await page.evaluate(() => {
    const base = (id, i, extra) => ({
      id,
      projectId: `p${i}`,
      profile: i === 3 ? 'claude-2' : 'claude-1',
      mode: 'chat',
      title: extra.title,
      status: 'working',
      approvals: [],
      messages: [
        { id: `${id}-u0`, role: 'user', text: 'Turno anterior' },
        {
          id: `${id}-a0`,
          role: 'assistant',
          text: '',
          blocks: [
            {
              type: 'tool_use',
              id: `${id}-old`,
              name: 'Write',
              input: { file_path: `/tmp/grid-${i}/antiguo.ts`, content: 'x\n'.repeat(40) },
              done: true,
            },
          ],
        },
        { id: `${id}-u1`, role: 'user', text: extra.ask },
        ...extra.messages,
      ],
      ...extra.fields,
    });
    window.fixture.state.sessions = [
      base('v1', 0, {
        title: 'Migrar API',
        ask: 'Migra la API a la versión 2',
        messages: [
          {
            id: 'v1-a1',
            role: 'assistant',
            text: '',
            blocks: [
              { type: 'text', text: 'Empiezo por el cliente y los tests.', final: true },
              {
                type: 'tool_use',
                id: 'v1-edit',
                name: 'Edit',
                input: {
                  file_path: '/tmp/grid-0/src/api.ts',
                  old_string: 'const a = 1;\nconst b = 2;',
                  new_string: 'const a = 1;\nconst c = 3;\nconst d = 4;',
                },
                done: true,
              },
              {
                type: 'tool_use',
                id: 'v1-write',
                name: 'Write',
                input: { file_path: '/tmp/grid-0/src/v2.ts', content: 'a\nb\nc\n' },
                done: true,
              },
              {
                type: 'tool_use',
                id: 'v1-test',
                name: 'Bash',
                input: { command: 'npm test', description: 'Ejecutar los tests' },
                done: false,
              },
            ],
          },
        ],
        fields: {
          todos: [
            { content: 'Leer el cliente', status: 'completed' },
            { content: 'Migrar endpoints', status: 'completed' },
            { content: 'Actualizar tipos', status: 'completed' },
            {
              content: 'Actualizar los tests',
              activeForm: 'Actualizando los tests',
              status: 'in_progress',
            },
            { content: 'Documentar', status: 'pending' },
          ],
          subagents: [
            {
              id: 't1',
              description: 'Revisar rutas',
              summary: 'Analizando el módulo de autenticación',
            },
            { id: 't2', description: 'Buscar usos de la API antigua' },
          ],
        },
      }),
      base('v2', 1, {
        title: 'Revisar PR',
        ask: 'Revisa el PR de pagos',
        messages: [
          {
            id: 'v2-a1',
            role: 'assistant',
            text: 'He revisado el PR: hay dos tests sin actualizar.',
          },
        ],
        fields: { status: 'ready' },
      }),
      base('v3', 2, {
        title: 'Corregir estilos',
        ask: 'Corrige el modo oscuro',
        messages: [
          {
            id: 'v3-a1',
            role: 'assistant',
            text: '',
            blocks: [
              {
                type: 'tool_use',
                id: 'v3-edit',
                name: 'Edit',
                input: {
                  file_path: '/tmp/grid-2/src/style.css',
                  old_string: 'color: #000;',
                  new_string: 'color: var(--text);',
                },
                done: true,
              },
              { type: 'text', text: 'Listo: el texto usa ya la variable del tema.', final: true },
            ],
          },
        ],
        fields: {
          status: 'ready',
          todos: [
            { content: 'Localizar colores fijos', status: 'completed' },
            { content: 'Usar variables', status: 'completed' },
          ],
        },
      }),
      base('v4', 3, {
        title: 'Investigar error',
        ask: 'Investiga el error 500',
        messages: [{ id: 'v4-a1', role: 'assistant', text: 'Buscando en los registros…' }],
        fields: {},
      }),
    ];
    window.fixture.publish();
  });
  await page.waitForFunction(() => document.querySelectorAll('.multichat-card').length === 4);
  const migrate = grid.locator('[data-session-id="v1"]');
  const plan = migrate.getByRole('progressbar', { name: 'Progreso del plan' });
  assert.equal(await plan.getAttribute('aria-valuenow'), '3');
  assert.equal(await plan.getAttribute('aria-valuemax'), '5');
  assert.match(await plan.innerText(), /3\/5/);
  assert.match(await plan.getAttribute('aria-valuetext'), /Actualizando los tests/);
  assert.equal(await migrate.locator('.todo-panel').count(), 0);
  await migrate.getByRole('button', { name: 'Ver tareas de Migrar API', exact: true }).click();
  assert.equal(await migrate.locator('.todo-panel li').count(), 5);
  await migrate.getByRole('button', { name: 'Ver tareas de Migrar API', exact: true }).click();
  // Only the current turn counts: the earlier Write of antiguo.ts is not in the chip.
  const changes = migrate.locator('.multichat-changes');
  assert.match(await changes.innerText(), /^2\s*\+5\s*−1$/);
  assert.match(await changes.getAttribute('title'), /src\/api\.ts\nsrc\/v2\.ts$/);
  assert.equal(await migrate.locator('.execution-panel').getAttribute('open'), null);
  await migrate.locator('.execution-panel > summary').click();
  assert.match(
    await migrate.locator('.execution-panel').innerText(),
    /Analizando el módulo de autenticación/,
  );
  await migrate.locator('.execution-panel > summary').click();
  assert.equal(
    await migrate.evaluate((el) => {
      const info = el.querySelector('.multichat-info-line').getBoundingClientRect();
      const supervision = el.querySelector('.multichat-supervision').getBoundingClientRect();
      const messages = el.querySelector('.multichat-preview').getBoundingClientRect();
      return info.bottom <= supervision.top && supervision.bottom <= messages.top;
    }),
    true,
    'supervision sits between the header and the full history',
  );
  const styles = grid.locator('[data-session-id="v3"]');
  assert.match(await styles.locator('.multichat-plan').innerText(), /2\/2/);
  assert.match(await styles.locator('.multichat-changes').innerText(), /^1\s*\+1\s*−1$/);
  const plain = grid.locator('[data-session-id="v4"]');
  assert.equal(await plain.locator('.multichat-supervision').count(), 0);
  // The draft is shared when the grid card unmounts for the expanded chat.
  const review = grid.locator('[data-session-id="v2"]');
  const draft = 'Actualiza esos dos tests y vuelve a ejecutarlos';
  const sends = () =>
    page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'send').length);
  const sentBefore = await sends();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/multichat-supervision-light.png' });
  await migrate.screenshot({ path: 'artifacts/multichat-supervision-card-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/multichat-supervision-dark.png' });
  await migrate.screenshot({ path: 'artifacts/multichat-supervision-card-dark.png' });
  const reviewField = review.getByRole('textbox', { name: 'Mensaje para Revisar PR', exact: true });
  await reviewField.fill(draft);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'Mensaje para Revisar PR',
  );
  assert.equal(await sends(), sentBefore);
  await review.getByRole('button', { name: 'Ampliar Revisar PR', exact: true }).click();
  await page.getByRole('button', { name: 'Volver al grid' }).waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(), draft);
  await page.locator('.composer textarea').fill(draft + ' y resume el resultado.');
  assert.equal(await sends(), sentBefore);
  await page.getByRole('button', { name: 'Volver al grid' }).click();
  await grid.waitFor({ state: 'visible' });
  assert.equal(await reviewField.inputValue(), draft + ' y resume el resultado.');
  await reviewField.fill('');
  // The chip opens the changes of that chat.
  await changes.click();
  await page.getByRole('button', { name: 'Volver al grid' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), 'v1');
  await page.getByRole('button', { name: 'Volver al grid' }).click();
  await grid.waitFor({ state: 'visible' });
  // New chat without leaving the grid: project and account chosen in place.
  await toolbar.getByRole('button', { name: 'Nuevo chat', exact: true }).click();
  const newChat = page.getByRole('form', { name: 'Nuevo chat' });
  await newChat.getByLabel('Proyecto').selectOption({ label: 'Proyecto 3' });
  await newChat.getByLabel('Cuenta').selectOption({ label: 'Trabajo' });
  await page.screenshot({ path: 'artifacts/multichat-new-chat.png' });
  await newChat.getByRole('button', { name: 'Crear chat', exact: true }).click();
  await newChat.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.multichat-card').length === 5);
  assert.deepEqual(
    await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'newSession').at(-1)),
    { type: 'newSession', projectId: 'p2', profile: 'claude-2' },
  );
  assert.equal(await grid.isVisible(), true);
  assert.deepEqual(
    (await grid.locator('.multichat-title strong').allTextContents()).slice(0, 4),
    ['Migrar API', 'Revisar PR', 'Corregir estilos', 'Investigar error'],
    'existing cards keep their place',
  );
  const created = grid.locator('.multichat-card').last();
  assert.equal(await created.locator('.multichat-account').innerText(), 'Trabajo');
  await page.waitForFunction(
    () => document.activeElement?.closest('.multichat-card')?.dataset.sessionId === 'new-4',
  );
  // Explicit deletion is separate from reversible hiding, even when no agent is active.
  menu = await options('Chat nuevo 5');
  await menu.getByRole('menuitem', { name: 'Eliminar Chat nuevo 5', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Eliminar conversación', exact: true });
  await deleteDialog.waitFor();
  assert.equal(await grid.locator('.multichat-card').count(), 5);
  assert.equal(
    await page.evaluate(
      () => window.fixture.actions.filter((action) => action.type === 'deleteSession').length,
    ),
    0,
  );
  await deleteDialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  menu = await options('Chat nuevo 5');
  await menu.getByRole('menuitem', { name: 'Eliminar Chat nuevo 5', exact: true }).click();
  await deleteDialog.getByRole('button', { name: 'Eliminar chat', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.multichat-card').length === 4);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.actions.filter((action) => action.type === 'deleteSession').at(-1),
    ),
    { type: 'deleteSession', sessionId: 'new-4' },
  );
  await page.evaluate(() => {
    window.fixture.state.sessions = window.fixture.state.sessions.filter(
      (session) => session.id === 'v1',
    );
    window.fixture.publish();
  });
  await page.waitForFunction(() => document.querySelectorAll('.multichat-card').length === 1);
  assert.match(await layoutButton.innerText(), /Auto\s*1 × 1/);
  await page.screenshot({ path: 'artifacts/multichat-single-card.png' });
  await page.evaluate(() => {
    window.fixture.state.sessions = [];
    window.fixture.publish();
  });
  await grid.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Multichat', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'Multichat: 16 chats, cross-project expansion, Esc, retention, responsive layout, mini-chat sends, attachments, shared drafts across card unmounts, failures, permissions, interrupt, drag and keyboard reordering, saved order, detailed activity, tool log, account nickname, Git header, per-chat dev ports, Chrome action, account colors, shared rich text, response links, project sidebar navigation, saved and automatic layout, attention and unseen jumps, numbered shortcuts, saved hidden chats, title renaming, plan progress, turn changes, subagent summaries, new chat from the grid, expanded/collapsed sidebar project dragging, accessible card menus, resize/stream follow and last-chat removal passed.',
  );
} finally {
  await browser?.close();
  await server.httpServer.close();
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
