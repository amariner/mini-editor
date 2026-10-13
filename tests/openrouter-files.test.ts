import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenRouterRuntime } from '../electron/openrouter-runtime';
import { OpenRouterService } from '../electron/openrouter';
import type { Session, ModelInfo } from '../src/shared';

const call = (name: string, args: Record<string, string>) => ({
  index: 0,
  id: 'tool-' + Math.random(),
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
async function wait(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error('timeout');
}
async function fixture(t: test.TestContext, image = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-read-')));
  const project = path.join(root, 'project');
  const external = path.join(root, 'references');
  await fs.mkdir(project);
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'note.txt'), 'external reference');
  const bodies: any[] = [];
  const queue: any[][] = [];
  const api = new OpenRouterService(root, {
    codec: { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
    fetch: async (_url, init) => {
      if (!init?.body) return Response.json({ data: { usage: 0 } });
      bodies.push(JSON.parse(String(init.body)));
      const calls = queue.shift();
      const event = {
        choices: [
          {
            delta: calls?.length ? { tool_calls: calls } : { content: 'Hecho' },
            finish_reason: calls?.length ? 'tool_calls' : 'stop',
          },
        ],
      };
      return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n');
    },
  });
  await api.connect('openrouter-1', 'fixture');
  const s: Session = {
    id: 's',
    projectId: 'p',
    profile: 'openrouter-1',
    title: 'T',
    status: 'ready',
    messages: [],
    approvals: [],
    providerConfig: { model: 'fixture' },
  };
  const model: ModelInfo = {
    value: 'fixture',
    displayName: 'Fixture',
    description: 'Test model',
    tools: true,
    image,
  };
  const runtime = () =>
    new OpenRouterRuntime(
      s,
      project,
      api,
      () => {},
      async () => [model],
      () => '',
    );
  let rt = runtime();
  t.after(async () => {
    await rt.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    project,
    external,
    bodies,
    queue,
    s,
    get rt() {
      return rt;
    },
    async restart() {
      await rt.stop();
      rt = runtime();
    },
    async run(...calls: any[]) {
      queue.push(calls);
      await rt.send('Lee la referencia', []);
    },
    async pending() {
      await wait(() => s.status === 'waiting');
      return s.approvals[0];
    },
    async ready() {
      await wait(() => s.status === 'ready');
    },
    results() {
      return bodies
        .at(-1)
        .messages.filter((m: any) => m.role === 'tool')
        .map((m: any) => m.content)
        .join('\n');
    },
  };
}
test('external reading asks inline, accept-once does not grant the whole folder', async (t) => {
  const f = await fixture(t);
  await f.run(call('read_file', { path: '../references/note.txt' }));
  const approval = await f.pending();
  assert.equal(approval.method, 'provider/read-external');
  assert.equal(approval.input.directory, f.external);
  assert.equal(f.bodies.length, 1, 'no contents sent before approval');
  f.rt.approve(approval.id, 'accept');
  await f.ready();
  assert.match(f.results(), /external reference/);
  await f.run(call('read_file', { path: path.join(f.external, 'note.txt') }));
  f.rt.approve((await f.pending()).id, 'decline');
  await f.ready();
  assert.match(f.results(), /rechazado/);
});
test('folder grant covers nested reads, but not sibling prefixes, symlink escapes or writes', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.external, 'nested'));
  await fs.writeFile(path.join(f.external, 'nested/a.txt'), 'nested content');
  const other = f.external + '-other';
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, 'secret.txt'), 'other reference');
  await fs.symlink(other, path.join(f.external, 'link'));
  await f.run(call('list_files', { path: f.external }));
  f.rt.approve((await f.pending()).id, 'always');
  await f.ready();
  await f.run(call('read_file', { path: path.join(f.external, 'nested/a.txt') }));
  await f.ready();
  assert.match(f.results(), /nested content/);
  for (const filename of [
    path.join(other, 'secret.txt'),
    path.join(f.external, 'link/secret.txt'),
  ]) {
    await f.run(call('read_file', { path: filename }));
    assert.equal((await f.pending()).input.directory, other);
    f.rt.approve(f.s.approvals[0].id, 'decline');
    await f.ready();
    assert.doesNotMatch(f.results(), /other reference/);
  }
  await f.run(call('write_file', { path: path.join(f.external, 'note.txt'), content: 'changed' }));
  await f.ready();
  assert.equal(await fs.readFile(path.join(f.external, 'note.txt'), 'utf8'), 'external reference');
  assert.match(f.results(), /fuera del proyecto/);
  await f.restart();
  await f.run(call('read_file', { path: path.join(f.external, 'note.txt') }));
  await f.pending();
  await f.rt.interrupt();
});
test('rejection and interruption never send external contents', async (t) => {
  for (const decline of [true, false]) {
    const f = await fixture(t);
    await f.run(call('read_file', { path: '../references/note.txt' }));
    const approval = await f.pending();
    if (decline) f.rt.approve(approval.id, 'decline');
    else await f.rt.interrupt();
    await f.ready();
    assert.equal(f.s.approvals.length, 0);
    assert.doesNotMatch(JSON.stringify(f.bodies), /external reference/);
  }
});
test('changing a symlink during approval does not read the replacement or retain a folder grant', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.project, 'reference');
  await fs.symlink(path.join(f.external, 'note.txt'), link);
  await fs.writeFile(path.join(f.external, 'second.txt'), 'replacement contents');
  await f.run(call('read_file', { path: link }));
  const approval = await f.pending();
  await fs.unlink(link);
  await fs.symlink(path.join(f.external, 'second.txt'), link);
  f.rt.approve(approval.id, 'always');
  await f.ready();
  assert.match(f.results(), /ruta ha cambiado/);
  assert.doesNotMatch(JSON.stringify(f.bodies), /replacement contents/);
  await f.run(call('read_file', { path: link }));
  await f.pending();
  await f.rt.interrupt();
});
test('sensitive files stay excluded after granting an external directory; normal project reads need no approval', async (t) => {
  const f = await fixture(t);
  await f.run(call('list_files', { path: f.external }));
  f.rt.approve((await f.pending()).id, 'always');
  await f.ready();
  await fs.writeFile(path.join(f.external, '.env'), 'private secret');
  await fs.symlink(path.join(f.external, '.env'), path.join(f.project, 'alias'));
  for (const filename of [path.join(f.external, '.env'), 'alias']) {
    await f.run(call('read_file', { path: filename }));
    await f.ready();
    assert.match(f.results(), /sensible/);
    assert.doesNotMatch(JSON.stringify(f.bodies), /private secret/);
  }
  await fs.writeFile(path.join(f.project, 'local.txt'), 'local content');
  await f.run(call('read_file', { path: 'local.txt' }));
  await f.ready();
  assert.match(f.results(), /local content/);
});
test('vision reads send approved bytes after the complete tool-result group without persisting base64', async (t) => {
  const f = await fixture(t);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
    'base64',
  );
  await fs.writeFile(path.join(f.external, 'reference.png'), png);
  const list = call('list_files', { path: '.' });
  list.index = 1;
  await f.run(call('read_image', { path: '../references/reference.png' }), list);
  f.rt.approve((await f.pending()).id, 'accept');
  await f.ready();
  const messages = f.bodies.at(-1).messages;
  assert.deepEqual(
    messages.slice(-3).map((m: any) => m.role),
    ['tool', 'tool', 'user'],
  );
  assert.equal(
    messages.at(-1).content[1].image_url.url,
    'data:image/png;base64,' + png.toString('base64'),
  );
  assert.doesNotMatch(JSON.stringify(f.s), /data:image/);
});
test('text-only models neither advertise vision nor load local images as text', async (t) => {
  const f = await fixture(t, false);
  await fs.writeFile(
    path.join(f.project, 'image.png'),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  await f.run(call('read_image', { path: 'image.png' }));
  await f.ready();
  assert.ok(f.bodies[0].tools.every((t: any) => t.function.name !== 'read_image'));
  assert.match(f.results(), /modelo con visión/);
  await f.run(call('read_file', { path: 'image.png' }));
  await f.ready();
  assert.match(f.results(), /binario.*modelo con visión/);
  assert.doesNotMatch(JSON.stringify(f.bodies), /data:image/);
});
