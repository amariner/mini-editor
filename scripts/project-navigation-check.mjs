// Isolated renderer checks for project/chat navigation. No personal data or provider calls.
// Always build into a temporary folder so a running development app is never overwritten.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-project-navigation-'));
const artifactRoot = 'artifacts/project-navigation';
await fs.mkdir(artifactRoot, { recursive: true });
const checks = [];
const startedAt = Date.now();
let browser, server, currentPage;
const check = (label) => checks.push(label);
const center = async (locator) => {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, `Missing visible bounds for ${locator}`);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
};
const assertAligned = async (one, two, axis, label) => {
  const a = await center(one),
    b = await center(two);
  assert.ok(Math.abs(a[axis] - b[axis]) <= 1.5, `${label}: ${a[axis]} vs ${b[axis]}`);
};
const selected = (page, id) =>
  page.waitForFunction((id) => window.fixture.state.selectedSession === id, id);
const actionCount = (page, type) =>
  page.evaluate((type) => window.fixture.actions.filter((a) => a.type === type).length, type);
const visuallyHidden = (page, selector) =>
  page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    if (!element) return true;
    const style = getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
  }, selector);
const visiblyShown = (page, selector) =>
  page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.95
    );
  }, selector);

async function fixture(page) {
  await page.addInitScript((protocol) => {
    localStorage.setItem('agent-desk.sidebar-collapsed', 'false');
    const session = (id, title, projectId = 'p') => ({
      id,
      projectId,
      title,
      profile: 'claude-1',
      mode: 'chat',
      status: 'stopped',
      approvals: [],
      messages: [],
      accountLocked: false,
      stats: { cost: 0, turns: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      info: { models: [{ value: 'fixture', displayName: 'Fixture' }], commands: [] },
    });
    const state = {
      profiles: [
        {
          id: 'claude-1',
          kind: 'claude',
          name: 'Cuenta de prueba',
          optimization: { level: 0, autoModel: false },
        },
      ],
      defaultProfile: 'claude-1',
      accounts: {},
      tools: {},
      theme: 'system',
      dataDir: '/tmp/project-navigation-fixture',
      projects: [
        { id: 'p', name: 'Estudio', path: '/tmp/project-navigation-fixture/studio' },
        { id: 'q', name: 'Documentación', path: '/tmp/project-navigation-fixture/docs' },
      ],
      sessions: [session('s1', 'Revisar interfaz'), session('s2', 'Preparar pruebas')],
      selectedProject: 'p',
      selectedSession: 's1',
      browsers: [],
      devServers: [],
      coordination: [],
      floatingChats: [],
      runtime: { protocol, instanceId: 'navigation-fixture' },
    };
    const listeners = new Set();
    const publish = () =>
      listeners.forEach((listener) => listener({ type: 'state', state: structuredClone(state) }));
    window.fixture = { state, publish, actions: [], unexpected: [], session };
    window.desk = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async invoke(action) {
        window.fixture.actions.push(action);
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'diff')
          return {
            repository: true,
            branch: 'main',
            branches: ['main', 'feature/design'],
            files: [],
            commits: [],
            counts: { conflicts: 0, staged: 0, unstaged: 0 },
            lines: { added: 0, removed: 0 },
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
          };
        if (action.type === 'listFiles') return [];
        if (
          [
            'refreshUsage',
            'accountRefresh',
            'refreshModels',
            'browserPresent',
            'gitOperation',
          ].includes(action.type)
        )
          return true;
        if (action.type === 'select') {
          state.selectedProject = action.projectId;
          state.selectedSession = action.sessionId;
        } else if (action.type === 'renameProject') {
          state.projects.find((p) => p.id === action.projectId).name = action.name;
        } else if (action.type === 'rename') {
          state.sessions.find((s) => s.id === action.sessionId).title = action.title;
        } else if (action.type === 'newSession') {
          const created = session(
            `s${state.sessions.length + 1}`,
            `Chat ${state.sessions.length + 1}`,
            action.projectId,
          );
          state.sessions.push(created);
          state.selectedProject = action.projectId;
          state.selectedSession = created.id;
          publish();
          return structuredClone(created);
        } else if (action.type === 'setIsolation') {
          state.sessions.find((s) => s.id === action.sessionId).isolation = action.isolation;
        } else if (action.type === 'deleteSession') {
          state.sessions = state.sessions.filter((s) => s.id !== action.sessionId);
        } else if (action.type === 'floatingChat') {
          // Keep this renderer's fixture mounted so repeated gesture IPC can be counted.
          return true;
        } else if (action.type === 'addProject') {
          state.projects.push({
            id: 'added',
            name: 'Nuevo proyecto',
            path: '/tmp/project-navigation-fixture/new',
          });
        } else {
          window.fixture.unexpected.push(action);
          throw new Error(`Unexpected fixture action: ${action.type}`);
        }
        publish();
        return true;
      },
    };
  }, protocol);
}

