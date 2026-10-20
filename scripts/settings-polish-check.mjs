// Isolated renderer fixtures: no credentials, provider requests, or persistent user data.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const testBuild = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-settings-'))
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
  for (const [colorScheme, width, height] of [
    ['dark', 1200, 900],
    ['light', 1200, 900],
    ['dark', 560, 820],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ protocol }) => {
        const state = {
          profiles: [
            { id: 'claude-1', name: 'Personal', kind: 'claude' },
            { id: 'codex-1', name: 'Trabajo', kind: 'codex' },
            { id: 'openrouter-1', name: 'Modelos API', kind: 'openrouter' },
          ],
          accounts: {
            'claude-1': { status: 'signedIn', label: 'personal@example.test', plan: 'Max' },
            'codex-1': { status: 'signedOut' },
            'openrouter-1': { status: 'signedOut' },
          },
          projects: [{ id: 'p', name: 'Proyecto', path: '/tmp/settings-fixture' }],
          sessions: [
            {
              id: 's',
              projectId: 'p',
              profile: 'claude-1',
              title: 'Diseño de interfaz',
              status: 'ready',
              mode: 'chat',
              approvals: [],
              messages: [],
            },
          ],
          defaultProfile: 'claude-1',
          selectedSession: 's',
          selectedProject: 'p',
          tools: {
            claude: '/tmp/settings-fixture/node_modules/.bin/claude',
            codex:
              '/Applications/Example.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
          },
          dataDir: '/tmp/settings-fixture',
          runtime: { protocol },
          coordination: [],
          theme: 'system',
        };
        const listeners = new Set();
        window.fixture = { actions: [], state };
        window.desk = {
          subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          async invoke(action) {
            window.fixture.actions.push(action);
            if (action.type === 'snapshot') return structuredClone(state);
            if (action.type === 'diff') return { repository: false };
            let result = true;
            if (action.type === 'addAccount') {
              result = { id: `${action.kind}-fixture`, kind: action.kind, name: action.name };
              state.profiles.push(result);
              state.accounts[result.id] = { status: 'signedOut' };
            }
            if (action.type === 'setAccountColor')
              state.profiles.find((p) => p.id === action.profile).color = action.color;
            if (action.type === 'setDefaultAccount') state.defaultProfile = action.profile;
            if (action.type === 'configureOptimization')
              state.profiles.find((p) => p.id === action.profile).optimization =
                action.optimization;
            if (action.type === 'setTheme') state.theme = action.theme;
            if (action.type === 'removeAccount') {
              state.profiles = state.profiles.filter((p) => p.id !== action.profile);
              delete state.accounts[action.profile];
            }
            for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
            return result;
          },
        };
      },
      { protocol },
    );
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Ajustes', exact: true });
    await dialog.waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Cerrar ajustes' })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    const personal = page.getByRole('region', { name: 'Cuenta Personal', exact: true });
    assert.equal(
      await personal.getByLabel('Color de Personal', { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await personal.getByRole('button', { name: 'Eliminar cuenta Personal' }).isVisible(),
      false,
    );
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/settings-v20-${colorScheme}-${width}.png` });
    await personal.getByRole('button', { name: 'Opciones de Personal', exact: true }).click();
    await personal.getByLabel('Color de Personal', { exact: true }).fill('#708c89');
    await personal.getByRole('button', { name: 'Guardar color', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.state.profiles[0].color), '#708c89');
    await personal.getByRole('button', { name: 'Sin color', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.state.profiles[0].color), null);
    await personal.getByLabel('Ahorro de tokens', { exact: true }).selectOption('2');
    await personal.getByRole('switch', { name: 'Modelo auto' }).check();
    assert.deepEqual(await page.evaluate(() => window.fixture.state.profiles[0].optimization), {
      level: 2,
      autoModel: true,
    });
    await personal.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Confirmar cambio de cuenta' });
    await confirmation.waitFor();
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await confirmation
        .getByRole('button', { name: 'Confirmar cierre de sesión' })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    await page.keyboard.press('Escape');
    assert.equal(await confirmation.count(), 0);
    assert.equal(await dialog.count(), 1);
    assert.equal(
      await personal
        .getByRole('button', { name: 'Cerrar sesión', exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    assert.equal(
      await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'accountLogout')),
      false,
    );
    await personal.getByRole('button', { name: 'Eliminar cuenta Personal' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancelar', exact: true })
      .click();
    assert.equal(
      await personal
        .getByRole('button', { name: 'Eliminar cuenta Personal' })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    const work = page.getByRole('region', { name: 'Cuenta Trabajo', exact: true });
    await work.getByRole('button', { name: 'Opciones de Trabajo', exact: true }).click();
    await work.getByLabel('Usar Trabajo como cuenta predeterminada').check();
    assert.equal(await page.evaluate(() => window.fixture.state.defaultProfile), 'codex-1');
    const api = page.getByRole('region', { name: 'Cuenta Modelos API', exact: true });
    await api.getByRole('button', { name: 'Conectar', exact: true }).click();
    assert.equal(await api.getByLabel('Clave API de Modelos API').isVisible(), true);
    await api.getByRole('button', { name: 'Opciones de Modelos API', exact: true }).click();
    await page.locator('.account-tools > summary').click();
    for (const tool of await page.locator('.tool-setting').all()) {
      const label = await tool.locator('strong').boundingBox();
      const button = await tool.getByRole('button').boundingBox();
      assert.ok(label.x < button.x, 'tool label must precede its compact file picker');
      assert.equal(await tool.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
    }
    await page.screenshot({ path: `artifacts/settings-expanded-v20-${colorScheme}-${width}.png` });
    // Closing a creation form and removing a focused account must not strand focus on body.
    const assertModalFocus = async () => {
      await page.waitForFunction(() => {
        const modal = document.querySelector('[role="dialog"][aria-label="Ajustes"]');
        const active = document.activeElement;
        return (
          modal?.contains(active) &&
          active instanceof HTMLElement &&
          active.getClientRects().length > 0 &&
          !active.closest('[hidden], [inert]') &&
          !active.matches(':disabled')
        );
      });
      await page.keyboard.press('Tab');
      assert.equal(
        await dialog.evaluate((el) => el.contains(document.activeElement)),
        true,
        'Tab must remain in settings after its focused control is removed',
      );
    };
    await page.getByRole('button', { name: 'Añadir cuenta', exact: true }).click();
    await page.getByLabel('Nombre de la nueva cuenta', { exact: true }).fill('Temporal');
    await page.getByRole('button', { name: 'Crear perfil', exact: true }).click();
    const temporary = page.getByRole('region', { name: 'Cuenta Temporal', exact: true });
    await temporary.waitFor();
    assert.equal(await page.locator('.add-account-form').count(), 0);
    await assertModalFocus();
    await temporary.getByRole('button', { name: 'Opciones de Temporal', exact: true }).click();
    await temporary.getByRole('button', { name: 'Eliminar cuenta Temporal', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: 'Confirmar eliminación de cuenta', exact: true })
      .getByRole('button', { name: 'Confirmar eliminación', exact: true })
      .click();
    await temporary.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(
      await page.evaluate(() =>
        window.fixture.state.profiles.some((profile) => profile.name === 'Temporal'),
      ),
      false,
    );
    await assertModalFocus();
    await page.getByRole('tab', { name: 'Interfaz', exact: true }).click();
    assert.equal(
      await page.getByLabel('Color de fuente del chat', { exact: true }).isVisible(),
      false,
    );
    await page.locator('summary').filter({ hasText: 'Colores personalizados' }).click();
    await page.getByLabel('Color de fuente del chat', { exact: true }).fill('#aabbcc');
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('agent-desk.interface.v1')).chatColor,
      ),
      '#aabbcc',
    );
    await page.getByRole('radio', { name: 'Oscuro', exact: true }).click();
    assert.equal(
      await page.getByRole('radio', { name: 'Oscuro', exact: true }).getAttribute('aria-checked'),
      'true',
    );
    await page.getByRole('radio', { name: 'Oscuro', exact: true }).press('ArrowLeft');
    assert.equal(
      await page.getByRole('radio', { name: 'Claro', exact: true }).getAttribute('aria-checked'),
      'true',
    );
    await page.getByRole('radio', { name: 'Claro', exact: true }).press('Home');
    assert.equal(
      await page.getByRole('radio', { name: 'Sistema', exact: true }).getAttribute('aria-checked'),
      'true',
    );
    await page.screenshot({ path: `artifacts/settings-interface-v20-${colorScheme}-${width}.png` });
    await page.getByRole('tab', { name: 'Red', exact: true }).click();
    await page.getByLabel('Modo de proxy', { exact: true }).selectOption('manual');
    await page.getByLabel('Servidor del proxy', { exact: true }).fill('proxy.example.test');
    await page.locator('.proxy-credentials > summary').click();
    await page.getByLabel('Usuario del proxy', { exact: true }).fill('fixture-user');
    await page.getByLabel('Usuario del proxy', { exact: true }).fill('');
    assert.equal(await page.locator('.proxy-credentials').evaluate((el) => el.open), true);
    assert.equal(
      await page
        .getByLabel('Usuario del proxy', { exact: true })
        .evaluate((el) => document.activeElement === el && el.getBoundingClientRect().height > 0),
      true,
      'clearing a username must keep its focused field visible',
    );
    await page.getByLabel('Usuario del proxy', { exact: true }).fill('fixture-user');
    await page.getByLabel('Contraseña del proxy', { exact: true }).fill('fixture-password');
    await page.getByLabel('Modo de proxy', { exact: true }).selectOption('system');
    assert.equal(await page.getByLabel('Servidor del proxy', { exact: true }).count(), 0);
    await page.getByLabel('Modo de proxy', { exact: true }).selectOption('manual');
    assert.equal(
      await page.getByLabel('Usuario del proxy', { exact: true }).inputValue(),
      'fixture-user',
    );
    assert.equal(
      await page.getByLabel('Contraseña del proxy', { exact: true }).inputValue(),
      'fixture-password',
    );
    await page.locator('.proxy-credentials > summary').click();
    await page.screenshot({ path: `artifacts/settings-network-v20-${colorScheme}-${width}.png` });
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
      'settings must not scroll horizontally',
    );
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(
      await page
        .getByRole('button', { name: 'Ajustes', exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: compact accounts; color, defaults and optimization; modal focus after account creation/deletion and confirmation cancellation; interface preferences; responsive dark/light settings and network.',
  );
} finally {
  await browser?.close();
  await server.close();
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
