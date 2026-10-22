// A temporary Vite build and a mock desk bridge keep this check away from personal chats.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-sidebar-refinement-'));
const artifactRoot = 'artifacts/sidebar-refinement';
await fs.mkdir(artifactRoot, { recursive: true });
const checks = [];
const startedAt = Date.now();
let browser, server, currentPage;
const check = (label) => checks.push(label);
const center = async (locator) => {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, `Missing bounds for ${locator}`);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
};
const aligned = async (one, two, axis, label) => {
  const a = await center(one),
    b = await center(two);
  assert.ok(Math.abs(a[axis] - b[axis]) <= 1.5, `${label}: ${a[axis]} vs ${b[axis]}`);
};
const actionCount = (page, type) =>
  page.evaluate((type) => window.fixture.actions.filter((a) => a.type === type).length, type);
const selected = (page, id) =>
  page.waitForFunction((id) => window.fixture.state.selectedSession === id, id);
const row = (page, id) => page.locator(`.project-chat-row[data-session-id="${id}"]`);
const chat = (page, id) => row(page, id).locator('.project-chat');
const ordered = async (locator, expected, label) => {
  await locator.first().waitFor();
  const deadline = Date.now() + 5000;
  let actual;
  do {
    actual = await locator.allTextContents();
    if (JSON.stringify(actual) === JSON.stringify(expected)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, expected, label);
};

async function fixture(page) {
  await page.addInitScript((protocol) => {
    if (!localStorage.getItem('agent-desk.sidebar-collapsed'))
      localStorage.setItem('agent-desk.sidebar-collapsed', 'false');
    const session = (id, title, parentId) => ({
      id,
      title,
      parentId,
      projectId: 'p',
      profile: 'claude-1',
      mode: 'chat',
      status: 'stopped',
      approvals: [],
      messages: [],
      accountLocked: false,
      stats: { cost: 0, turns: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      info: { models: [{ value: 'fixture', displayName: 'Fixture' }], commands: [] },
    });
    const initial = {
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
      dataDir: '/tmp/sidebar-refinement-fixture',
      projects: [
        { id: 'p', name: 'Estudio', path: '/tmp/sidebar-refinement-fixture/studio' },
        { id: 'q', name: 'Documentación', path: '/tmp/sidebar-refinement-fixture/docs' },
      ],
      sessions: [
        session('s1', 'Primero'),
        session('s2', 'Segundo'),
        session('s3', 'Tercero'),
        session('c1', 'Subchat primero', 's1'),
        session('c2', 'Subchat segundo', 's1'),
        session('c3', 'Subchat tercero', 's1'),
      ],
      selectedProject: 'p',
      selectedSession: 's3',
      browsers: [],
      devServers: [],
      coordination: [],
      floatingChats: [],
      runtime: { protocol, instanceId: 'sidebar-fixture' },
    };
    initial.sessions.find((s) => s.id === 's2').status = 'working';
    initial.sessions.find((s) => s.id === 'c2').status = 'working';
    const completed = initial.sessions.find((s) => s.id === 's1');
    completed.status = 'ready';
    completed.messages = [{ id: 'answer', role: 'assistant', text: 'Revisión terminada.' }];
    const state = JSON.parse(sessionStorage.getItem('sidebar-fixture-state') || 'null') || initial;
    const listeners = new Set();
    const publish = () => {
      sessionStorage.setItem('sidebar-fixture-state', JSON.stringify(state));
      listeners.forEach((listener) => listener({ type: 'state', state: structuredClone(state) }));
    };
    window.fixture = { state, publish, session, actions: [], unexpected: [] };
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
            branches: ['main'],
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
          ['refreshUsage', 'accountRefresh', 'refreshModels', 'browserPresent'].includes(
            action.type,
          )
        )
          return true;
        if (action.type === 'select') {
          state.selectedProject = action.projectId;
          state.selectedSession = action.sessionId;
        } else if (action.type === 'newSession') {
          const created = { ...session('s4', 'Nuevo chat'), projectId: action.projectId };
          state.sessions.push(created);
          state.selectedProject = action.projectId;
          state.selectedSession = created.id;
          publish();
          return structuredClone(created);
        } else if (action.type === 'deleteSession') {
          state.sessions = state.sessions.filter((s) => s.id !== action.sessionId);
        } else if (action.type === 'removeProject') {
          state.projects = state.projects.filter((p) => p.id !== action.projectId);
          state.sessions = state.sessions.filter((s) => s.projectId !== action.projectId);
        } else if (action.type === 'floatingChat') {
          return true;
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
      reducedMotion: 'no-preference',
    }));
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await fixture(page);
    await page.goto(server.resolvedUrls.local[0]);
    const composer = page.getByRole('textbox', { name: 'Mensaje', exact: true });
    await composer.waitFor();
    const sidebar = page.locator('.sidebar');
    const project = page.locator('[data-project-id="p"]');
    const roots = project.locator('.project-chats > div > .project-chat-row .project-chat > span');
    const children = project.locator('.project-subchats .project-chat > span');
    await ordered(roots, ['Tercero', 'Segundo', 'Primero'], 'Newest root first');
    await ordered(
      children,
      ['Subchat tercero', 'Subchat segundo', 'Subchat primero'],
      'Newest child first',
    );
    assert.equal(
      await page.locator('.chat-switcher-trigger').count(),
      0,
      'Sidebar is the chat navigation surface',
    );
    check(
      `${colorScheme}: roots and subchats start newest first without a duplicate composer selector`,
    );

    await page.mouse.move(1000, 100);
    const projectStatus = project.locator('.project-status');
    const rootStatus = row(page, 's3').locator('.project-chat-status');
    const childStatus = row(page, 'c3').locator('.project-chat-status');
    await aligned(projectStatus, rootStatus, 'x', 'Project and root status column');
    await aligned(projectStatus, childStatus, 'x', 'Project and nested status column');
    const statusCenter = await center(projectStatus);
    await project.locator('.project-name').hover();
    const projectDelete = project.getByRole('button', { name: 'Quitar Estudio', exact: true });
    await projectDelete.waitFor();
    const deleteCenter = await center(projectDelete);
    assert.ok(
      Math.abs(deleteCenter.x - statusCenter.x) <= 1.5 &&
        Math.abs(deleteCenter.y - statusCenter.y) <= 1.5,
      'Project removal replaces its state',
    );
    await projectDelete.click();
    const removal = page.getByRole('dialog', { name: 'Quitar proyecto', exact: true });
    await removal.waitFor();
    await removal.getByRole('button', { name: 'Cancelar', exact: true }).click();
    assert.equal(await actionCount(page, 'removeProject'), 0, 'Cancelling does not remove project');
    for (const id of ['s3', 'c3']) {
      const status = row(page, id).locator('.project-chat-status');
      const statusCenter = await center(status);
      await chat(page, id).hover();
      const remove = row(page, id).locator('.project-chat-delete');
      const deleteCenter = await center(remove);
      assert.ok(
        Math.abs(deleteCenter.x - statusCenter.x) <= 1.5 &&
          Math.abs(deleteCenter.y - statusCenter.y) <= 1.5,
        `${id} delete replaces status`,
      );
      assert.equal(await remove.locator('.lucide-x').count(), 1);
    }
    check(`${colorScheme}: project, roots and nested statuses share the deletion column`);

    await chat(page, 'c1').click();
    await selected(page, 'c1');
    assert.equal(await chat(page, 'c1').getAttribute('aria-current'), 'true');
    await composer.fill('Borrador de subchat');
    await chat(page, 's3').click();
    await selected(page, 's3');
    await chat(page, 'c1').click();
    await selected(page, 'c1');
    await page.waitForFunction(
      () => document.querySelector('.composer textarea')?.value === 'Borrador de subchat',
    );
    check(`${colorScheme}: subchats are selectable and keep their own draft`);

    const drag = async (id, target, end = 'drop') => {
      const from = await center(chat(page, id));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 8 });
      await page.locator('.chat-detach-preview').waitFor();
      if (end === 'cancel') await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.locator('.chat-detach-preview').waitFor({ state: 'detached' });
    };
    const rootEnd = await row(page, 's1').boundingBox();
    await drag('s3', { x: rootEnd.x + 60, y: rootEnd.y + rootEnd.height - 2 });
    await ordered(roots, ['Segundo', 'Primero', 'Tercero'], 'Roots reorder vertically');
    const childEnd = await row(page, 'c1').boundingBox();
    await drag('c3', { x: childEnd.x + 55, y: childEnd.y + childEnd.height - 2 });
    await ordered(
      children,
      ['Subchat segundo', 'Subchat primero', 'Subchat tercero'],
      'Children reorder independently',
    );
    assert.equal(await actionCount(page, 'floatingChat'), 0, 'Reorder does not float');
    await page.reload();
    await composer.waitFor();
    await ordered(roots, ['Segundo', 'Primero', 'Tercero'], 'Root order survives reload');
    await ordered(
      children,
      ['Subchat segundo', 'Subchat primero', 'Subchat tercero'],
      'Child order survives reload',
    );
    check(
      `${colorScheme}: pointer reorders roots and siblings independently, persisted across reload`,
    );

    const selectionsBeforeKeyboard = await actionCount(page, 'select');
    await chat(page, 's3').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await ordered(roots, ['Segundo', 'Tercero', 'Primero'], 'Keyboard moves a root up');
    assert.ok(
      await chat(page, 's3').evaluate((element) => element === document.activeElement),
      'Keyboard ordering retains focus on the moved root',
    );
    await page.keyboard.press('Alt+ArrowDown');
    await ordered(roots, ['Segundo', 'Primero', 'Tercero'], 'Keyboard moves a root down');
    await chat(page, 'c3').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await ordered(
      children,
      ['Subchat segundo', 'Subchat tercero', 'Subchat primero'],
      'Keyboard moves a child within its siblings',
    );
    await page.keyboard.press('Alt+ArrowDown');
    await ordered(
      children,
      ['Subchat segundo', 'Subchat primero', 'Subchat tercero'],
      'Keyboard restores the child position',
    );
    assert.equal(
      await actionCount(page, 'select'),
      selectionsBeforeKeyboard,
      'Keyboard ordering does not navigate to another chat',
    );
    check(
      `${colorScheme}: Alt+ArrowUp/Down moves roots and children without losing focus or selection`,
    );

    const firstRoot = await row(page, 's2').boundingBox();
    await drag('s3', { x: firstRoot.x + 60, y: firstRoot.y + 2 }, 'cancel');
    await ordered(roots, ['Segundo', 'Primero', 'Tercero'], 'Escape cancels root reorder');
    assert.equal(await actionCount(page, 'floatingChat'), 0);
    const side = await sidebar.boundingBox();
    const beforeFloat = await center(chat(page, 'c3'));
    await drag('c3', { x: side.x + side.width + 140, y: beforeFloat.y }, 'cancel');
    assert.equal(await actionCount(page, 'floatingChat'), 0, 'Escape cancels detach');
    await drag('c3', { x: side.x + side.width + 140, y: beforeFloat.y });
    assert.equal(await actionCount(page, 'floatingChat'), 1, 'Outside drag floats exactly once');
    await ordered(
      children,
      ['Subchat segundo', 'Subchat primero', 'Subchat tercero'],
      'Float does not reorder siblings',
    );
    check(`${colorScheme}: Escape cancels ordering and floating, outside drop floats once`);

    const create = project.getByRole('button', { name: 'Nuevo chat en Estudio', exact: true });
    await composer.focus();
    await page.mouse.move(1000, 100);
    const listBeforeReveal = await row(page, 's2').boundingBox();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-project-id="p"] .project-new-chat'))
          .opacity === '0',
    );
    await project.locator('.project-name').hover();
    await page.waitForFunction(
      () =>
        Number(
          getComputedStyle(document.querySelector('[data-project-id="p"] .project-new-chat'))
            .opacity,
        ) > 0.95,
    );
    const listAfterReveal = await row(page, 's2').boundingBox();
    assert.ok(
      Math.abs(listBeforeReveal.y - listAfterReveal.y) <= 0.5,
      'Hovering the project reveals its divider without moving the customized list',
    );
    const dividerBounds = await create.boundingBox();
    const headerBounds = await project.locator('.project-row').boundingBox();
    assert.ok(
      dividerBounds.y >= headerBounds.y + headerBounds.height - 1 &&
        dividerBounds.y + dividerBounds.height <= listAfterReveal.y + 1,
      'New-chat divider remains above the first manually ordered chat',
    );
    await aligned(
      create,
      create.locator('svg'),
      'x',
      'Plus stays centered in its horizontal divider',
    );
    assert.ok(
      (await create.locator('svg').boundingBox()).width <= 12,
      'Creation icon is understated',
    );
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-creation-divider.png` });
    await page.mouse.move(1000, 100);
    await create.focus();
    await create.press('Space');
    await selected(page, 's4');
    await ordered(
      roots,
      ['Nuevo chat', 'Segundo', 'Primero', 'Tercero'],
      'New root leads customized order',
    );
    await page.evaluate(() => {
      window.fixture.state.sessions.push(window.fixture.session('c4', 'Subchat nuevo', 's1'));
      window.fixture.publish();
    });
    await ordered(
      children,
      ['Subchat nuevo', 'Subchat segundo', 'Subchat primero', 'Subchat tercero'],
      'New child leads customized order',
    );
    assert.equal(await actionCount(page, 'newSession'), 1);
    check(
      `${colorScheme}: stable centered divider supports keyboard creation; new chats lead manual ordering`,
    );

    await page.evaluate(() => {
      window.fixture.state.sessions.push(
        ...Array.from({ length: 40 }, (_, index) =>
          window.fixture.session(`long-${index}`, `Conversación larga ${index}`),
        ),
      );
      window.fixture.publish();
    });
    await chat(page, 'long-39').waitFor();
    const projects = page.locator('.projects');
    assert.ok(
      await projects.evaluate((element) => element.scrollHeight > element.clientHeight),
      'Long chat list scrolls',
    );
    await projects.evaluate((element) => {
      element.scrollTop = 0;
    });
    const beforeScrollOrder = await roots.allTextContents();
    const beforeScrollStorage = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith('agent-desk.chat-order.v1:'))
        .sort(),
    );
    const beforeScrollFloating = await actionCount(page, 'floatingChat');
    const from = await center(chat(page, 'long-39'));
    const viewport = await projects.boundingBox();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, viewport.y + viewport.height - 4, { steps: 8 });
    await page.locator('.chat-detach-preview').waitFor();
    await page.waitForFunction(() => document.querySelector('.projects').scrollTop > 40);
    assert.equal(
      await page.locator('.chat-detach-preview').getAttribute('data-detach-ready'),
      'false',
      'Scrolling near the bottom remains an internal reorder gesture',
    );
    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-drag-autoscroll.png` });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.locator('.chat-detach-preview').waitFor({ state: 'detached' });
    const scrollPositions = await projects.evaluate(async (element) => {
      const positions = [element.scrollTop];
      for (let frame = 0; frame < 9; frame++) {
        await new Promise(requestAnimationFrame);
        positions.push(element.scrollTop);
      }
      return positions;
    });
    assert.ok(
      Math.max(...scrollPositions) - Math.min(...scrollPositions) <= 1,
      `Escape stops auto-scroll immediately: ${scrollPositions}`,
    );
    await ordered(roots, beforeScrollOrder, 'Escape leaves the long list order unchanged');
    assert.deepEqual(
      await page.evaluate(() =>
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith('agent-desk.chat-order.v1:'))
          .sort(),
      ),
      beforeScrollStorage,
      'Cancelled auto-scroll does not change saved ordering',
    );
    assert.equal(
      await actionCount(page, 'floatingChat'),
      beforeScrollFloating,
      'Cancelled auto-scroll opens no floating window',
    );
    assert.equal(
      await page.locator('[data-reorder-edge]').count(),
      0,
      'Cancelled auto-scroll removes its insertion marker',
    );
    await page.evaluate(() => {
      window.fixture.state.sessions = window.fixture.state.sessions.filter(
        (session) => !session.id.startsWith('long-'),
      );
      window.fixture.publish();
    });
    await ordered(
      roots,
      ['Nuevo chat', 'Segundo', 'Primero', 'Tercero'],
      'Removing long-list fixture preserves original custom order',
    );
    await projects.evaluate((element) => {
      element.scrollTop = 0;
    });
    check(
      `${colorScheme}: long-list drag auto-scrolls; Escape stops it without reordering or floating`,
    );

    // Animation and completion use the actual status rather than unread badges.
    await page.mouse.move(1000, 100);
    await composer.focus();
    const working = row(page, 's2').locator('.project-chat-status');
    const workingShapes = working.locator('.desk-mark');
    await workingShapes.waitFor();
    assert.ok(
      await workingShapes.evaluate((element) =>
        [element, ...element.querySelectorAll('*')].some(
          (e) => getComputedStyle(e).animationName !== 'none',
        ),
      ),
      'Working app shapes animate',
    );
    await page.evaluate(() => {
      const session = window.fixture.state.sessions.find((s) => s.id === 's2');
      session.status = 'ready';
      session.messages.push({ id: 'completed', role: 'assistant', text: 'Terminado.' });
      window.fixture.publish();
    });
    await page.waitForFunction(() =>
      document
        .querySelector('[data-session-id="s2"] .project-chat-status')
        ?.classList.contains('done'),
    );
    const doneColor = await working
      .locator('.chat-state-mark')
      .evaluate((element) => getComputedStyle(element).color);
    const rgb = doneColor.match(/[\d.]+/g).map(Number);
    assert.ok(rgb[1] > rgb[0] && rgb[1] > rgb[2], `Done uses green: ${doneColor}`);
    await chat(page, 's2').click();
    await selected(page, 's2');
    assert.ok(
      (await working.getAttribute('class')).includes('done'),
      'Reading keeps completion state',
    );
    await composer.focus();
    await page.mouse.move(1000, 100);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const remainingWork = row(page, 'c2').locator('.project-chat-status .desk-mark');
    assert.equal(
      await remainingWork.evaluate((element) =>
        [element, ...element.querySelectorAll('*')].some((e) => {
          const style = getComputedStyle(e);
          return style.animationName !== 'none' && parseFloat(style.animationDuration) > 0.001;
        }),
      ),
      false,
      'Reduced motion disables working animation',
    );
    check(
      `${colorScheme}: app shapes animate while working, completed stays green, reduced motion respected`,
    );

    await page.screenshot({ path: `${artifactRoot}/${colorScheme}-desktop.png` });
    const rowBounds = await chat(page, 's4').boundingBox();
    const sidebarBounds = await sidebar.boundingBox();
    assert.ok(rowBounds.height <= 26, `Compact chat row: ${rowBounds.height}px`);
    assert.ok(sidebarBounds.width < 260, `Narrow sidebar: ${sidebarBounds.width}px`);
    for (const [width, height] of [
      [760, 620],
      [480, 600],
    ]) {
      await page.setViewportSize({ width, height });
      // Let Chromium finish both layout and painting after resizing before capturing it.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `No document overflow at ${width}px`,
      );
      const bounds = await composer.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Composer fits viewport');
      await page.screenshot({ path: `${artifactRoot}/${colorScheme}-${width}.png` });
    }
    check(`${colorScheme}: compact rows and narrower sidebar fit desktop and small viewports`);
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
  console.log(`PASS: ${checks.length} sidebar refinement checks. Screenshots: ${artifactRoot}`);
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
