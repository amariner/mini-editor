// Isolated renderer audit: no personal accounts, agent processes, or network calls.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testBuild = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-ui-polish-'))
  : undefined;
if (testBuild) await build({ build: { outDir: testBuild, emptyOutDir: true }, logLevel: 'silent' });
const server = await preview({
  build: { outDir: testBuild ?? 'dist' },
  preview: { host: '127.0.0.1', port: 0 },
  logLevel: 'silent',
});
const protocol = Number(
  (await fs.readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8')).match(
    /IPC_VERSION = (\d+)/,
  )[1],
);
let browser;
try {
  await fs.mkdir('artifacts/v20', { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((protocol) => {
      const projects = [
        { id: 'p', name: 'Studio', path: '/tmp/fixture-studio' },
        { id: 'p2', name: 'Design system', path: '/tmp/fixture-design' },
        { id: 'p3', name: 'Website', path: '/tmp/fixture-site' },
      ];
      const state = {
        profiles: [
          { id: 'claude-1', kind: 'claude', name: 'Personal' },
          { id: 'codex-1', kind: 'codex', name: 'Trabajo' },
        ],
        defaultProfile: 'claude-1',
        accounts: {
          'claude-1': { status: 'signedIn', label: 'Cuenta personal', plan: 'Pro' },
          'codex-1': { status: 'signedIn', label: 'Equipo', plan: 'Plus' },
        },
        projects,
        sessions: Array.from({ length: 4 }, (_, i) => ({
          id: `s${i}`,
          projectId: i < 2 ? 'p' : i === 2 ? 'p2' : 'p3',
          profile: i === 2 ? 'codex-1' : 'claude-1',
          mode: 'chat',
          status: i === 1 ? 'working' : 'ready',
          title: [
            'Pulir la página de inicio',
            'Revisar componentes',
            'Documentar los tokens',
            'Preparar el lanzamiento',
          ][i],
          approvals: [],
          config: { model: 'sonnet' },
          info: {
            model: 'sonnet',
            models: [{ value: 'sonnet', displayName: 'Sonnet' }],
            commands: [],
            tools: [],
            mcpServers: [],
            skills: [],
            plugins: [],
            agents: [],
            outputStyles: [],
          },
          messages: [
            {
              id: `u${i}`,
              role: 'user',
              text: 'Revisa la interfaz y simplifica los controles. Conserva todas las funciones.',
            },
            {
              id: `a${i}`,
              role: 'assistant',
              text: '',
              blocks: [
                {
                  type: 'text',
                  text: 'Voy a revisar la jerarquía y los componentes.',
                  final: true,
                },
                {
                  type: 'tool_use',
                  id: `t${i}`,
                  name: 'Read',
                  input: { file_path: '/tmp/fixture-studio/src/app.tsx' },
                  done: true,
                  result: 'export function App() {}',
                },
              ],
            },
            {
              id: `f${i}`,
              role: 'assistant',
              text: 'La interfaz tiene ahora más espacio y una jerarquía más clara.\n\n- **Acciones frecuentes** junto al contenido.\n- Ajustes secundarios dentro de un menú.\n- Navegación por teclado conservada.\n\nLos cambios están listos para revisar.',
              model: 'Sonnet',
              at: 1792530000000,
            },
          ],
          stats: {
            inputTokens: 1200,
            outputTokens: 320,
            turns: 1,
            cost: 0,
            durationMs: 2400,
            tokensReported: true,
          },
        })),
        selectedProject: 'p',
        selectedSession: 's0',
        tools: {},
        coordination: [],
        runtime: { protocol },
        dataDir: '/tmp/ui-polish-fixture',
      };
      const listeners = new Set();
      const publish = () =>
        listeners.forEach((fn) => fn({ type: 'state', state: structuredClone(state) }));
      window.fixture = { state, actions: [], publish };
      window.desk = {
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        async invoke(action) {
          window.fixture.actions.push(action);
          if (action.type === 'snapshot') return structuredClone(state);
          if (action.type === 'diff')
            return {
              repository: true,
              branch: 'main',
              files: [],
              lines: { added: 0, removed: 0 },
              counts: { conflicts: 0 },
            };
          if (
            ['refreshUsage', 'accountRefresh', 'refreshModels', 'browserPresent'].includes(
              action.type,
            )
          )
            return true;
          if (action.type === 'select') {
            state.selectedProject = action.projectId;
            state.selectedSession =
              action.sessionId ?? state.sessions.find((s) => s.projectId === action.projectId)?.id;
            publish();
            return true;
          }
          throw new Error(`Unexpected fixture action: ${action.type}`);
        },
      };
    }, protocol);
    await page.goto(server.resolvedUrls.local[0]);
    await page.locator('.workspace .composer').waitFor();
    await page.screenshot({ path: `artifacts/v20/workspace-${colorScheme}.png` });
    const composer = page.locator('.workspace .composer textarea');
    await composer.focus();
    await page.keyboard.press('Meta+k');
    await page.getByRole('combobox', { name: 'Buscar proyecto o sesión', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.ok(
      await composer.evaluate((element) => element === document.activeElement),
      'Search must return focus to the composer that opened it',
    );

    // Opening a modal isolates its keyboard scope and restores the exact trigger.
    const settings = page.getByRole('button', { name: 'Ajustes', exact: true });
    await settings.click();
    const dialog = page.getByRole('dialog', { name: 'Ajustes', exact: true });
    await dialog.waitFor();
    assert.ok(await page.locator('.app > main').evaluate((element) => element.inert));
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
      assert.ok(await dialog.evaluate((element) => element.contains(document.activeElement)));
    }
    const before = await page.evaluate(() => window.fixture.actions.length);
    await page.keyboard.press('Meta+n');
    assert.equal(
      await page.evaluate(() => window.fixture.actions.slice(-1)[0]?.type === 'newSession'),
      false,
    );
    assert.ok(
      await page.evaluate(
        (before) => window.fixture.actions.slice(before).every((a) => a.type !== 'configure'),
        before,
      ),
    );
    await page.screenshot({ path: `artifacts/v20/settings-${colorScheme}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.ok(await settings.evaluate((element) => element === document.activeElement));
    assert.equal(await page.locator('.app > main').evaluate((element) => element.inert), false);

    // The last pending agent can resolve while its queue is open, removing its trigger on close.
    await page.evaluate(() => {
      window.fixture.state.sessions[1].status = 'waiting';
      window.fixture.publish();
    });
    const attentionTrigger = page.getByRole('button', { name: 'Centro de atención', exact: true });
    await attentionTrigger.click();
    const attention = page.getByRole('dialog', { name: 'Centro de atención', exact: true });
    await attention.waitFor();
    await page.evaluate(() => {
      window.fixture.state.sessions[1].status = 'ready';
      window.fixture.publish();
    });
    await attention.getByText('No hay nada pendiente', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await attention.waitFor({ state: 'detached' });
    assert.equal(await attentionTrigger.count(), 0);
    assert.ok(
      await composer.evaluate((element) => element === document.activeElement),
      'Closing a resolved queue must restore a usable control when its trigger disappears',
    );

    const search = page.getByRole('button', { name: 'Buscar proyectos y sesiones', exact: true });
    await search.click();
    await page
      .getByRole('combobox', { name: 'Buscar proyecto o sesión', exact: true })
      .fill('tokens');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page
      .getByRole('dialog', { name: 'Buscar proyectos y sesiones' })
      .waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), 's2');
    assert.ok(
      await page.getByRole('img', { name: 'Sin cambios locales', exact: true }).isVisible(),
    );
    await page.evaluate(() => {
      const fixture = window.fixture;
      for (let i = 0; i < 30; i++)
        fixture.state.projects.push({
          id: `extra${i}`,
          name: `Archivo ${i}`,
          path: `/tmp/extra${i}`,
        });
      fixture.publish();
    });
    await page.keyboard.press('Meta+k');
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowDown');
    const activeOption = page
      .getByRole('listbox', { name: 'Proyectos y sesiones' })
      .getByRole('option', { selected: true });
    const optionBox = await activeOption.boundingBox();
    const listBox = await page.getByRole('listbox', { name: 'Proyectos y sesiones' }).boundingBox();
    assert.ok(
      optionBox.y >= listBox.y && optionBox.y + optionBox.height <= listBox.y + listBox.height + 1,
      `Keyboard search must scroll the highlighted result into view: ${JSON.stringify({ optionBox, listBox })}`,
    );
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.fixture.state.projects.splice(3);
      window.fixture.publish();
    });

    // Project rail state survives reload; native window controls retain a clear drag area.
    await page.getByRole('button', { name: 'Plegar proyectos' }).click();
    await page.reload();
    await page.locator('.sidebar.collapsed').waitFor();
    await page.getByRole('button', { name: 'Multichat', exact: true }).click();
    await page.locator('.multichat-card:visible').first().waitFor();
    for (const [width, height] of [
      [1440, 960],
      [1024, 768],
      [780, 620],
    ]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `artifacts/v20/grid-${colorScheme}-${width}.png` });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `Page overflows at ${width}`,
      );
      const title = await page.locator('.topbar-slot').boundingBox();
      assert.ok(title.x >= 110, 'Grid toolbar must clear the native macOS window buttons');
      for (const button of await page.locator('button:visible').all()) {
        const name = await button.evaluate(
          (element) =>
            element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            element.textContent.trim(),
        );
        assert.ok(name, 'Every visible icon button must have an accessible label or tooltip');
      }
    }
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    await page.getByRole('tab', { name: 'Interfaz', exact: true }).click();
    await page.getByLabel('Tamaño de fuente del chat', { exact: true }).selectOption('18');
    await page.keyboard.press('Escape');
    for (const selector of [
      '.multichat-preview .md',
      '.multichat-preview .bubble',
      '.multichat-compose-row textarea',
    ]) {
      assert.equal(
        await page
          .locator(`${selector}:visible`)
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize),
        '18px',
        'The grid must preserve the chosen chat font size for messages and drafts',
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: light/dark, desktop/narrow grid, labelled controls, modal focus and shortcuts, search, restored rail, native-titlebar clearance.',
  );
} finally {
  await browser?.close();
  await server.close();
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
