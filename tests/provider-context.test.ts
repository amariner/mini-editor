import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenRouterRuntime } from '../electron/openrouter-runtime';
import { OpenRouterService } from '../electron/openrouter';
import type { ModelInfo, Session } from '../src/shared';

const tool = (name: string, args: Record<string, string>, index = 0) => ({
  index,
  id: `call-${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Provider context fixture timed out.');
}
async function fixture(t: test.TestContext, name = 'Local') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'provider-context-')));
  const project = path.join(root, 'Project "quoted" folder');
  await fs.mkdir(project);
  const bodies: any[] = [];
  const responses: any[][] = [];
  class Service extends OpenRouterService {
    override readonly name = name;
    override async key() {
      return 'fixture';
    }
    override async usage() {
      return undefined;
    }
    override async request(_route: string, _key: string | undefined, init: RequestInit = {}) {
      bodies.push(JSON.parse(String(init.body)));
      const calls = responses.shift();
      const event = {
        choices: [
          {
            delta: calls?.length ? { tool_calls: calls } : { content: 'Hecho' },
            finish_reason: calls?.length ? 'tool_calls' : 'stop',
          },
        ],
      };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    }
  }
  const model: ModelInfo = {
    value: 'fixture.gguf',
    displayName: 'Fixture',
    description: 'Fixture',
    tools: false,
    image: false,
  };
  const session: Session = {
    id: 's',
    projectId: 'p',
    profile: 'local-1',
    title: 'Local context',
    status: 'ready',
    messages: [],
    approvals: [],
    providerConfig: { model: model.value },
  };
  const runtime = new OpenRouterRuntime(
    session,
    project,
    new Service(root),
    () => {},
    async () => [model],
    () => 'Keep answers concise.',
  );
  t.after(async () => {
    await runtime.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    project,
    bodies,
    responses,
    model,
    session,
    runtime,
    context: () => bodies.at(-1).messages[0].content as string,
    ready: () => waitFor(() => session.status === 'ready'),
    waiting: () => waitFor(() => session.status === 'waiting'),
  };
}

test('local text mode knows the exact project and explains the actual tools setting', async (t) => {
  const f = await fixture(t);
  await f.runtime.send('¿En qué carpeta estás? Escribe una nota.', []);
  await f.ready();
  assert.ok(f.context().includes(JSON.stringify(f.project)), 'project path is unambiguous');
  assert.match(f.context(), /working directory "\." is this project/);
  assert.match(f.context(), /do not ask the user to provide it again/);
  assert.match(f.context(), /Project tools are disabled/);
  assert.match(f.context(), /Permitir herramientas del proyecto/);
  assert.match(f.context(), /Ajustes → Cuentas/);
  assert.match(f.context(), /operating-system permission will not enable tools/);
  assert.match(f.context(), /Keep answers concise/);
  assert.equal(f.bodies[0].tools, undefined);
  assert.equal(f.session.approvals.length, 0);
  assert.deepEqual(await fs.readdir(f.project), []);
});

test('enabled local context supports project reads and delegates write approval to the app', async (t) => {
  const f = await fixture(t);
  f.model.tools = true;
  await fs.writeFile(path.join(f.project, 'seed.txt'), 'Project fixture contents');
  f.responses.push(
    [tool('list_files', { path: '.' }), tool('read_file', { path: 'seed.txt' }, 1)],
    [tool('write_file', { path: 'result.txt', content: 'Project fixture contents copied' })],
  );
  await f.runtime.send('Revisa el proyecto y copia seed.txt a result.txt.', []);
  await f.waiting();
  assert.equal(f.bodies.length, 2, 'project reads need no separate approval');
  assert.ok(f.context().includes(JSON.stringify(f.project)));
  assert.match(f.context(), /Project tools are enabled/);
  assert.match(f.context(), /call list_files with path "\."/);
  assert.match(f.context(), /initiate that approval by calling the tool/);
  assert.doesNotMatch(f.context(), /Project tools are disabled/);
  assert.deepEqual(
    f.bodies[0].tools.map((item: any) => item.function.name),
    ['read_file', 'list_files', 'write_file', 'run_command'],
  );
  const results = f.bodies[1].messages.filter((message: any) => message.role === 'tool');
  assert.deepEqual(JSON.parse(results[0].content), {
    directory: f.project,
    entries: ['seed.txt'],
  });
  assert.equal(results[1].content, 'Project fixture contents');
  assert.equal(f.session.approvals.length, 1);
  assert.equal(f.session.approvals[0].input.path, 'result.txt');
  await assert.rejects(fs.access(path.join(f.project, 'result.txt')));
  f.runtime.approve(f.session.approvals[0].id, 'accept');
  await f.ready();
  assert.equal(
    await fs.readFile(path.join(f.project, 'result.txt'), 'utf8'),
    'Project fixture contents copied',
  );
  assert.equal(f.session.error, undefined);

  // Changing the setting on a live chat must change the next request too.
  f.model.tools = false;
  await f.runtime.send('¿Siguen activadas las herramientas?', []);
  await f.ready();
  assert.equal(f.bodies.at(-1).tools, undefined);
  assert.match(f.context(), /Project tools are disabled/);
});

test('a remote text-only model is directed to model selection, not local account settings', async (t) => {
  const f = await fixture(t, 'OpenRouter');
  await f.runtime.send('Lee el proyecto.', []);
  await f.ready();
  assert.ok(f.context().includes(JSON.stringify(f.project)));
  assert.match(f.context(), /select a model with tool support/);
  assert.doesNotMatch(f.context(), /Permitir herramientas del proyecto/);
  assert.equal(f.bodies[0].tools, undefined);
});
