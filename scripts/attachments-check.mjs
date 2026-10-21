// Real Electron UI/IPC with isolated data, no inference or account changes.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Composer tools sit behind the "+" toggle.
async function openComposerTools(page) {
  const toggle = page.getByRole('button', { name: 'Herramientas del chat', exact: true });
  if (await toggle.count()) await toggle.click();
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-documents-ui-'));
const project = path.join(root, 'project'),
  data = path.join(root, 'data');
await fs.mkdir(project);
await fs.mkdir(data);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [{ id: 'claude-1', name: 'Test', kind: 'claude' }],
    projects: [{ id: 'p', name: 'Proyecto adjuntos', path: project }],
    sessions: [{ id: 's', projectId: 'p', profile: 'claude-1', title: 'Adjuntos', messages: [] }],
    selectedProject: 'p',
    selectedSession: 's',
    tools: { claude: '/usr/bin/false', codex: '/usr/bin/false' },
  }),
);
const pdf = path.join(root, 'informe.pdf');
await fs.writeFile(pdf, '%PDF-1.4\n%%EOF');
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
  await page.waitForFunction(() => !!window.desk);
  const call = (action) => page.evaluate((a) => window.desk.invoke(a), action);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async (window, options) => {
      if (!options.filters.some((f) => f.extensions.includes('pdf')))
        throw Error('Falta filtro PDF');
      return { canceled: false, filePaths: [file] };
    };
  }, pdf);
  await openComposerTools(page);
  await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).click();
  await page.locator('.attachment-file').filter({ hasText: 'informe.pdf' }).waitFor();
  await page.locator('.attachment-thumb button').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: 'Enviar', exact: true }).isEnabled(), true);
  const transferFiles = async (files, paste = false) => {
    await page.evaluate(
      ({ files, paste }) => {
        const dataTransfer = new DataTransfer();
        for (const f of files)
          dataTransfer.items.add(new File([f.text], f.name, { type: f.type ?? '' }));
        const target = document.querySelector(
          paste ? 'textarea[aria-label="Mensaje"]' : '.messages',
        );
        target.dispatchEvent(
          paste
            ? new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dataTransfer,
              })
            : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
        );
      },
      { files, paste },
    );
  };
  await transferFiles([
    { name: 'ventas.csv', text: 'producto,importe\ncafé,12', type: 'text/csv' },
  ]);
  await page.locator('.attachment-file').filter({ hasText: 'ventas.csv' }).waitFor();
  await transferFiles([{ name: 'notas.txt', text: 'Texto pegado', type: 'text/plain' }], true);
  await page.locator('.attachment-file').filter({ hasText: 'notas.txt' }).waitFor();
  await transferFiles([
    { name: 'documento.docx', text: 'PK\x03\x04office' },
    { name: 'datos.xlsx', text: 'PK\x03\x04excel' },
  ]);
  await page.locator('.attachment-file').filter({ hasText: 'datos.xlsx' }).waitFor();
  assert.equal(await page.locator('.attachment-thumb img').count(), 0);
  await transferFiles(Array.from({ length: 6 }, (_, i) => ({ name: `extra${i}.txt`, text: 'x' })));
  await page.locator('.attachment-file').filter({ hasText: 'extra5.txt' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).isEnabled(),
    true,
  );
  assert.equal(await page.locator('.attachment-error').count(), 0);
  assert.equal(await page.locator('.attachment-thumb').count(), 11);
  const second = await call({ type: 'newSession', projectId: 'p', profile: 'claude-1' });
  await page.locator('.attachment-thumb').first().waitFor({ state: 'detached' });
  await call({ type: 'select', projectId: 'p', sessionId: 's' });
  await page.locator('.attachment-file').filter({ hasText: 'informe.pdf' }).waitFor();
  assert.equal(await page.locator('.attachment-thumb').count(), 11);
  const refs = await call({
    type: 'dropImages',
    sessionId: 's',
    images: [{ name: 'empty.txt', data: '' }],
  });
  await assert.rejects(
    call({ type: 'send', sessionId: second.id, text: '', attachmentIds: [refs[0].id] }),
    /no pertenece/,
  );
  await call({ type: 'discardImages', sessionId: 's', attachmentIds: [refs[0].id] });
  await page.getByRole('button', { name: 'Quitar notas.txt', exact: true }).click();
  assert.equal(await page.locator('.attachment-thumb').count(), 10);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('.conversation').evaluate((e) => e.scrollWidth <= e.clientWidth),
    true,
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/attachments-documents.png' });
  assert.deepEqual(await fs.readdir(project), []);
  assert.equal(await fs.readFile(pdf, 'utf8'), '%PDF-1.4\n%%EOF');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: PDF picker, CSV/Office drop, text file paste, attachment-only send enabled, more than ten files, per-chat drafts, ownership, removal and compact layout. No inference calls.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
