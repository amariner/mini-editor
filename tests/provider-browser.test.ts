import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterRuntime } from '../electron/openrouter-runtime';
import { OpenRouterService } from '../electron/openrouter';
import { coordinationToolResult } from '../electron/coordination-result';
import type { BrowserInput } from '../src/browser-protocol';
import type { ModelInfo, Session } from '../src/shared';

async function fixture(t: test.TestContext, connected = true) {
  const bodies: any[] = [];
  const queue: BrowserInput[][] = [];
  const actions: BrowserInput[] = [];
  let result: unknown = { tabs: [{ id: 'tab', title: 'Example' }] };
  class Service extends OpenRouterService {
    override async key() {
      return 'fixture';
    }
    override async request(_route: string, _key: string | undefined, init: RequestInit = {}) {
      bodies.push(JSON.parse(String(init.body)));
      const calls = queue.shift()?.map((input, index) => ({
        index,
        id: `browser-${index}`,
        type: 'function',
        function: { name: 'browser', arguments: JSON.stringify(input) },
      }));
      return new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: calls?.length ? { tool_calls: calls } : { content: 'Hecho' },
              finish_reason: calls?.length ? 'tool_calls' : 'stop',
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
    }
  }
  const s: Session = {
    id: 's',
    projectId: 'p',
    profile: 'openrouter-1',
    title: 'Browser',
    status: 'ready',
    messages: [],
    approvals: [],
    providerConfig: { model: 'fixture' },
  };
  const model: ModelInfo = {
    value: 'fixture',
    displayName: 'Fixture',
    description: '',
    tools: true,
    image: true,
  };
  const runtime = new OpenRouterRuntime(
    s,
    '/project',
    new Service('/unused'),
    () => {},
    async () => [model],
    () => '',
    connected
      ? async (input, signal) => {
          signal.throwIfAborted();
          actions.push(input);
          return result;
        }
      : undefined,
  );
  t.after(() => runtime.stop());
  return {
    s,
    model,
    bodies,
    actions,
    runtime,
    setResult(value: unknown) {
      result = value;
    },
    async run(...inputs: BrowserInput[]) {
      queue.push(inputs);
      await runtime.send('Controla la web del proyecto', []);
      for (let i = 0; i < 200 && s.status !== 'ready'; i++)
        await new Promise((r) => setTimeout(r, 5));
      assert.equal(s.status, 'ready');
    },
    results() {
      return bodies.at(-1).messages.filter((m: any) => m.role === 'tool');
    },
  };
}

test('API browser tool uses the shared schema and accepts direct list/new state without extra approvals', async (t) => {
  const f = await fixture(t);
  await f.run({ action: 'list' });
  const spec = f.bodies[0].tools.find((entry: any) => entry.function.name === 'browser');
  assert.ok(spec.function.parameters.properties.action.enum.includes('inspect'));
  assert.match(f.bodies[0].messages[0].content, /do not request a duplicate permission/);
  assert.deepEqual(f.actions, [{ action: 'list' }]);
  assert.match(f.results()[0].content, /Example/);
  assert.equal(f.s.approvals.length, 0);
  assert.ok(f.s.info?.tools.includes('browser'));
  f.setResult({ id: 'second', url: 'https://example.com' });
  await f.run({ action: 'new', url: 'https://example.com' });
  assert.doesNotMatch(f.results().at(-1).content, /Error:/);
});

test('browser screenshots carry viewport metadata and image bytes after the full tool group, never in saved messages', async (t) => {
  const f = await fixture(t);
  f.setResult({
    ok: true,
    image: 'fixture-image',
    mimeType: 'image/png',
    viewport: { width: 1600, height: 900 },
    imageSize: { width: 1440, height: 810 },
  });
  await f.run({ action: 'screenshot', tabId: 'tab' }, { action: 'screenshot', tabId: 'tab' });
  const messages = f.bodies.at(-1).messages;
  assert.deepEqual(
    messages.slice(-3).map((m: any) => m.role),
    ['tool', 'tool', 'user'],
  );
  assert.match(messages.at(-3).content, /1600/);
  assert.equal(messages.at(-1).content[1].image_url.url, 'data:image/png;base64,fixture-image');
  assert.doesNotMatch(JSON.stringify(f.s), /fixture-image/);
});

test('text models can inspect pages but cannot request screenshots; disabled tools do not advertise browser', async (t) => {
  const f = await fixture(t);
  f.model.image = false;
  await f.run({ action: 'screenshot' });
  assert.deepEqual(f.actions, []);
  assert.match(f.results()[0].content, /Usa inspect/);
  await f.run({ action: 'inspect' });
  assert.deepEqual(f.actions, [{ action: 'inspect' }]);
  f.model.tools = false;
  await f.run();
  assert.equal(f.bodies.at(-1).tools, undefined);
  assert.deepEqual(f.s.info?.tools, []);
});

test('unavailable and malformed browser calls never dispatch; explicit runtime failures reach the model', async (t) => {
  const missing = await fixture(t, false);
  await missing.run({ action: 'list' });
  assert.ok(missing.bodies[0].tools.every((entry: any) => entry.function.name !== 'browser'));
  assert.match(missing.results()[0].content, /no está disponible/);
  const f = await fixture(t);
  await f.run({ action: 'execute', script: 'document.cookie' } as any);
  assert.deepEqual(f.actions, []);
  f.setResult({ ok: false, reason: 'La pestaña no pertenece a este proyecto.' });
  await f.run({ action: 'list' });
  assert.match(f.results().at(-1).content, /Error:.*no pertenece/);
  assert.equal(f.s.messages.filter((m) => m.tool).at(-1)?.tool?.status, 'failed');
});

test('MCP response adapters preserve successful direct state and report transport or explicit failures', () => {
  for (const value of [{ tabs: [] }, { id: 'new-tab' }, { ok: true }])
    assert.equal(coordinationToolResult(value).isError, false);
  assert.equal(coordinationToolResult({ reason: 'offline' }, false).isError, true);
  assert.equal(coordinationToolResult({ ok: false, reason: 'closed' }).isError, true);
  const image = coordinationToolResult({
    ok: true,
    image: 'data',
    mimeType: 'image/png',
    viewport: { width: 1200 },
  });
  assert.match((image.content[0] as any).text, /viewport/);
  assert.equal(image.content[1].type, 'image');
  const failure = coordinationToolResult({
    ok: false,
    image: 'private-bytes',
    mimeType: 'image/png',
    reason: 'failed',
  });
  assert.doesNotMatch(JSON.stringify(failure), /private-bytes/);
});
