// Full renderer with synthetic accounts and tools. No inference or real account data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const server = await createServer({ server: { host: '127.0.0.1', port: 5188, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  });
  await fs.mkdir('artifacts/minimal-workspace', { recursive: true });
  for (const colorScheme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 1360, height: 900 },
      colorScheme,
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ protocol }) => {
        const models = [
          {
            value: 'gpt-fixture',
            displayName: 'GPT Fixture',
            isDefault: true,
            defaultEffort: 'high',
            supportedEffortLevels: ['low', 'high'],
          },
          { value: 'gpt-6.1-terra', displayName: 'GPT-6.1-Terra', supportedEffortLevels: ['high'] },
        ];
        const state = {
          runtime: { protocol },
          theme: 'system',
          tools: {},
          coordination: [],
          dataDir: '/tmp/fixture',
          profiles: [
            { id: 'codex', kind: 'codex', name: 'Personal' },
            { id: 'codex-2', kind: 'codex', name: 'Trabajo' },
          ],
          accounts: { codex: { status: 'signedIn' }, 'codex-2': { status: 'signedIn' } },
          defaultProfile: 'codex',
          projects: [{ id: 'p', name: 'mini-editor', path: '/tmp/fixture' }],
          selectedProject: 'p',
          selectedSession: 's',
          browsers: [],
          terminals: [],
          sessions: [
            {
              id: 's',
              projectId: 'p',
              profile: 'codex',
              title: 'Una interfaz más sencilla',
              status: 'ready',
              account: 'fixture',
              accountLocked: true,
              approvals: [],
              modelsFetchedAt: Date.now(),
              codexConfig: {
                model: 'gpt-fixture',
                effort: 'high',
                sandbox: 'workspace-write',
                approvalPolicy: 'on-request',
              },
              info: { models, tools: [], commands: [], mcpServers: [] },
              messages: [
                { id: 'u', role: 'user', text: 'Simplifica el espacio de trabajo.' },
                {
                  id: 'a',
                  role: 'assistant',
                  text: 'El chat reúne los controles en el cuadro de escritura. Las herramientas se abren en un panel con pestañas para mantener el trabajo a mano.',
                },
              ],
            },
          ],
        };
        const listeners = new Set();
        const publish = () =>
          listeners.forEach((fn) => fn({ type: 'state', state: structuredClone(state) }));
        window.fixture = { state, actions: [], publish };
        window.desk = {
          subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          invoke: async (action) => {
            window.fixture.actions.push(action);
            const chat = state.sessions[0];
            if (action.type === 'snapshot') return structuredClone(state);
            if (action.type === 'pickImages') return [];
            if (action.type === 'diff') return { repository: false };
            if (action.type === 'changeSessionAccount') {
              chat.profile = action.profile;
              chat.status = 'stopped';
            }
            if (action.type === 'refreshModels') {
              chat.info.models = models;
              chat.modelsFetchedAt = Date.now();
            }
            if (action.type === 'configureCodex') Object.assign(chat.codexConfig, action.config);
            if (action.type === 'openProjectTerminal')
              state.terminals = [
                { id: 'shell:p', projectId: 'p', kind: 'shell', status: 'terminal' },
              ];
            if (action.type === 'terminalBuffer')
              return { data: 'mini-editor % echo listo\r\nlisto\r\nmini-editor % ', sequence: 1 };
            if (action.type === 'workspaceFiles')
              return {
                root: '/tmp/fixture',
                entries: [
                  { path: 'src', name: 'src', kind: 'directory' },
                  { path: 'README.md', name: 'README.md', kind: 'file' },
                ],
                truncated: false,
              };
            if (action.type === 'workspaceFile')
              return {
                root: '/tmp/fixture',
                path: action.path,
                content: '# Mini editor\n\nUna interfaz más sencilla.',
                size: 42,
                binary: false,
                truncated: false,
              };
            if (action.type === 'browserNew') {
              const tab = {
                id: 'b' + state.browsers.length,
                projectId: 'p',
                sessionId: 's',
                title: 'Nueva página',
                url: '',
                zoom: 1,
                loading: false,
                canGoBack: false,
                canGoForward: false,
              };
              state.browsers.push(tab);
              publish();
              return tab;
            }
            publish();
            return true;
          },
        };
      },
      { protocol },
    );
    await page.goto('http://127.0.0.1:5188');
    const composer = page.locator('.desk-input .composer');
    const account = composer.getByRole('button', { name: 'Cuenta del chat', exact: true });
    await account.waitFor();
    const message = page.getByRole('textbox', { name: 'Mensaje', exact: true });
    await message.fill('/term');
    await page.getByRole('option', { name: /terminal.*Terminal del proyecto/i }).waitFor();
    await message.press('Escape');
    assert.equal(await page.getByRole('listbox', { name: 'Comandos' }).count(), 0);
    await message.fill('');
    await page.evaluate(() => {
      window.fixture.state.sessions[0].status = 'working';
      window.fixture.publish();
    });
    await composer.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
    await message.focus();
    await message.press('Escape');
    assert.equal(
      await composer
        .getByRole('button', { name: 'Herramientas del chat', exact: true })
        .getAttribute('aria-expanded'),
      'false',
    );
    assert.equal(
      await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'interrupt')),
      false,
    );
    await page.evaluate(() => {
      window.fixture.state.sessions[0].status = 'ready';
      window.fixture.publish();
    });
    await page.getByRole('button', { name: 'Multichat', exact: true }).click();
    const smallCard = page.locator('.multichat-card').first();
    await smallCard.waitFor();
    assert.equal(
      await smallCard.getByRole('button', { name: 'Detalles del chat', exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: 'Multichat', exact: true }).click();
    await account.waitFor();
    assert.equal(await composer.getByRole('button', { name: 'Adjuntar archivos' }).count(), 0);
    await composer.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
    await composer.getByRole('button', { name: 'Adjuntar archivos', exact: true }).click();
    assert.equal(await composer.getByRole('button', { name: 'Adjuntar archivos' }).count(), 0);
    assert.ok(
      await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'pickImages')),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.hasAttribute('data-original-style')),
      true,
    );
    await page.evaluate(() => {
      localStorage.setItem('agent-desk.styles.v1', ':root { --fixture-style: 1; }');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'agent-desk.styles.v1', storageArea: localStorage }),
      );
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.hasAttribute('data-original-style')),
      false,
    );
    await page.evaluate(() => {
      localStorage.removeItem('agent-desk.styles.v1');
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'agent-desk.styles.v1', storageArea: localStorage }),
      );
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.hasAttribute('data-original-style')),
      true,
    );
    assert.equal(
      await account.isEnabled(),
      true,
      'existing history must not lock account selection',
    );
    assert.equal(await page.locator('.composer-footer').count(), 0, 'no controls below the input');
    assert.equal(
      await composer.locator('.git-context').count(),
      0,
      'repository stays in information panel',
    );
    await page
      .getByRole('textbox', { name: 'Mensaje', exact: true })
      .fill('Conserva este borrador al cambiar de cuenta.');
    await account.click();
    await page
      .getByRole('dialog', { name: 'Cuenta del chat' })
      .getByRole('button', { name: 'Trabajo', exact: true })
      .click();
    await page.waitForFunction(() => window.fixture.state.sessions[0].profile === 'codex-2');
    assert.equal(
      await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
      'Conserva este borrador al cambiar de cuenta.',
    );
    assert.match(await page.locator('#conversation-content').innerText(), /herramientas se abren/);
    const modelButton = composer.getByRole('button', { name: 'Modelo de Codex', exact: true });
    assert.equal(await modelButton.locator('svg').count(), 0, 'model selector has no icon');
    const accountBounds = await account.boundingBox();
    const modelBounds = await modelButton.boundingBox();
    assert.ok(
      accountBounds.x + accountBounds.width <= modelBounds.x + 1,
      'account is beside and left of the model',
    );
    assert.equal(
      await page
        .locator('.top-actions')
        .getByRole('button', { name: 'Navegador', exact: true })
        .count(),
      0,
    );
    await composer.getByRole('button', { name: 'Modelo de Codex', exact: true }).click();
    await page.getByRole('button', { name: 'Actualizar modelos', exact: true }).click();
    await page.waitForFunction(() =>
      window.fixture.actions.some((a) => a.type === 'refreshModels'),
    );
    const modelMenu = page.getByRole('dialog', { name: 'Modelo de Codex' });
    const beforeMenu = await modelMenu.boundingBox();
    await modelMenu.getByRole('button', { name: 'GPT-6.1-Terra', exact: true }).click();
    let sideMenu = page.getByRole('dialog', { name: 'Intensidad · GPT-6.1-Terra' });
    await sideMenu.waitFor();
    await page.screenshot({ path: `artifacts/minimal-workspace/model-menu-${colorScheme}.png` });
    const afterMenu = await modelMenu.boundingBox();
    assert.deepEqual(afterMenu, beforeMenu, 'opening intensity does not move the model menu');
    const sideBounds = await sideMenu.boundingBox();
    assert.ok(
      sideBounds.x + sideBounds.width <= afterMenu.x ||
        sideBounds.x >= afterMenu.x + afterMenu.width,
      'intensity opens beside the model menu',
    );
    assert.equal(
      await page.evaluate(() => window.fixture.state.sessions[0].codexConfig.model),
      'gpt-fixture',
      'model stays unchanged until effort is selected',
    );
    await page.keyboard.press('Escape');
    assert.equal(await sideMenu.count(), 0, 'Escape cancels the pending model');
    assert.equal(
      await page.evaluate(() => window.fixture.state.sessions[0].codexConfig.model),
      'gpt-fixture',
    );
    await modelMenu.getByRole('button', { name: 'GPT-6.1-Terra', exact: true }).click();
    sideMenu = page.getByRole('dialog', { name: 'Intensidad · GPT-6.1-Terra' });
    assert.equal(await sideMenu.getByRole('button', { name: 'Low', exact: true }).count(), 0);
    await sideMenu.getByRole('button', { name: 'High', exact: true }).click();
    await page.waitForFunction(
      () => window.fixture.state.sessions[0].codexConfig.effort === 'high',
    );
    assert.equal(
      await page.evaluate(() => window.fixture.state.sessions[0].codexConfig.model),
      'gpt-6.1-terra',
    );
    await page.screenshot({ path: `artifacts/minimal-workspace/chat-${colorScheme}.png` });
    await composer.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
    await composer.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('tab', { name: 'Terminal', exact: true }).waitFor();
    await page.locator('.xterm').waitFor();
    assert.equal(await page.locator('.terminal-pane').count(), 1);
    await page.evaluate(() => {
      window.fixture.state.sessions[0].status = 'working';
      window.fixture.publish();
    });
    const shellInput = page.locator('.xterm-helper-textarea');
    await shellInput.focus();
    await shellInput.press('Escape');
    assert.equal(
      await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'interrupt')),
      false,
      'terminal Escape never interrupts the agent',
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'Panel de trabajo', exact: true })
        .getAttribute('aria-expanded'),
      'true',
    );
    await page.evaluate(() => {
      window.fixture.state.sessions[0].status = 'ready';
      window.fixture.publish();
    });

    await page.getByRole('button', { name: 'Abrir herramienta', exact: true }).click();
    await page
      .locator('.dock-launcher')
      .getByRole('button', { name: /Archivos/ })
      .click();
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await page.getByRole('region', { name: 'Contenido de README.md' }).waitFor();
    await page.screenshot({ path: `artifacts/minimal-workspace/files-${colorScheme}.png` });
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    assert.equal(
      await page.evaluate(
        () => window.fixture.actions.filter((a) => a.type === 'openProjectTerminal').length,
      ),
      2,
      'reopening reuses the project terminal action',
    );
    await page.getByRole('tab', { name: 'Archivos', exact: true }).click();
    await page.getByRole('region', { name: 'Contenido de README.md' }).waitFor();
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Ampliar panel', exact: true }).click();
    assert.equal(await page.locator('.conversation').isVisible(), false);
    const expandedBounds = await page.locator('.workspace-tools').boundingBox();
    const workspaceBounds = await page.locator('.workspace-shell').boundingBox();
    assert.ok(
      expandedBounds.width >= workspaceBounds.width - 2,
      'expanded tools fill the workspace',
    );
    await page.screenshot({ path: `artifacts/minimal-workspace/terminal-${colorScheme}.png` });
    await page.getByRole('button', { name: 'Reducir panel', exact: true }).click();
    await page.getByRole('button', { name: 'Abrir herramienta', exact: true }).click();
    await page
      .locator('.dock-launcher')
      .getByRole('button', { name: /Navegador/ })
      .click();
    await page.getByRole('region', { name: 'Navegador integrado' }).waitFor();
    // Escape from the composer closes tools; it must not interrupt an active agent.
    await page.evaluate(() => {
      window.fixture.state.sessions[0].status = 'working';
      window.fixture.publish();
    });
    await message.focus();
    await message.press('Escape');
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Panel de trabajo"]').getAttribute('aria-expanded') ===
        'false',
    );
    assert.equal(
      await page.evaluate(() => window.fixture.actions.some((a) => a.type === 'interrupt')),
      false,
    );
    await page.evaluate(() => {
      window.fixture.state.sessions[0].status = 'ready';
      window.fixture.publish();
    });
    await page.getByRole('button', { name: 'Panel de trabajo', exact: true }).click();

    await page.getByRole('tab', { name: 'Navegador', exact: true }).click();
    const panelButton = page.getByRole('button', { name: 'Panel de trabajo', exact: true });
    assert.equal(await panelButton.getAttribute('aria-expanded'), 'true');
    await panelButton.click();
    assert.equal(await panelButton.getAttribute('aria-expanded'), 'false');
    await panelButton.click();
    assert.equal(
      await page.evaluate(() => window.fixture.state.browsers.length),
      1,
      'blank browser works without a dev server',
    );
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
    await page.getByRole('tab', { name: 'Navegador', exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.fixture.state.browsers.length),
      1,
      'reopening a blank browser does not duplicate it',
    );
    await page.getByRole('tab', { name: 'Archivos', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(
      await page.getByRole('tab', { name: 'Terminal', exact: true }).getAttribute('aria-selected'),
      'true',
    );
    await page.getByRole('button', { name: 'Cerrar pestaña Terminal', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: 'Terminal', exact: true }).count(), 0);
    assert.equal(
      await page
        .getByRole('tab', { name: 'Navegador', exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
      'closing the active tab restores focus to its replacement',
    );
    await page.getByRole('button', { name: 'Ocultar panel de herramientas', exact: true }).click();
    await page.setViewportSize({ width: 620, height: 780 });
    await page.waitForTimeout(200);
    await modelButton.click();
    await page
      .getByRole('dialog', { name: 'Modelo de Codex' })
      .getByRole('button', { name: 'GPT Fixture', exact: true })
      .click();
    const compactSide = page.getByRole('dialog', { name: 'Intensidad · GPT Fixture' });
    const compactSideBounds = await compactSide.boundingBox();
    assert.ok(
      compactSideBounds.x >= 0 && compactSideBounds.x + compactSideBounds.width <= 620,
      'intensity remains on screen at compact width',
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const rect = await composer.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 621);
    const send = await composer.getByRole('button', { name: 'Enviar', exact: true }).boundingBox();
    assert.ok(
      send.x + send.width <= rect.x + rect.width + 1,
      'send stays inside the compact composer',
    );
    await page.screenshot({ path: `artifacts/minimal-workspace/compact-${colorScheme}.png` });
    for (const inputWidth of [360, 280, 230, 200]) {
      await page.locator('.desk-input').evaluate((element, width) => {
        element.style.width = `${width}px`;
      }, inputWidth);
      const geometry = await composer.evaluate((element) => {
        const row = element.querySelector('.composer-bar');
        const inputs = [
          row.querySelector('.tools-toggle'),
          row.querySelector('[aria-label="Permisos de Codex"]'),
          row.querySelector('[aria-label="Cuenta del chat"]'),
          row.querySelector('[aria-label="Modelo de Codex"]'),
          row.querySelector('.footer-insight'),
          row.querySelector('.send'),
        ].filter((node) => node && getComputedStyle(node).display !== 'none');
        const box = (node) => {
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, width: r.width, height: r.height };
        };
        return {
          parent: box(row),
          controls: inputs.map(box),
          scrollWidth: row.scrollWidth,
          clientWidth: row.clientWidth,
        };
      });
      for (const [index, control] of geometry.controls.entries()) {
        assert.ok(control.width >= 16, `usable control at ${inputWidth}px`);
        assert.ok(
          control.x >= geometry.parent.x - 1 && control.right <= geometry.parent.right + 1,
          `control stays in row at ${inputWidth}px`,
        );
        if (index) {
          assert.ok(
            control.x >= geometry.controls[index - 1].right - 1,
            `no overlapping controls at ${inputWidth}px`,
          );
          assert.ok(
            Math.abs(
              control.y +
                control.height / 2 -
                (geometry.controls[0].y + geometry.controls[0].height / 2),
            ) <= 2,
            `controls stay on one row at ${inputWidth}px`,
          );
        }
      }
      if (inputWidth === 280)
        await page.screenshot({ path: `artifacts/minimal-workspace/narrow-${colorScheme}.png` });
      await account.click();
      await page.getByRole('dialog', { name: 'Cuenta del chat' }).waitFor();
      await page.keyboard.press('Escape');
      await modelButton.click();
      await page.getByRole('dialog', { name: 'Modelo de Codex' }).waitFor();
      await page.keyboard.press('Escape');
      await composer.getByRole('button', { name: 'Permisos de Codex', exact: true }).click();
      await page.getByRole('dialog', { name: 'Permisos de Codex' }).waitFor();
      await page.keyboard.press('Escape');
      await composer.locator('.footer-insight').focus();
      const tooltip = composer.locator('.footer-insight-card');
      await tooltip.waitFor({ state: 'visible' });
      const tooltipBounds = await tooltip.boundingBox();
      const inputBounds = await composer.boundingBox();
      assert.ok(
        tooltipBounds.x >= inputBounds.x - 1 &&
          tooltipBounds.x + tooltipBounds.width <= inputBounds.x + inputBounds.width + 1,
        `context stays inside the composer at ${inputWidth}px`,
      );
      await page.getByRole('textbox', { name: 'Mensaje', exact: true }).focus();
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'OK: composer, account draft/history, model refresh, tools, terminal reuse, blank browser, keyboard, expand/collapse and compact layout.',
  );
} finally {
  await browser?.close();
  await server.close();
}
