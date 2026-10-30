import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OpenRouterService,
  routerError,
  routerModels,
  routerStream,
  routerUsage,
} from '../electron/openrouter';
import { OpenRouterRuntime, projectToolPath } from '../electron/openrouter-runtime';
import {
  geminiAccount,
  geminiLogout,
  geminiRpc,
  initializeGemini,
  GeminiRuntime,
} from '../electron/gemini';
import { Store } from '../electron/store';
import { actionSchema, profileDirectory } from '../electron/core';
import { providerKind, type Session } from '../src/shared';
import { googleClientUnavailable } from '../src/google-access';
import { Accounts } from '../electron/accounts';
const model = {
  id: 'test/coder:free',
  name: 'Coder',
  description: 'Coding',
  pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  supported_parameters: ['tools'],
  context_length: 8192,
};
const codec = {
  available: () => true,
  encrypt: (s: string) => Buffer.from('encrypted:' + s),
  decrypt: (b: Buffer) => b.toString().slice(10),
};
const session = (): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'openrouter-1',
  title: 'Test',
  status: 'ready',
  messages: [],
  approvals: [],
  providerConfig: { model: model.id },
});
const sse = (events: any[]) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
async function wait(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('timeout');
}
test('provider identifiers, persisted configuration and pricing keep providers distinct', async () => {
  for (const id of ['openrouter-1', 'gemini-2'])
    assert.equal(actionSchema.safeParse({ type: 'accountRefresh', profile: id }).success, true);
  assert.equal(providerKind('gemini-1'), 'gemini');
  assert.equal(
    actionSchema.safeParse({ type: 'accountRefresh', profile: 'openrouter-../secret' }).success,
    false,
  );
  const [m] = routerModels({ data: [model] });
  assert.equal(m.free, true);
  assert.equal(m.tools, true);
  assert.equal(m.image, true);
  assert.equal(
    routerModels({
      data: [{ ...model, pricing: { prompt: '0', completion: '0', request: '1' } }],
    })[0].free,
    false,
  );
  assert.equal(routerModels({ data: [{ ...model, pricing: {} }] })[0].free, false);
  assert.deepEqual(
    routerUsage({ data: { usage: 1, limit: null, limit_remaining: null } }).remaining,
    undefined,
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-state-'));
  try {
    const store = new Store(root);
    store.state.profiles = [
      { id: 'gemini-1', kind: 'gemini', name: 'Google' },
      {
        id: 'openrouter-1',
        kind: 'openrouter',
        name: 'Router',
        modelSelection: { freeOnly: true, models: [model.id] },
      },
    ];
    store.state.projects = [{ id: 'p', name: 'P', path: root }];
    store.state.sessions = [
      {
        ...session(),
        stats: {
          cost: 0,
          turns: 1,
          inputTokens: 2,
          outputTokens: 3,
          durationMs: 1,
          costReported: true,
          tokensReported: true,
        },
      },
    ];
    store.flush();
    const restored = new Store(root);
    assert.equal(restored.state.profiles?.length, 2);
    assert.equal(restored.state.sessions[0].providerConfig?.model, model.id);
    assert.equal(restored.state.sessions[0].stats?.costReported, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('API keys stay outside state; invalid replacement preserves previous key and errors redact response', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-key-'));
  let valid = true;
  const service = new OpenRouterService(root, {
    codec,
    fetch: async () =>
      valid
        ? Response.json({ data: { usage: 0, limit: 5, limit_remaining: 5 } })
        : Response.json({ error: { message: 'private-api-key' } }, { status: 401 }),
  });
  try {
    await service.connect('openrouter-1', 'valid-api-key');
    assert.equal(await service.key('openrouter-1'), 'valid-api-key');
    valid = false;
    await assert.rejects(
      service.connect('openrouter-1', 'private-api-key'),
      (e) => !String(e).includes('private-api-key'),
    );
    assert.equal(await service.key('openrouter-1'), 'valid-api-key');
    assert.equal(await service.key('openrouter-2'), undefined);
    await service.disconnect('openrouter-1');
    assert.equal(await service.key('openrouter-1'), undefined);
    const unavailable = new OpenRouterService(root, {
      codec: { ...codec, available: () => false },
    });
    await assert.rejects(unavailable.connect('openrouter-1', 'key'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('proxy authentication errors point to network settings and cancel the error body', async () => {
  let cancelled = false;
  const service = new OpenRouterService('/unused', {
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 407 },
      ),
  });
  await assert.rejects(service.request('/key', 'fixture-key'), /407.*proxy.*Ajustes → Red/);
  assert.equal(cancelled, true);
});
test('SSE reads split UTF-8, comments, usage and rejects incomplete/midstream error', async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\ndata: {"choices":[{"delta":{"content":"España"}}]}\r\n\r\ndata: {"usage":{"cost":0}}\r\n\r\ndata: [DONE]\r\n\r\n',
  );
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
      c.close();
    },
  });
  const events = [];
  for await (const e of routerStream(body)) events.push(e);
  assert.equal(events[0].choices[0].delta.content, 'España');
  assert.equal(events[1].usage.cost, 0);
  await assert.rejects(async () => {
    for await (const _ of routerStream(new Response('data: {"error":{}}\n\n').body!)) {
    }
  });
  await assert.rejects(async () => {
    for await (const _ of routerStream(new Response('data: {}\n\n').body!)) {
    }
  });
});
test('OpenRouter stream errors identify upstream codes without leaking raw messages', async () => {
  for (const [code, hint] of [
    [429, /límite/],
    [502, /proveedor.*falló/],
    [503, /no está disponible/],
  ] as const) {
    const error = routerError({ code, message: 'private-api-key and private prompt' });
    assert.match(error.message, new RegExp(String(code)));
    assert.match(error.message, hint);
    assert.doesNotMatch(error.message, /private/);
    await assert.rejects(async () => {
      for await (const _ of routerStream(sse([{ error: { code, message: 'private' } }]).body!)) {
      }
    }, hint);
  }
  assert.match(
    routerError({ code: 400, message: 'Failed to parse tool call: private' }).message,
    /herramienta no válida/,
  );
});
test('interrupted OpenRouter tool streams never run partial calls and retain visible text on retry', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-partial-')));
  const bodies: any[] = [];
  const service = new OpenRouterService(root, {
    codec,
    fetch: async (_url, init) => {
      if (!init?.body) return Response.json({ data: { usage: 0 } });
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? sse([
            {
              choices: [
                {
                  delta: {
                    content: 'Respuesta parcial',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'partial',
                        function: { name: 'write_file', arguments: '{"path":"no.txt","content":' },
                      },
                    ],
                  },
                },
              ],
            },
            { error: { code: 502, message: 'private' } },
          ])
        : sse([{ choices: [{ delta: { content: 'Recuperado' }, finish_reason: 'stop' }] }]);
    },
  });
  try {
    await service.connect('openrouter-1', 'fixture-key');
    const s = session();
    s.messages.push({ id: 'old-empty', role: 'assistant', text: '' });
    const rt = new OpenRouterRuntime(
      s,
      root,
      service,
      () => {},
      async () => routerModels({ data: [model] }),
      () => '',
    );
    await rt.send('Primero', []);
    await wait(() => s.status === 'ready');
    assert.ok(bodies[0].messages.every((m: any) => m.role !== 'assistant' || m.content));
    assert.match(s.error!, /502/);
    assert.equal(s.approvals.length, 0);
    assert.equal(s.messages.filter((m) => m.role === 'tool').length, 0);
    await assert.rejects(fs.access(path.join(root, 'no.txt')));
    await rt.send('Continúa', []);
    await wait(() => s.status === 'ready');
    assert.ok(
      bodies[1].messages.some(
        (m: any) => m.role === 'assistant' && m.content === 'Respuesta parcial',
      ),
    );
    assert.ok(bodies[1].messages.every((m: any) => !m.tool_calls));
    assert.equal(s.error, undefined);
    await rt.stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('OpenRouter coding loop approves writes, retains tool results and accounts for provider costs', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-turn-')));
  let n = 0;
  const bodies: any[] = [];
  const service = new OpenRouterService(root, {
    codec,
    fetch: async (_url, init) => {
      if (!init?.body) return Response.json({ data: { usage: 0 } });
      bodies.push(JSON.parse(String(init.body)));
      n++;
      return n === 1
        ? sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 't1',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({ path: 'hello.txt', content: 'hola' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0 },
            },
          ])
        : sse([
            {
              choices: [{ delta: { content: 'Hecho' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 20, completion_tokens: 3, cost: 0 },
            },
          ]);
    },
  });
  try {
    await service.connect('openrouter-1', 'test-api-key');
    const s = session();
    const rt = new OpenRouterRuntime(
      s,
      root,
      service,
      () => {},
      async () => routerModels({ data: [model] }),
      () => '',
    );
    await rt.send('Crea un archivo', []);
    await wait(() => s.status === 'waiting');
    await assert.rejects(fs.access(path.join(root, 'hello.txt')));
    rt.approve(s.approvals[0].id, 'accept');
    await wait(() => s.status === 'ready');
    assert.equal(await fs.readFile(path.join(root, 'hello.txt'), 'utf8'), 'hola');
    assert.equal(s.messages.at(-1)?.text, 'Hecho');
    assert.equal(s.stats?.inputTokens, 30);
    assert.equal(s.stats?.costReported, true);
    assert.equal(bodies[1].messages.at(-1).role, 'tool');
    await rt.stop();
    await fs.symlink('/tmp', path.join(root, 'outside'));
    await assert.rejects(projectToolPath(root, 'outside/file.txt', true));
    await assert.rejects(projectToolPath(root, '../file.txt', true));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('cancel while awaiting approval prevents writes and releases the turn', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-cancel-')));
  const service = new OpenRouterService(root, {
    codec,
    fetch: async (_url, init) =>
      !init?.body
        ? Response.json({ data: { usage: 0 } })
        : sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'x',
                        function: {
                          name: 'write_file',
                          arguments: '{"path":"blocked","content":"no"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]),
  });
  try {
    await service.connect('openrouter-1', 'test-api-key');
    const s = session(),
      rt = new OpenRouterRuntime(
        s,
        root,
        service,
        () => {},
        async () => routerModels({ data: [model] }),
        () => '',
      );
    await rt.send('write', []);
    await wait(() => s.status === 'waiting');
    await rt.interrupt();
    assert.equal(s.status, 'ready');
    assert.equal(s.approvals.length, 0);
    await assert.rejects(fs.access(path.join(root, 'blocked')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('retired Google client is explained and stays unavailable after account refresh', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-google-retired-'));
  const dir = profileDirectory(root, 'gemini-1');
  let rpc;
  try {
    await fs.mkdir(path.join(dir, '.gemini'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.gemini/settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
      }),
    );
    await fs.writeFile(path.join(dir, '.gemini/oauth_creds.json'), '{"refresh_token":"fixture"}');
    assert.equal(
      (await geminiAccount(dir)).status,
      'unknown',
      'cached tokens alone do not verify access',
    );
    const binary = path.join(root, 'fake-gemini');
    await fs.writeFile(
      binary,
      `#!${process.execPath}
require('readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...(m.params?.methodId==='recovered'?{result:{}}:{error:{code:-32000,message:'This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google'}})}));
});`,
      { mode: 0o700 },
    );
    rpc = await geminiRpc(binary, dir);
    await assert.rejects(rpc.call('authenticate', { methodId: 'oauth-personal' }), {
      message: googleClientUnavailable,
    });
    assert.deepEqual(await geminiAccount(dir), {
      status: 'unknown',
      error: googleClientUnavailable,
    });
    const accounts = new Accounts(
      root,
      () => ({ gemini: binary }),
      () => {},
      () => {},
      async () => {},
    );
    accounts.register('gemini-1');
    await accounts.refresh('gemini-1');
    assert.equal(accounts.state['gemini-1'].status, 'unknown');
    assert.equal(accounts.state['gemini-1'].error, googleClientUnavailable);
    assert.equal((await geminiAccount(profileDirectory(root, 'gemini-2'))).status, 'signedOut');
    await rpc.call('authenticate', { methodId: 'recovered' });
    assert.equal((await geminiAccount(dir)).status, 'signedIn');
    await geminiLogout(dir);
    assert.equal((await geminiAccount(dir)).status, 'signedOut');
  } finally {
    await rpc?.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('Gemini keeps Google access per profile and ACP supports model, resume and permission responses', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-gemini-'))),
    dir = profileDirectory(root, 'gemini-1');
  try {
    await fs.mkdir(path.join(dir, '.gemini'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.gemini/settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
    );
    await fs.writeFile(path.join(dir, '.gemini/oauth_creds.json'), '{"refresh_token":"fixture"}');
    await fs.writeFile(
      path.join(dir, '.gemini/google_accounts.json'),
      '{"active":"fixture@example.test"}',
    );
    assert.equal((await geminiAccount(dir)).label, 'fixture@example.test');
    assert.equal((await geminiAccount(profileDirectory(root, 'gemini-2'))).status, 'signedOut');
    const bin = path.join(root, 'fake-gemini');
    await fs.writeFile(
      bin,
      `#!/usr/bin/env node
const readline=require('node:readline');let pending;
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.jsonrpc!=='2.0')process.exit(9);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new'||m.method==='session/load')send({id:m.id,result:{sessionId:'g1',models:{availableModels:[{modelId:'gemini-test',name:'Gemini test'}],currentModelId:'gemini-test'}}});
else if(m.method==='session/set_model')send({id:m.id,result:{}});
else if(m.method==='session/prompt'){pending=m.id;send({id:70,method:'session/request_permission',params:{sessionId:'g1',options:[{kind:'allow_once',optionId:'once'}],toolCall:{title:'Test'}}});}
else if(m.id===70){if(m.result.outcome.optionId!=='once')process.exit(8);send({method:'session/update',params:{sessionId:'g1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Gemini listo'}}}});send({id:pending,result:{stopReason:'end_turn'}});}
});\n`,
      { mode: 0o700 },
    );
    const s = {
        ...session(),
        profile: 'gemini-1' as const,
        providerConfig: { model: 'gemini-test' },
      },
      rpc = await geminiRpc(bin, dir),
      rt = new GeminiRuntime(s, rpc, root, () => {});
    try {
      await rt.start();
      await rt.send('Hola', []);
      await wait(() => s.status === 'waiting');
      rt.approve(70, 'accept');
      await wait(() => s.status === 'ready');
      assert.equal(s.messages.at(-1)?.text, 'Gemini listo');
      assert.equal(s.reference, 'g1');
    } finally {
      await rt.stop();
    }
    await geminiLogout(dir);
    assert.equal((await geminiAccount(dir)).status, 'signedOut');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import { providerCommand } from '../electron/provider-command';
test('approved commands return output; cancellation stops the process group', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-command-')));
  try {
    assert.equal(
      await providerCommand('printf prueba', root, new AbortController().signal),
      'prueba',
    );
    assert.equal(
      await providerCommand(
        'printf "%s|%s" "$HTTPS_PROXY" "$NODE_EXTRA_CA_CERTS"',
        root,
        new AbortController().signal,
        { HTTPS_PROXY: 'http://127.0.0.1:8099', NODE_EXTRA_CA_CERTS: '/tmp/fixture-ca.pem' },
      ),
      'http://127.0.0.1:8099|/tmp/fixture-ca.pem',
    );
    const controller = new AbortController();
    const work = providerCommand('sleep 30 & wait', root, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(work, /interrumpido/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import { Manager } from '../electron/manager';
test('free-only model selection is enforced in the backend and new provider accounts stay independent', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'providers-manager-')));
  const m = new Manager(
    root,
    () => {},
    root,
    () => ({}),
    {
      codec,
      fetch: async () =>
        Response.json({
          data: [
            model,
            { ...model, id: 'test/paid', pricing: { prompt: '0.01', completion: '0.02' } },
          ],
        }),
    },
  );
  try {
    const router = m.addAccount('openrouter'),
      google = m.addAccount('gemini');
    m.state.projects.push({ id: 'p', name: 'P', path: root });
    await m.selectProviderModels(router.id, { freeOnly: true, models: [model.id, 'test/paid'] });
    assert.deepEqual(
      (await m.selectedModels(router.id)).map((x) => x.value),
      [model.id],
    );
    const s = m.newSession('p', router.id);
    await m.refreshModels(s.id);
    await assert.rejects(m.configureProvider(s.id, { model: 'test/paid' }), /disponible/);
    await m.configureProvider(s.id, { model: model.id });
    const other = await m.changeSessionAccount(s.id, google.id);
    assert.equal(other.providerConfig?.model, 'default');
    assert.equal(other.config, undefined);
    m.store.flush();
    assert.equal(
      new Store(root).state.profiles?.find((p) => p.id === router.id)?.modelSelection?.freeOnly,
      true,
    );
  } finally {
    await m.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
