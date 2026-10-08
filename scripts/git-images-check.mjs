// Isolated end-to-end verification. Only temporary repositories and profiles are used.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-git-images-')));
const project = path.join(root, 'project'),
  data = path.join(root, 'data'),
  remote = path.join(root, 'remote.git');
await fs.mkdir(project);
await fs.mkdir(data);
const git = async (...args) => (await exec('git', args, { cwd: project })).stdout.trim();
await git('init', '-b', 'main');
await git('config', 'user.name', 'Agent Desk Test');
await git('config', 'user.email', 'test@example.invalid');
await git('config', 'commit.gpgsign', 'false');
await git('config', 'core.hooksPath', '/dev/null');
await git('init', '--bare', '-b', 'main', remote);
await git('remote', 'add', 'origin', remote);
await fs.writeFile(path.join(project, 'base.txt'), 'base\n');
await git('add', '.');
await git('commit', '-m', 'Base');
await fs.writeFile(path.join(project, 'nuevo.txt'), 'nuevo\n');
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [{ id: 'claude-1', name: 'Test', kind: 'claude' }],
    projects: [{ id: 'project', name: 'Proyecto de prueba', path: project }],
    sessions: [
      { id: 'session', projectId: 'project', profile: 'claude-1', title: 'Prueba', messages: [] },
    ],
    selectedProject: 'project',
    selectedSession: 'session',
    tools: { claude: '/usr/bin/false', codex: '/usr/bin/false' },
  }),
);
let app;
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => !!window.desk);
  const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
  await page.getByRole('button', { name: 'Gestionar ramas y Git' }).click();
  await page.getByRole('region', { name: 'Flujo de Git' }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Rama local' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Preparar todos', exact: true }).click();
  await page.getByText('Cambios preparados.', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Mensaje del commit' }).fill('Commit desde la interfaz');
  await page.getByRole('button', { name: 'Crear commit', exact: true }).click();
  await page.getByText('Commit creado.', { exact: true }).waitFor();
  assert.equal(await git('log', '-1', '--format=%s'), 'Commit desde la interfaz');
  await page.getByRole('textbox', { name: 'Nombre de nueva rama' }).fill('feature/visual');
  await page.getByRole('button', { name: 'Crear rama', exact: true }).click();
  await page.getByText('Rama creada y seleccionada.', { exact: true }).waitFor();
  assert.equal(await git('branch', '--show-current'), 'feature/visual');
  await page.getByRole('button', { name: 'Publicar rama', exact: true }).click();
  await page.getByText('Rama enviada al remoto.', { exact: true }).waitFor();
  assert.equal(await git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/visual');
  await page.getByRole('button', { name: 'Consultar remoto', exact: true }).click();
  await page.getByText('Referencias remotas actualizadas.', { exact: true }).waitFor();
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/git-flujo.png' });
  await page.getByRole('button', { name: 'Gestionar ramas y Git' }).click();
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(
        Buffer.from([70, 100, 180, 255, 90, 120, 200, 255, 180, 120, 80, 255, 80, 180, 120, 255]),
        { width: 2, height: 2 },
      )
      .toPNG()
      .toString('base64'),
  );
  const drop = (names, extra = {}) =>
    page.evaluate(
      ({ names, png, extra }) => {
        const transfer = new DataTransfer();
        for (const name of names)
          transfer.items.add(
            new File(
              [
                extra.large
                  ? new Uint8Array(5 * 1024 * 1024 + 1)
                  : extra.invalid
                    ? 'invalid'
                    : Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
              ],
              name,
              { type: 'image/png' },
            ),
          );
        const target = document.querySelector('.messages');
        target.dispatchEvent(
          new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
        target.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
        target.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      },
      { names, png, extra },
    );
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Describe las imágenes');
  await drop(['uno.png']);
  await page.getByRole('img', { name: 'uno.png', exact: true }).waitFor();
  await drop(['no.png'], { invalid: true });
  await page
    .getByText('Formato no compatible. Selecciona PNG, JPEG, GIF o WebP.', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.attachment-thumb').count(), 1);
  await drop(['grande.png'], { large: true });
  await page.locator('.attachment-error').filter({ hasText: '5 MB' }).waitFor();
  await drop(['dos.png', 'tres.png', 'cuatro.png']);
  await page.getByRole('img', { name: 'cuatro.png', exact: true }).waitFor();
  await drop(['cinco.png']);
  await page.locator('.attachment-error').filter({ hasText: 'hasta 4' }).waitFor();
  assert.equal(await page.locator('.attachment-thumb').count(), 4);
  assert.equal(await page.locator('.image-drop-active').count(), 0);
  const second = await call({ type: 'newSession', projectId: 'project', profile: 'claude-1' });
  await page.getByRole('img', { name: 'uno.png' }).waitFor({ state: 'detached' });
  await call({ type: 'select', projectId: 'project', sessionId: 'session' });
  await page.getByRole('img', { name: 'uno.png' }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Describe las imágenes',
  );
  assert.equal(
    (await call({ type: 'snapshot' })).sessions.find((s) => s.id === second.id).messages.length,
    0,
  );
  await page.getByRole('button', { name: 'Quitar uno.png', exact: true }).click();
  assert.equal(await page.locator('.attachment-thumb').count(), 3);
  await page.screenshot({ path: 'artifacts/chat-imagenes-arrastradas.png' });
  assert.ok((await page.locator('.conversation').boundingBox()).width <= 960);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  await page.getByRole('button', { name: 'Gestionar ramas y Git' }).click();
  await page.screenshot({ path: 'artifacts/git-chat-compacto.png' });
  assert.equal(
    await page.locator('.conversation').evaluate((e) => e.scrollWidth <= e.clientWidth),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real Git stage/commit/create/publish/fetch through UI; drag/drop validation, limits, previews, removal and per-chat drafts; 960px cap and narrow layout. Only temporary local repositories/profiles, no model calls.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
