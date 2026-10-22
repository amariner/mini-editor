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
            remote: 'origin',
            ahead: 0,
            behind: 0,
            ...(window.fixture.gitPatch || {}),
          };
        if (action.type === 'listFiles') return [];
        if (action.type === 'gitOperation' && window.fixture.holdGit) {
          return new Promise((resolve) => {
            window.fixture.releaseGit = resolve;
          });
        }
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
    const newChat = firstProject
      .getByRole('button', { name: /Nueva conversación|Nuevo chat/ })
      .first();
    await composer.focus();
    await page.mouse.move(1000, 150);
    await visuallyHidden(page, '[data-project-id="p"] .project-new-chat');
    const restingRowBounds = await row.boundingBox();
    await firstProject.locator('.project-name').hover();
    await visiblyShown(page, '[data-project-id="p"] .project-new-chat');
    assert.equal(await newChat.locator('.lucide-plus').count(), 1, 'New chat uses a quiet plus');
    const newChatBounds = await newChat.boundingBox();
    const projectHeaderBounds = await firstProject.locator('.project-row').boundingBox();
    const hoveringRowBounds = await row.boundingBox();
    assert.ok(
      newChatBounds.y >= projectHeaderBounds.y + projectHeaderBounds.height - 1 &&
        newChatBounds.y + newChatBounds.height <= hoveringRowBounds.y + 1,
      'Creation divider sits between the project header and newest chat',
    );
    assert.ok(
      Math.abs(hoveringRowBounds.y - restingRowBounds.y) <= 0.5,
      'Revealing the divider does not move the chat rows',
    );
    await assertAligned(newChat, newChat.locator('svg'), 'x', 'Plus is centered in the divider');
    await assertAligned(newChat, newChat.locator('svg'), 'y', 'Plus shares the horizontal line');
    const lines = await newChat.evaluate((element) =>
      ['::before', '::after'].map((pseudo) => {
        const style = getComputedStyle(element, pseudo);
        return {
          content: style.content,
          width: parseFloat(style.width),
          height: parseFloat(style.height),
        };
      }),
    );
    assert.ok(
      lines.every((line) => line.content !== 'none' && line.width > 20 && line.height <= 1) &&
        Math.abs(lines[0].width - lines[1].width) <= 1,
      'Matching fine divider lines flank the centered plus',
    );
    await composer.focus();
    await page.mouse.move(1000, 150);
    await visuallyHidden(page, '[data-project-id="p"] .project-new-chat');
    await newChat.focus();
    await visiblyShown(page, '[data-project-id="p"] .project-new-chat');
    assert.ok(
      Math.abs((await row.boundingBox()).y - restingRowBounds.y) <= 0.5,
      'Keyboard focus reveals the divider without moving chats',
    );
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-desktop.png` });
    check(
      `${colorScheme}: deletion replaces status; centered creation divider appears on hover and focus without layout shift`,
    );

    assert.equal(
      await page.locator('.chat-switcher-trigger').count(),
      0,
      'The main composer relies on sidebar navigation',
    );
    assert.equal(
      await page.locator('.desk-input .git-summary-project').count(),
      0,
      'The composer does not repeat the project name',
    );
    await composer.fill('Borrador que debe conservarse');
    const originalChat = firstProject.locator(
      '.project-chat-row[data-session-id="s1"] .project-chat',
    );
    const nextChat = firstProject.locator('.project-chat-row[data-session-id="s2"] .project-chat');
    await nextChat.focus();
    await nextChat.press('Enter');
    await selected(page, 's2');
    assert.equal(await nextChat.getAttribute('aria-current'), 'true');
    assert.equal(await composer.inputValue(), '');
    await originalChat.click();
    await selected(page, 's1');
    await page.waitForFunction(
      () => document.querySelector('.composer textarea')?.value === 'Borrador que debe conservarse',
    );
    check(
      `${colorScheme}: sidebar mouse and keyboard navigation preserves separate drafts without redundant composer navigation`,
    );

    await page.getByRole('button', { name: 'Gestionar ramas y Git', exact: true }).click();
    const worktree = page.getByRole('checkbox', { name: 'Aislar en worktree', exact: false });
    await worktree.waitFor();
    assert.equal(
      await worktree.locator('xpath=ancestor::*[contains(@class,"git-workflow")]').count(),
      1,
      'Worktree isolation is inside bottom Git workflow',
    );
    const commitDraft = page.getByRole('textbox', { name: 'Mensaje del commit', exact: true });
    await commitDraft.fill('Borrador de commit entre chats');
    await worktree.check();
    await page.waitForFunction(
      () => window.fixture.state.sessions.find((s) => s.id === 's1').isolation === 'worktree',
    );
    const gitControl = page.getByRole('button', { name: 'Gestionar ramas y Git', exact: true });
    await page.waitForFunction(() =>
      document.querySelector('.git-dock-trigger')?.textContent.includes('Worktree pendiente'),
    );
    await gitControl.click();
    await nextChat.click();
    await selected(page, 's2');
    await gitControl.click();
    assert.equal(
      await commitDraft.inputValue(),
      'Borrador de commit entre chats',
      'Switching shared chats preserves the Git commit draft',
    );
    await page.evaluate(() => {
      window.fixture.holdGit = true;
    });
    await page.getByRole('button', { name: 'Consultar remoto', exact: true }).click();
    await page.waitForFunction(() => typeof window.fixture.releaseGit === 'function');
    await originalChat.click();
    await selected(page, 's1');
    if ((await gitControl.getAttribute('aria-expanded')) !== 'true') await gitControl.click();
    assert.equal(
      await commitDraft.isDisabled(),
      true,
      'A Git operation stays in flight across chat navigation',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Consultar remoto', exact: true }).isDisabled(),
      true,
    );
    await page.evaluate(() => {
      window.fixture.holdGit = false;
      window.fixture.releaseGit(true);
    });
    await page.waitForFunction(
      () => !document.querySelector('input[aria-label="Mensaje del commit"]')?.disabled,
    );
    assert.equal(await commitDraft.inputValue(), 'Borrador de commit entre chats');
    await page.keyboard.press('Escape');
    await page.locator('.git-workflow:visible').waitFor({ state: 'hidden' });
    check(
      `${colorScheme}: bottom Git panel preserves worktree controls, commit draft and in-flight operations across shared chats`,
    );

    await originalChat.focus();
    await originalChat.press('F2');
    const chatName = page.getByRole('textbox', { name: 'Nombre del chat', exact: true });
    await chatName.fill('Interfaz revisada');
    await chatName.press('Enter');
    await page.waitForFunction(
      () => window.fixture.state.sessions[0].title === 'Interfaz revisada',
    );
    await originalChat.focus();
    await originalChat.press('F2');
    await chatName.fill('Revisar interfaz');
    await chatName.press('Enter');
    await page.waitForFunction(() => window.fixture.state.sessions[0].title === 'Revisar interfaz');
    await originalChat.click({ button: 'right' });
    await chatName.fill('Este nombre se cancela');
    await chatName.press('Escape');
    assert.equal(
      await page.evaluate(() => window.fixture.state.sessions[0].title),
      'Revisar interfaz',
    );
    await page.waitForFunction(() =>
      document.activeElement?.matches('[data-session-id="s1"] .project-chat'),
    );
    check(
      `${colorScheme}: sidebar F2/right-click edits names, Escape cancels and restores row focus`,
    );

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

    // Names rename, projects fold their chats, and only the free rail toggles panel width.
    const accordion = firstProject.locator('.project-chat-accordion');
    const railWidth = (await sidebar.boundingBox()).width;
    const projectExpandedBeforeRename = await accordion.getAttribute('data-expanded');
    const name = page.getByRole('textbox', { name: 'Nombre del proyecto', exact: true });
    const assertStableProject = async (expanded, label) => {
      assert.equal(await accordion.getAttribute('data-expanded'), expanded, `${label}: accordion`);
      assert.ok(
        Math.abs((await sidebar.boundingBox()).width - railWidth) <= 0.5,
        `${label}: rail width`,
      );
      assert.equal(
        await sidebar.evaluate((element) => element.classList.contains('collapsed')),
        false,
      );
    };
    await projectName.dblclick();
    await name.waitFor();
    await assertStableProject(projectExpandedBeforeRename, 'Double-click rename');
    await name.fill('Nombre que se cancela');
    await name.press('Escape');
    await page.waitForFunction(() => document.activeElement?.matches('.project-name'));
    assert.equal(await projectName.getAttribute('aria-label'), 'Estudio');
    await assertStableProject(projectExpandedBeforeRename, 'Cancelling rename');

    await projectName.dblclick();
    await name.fill('Estudio de interfaz');
    await name.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await name.isVisible(), true, 'IME confirmation must not save the project name');
    await name.press('Enter');
    await page.waitForFunction(
      () => window.fixture.state.projects[0].name === 'Estudio de interfaz',
    );
    await assertStableProject(projectExpandedBeforeRename, 'Saving rename');
    await page.waitForFunction(() => document.activeElement?.matches('.project-name'));
    await projectName.focus();
    await projectName.press('F2');
    await name.fill('Estudio de navegación');
    await name.press('Enter');
    await page.waitForFunction(
      () => window.fixture.state.projects[0].name === 'Estudio de navegación',
    );
    await assertStableProject(projectExpandedBeforeRename, 'F2 rename');

    await projectName.click();
    assert.equal(await accordion.getAttribute('data-expanded'), 'false', 'One click folds chats');
    await projectName.dblclick();
    await name.waitFor();
    await assertStableProject('false', 'Renaming a folded project');
    await name.press('Escape');
    await projectName.click();
    assert.equal(await accordion.getAttribute('data-expanded'), 'true', 'One click unfolds chats');
    await firstProject.dblclick({ position: { x: 1, y: 1 } });
    assert.equal(await name.count(), 0, 'Project padding does not enter rename');
    await assertStableProject('true', 'Double-clicking project padding');

    await sidebar.dblclick({ position: { x: 12, y: 420 } });
    await page.waitForFunction(() =>
      document.querySelector('.sidebar')?.classList.contains('collapsed'),
    );
    await visuallyHidden(page, '[data-project-id="p"] .project-new-chat');
    assert.equal(
      await firstProject.locator('.project-new-chat').boundingBox(),
      null,
      'Collapsed rail has no creation divider',
    );
    await sidebar.locator('.traffic-space').hover();
    await assertAligned(
      addProject.locator('svg'),
      projectName.locator('.project-mark'),
      'x',
      'Collapsed add project aligns with the project mark',
    );
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-collapsed.png` });
    await sidebar.dblclick({ position: { x: 12, y: 420 } });
    await page.waitForFunction(
      () => !document.querySelector('.sidebar')?.classList.contains('collapsed'),
    );
    await assertStableProject('true', 'Double-clicking the free rail');
    check(
      `${colorScheme}: double-click/F2 rename with save/cancel preserves accordion and width; project padding stays inert; free rail collapses and expands`,
    );

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

    await page.mouse.move(1000, 150);
    await newChat.focus();
    await newChat.press('Enter');
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
    check(
      `${colorScheme}: keyboard activates the creation divider; confirmed deletion uses the project block`,
    );

    // Creating from a folded, empty project opens its first conversation and its accordion.
    const secondProject = page.locator('[data-project-id="q"]');
    await secondProject.locator('.project-name').click();
    await page.waitForFunction(() => window.fixture.state.selectedProject === 'q');
    assert.equal(
      await secondProject.locator('.project-name').getAttribute('aria-expanded'),
      'false',
    );
    await page.keyboard.press('Meta+n');
    await page.waitForFunction(() =>
      window.fixture.state.sessions.some(
        (s) => s.projectId === 'q' && s.id === window.fixture.state.selectedSession,
      ),
    );
    await composer.waitFor();
    assert.equal(
      await secondProject.locator('.project-name').getAttribute('aria-expanded'),
      'true',
    );
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
    await selected(page, 's1');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-session-id="s1"] .project-chat')
          ?.getAttribute('aria-current') === 'true',
    );
    check(`${colorScheme}: creating a first chat with Cmd+N expands its folded project`);

    // Every conversation stays reachable; navigation is not capped by the former tab limit.
    await page.evaluate(() => {
      window.fixture.state.sessions.push(
        ...Array.from({ length: 20 }, (_, i) =>
          window.fixture.session(`many-${i}`, `Conversación adicional ${i + 1}`),
        ),
      );
      window.fixture.publish();
    });
    const allChats = firstProject.locator('.project-chat');
    assert.equal(await allChats.count(), 22);
    assert.ok(
      await page
        .locator('.projects')
        .evaluate((element) => element.scrollHeight > element.clientHeight),
      'All chats stay in the bounded sidebar scroller',
    );
    const latestChat = firstProject.locator('[data-session-id="many-19"] .project-chat');
    await latestChat.scrollIntoViewIfNeeded();
    await latestChat.focus();
    await latestChat.press('Enter');
    await selected(page, 'many-19');
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-many-chats.png` });
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
      `${colorScheme}: all 22 chats stay reachable in the sidebar with bounded scrolling and keyboard navigation`,
    );

    for (const [width, height] of [
      [2200, 1200],
      [760, 620],
      [480, 600],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const gitTrigger = page.getByRole('button', { name: 'Gestionar ramas y Git', exact: true });
      await gitTrigger.waitFor();
      await page.waitForFunction(
        () => !document.querySelector('.git-dock-trigger')?.textContent.includes('Consultando'),
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `No horizontal document overflow at ${width}`,
      );
      const composerBounds = await page.locator('.composer').boundingBox();
      const conversationBounds = await page.locator('.conversation').boundingBox();
      assert.ok(
        composerBounds.width <= 780.5,
        `Composer limited to 780px at ${width}: ${composerBounds.width}`,
      );
      assert.ok(
        composerBounds.x >= 0 && composerBounds.x + composerBounds.width <= width + 1,
        'Composer remains inside viewport',
      );
      assert.ok(
        Math.abs(
          composerBounds.x +
            composerBounds.width / 2 -
            conversationBounds.x -
            conversationBounds.width / 2,
        ) <= 1,
        `Composer centered in conversation at ${width}`,
      );
      const footer = page.locator('.composer-footer');
      assert.equal(
        await footer.locator('.git-dock-trigger').count(),
        1,
        'Git control belongs to the composer footer',
      );
      const gitBounds = await gitTrigger.boundingBox();
      const accountBounds = await footer.locator('.task-signature').boundingBox();
      const terminalBounds = await footer
        .getByRole('button', { name: 'Terminal', exact: true })
        .boundingBox();
      assert.ok(
        gitBounds.y >= composerBounds.y + composerBounds.height - 1,
        'Git sits below the writing surface',
      );
      assert.ok(
        gitBounds.x + gitBounds.width <= accountBounds.x + 1,
        `Git and account controls do not overlap at ${width}`,
      );
      assert.ok(
        accountBounds.x + accountBounds.width <= terminalBounds.x + 1,
        `Account and terminal controls do not overlap at ${width}`,
      );
      assert.ok(
        terminalBounds.x + terminalBounds.width <= composerBounds.x + composerBounds.width + 1,
        'Footer remains inside the writing column',
      );
      await page.screenshot({ path: `${artifactRoot}/${colorScheme}-${width}.png` });
      await gitTrigger.focus();
      await gitTrigger.press('Enter');
      const workflow = page.locator('.git-workflow:visible');
      await workflow.waitFor();
      await page.waitForFunction(() => {
        const popup = document.querySelector('.git-workflow:popover-open');
        if (!popup) return false;
        const bounds = popup.getBoundingClientRect();
        return (
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.right <= innerWidth + 1 &&
          bounds.bottom <= innerHeight + 1
        );
      });
      const bounds = await workflow.boundingBox();
      assert.ok(
        bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y + bounds.height <= height + 1,
        `Git popover stays inside ${width}×${height}`,
      );
      assert.ok(
        await workflow.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        `Git workflow content has no horizontal overflow at ${width}`,
      );
      for (const conflicts of [0, 2]) {
        await page.evaluate((conflicts) => {
          window.fixture.gitPatch = {
            files: Array.from({ length: 12 }, (_, index) => ({
              path: `src/example-${index}.tsx`,
              index: 'M',
              worktree: ' ',
              conflict: conflicts > 0 && index < 2,
            })),
            counts: { conflicts, staged: 12, unstaged: 0 },
            lines: { added: 138, removed: 52 },
          };
        }, conflicts);
        await workflow
          .getByRole('button', { name: 'Actualizar estado de Git', exact: true })
          .click();
        await page.waitForFunction((conflicts) => {
          const count = document.querySelector('.git-dock-count');
          return !!count && count.classList.contains('has-conflicts') === conflicts > 0;
        }, conflicts);
        const metrics = await gitTrigger.evaluate((element) => ({
          scroll: element.scrollWidth,
          width: element.clientWidth,
          text: element.textContent,
        }));
        assert.ok(
          metrics.scroll <= metrics.width + 1,
          `Git control fits ${width}px with ${conflicts} conflicts: ${JSON.stringify(metrics)}`,
        );
        const currentGit = await gitTrigger.boundingBox();
        const currentAccount = await footer.locator('.task-signature').boundingBox();
        assert.ok(
          currentGit.x + currentGit.width <= currentAccount.x + 1,
          `Changed Git control does not overlap account at ${width}`,
        );
        assert.ok(
          await workflow.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          `Dirty/conflicted Git workflow content fits at ${width}`,
        );
      }
      await page.screenshot({ path: `${artifactRoot}/${colorScheme}-${width}-git.png` });
      await page.keyboard.press('Escape');
      await workflow.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'Gestionar ramas y Git',
      );
      await page.waitForFunction(
        () =>
          document.querySelector('.git-dock-trigger')?.getAttribute('aria-expanded') === 'false',
      );
    }
    check(
      `${colorScheme}: 2200px, 760px and 480px layouts cap and center the composer, separate footer controls and keep keyboard Git popover in view`,
    );

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
