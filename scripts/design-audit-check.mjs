// Isolated renderer checks for zoom-sized windows, long names and keyboard affordances.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-design-'));
let server;
let browser;
try {
  await build({ build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: buildDir },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  await fs.mkdir('artifacts/design-audit', { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 900, height: 620 },
      colorScheme,
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((protocol) => {
      const state = {
        profiles: [{ id: 'claude-1', kind: 'claude', name: 'Desarrollo' }],
        defaultProfile: 'claude-1',
        accounts: { 'claude-1': { status: 'signedIn', label: 'desarrollo@example.test' } },
        projects: Array.from({ length: 18 }, (_, i) => ({
          id: `p${i}`,
          name: `${i + 1} Proyecto de desarrollo con un nombre largo y reconocible`,
          path: `/tmp/fixture-design/${'directorio-largo-'.repeat(8)}${i}`,
        })),
        sessions: Array.from({ length: 4 }, (_, i) => ({
          id: `s${i}`,
          projectId: 'p0',
          profile: 'claude-1',
          mode: 'chat',
          status: 'ready',
          title: `Revisar el proyecto ${i + 1}`,
          approvals: [],
          messages: [
            {
              id: `m${i}`,
              role: 'assistant',
              text: '```ts\n// Keep development notes legible.\nconst ready = true;\n```',
            },
          ],
        })),
        selectedProject: 'p0',
        selectedSession: 's0',
        tools: {},
        coordination: [],
        runtime: { protocol },
        dataDir: '/tmp/fixture-design',
        theme: 'system',
      };
      const listeners = new Set();
      window.fixture = { state };
      window.desk = {
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        async invoke(action) {
          if (action.type === 'snapshot') return structuredClone(state);
          if (action.type === 'diff') return { repository: false };
          if (action.type === 'setTheme') state.theme = action.theme;
          if (action.type === 'select') {
            state.selectedProject = action.projectId;
            state.selectedSession = action.sessionId;
          }
          for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
          return true;
        },
      };
    }, protocol);
    await page.goto(server.resolvedUrls.local[0]);
    await page.locator('.workspace .composer').waitFor();
    await page.locator('.project-chat:not(.selected)').first().click();
    await page.locator('.session-tab:not(.selected)').waitFor();
    await page.keyboard.press('Tab');
    const settingsButton = page.getByRole('button', { name: 'Ajustes', exact: true });
    await settingsButton.focus();
    const focusStyle = await settingsButton.evaluate((el) => getComputedStyle(el).boxShadow);
    assert.match(focusStyle, /0px 0px 0px 2px inset/, 'keyboard focus must retain a visible ring');
    const contrast = await page.evaluate(() => {
      const context = document.createElement('canvas').getContext('2d');
      const luminance = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const background = luminance(getComputedStyle(document.documentElement).backgroundColor);
      const ratios = ['.project-chat:not(.selected)', '.session-tab:not(.selected)'].map(
        (selector) => {
          const foreground = luminance(getComputedStyle(document.querySelector(selector)).color);
          return (
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
          );
        },
      );
      const codeBackground = luminance(
        getComputedStyle(document.querySelector('.workspace .md-code')).backgroundColor,
      );
      const comment = luminance(getComputedStyle(document.querySelector('.workspace .tk-c')).color);
      ratios.push(
        (Math.max(codeBackground, comment) + 0.05) / (Math.min(codeBackground, comment) + 0.05),
      );
      return ratios;
    });
    assert.ok(
      contrast.every((value) => value >= 4.5),
      `${colorScheme} navigation contrast: ${contrast}`,
    );
    console.log(
      `${colorScheme} contrast (sidebar, tabs, code comments): ${contrast.map((value) => value.toFixed(2)).join(', ')}`,
    );
    await page.screenshot({ path: `artifacts/design-audit/workspace-${colorScheme}.png` });
    await page.keyboard.press('Meta+k');
    await page.getByRole('combobox', { name: 'Buscar proyecto o sesión', exact: true }).waitFor();
    for (const viewport of [
      { width: 900, height: 620 },
      { width: 560, height: 340 },
    ]) {
      await page.setViewportSize(viewport);
      await page.getByRole('option').last().scrollIntoViewIfNeeded();
      const geometry = await page.locator('.palette').evaluate((el) => {
        const list = el.querySelector('.palette-results');
        const last = list.lastElementChild;
        const search = el.querySelector('.palette-search');
        return {
          width: el.clientWidth,
          scroll: el.scrollWidth,
          bounds: el.getBoundingClientRect().toJSON(),
          list: list.getBoundingClientRect().toJSON(),
          last: last.getBoundingClientRect().toJSON(),
          search: search.getBoundingClientRect().toJSON(),
          searchScroll: el.scrollTop,
          overflowRows: [...list.children].some((row) => row.scrollWidth > row.clientWidth + 1),
        };
      });
      assert.equal(geometry.searchScroll, 0, 'scrolling results must not hide the search field');
      assert.ok(
        geometry.search.top >= geometry.bounds.top,
        'search field must remain inside its dialog',
      );
      assert.ok(
        geometry.list.top >= geometry.search.bottom,
        'results must stay below the search field',
      );
      assert.ok(
        geometry.last.bottom <= geometry.bounds.bottom,
        'last result must remain reachable',
      );
      assert.ok(
        geometry.scroll <= geometry.width + 1 && !geometry.overflowRows,
        'long names must not overflow',
      );
      await page.screenshot({
        path: `artifacts/design-audit/search-${colorScheme}-${viewport.width}.png`,
      });
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    await page.getByRole('dialog', { name: 'Ajustes', exact: true }).waitFor();
    await page.setViewportSize({ width: 450, height: 420 });
    for (const name of ['Cuentas', 'Interfaz', 'Red']) {
      await page.getByRole('tab', { name, exact: true }).click();
      assert.equal(
        await page
          .getByRole('dialog', { name: 'Ajustes', exact: true })
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
        `${name} must fit a zoom-sized viewport`,
      );
      await page.screenshot({ path: `artifacts/design-audit/settings-${colorScheme}-${name}.png` });
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 900, height: 620 });
    await page.emulateMedia({ forcedColors: 'active' });
    for (const control of [
      settingsButton,
      page.getByRole('tab', { name: 'Revisar el proyecto 1', exact: true }),
    ]) {
      await control.focus();
      const focus = await control.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          style: style.outlineStyle,
          width: Number.parseFloat(style.outlineWidth),
          visible: el.matches(':focus-visible'),
          name: el.getAttribute('aria-label') ?? el.textContent,
        };
      });
      assert.ok(
        focus.style === 'solid' && focus.width >= 2,
        `high contrast mode must retain focus when shadows are removed: ${JSON.stringify(focus)}`,
      );
    }
    await page.emulateMedia({ forcedColors: 'none' });
    await page.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
    assert.equal(
      await page
        .locator('.composer-tools.open .composer-chips')
        .evaluate((el) =>
          [...el.children].every((child) => getComputedStyle(child).animationDelay === '0s'),
        ),
      true,
      'reduced motion must also remove staggered entrance delays',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: light/dark navigation contrast, keyboard/high-contrast focus, reduced motion, search scrolling and zoom-sized settings.',
  );
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(buildDir, { recursive: true, force: true });
}
