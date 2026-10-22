// Renderer-only fixture for worktree isolation: no accounts, provider processes or model calls.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
await fs.mkdir('artifacts', { recursive: true });
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-worktree-ui-'));
let browser, server;
try {
  await build({ build: { outDir: output, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((protocol) => {
    const worktree = {
      path: '/tmp/data/worktrees/web-1/arreglar-login-s0',
      cwd: '/tmp/data/worktrees/web-1/arreglar-login-s0',
      branch: 'agent-desk/arreglar-login-s0',
      base: 'main',
      baseCommit: 'abc',
      root: '/tmp/web',
      createdAt: 1,
    };
    const chat = (id, patch) => ({
      id,
      projectId: 'p0',
      profile: 'claude-1',
      mode: 'chat',
      status: 'stopped',
      approvals: [],
      messages: [],
      reference: `ref-${id}`,
      ...patch,
    });
    const state = {
      profiles: [{ id: 'claude-1', kind: 'claude', name: 'Personal' }],
      accounts: { 'claude-1': { status: 'signedIn', label: 'ana@example.test', plan: 'Pro' } },
      projects: [{ id: 'p0', name: 'web', path: '/tmp/web' }],
      sessions: [
        chat('s0', {
          title: 'Arreglar login',
          status: 'ready',
          attempted: true,
          worktree,
          isolation: 'worktree',
          messages: [
            { id: 'u-1', role: 'user', text: 'Arregla el login', checkpoint: 'c1' },
            { id: 'a-1', role: 'assistant', text: 'He cambiado `src/login.ts`.' },
          ],
        }),
        chat('s1', { title: 'Refactor', status: 'working', attempted: true }),
        chat('s2', { title: 'Sesión 3' }),
      ],
      selectedSession: sessionStorage.getItem('fixture-selected') ?? 's0',
      selectedProject: 'p0',
      runtime: { protocol },
      tools: {},
      coordination: [],
    };
    const listeners = new Set();
    const publish = () => {
      for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
    };
    window.fixture = { state, actions: [], publish };
    const snapshot = (withWorktree) => ({
      repository: true,
      branch: withWorktree ? worktree.branch : 'main',
      branches: ['main'],
      files: [{ path: 'src/login.ts', index: ' ', worktree: 'M', conflict: false }],
      counts: { staged: 0, unstaged: 1, untracked: 0, conflicts: 0 },
      status: '',
      staged: '',
      unstaged: '',
      lines: { added: 3, removed: 1 },
      commits: [],
      ...(withWorktree
        ? {
            worktree: {
              exists: true,
              branch: worktree.branch,
              base: 'main',
              mainBranch: 'main',
              ahead: 1,
              behind: 2,
              dirty: 1,
              conflicts: 0,
            },
          }
        : {}),
    });
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
          state.selectedSession = a.sessionId;
          return true;
        }
        if (a.type === 'diff') return snapshot(!!a.sessionId);
        if (a.type === 'worktree' && a.operation === 'merge')
          return {
            merged: false,
            conflicts: ['src/login.ts'],
            message: 'La fusión en main tendría conflictos en 1 archivos.',
          };
        if (a.type === 'rewindFiles')
          return a.dryRun
            ? { canRewind: true, filesChanged: ['src/login.ts'], insertions: 1, deletions: 3 }
            : { canRewind: true, filesChanged: ['src/login.ts'] };
        if (a.type === 'setIsolation') {
          state.sessions.find((s) => s.id === a.sessionId).isolation = a.isolation;
          publish();
          return true;
        }
        if (a.type === 'forkSession') {
          const source = state.sessions.find((s) => s.id === a.sessionId);
          const fork = {
            ...structuredClone(source),
            messages: structuredClone(source.messages).map((m) => ({
              ...m,
              checkpoint: undefined,
            })),
            id: 's3',
            title: `${source.title} (copia)`,
            status: 'stopped',
            forkFrom: source.reference,
            forkOf: source.id,
            worktree: { ...worktree, branch: 'agent-desk/arreglar-login-copia-s3' },
          };
          state.sessions.push(fork);
          state.selectedSession = fork.id;
          return fork;
        }
        if (a.type === 'listFiles') return [];
        return true;
      },
    };
  }, protocol);
  await page.goto(server.resolvedUrls.local[0]);
  // Isolation and worktree actions share the compact Git popover below the composer.
  const gitToggle = page.getByRole('button', { name: 'Gestionar ramas y Git' });
  await gitToggle.getByText('Worktree · agent-desk/arreglar-login-s0').waitFor();
  await gitToggle.click();
  const strip = page.locator('.isolation-bar');
  await strip.getByText('agent-desk/arreglar-login-s0').waitFor();
  assert.ok(await strip.getByRole('button', { name: 'Duplicar chat' }).isVisible());
  const panel = page.locator('.worktree-panel');
  await panel.getByText('1 archivos sin commit · 1 commits por fusionar').waitFor();
  await page.screenshot({ path: 'artifacts/worktree-panel.png' });
  await panel.getByRole('button', { name: 'Fusionar en main' }).click();
  await panel.getByText('La fusión en main tendría conflictos').waitFor();
  assert.ok(
    await panel.locator('.git-file-list code', { hasText: 'src/login.ts' }).first().isVisible(),
  );
  await panel.getByRole('button', { name: 'Descartar worktree' }).click();
  await panel.getByRole('alertdialog', { name: 'Confirmar descarte' }).waitFor();
  await page.screenshot({ path: 'artifacts/worktree-merge-conflict.png' });
  await panel.getByRole('button', { name: 'Cancelar' }).click();
  await page.keyboard.press('Escape');
  // Per-turn undo: dry run preview, then confirm.
  const userRow = page.locator('.row.user:visible').first();
  await userRow.hover();
  await userRow.getByRole('button', { name: 'Deshacer cambios de este turno' }).click();
  const confirm = page.locator('.rewind-confirm:visible');
  await confirm.getByText('Se restaurarán 1 archivo').waitFor();
  await page.screenshot({ path: 'artifacts/worktree-rewind.png' });
  await confirm.getByRole('button', { name: 'Deshacer' }).click();
  await confirm.getByText('1 archivos restaurados.').waitFor();
  const box = await confirm.boundingBox();
  assert.ok(box && box.height < 80 && box.width > 300, JSON.stringify(box));
  const rewinds = await page.evaluate(() =>
    window.fixture.actions.filter((a) => a.type === 'rewindFiles'),
  );
  assert.deepEqual(
    rewinds.map((a) => [a.messageId, !!a.dryRun]),
    [
      ['u-1', true],
      ['u-1', false],
    ],
  );
  // Duplicate opens the copy with the same history.
  await gitToggle.click();
  await strip.getByRole('button', { name: 'Duplicar chat' }).click();
  await page.waitForFunction(() => window.fixture.state.selectedSession === 's3');
  await gitToggle.click();
  await page.locator('.isolation-bar').getByText('agent-desk/arreglar-login-copia-s3').waitFor();
  await page.locator('.row.user:visible', { hasText: 'Arregla el login' }).waitFor();
  // A new chat defaults to isolation because another agent is running.
  await page.evaluate(() => sessionStorage.setItem('fixture-selected', 's2'));
  await page.reload();
  await gitToggle.click();
  const toggle = page.getByRole('checkbox', { name: /Aislar en worktree/ });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), true);
  assert.match(
    await page.locator('.isolation-toggle').innerText(),
    /activado: hay 2 agentes en este proyecto/,
  );
  const label = await page.locator('.isolation-toggle').boundingBox();
  const check = await toggle.boundingBox();
  assert.ok(check.width < 24 && label.width > 300, JSON.stringify({ label, check }));
  await page.screenshot({ path: 'artifacts/worktree-default-toggle.png' });
  await toggle.uncheck();
  assert.deepEqual(
    (await page.evaluate(() => window.fixture.actions)).find((a) => a.type === 'setIsolation'),
    { type: 'setIsolation', sessionId: 's2', isolation: 'shared' },
  );
  await page.keyboard.press('Escape');
  // Multichat card shows the worktree branch and a duplicate action.
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  await page
    .locator('[data-session-id="s0"] .multichat-worktree')
    .getByText('agent-desk/arreglar-login-s0')
    .waitFor();
  await page
    .locator('[data-session-id="s0"]')
    .getByRole('button', { name: 'Opciones de Arreglar login', exact: true })
    .click();
  assert.ok(
    await page.getByRole('menuitem', { name: 'Duplicar Arreglar login', exact: true }).isVisible(),
  );
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'artifacts/worktree-multichat.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Worktree UI: branch strip, Git worktree panel, merge conflicts, discard confirmation, per-turn undo, duplicate chat, default isolation toggle and Multichat branch passed.',
  );
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(output, { recursive: true, force: true });
}