try {
  await build({ build: { outDir: output, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  for (const colorScheme of ['dark', 'light']) {
    const page = (currentPage = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      colorScheme,
      reducedMotion: 'reduce',
    }));
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await fixture(page);
    await page.goto(server.resolvedUrls.local[0]);
    const sidebar = page.locator('.sidebar');
    const firstProject = page.locator('[data-project-id="p"]');
    const projectName = firstProject.locator('.project-name');
    const composer = page.getByRole('textbox', { name: 'Mensaje', exact: true });
    await composer.waitFor();
    assert.equal(
      await page.locator('.session-tabs-bar').count(),
      0,
      'The top chat tabs must be removed',
    );
    assert.equal(
      await page.locator('.workspace > .isolation-bar').count(),
      0,
      'Worktree isolation belongs in the bottom Git panel',
    );
    assert.equal(
      await page.getByRole('button', { name: /^(Plegar|Expandir) proyectos$/ }).count(),
      0,
      'No dedicated sidebar-collapse control',
    );
    assert.equal(
      await page.getByRole('button', { name: /^Sacar chat / }).count(),
      0,
      'Floating chat creation uses drag',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Buscar proyectos y sesiones', exact: true }).count(),
      0,
      'Search stays hidden when projects fit',
    );
    check(`${colorScheme}: removed top chrome and redundant controls`);

    const addProject = page.getByRole('button', { name: 'Añadir proyecto', exact: true });
    await composer.focus();
    await page.mouse.move(1000, 150);
    await visuallyHidden(page, '.project-tools button[aria-label="Añadir proyecto"]');
    await sidebar.locator('.traffic-space').hover();
    await visiblyShown(page, '.project-tools button[aria-label="Añadir proyecto"]');
    await assertAligned(
      addProject.locator('svg'),
      projectName.locator('.project-mark'),
      'x',
      'Add project aligns with the project mark',
    );
    await addProject.focus();
    await page.mouse.move(1000, 150);
    await visiblyShown(page, '.project-tools button[aria-label="Añadir proyecto"]');
    check(
      `${colorScheme}: project add appears on hover and keyboard focus, aligned with project icon`,
    );

    const row = firstProject.locator('.project-chat-row').first();
    const chat = row.locator('.project-chat');
    const status = row.locator('.project-chat-status svg');
    const deleteButton = row.locator('.project-chat-delete');
    const statusCenter = await center(status);
    await chat.hover();
    await visiblyShown(
      page,
      '[data-project-id="p"] .project-chat-row:first-child .project-chat-delete',
    );
    const deleteCenter = await center(deleteButton.locator('svg'));
    assert.ok(
      Math.abs(statusCenter.x - deleteCenter.x) <= 1.5 &&
        Math.abs(statusCenter.y - deleteCenter.y) <= 1.5,
      'Delete icon replaces the status dot in exactly the same position',
    );
    assert.equal(await deleteButton.locator('.lucide-x').count(), 1, 'Delete uses a cross');
    await firstProject.hover();
    const newChat = firstProject
      .getByRole('button', { name: /Nueva conversación|Nuevo chat/ })
      .first();
    await newChat.waitFor();
    assert.equal(await newChat.locator('.lucide-plus').count(), 0, 'New chat uses a writing icon');
    const newChatBounds = await newChat.boundingBox();
    const projectNameBounds = await projectName.boundingBox();
    const projectStatusBounds = await firstProject.locator('.project-status').boundingBox();
    assert.ok(
      newChatBounds.x >= projectNameBounds.x + projectNameBounds.width - 1 &&
        newChatBounds.x + newChatBounds.width <= projectStatusBounds.x + 1,
      'Writing action follows the project name, before the separate status column',
    );
    await assertAligned(newChat, projectName, 'y', 'Writing action shares the project baseline');
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-desktop.png` });
    check(`${colorScheme}: chat deletion replaces status, writing action follows the project name`);

    const switcher = page.locator('.chat-switcher-trigger');
    await switcher.waitFor();
    const projectBounds = await page.locator('.git-summary-project').boundingBox();
    const switcherBounds = await switcher.boundingBox();
    assert.ok(
      switcherBounds.x >= projectBounds.x + projectBounds.width - 1,
      'Chat title follows the project name',
    );
    assert.ok(
      Math.abs(
        switcherBounds.y + switcherBounds.height / 2 - (projectBounds.y + projectBounds.height / 2),
      ) <= 2,
      'Project and chat share the same line',
    );
    await composer.fill('Borrador que debe conservarse');
    await switcher.click();
    const menu = page.getByRole('menu', { name: 'Chats de Estudio', exact: true });
    await menu.waitFor();
    await menu.getByRole('menuitemradio').filter({ hasText: 'Preparar pruebas' }).click();
    await selected(page, 's2');
    await page.waitForFunction(() =>
      document.querySelector('.chat-switcher-trigger')?.textContent.includes('Preparar pruebas'),
    );
    assert.equal(await composer.inputValue(), '');
    await firstProject.locator('.project-chat').filter({ hasText: 'Revisar interfaz' }).click();
    await selected(page, 's1');
    await page.waitForFunction(
      () => document.querySelector('.composer textarea')?.value === 'Borrador que debe conservarse',
    );
    await switcher.focus();
    await switcher.press('ArrowDown');
    await menu.waitFor();
    await page.waitForFunction(() =>
      document.querySelector('.chat-switcher-menu')?.contains(document.activeElement),
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.querySelector('.chat-switcher-trigger') === document.activeElement,
    );
    check(
      `${colorScheme}: bottom chat selector and sidebar navigate without losing drafts, keyboard focus retained`,
    );

    await page.getByRole('button', { name: 'Gestionar ramas y Git', exact: true }).click();
    const worktree = page.getByRole('checkbox', { name: 'Aislar en worktree', exact: false });
    await worktree.waitFor();
    assert.equal(
      await worktree.locator('xpath=ancestor::*[contains(@class,"git-workflow")]').count(),
      1,
      'Worktree isolation is inside bottom Git workflow',
    );
    await worktree.check();
    await page.waitForFunction(
      () => window.fixture.state.sessions.find((s) => s.id === 's1').isolation === 'worktree',
    );
    await page.getByRole('button', { name: 'Gestionar ramas y Git', exact: true }).click();
    check(`${colorScheme}: worktree isolation is actionable in the bottom Git panel`);

    await switcher.focus();
    await switcher.press('F2');
    const chatName = page.getByRole('textbox', { name: 'Nombre del chat', exact: true });
    await chatName.fill('Interfaz revisada');
    await chatName.press('Enter');
    await page.waitForFunction(
      () => window.fixture.state.sessions[0].title === 'Interfaz revisada',
    );
    await switcher.click();
    await menu.getByRole('menuitem', { name: 'Cambiar nombre del chat', exact: false }).click();
    await chatName.fill('Revisar interfaz');
    await chatName.press('Enter');
    await page.waitForFunction(() => window.fixture.state.sessions[0].title === 'Revisar interfaz');
    check(`${colorScheme}: chat names remain editable from the selector menu and F2`);

    // Lifting a chat gives feedback; only a completed drop outside its source area floats it.
    const drag = async (outside = true) => {
      const from = await center(chat);
      const zone = await sidebar.boundingBox();
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(outside ? zone.x + zone.width + 130 : from.x + 14, from.y + 16, {
        steps: 5,
      });
      await page.locator('.chat-detach-preview').waitFor();
    };
    const preview = page.locator('.chat-detach-preview');
    const selectionsBeforeDrag = await actionCount(page, 'select');
    await drag(false);
    assert.equal(await preview.getAttribute('data-detach-ready'), 'false');
    await page.mouse.up();
    await preview.waitFor({ state: 'detached' });
    assert.equal(await actionCount(page, 'floatingChat'), 0);
    await drag();
    assert.equal(await preview.getAttribute('data-detach-ready'), 'true');
    assert.equal(await preview.locator('svg[class*="lucide-picture-in-picture"]').count(), 1);
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-drag-preview.png` });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await preview.waitFor({ state: 'detached' });
    assert.equal(await actionCount(page, 'floatingChat'), 0, 'Escape must cancel floating');
    await drag();
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
    await page.mouse.up();
    await preview.waitFor({ state: 'detached' });
    assert.equal(await actionCount(page, 'floatingChat'), 0, 'Window blur must cancel floating');
    await drag();
    await page.mouse.up();
    await preview.waitFor({ state: 'detached' });
    assert.equal(
      await actionCount(page, 'floatingChat'),
      1,
      'A drop outside opens exactly one floating window',
    );
    assert.equal(
      await actionCount(page, 'select'),
      selectionsBeforeDrag,
      'A drag must not also click/select a chat',
    );
    assert.equal(await composer.inputValue(), 'Borrador que debe conservarse');
    await chat.focus();
    await chat.press('Alt+Shift+f');
    assert.equal(
      await actionCount(page, 'floatingChat'),
      2,
      'The floating gesture has a keyboard alternative',
    );
    check(
      `${colorScheme}: lift preview, inside/Escape/blur cancellation, one floating action per drop, draft retained`,
    );

    const floatingBeforeTitleDrag = await actionCount(page, 'floatingChat');
    const dragTitle = async (outside = true) => {
      const from = await center(switcher);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 12, from.y + (outside ? -100 : 0), { steps: 5 });
      await preview.waitFor();
    };
    await dragTitle(false);
    assert.equal(await preview.getAttribute('data-detach-ready'), 'false');
    await page.mouse.up();
    await preview.waitFor({ state: 'detached' });
    assert.equal(await switcher.getAttribute('aria-expanded'), 'false');
    assert.equal(await actionCount(page, 'floatingChat'), floatingBeforeTitleDrag);
    await dragTitle();
    assert.equal(await preview.getAttribute('data-detach-ready'), 'true');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await preview.waitFor({ state: 'detached' });
    assert.equal(await switcher.getAttribute('aria-expanded'), 'false');
    assert.equal(await actionCount(page, 'floatingChat'), floatingBeforeTitleDrag);
    await dragTitle();
    await page.mouse.up();
    await preview.waitFor({ state: 'detached' });
    assert.equal(await switcher.getAttribute('aria-expanded'), 'false');
    assert.equal(await actionCount(page, 'floatingChat'), floatingBeforeTitleDrag + 1);
    assert.equal(await composer.inputValue(), 'Borrador que debe conservarse');
    check(
      `${colorScheme}: composer title drag cancels without opening its menu and floats once on drop`,
    );

    // Project rename remains reachable without conflicting with the new double-click gesture.
    await projectName.focus();
    await projectName.press('F2');
    const name = page.getByRole('textbox', { name: 'Nombre del proyecto', exact: true });
    await name.fill('Estudio de interfaz');
    await name.press('Enter');
    await page.waitForFunction(
      () => window.fixture.state.projects[0].name === 'Estudio de interfaz',
    );
    await projectName.dblclick();
    await page.waitForFunction(() =>
      document.querySelector('.sidebar')?.classList.contains('collapsed'),
    );
    assert.equal(await name.count(), 0, 'Double click collapses rather than entering rename');
    await sidebar.locator('.traffic-space').hover();
    await assertAligned(
      addProject.locator('svg'),
      projectName.locator('.project-mark'),
      'x',
      'Collapsed add project aligns with the project mark',
    );
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-collapsed.png` });
    await projectName.dblclick();
    await page.waitForFunction(
      () => !document.querySelector('.sidebar')?.classList.contains('collapsed'),
    );
    await sidebar.dblclick({ position: { x: 12, y: 420 } });
    await page.waitForFunction(() =>
      document.querySelector('.sidebar')?.classList.contains('collapsed'),
    );
    await sidebar.dblclick({ position: { x: 12, y: 420 } });
    await page.waitForFunction(
      () => !document.querySelector('.sidebar')?.classList.contains('collapsed'),
    );
    check(`${colorScheme}: double-click widget toggles width and F2 renames project`);

    await page.evaluate(() => {
      window.fixture.state.projects.push(
        ...Array.from({ length: 28 }, (_, index) => ({
          id: `extra-${index}`,
          name: `Proyecto adicional ${index}`,
          path: `/tmp/project-navigation-fixture/extra-${index}`,
        })),
      );
      window.fixture.publish();
    });
    const search = page.getByRole('button', { name: 'Buscar proyectos y sesiones', exact: true });
    await search.waitFor();
    assert.ok(
      await page
        .locator('.projects')
        .evaluate((element) => element.scrollHeight > element.clientHeight + 1),
    );
    await search.click();
    await page.getByRole('dialog', { name: 'Buscar proyectos y sesiones', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.fixture.state.projects = window.fixture.state.projects.filter(
        (p) => !p.id.startsWith('extra-'),
      );
      window.fixture.publish();
    });
    await search.waitFor({ state: 'detached' });
    check(`${colorScheme}: search tracks project-list overflow dynamically`);

    await firstProject.hover();
    await newChat.click();
    await selected(page, 's3');
    assert.equal(await actionCount(page, 'newSession'), 1);
    await firstProject.locator('.project-chat').filter({ hasText: 'Revisar interfaz' }).click();
    await selected(page, 's1');
    const disposable = firstProject.locator('.project-chat-row').filter({ hasText: 'Chat 3' });
    await disposable.hover();
    await disposable.getByRole('button', { name: 'Eliminar chat Chat 3', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Eliminar conversación', exact: true });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: 'Eliminar chat', exact: true }).click();
    await page.waitForFunction(() => !window.fixture.state.sessions.some((s) => s.id === 's3'));
    assert.equal(await actionCount(page, 'deleteSession'), 1);
    check(`${colorScheme}: new chat and confirmed deletion use the project block`);

    // The sidebar remains the creation entry point for a project without any conversations.
    const secondProject = page.locator('[data-project-id="q"]');
    await secondProject.locator('.project-name').click();
    await page.waitForFunction(() => window.fixture.state.selectedProject === 'q');
    await secondProject.hover();
    await secondProject
      .getByRole('button', { name: 'Nuevo chat en Documentación', exact: true })
      .click();
    await page.waitForFunction(() =>
      window.fixture.state.sessions.some(
        (s) => s.projectId === 'q' && s.id === window.fixture.state.selectedSession,
      ),
    );
    await composer.waitFor();
    assert.equal(await page.locator('.session-tabs-bar').count(), 0);
    assert.equal(await composer.inputValue(), '');
    await page.evaluate(() => {
      window.fixture.state.sessions = window.fixture.state.sessions.filter(
        (s) => s.projectId === 'p',
      );
      window.fixture.state.selectedProject = 'p';
      window.fixture.state.selectedSession = 's1';
      window.fixture.publish();
    });
    await page.waitForFunction(() =>
      document.querySelector('.chat-switcher-trigger')?.textContent.includes('Revisar interfaz'),
    );
    check(`${colorScheme}: an empty project can create its first chat from the project action`);

    // Every conversation stays reachable; navigation is not capped by the former tab limit.
    await page.evaluate(() => {
      window.fixture.state.sessions.push(
        ...Array.from({ length: 20 }, (_, i) =>
          window.fixture.session(`many-${i}`, `Conversación adicional ${i + 1}`),
        ),
      );
      window.fixture.publish();
    });
    await switcher.click();
    const allChats = page.getByRole('menu', { name: 'Chats de Estudio de interfaz', exact: true });
    await allChats.waitFor();
    await page.waitForFunction(() =>
      document.querySelector('.chat-switcher-menu')?.contains(document.activeElement),
    );
    assert.equal(await allChats.getByRole('menuitemradio').count(), 22);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowUp');
    assert.equal(
      await allChats
        .getByRole('menuitemradio')
        .last()
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-many-chats.png` });
    await page.keyboard.press('Enter');
    await selected(page, 's1');
    await firstProject.locator('.project-chat').filter({ hasText: 'Revisar interfaz' }).click();
    await selected(page, 's1');
    await page.evaluate(() => {
      window.fixture.state.sessions = window.fixture.state.sessions.filter(
        (s) => !s.id.startsWith('many-'),
      );
      window.fixture.publish();
    });
    await search.waitFor({ state: 'detached' });
    await page.waitForFunction(
      () => document.querySelector('.composer textarea')?.value === 'Borrador que debe conservarse',
    );
    check(
      `${colorScheme}: all 22 chats stay reachable with bounded scrolling and keyboard navigation`,
    );

    for (const [width, height] of [
      [760, 620],
      [480, 600],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(
        () => !document.querySelector('.git-branch-toggle')?.textContent.includes('Consultando'),
      );
      await page.screenshot({ path: `${artifactRoot}/${colorScheme}-${width}.png` });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `No horizontal document overflow at ${width}`,
      );
      const composerBounds = await composer.boundingBox();
      assert.ok(
        composerBounds.x >= 0 && composerBounds.x + composerBounds.width <= width + 1,
        'Composer remains inside viewport',
      );
      await switcher.click();
      const responsiveMenu = page.getByRole('menu', {
        name: 'Chats de Estudio de interfaz',
        exact: true,
      });
      await responsiveMenu.waitFor();
      // Native popover visibility precedes its onToggle/layout positioning.
      await page.waitForFunction(
        () => {
          const menu = document.querySelector('.chat-switcher-menu:popover-open');
          if (!menu) return false;
          const bounds = menu.getBoundingClientRect();
          return (
            bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.right <= innerWidth + 1 &&
            bounds.bottom <= innerHeight + 1
          );
        },
        undefined,
        { timeout: 5000 },
      );
      const bounds = await responsiveMenu.boundingBox();
      assert.ok(
        bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y + bounds.height <= height + 1,
        `Chat dropdown stays inside ${width}×${height}`,
      );
      await page.keyboard.press('Escape');
    }
    check(`${colorScheme}: 760px and 480px layouts keep composer and chat menu in view`);

    assert.deepEqual(await page.evaluate(() => window.fixture.unexpected), []);
    assert.deepEqual(errors, []);
    await page.close();
    currentPage = undefined;
  }
  await fs.writeFile(
    `${artifactRoot}/results.json`,
    JSON.stringify({ passed: true, durationMs: Date.now() - startedAt, checks }, null, 2),
  );
  await fs.rm(`${artifactRoot}/failure.png`, { force: true });
  console.log(
    `PASS: ${checks.length} project/chat navigation checks. Screenshots: ${artifactRoot}`,
  );
} catch (error) {
  if (currentPage && !currentPage.isClosed())
    await currentPage.screenshot({ path: `${artifactRoot}/failure.png` }).catch(() => {});
  await fs.writeFile(
    `${artifactRoot}/results.json`,
    JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  if (server)
    await new Promise((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  await fs.rm(output, { recursive: true, force: true });
}
