import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeService, freeDeepSeek, openCodeModels } from '../electron/opencode';
import { actionSchema } from '../electron/core';
import { providerKind, isConnectedProvider } from '../src/shared';
import { OpenRouterRuntime } from '../electron/openrouter-runtime';
import type { Session } from '../src/shared';

const catalogFixture = {
  opencode: {
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/inference/openai/v1',
    models: {
      [freeDeepSeek]: {
        id: freeDeepSeek,
        name: 'DeepSeek Free',
        tool_call: true,
        cost: { input: 0, output: 0 },
      },
      'kimi-k2.7-code': { name: 'Kimi', tool_call: true, cost: { input: 0.95, output: 4 } },
    },
  },
};

test('OpenCode saves an isolated encrypted key, streams tools, and rejects unlisted models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-opencode-'));
  const requests: any[] = [];
  const api = new OpenCodeService(root, {
    codec: {
      available: () => true,
      encrypt: (s) => Buffer.from('encrypted:' + s),
      decrypt: (b) => b.toString().slice(10),
    },
    fetch: (async (url: any, init: any) => {
      if (url.endsWith('/api/v2/config')) return new Response(null, { status: 404 });
      if (url === 'https://models.dev/api.json') return Response.json(catalogFixture);
      const body = JSON.parse(init.body);
      requests.push({ url, init, body });
      const delta =
        requests.length === 1
          ? {
              reasoning_content: 'Inspect project',
              tool_calls: [
                {
                  index: 0,
                  id: 'read',
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) },
                },
              ],
            }
          : { content: 'Archivo leído' };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    }) as typeof fetch,
  });
  try {
    assert.equal(providerKind('opencode-1'), 'opencode');
    assert.equal(isConnectedProvider('opencode-1'), true);
    assert.equal(actionSchema.safeParse({ type: 'addAccount', kind: 'opencode' }).success, true);
    await api.connect('opencode-1', 'test-secret-key');
    assert.equal(requests.length, 0);
    assert.equal(await api.key('opencode-1'), 'test-secret-key');
    await assert.rejects(api.key('openrouter-1'));
    await assert.rejects(
      api.request('/chat/completions', 'key', {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-v4.1-flash' }),
      }),
    );
    assert.equal(requests.length, 0);
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello');
    const s: Session = {
      id: 'conversation-1',
      profile: 'opencode-1',
      projectId: 'p',
      title: 'Test',
      status: 'ready',
      messages: [],
      approvals: [],
      providerConfig: { model: freeDeepSeek },
    };
    const runtime = new OpenRouterRuntime(
      s,
      root,
      api,
      () => {},
      () => api.catalog('opencode-1'),
      () => '',
    );
    await runtime.send('Lee hello.txt', []);
    for (let i = 0; i < 100 && s.status !== 'ready'; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.error, undefined);
    assert.equal(s.status, 'ready');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://opencode.ai/inference/openai/v1/chat/completions');
    assert.equal(requests[0].init.headers['x-opencode-session'], s.id);
    assert.equal(requests[0].body.plugins, undefined);
    assert.ok(requests[0].body.tools.length);
    assert.equal(
      requests[1].body.messages.find((m: any) => m.role === 'assistant').reasoning_content,
      'Inspect project',
    );
    assert.equal(s.messages.at(-1)?.text, 'Archivo leído');
    await api.disconnect('opencode-1');
    assert.equal(await api.key('opencode-1'), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('catalog includes multiple free and paid models, applies account routing, and excludes unsupported or hostile endpoints', () => {
  const catalog = openCodeModels(catalogFixture);
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models.find((m) => m.value === 'kimi-k2.7-code')?.free, false);
  assert.equal(catalog.models.find((m) => m.value === freeDeepSeek)?.free, true);
  const account = openCodeModels(catalogFixture, {
    providers: {
      'my-team': {
        canonical: 'opencode',
        package: '@ai-sdk/openai-compatible',
        settings: { baseURL: 'https://opencode.ai/inference/go/openai/v1' },
        models: {
          chosen: { modelID: 'kimi-k2.7-code', cost: { input: 1, output: 2 } },
          disabled: { disabled: true },
          anthropic: { package: '@ai-sdk/anthropic' },
          hostile: { settings: { baseURL: 'https://attacker.example/inference/openai/v1' } },
        },
      },
    },
  });
  assert.deepEqual(
    account.models.map((m) => m.value),
    ['my-team/chosen'],
  );
  assert.equal(account.routes.get('my-team/chosen')?.model, 'kimi-k2.7-code');
  assert.equal(account.models[0].inputPrice, 1e-6);
  assert.equal(
    openCodeModels({
      opencode: { ...catalogFixture.opencode, models: { unknown: { cost: { input: 0 } } } },
    }).models[0].free,
    false,
  );
});

const codec = {
  available: () => true,
  encrypt: (s: string) => Buffer.from('encrypted:' + s),
  decrypt: (b: Buffer) => b.toString().slice(10),
};

test('browser login persists encrypted credentials, scopes the organization, and serializes refresh rotation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-opencode-oauth-'));
  let refreshes = 0;
  const calls: any[] = [];
  const api = new OpenCodeService(root, {
    codec,
    fetch: (async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, init, body });
      if (url.endsWith('/device/code'))
        return Response.json({
          device_code: 'secret-device',
          user_code: 'USER-CODE',
          verification_uri_complete: '/console/device?user_code=USER-CODE',
          expires_in: 600,
          interval: 1,
        });
      if (url.endsWith('/device/token')) {
        if (body.grant_type === 'refresh_token') refreshes++;
        return Response.json({
          access_token: refreshes ? 'refreshed-access' : 'first-access',
          refresh_token: 'secret-refresh',
          expires_in: refreshes ? 3600 : 1,
          org_id: 'org-1',
        });
      }
      if (url.endsWith('/api/user')) return Response.json({ id: 'u', email: 'test@example.com' });
      if (url.endsWith('/api/orgs')) return Response.json([{ id: 'org-1', name: 'Personal' }]);
      if (url === 'https://models.dev/api.json') return Response.json(catalogFixture);
      if (url.endsWith('/api/v2/config')) return Response.json({ providers: {} });
      throw new Error('Unexpected request');
    }) as typeof fetch,
  });
  try {
    const attempt = await api.beginLogin('opencode-1');
    assert.equal(attempt.url, 'https://opencode.ai/console/device?user_code=USER-CODE');
    await api.completeLogin('opencode-1', attempt, new AbortController().signal);
    const keys = await Promise.all([api.key('opencode-1'), api.key('opencode-1')]);
    assert.deepEqual(keys, ['refreshed-access', 'refreshed-access']);
    assert.equal(refreshes, 1);
    await api.catalog('opencode-1');
    assert.equal(
      calls.find((c) => c.url.endsWith('/api/v2/config')).init.headers['x-org-id'],
      'org-1',
    );
    assert.ok(!JSON.stringify(attempt).includes('secret-refresh'));
    // Profile location is determined by core; the credential is also recoverable after re-opening.
    const reopened = new OpenCodeService(root, { codec });
    assert.equal(await reopened.key('opencode-1'), 'refreshed-access');
    await api.disconnect('opencode-1');
    assert.equal(await reopened.key('opencode-1'), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cancelled browser login preserves the previous key and rejects off-site verification URLs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-opencode-cancel-'));
  let malicious = false;
  const api = new OpenCodeService(root, {
    codec,
    fetch: (async () =>
      Response.json({
        device_code: 'd',
        user_code: 'u',
        verification_uri_complete: malicious ? 'https://attacker.example' : '/console/device',
        expires_in: 60,
        interval: 1,
      })) as typeof fetch,
  });
  try {
    await api.connect('opencode-1', 'previous-key');
    const attempt = await api.beginLogin('opencode-1');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(api.completeLogin('opencode-1', attempt, controller.signal));
    assert.equal(await api.key('opencode-1'), 'previous-key');
    malicious = true;
    await assert.rejects(api.beginLogin('opencode-1'), /dirección/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import { Accounts } from '../electron/accounts';
import { Manager } from '../electron/manager';

test('browser authorization can be cancelled or shut down without replacing an existing account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-opencode-accounts-'));
  const accounts = new Accounts(
    root,
    () => ({}),
    () => {},
    () => {},
    async () => {},
    () => ({}),
    {
      codec,
      fetch: (async () =>
        Response.json({
          device_code: 'd',
          user_code: 'CODE',
          verification_uri_complete: '/console/device',
          interval: 5,
          expires_in: 600,
        })) as typeof fetch,
    },
  );
  try {
    accounts.register('opencode-1');
    await accounts.connectOpenRouter('opencode-1', 'previous-key');
    const url = await accounts.login('opencode-1', false);
    assert.equal(url, 'https://opencode.ai/console/device');
    assert.equal(accounts.state['opencode-1'].loginCode, 'CODE');
    assert.equal(accounts.state['opencode-1'].busy, 'signingIn');
    assert.equal(accounts.state['opencode-1'].cancellable, true);
    await accounts.cancel('opencode-1');
    assert.equal(accounts.state['opencode-1'].status, 'signedIn');
    assert.equal(accounts.state['opencode-1'].loginCode, undefined);
    assert.equal(await accounts.opencode.key('opencode-1'), 'previous-key');
    await accounts.login('opencode-1', false);
    await accounts.shutdown();
    assert.equal(accounts.active, false);
    assert.equal(accounts.state['opencode-1'].busy, undefined);
    assert.equal(accounts.state['opencode-1'].loginUrl, undefined);
  } finally {
    await accounts.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OpenCode model choices persist and paid models require disabling the free filter', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'desk-opencode-selection-')),
  );
  const manager = new Manager(
    root,
    () => {},
    root,
    () => ({}),
    { codec, fetch: (async () => Response.json(catalogFixture)) as typeof fetch },
  );
  try {
    const profile = manager.addAccount('opencode');
    assert.deepEqual(profile.modelSelection, { freeOnly: true, models: [] });
    await manager.selectProviderModels(profile.id, {
      freeOnly: true,
      models: [freeDeepSeek, 'kimi-k2.7-code'],
    });
    assert.deepEqual(
      (await manager.selectedModels(profile.id)).map((m) => m.value),
      [freeDeepSeek],
    );
    await manager.selectProviderModels(profile.id, {
      freeOnly: false,
      models: [freeDeepSeek, 'kimi-k2.7-code'],
    });
    assert.equal((await manager.selectedModels(profile.id)).length, 2);
    manager.store.flush();
    const stored = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
    assert.deepEqual(stored.profiles.find((p: any) => p.id === profile.id).modelSelection.models, [
      freeDeepSeek,
      'kimi-k2.7-code',
    ]);
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Console aisdk adapters load without Models.dev and concurrent callers share one download', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-opencode-console-catalog-'));
  let downloads = 0;
  const remote = {
    providers: {
      opencode: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: 'https://opencode.ai/inference/openai/v1' },
        models: {
          [freeDeepSeek]: {
            name: 'DeepSeek V4.1 Flash Free',
            capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
            limit: { context: 200000 },
            cost: [{ input: 0, output: 0, cache: { read: 0 } }],
          },
          'kimi-k2.7-code': {
            name: 'Kimi K2.7 Code',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
            cost: [{ input: 0.95, output: 4 }],
          },
          claude: {
            package: 'aisdk:@ai-sdk/anthropic',
            settings: { baseURL: 'https://opencode.ai/inference/anthropic/v1' },
          },
        },
      },
    },
  };
  const api = new OpenCodeService(root, {
    codec,
    fetch: (async (url: string) => {
      assert.equal(
        url,
        'https://opencode.ai/console/api/v2/config',
        'authenticated catalogs must not depend on Models.dev',
      );
      downloads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json(remote);
    }) as typeof fetch,
  });
  try {
    await api.connect('opencode-1', 'test-key');
    const [first, second] = await Promise.all([
      api.catalog('opencode-1'),
      api.catalog('opencode-1'),
    ]);
    assert.equal(downloads, 1);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((m) => m.value),
      [freeDeepSeek, 'kimi-k2.7-code'],
    );
    assert.equal(first[0].free, true);
    assert.equal(first[0].tools, true);
    assert.equal(first[0].image, true);
    assert.equal(first[0].contextLength, 200000);
    assert.equal(first[1].free, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('free-tier restrictions are explained without exposing raw provider diagnostics or falling back to paid models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-opencode-free-restriction-'));
  let calls = 0;
  const api = new OpenCodeService(root, {
    codec,
    fetch: (async (url: string) => {
      if (url.endsWith('/api/v2/config')) return new Response(null, { status: 404 });
      if (url === 'https://models.dev/api.json') return Response.json(catalogFixture);
      calls++;
      return Response.json(
        { error: { type: 'FreeTierError', message: 'private prompt or token' } },
        { status: 403 },
      );
    }) as typeof fetch,
  });
  try {
    await api.connect('opencode-1', 'test-key');
    await api.catalog('opencode-1');
    await assert.rejects(
      api.request('/chat/completions', await api.key('opencode-1'), {
        method: 'POST',
        body: JSON.stringify({ model: freeDeepSeek }),
      }),
      (error: Error) => {
        assert.match(error.message, /cliente oficial/);
        assert.ok(!error.message.includes('private prompt'));
        return true;
      },
    );
    assert.equal(calls, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
