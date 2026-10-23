import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { McpConnections } from '../electron/mcp';
import { mcpConnectionInputSchema } from '../electron/mcp-validation';
import type { SecretCodec } from '../electron/proxy';

const key = randomBytes(32);
const codec: SecretCodec = {
  available: () => true,
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  decrypt(value) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return cipher.update(value.subarray(28)) + cipher.final('utf8');
  },
};

async function fixture(run: (connections: McpConnections, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-mcp-'));
  const connections = new McpConnections(root, { codec });
  try {
    await run(connections, root);
  } finally {
    await connections.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function serverFixture(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: string,
  ) => void | Promise<void>,
) {
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      await handler(request, response, body);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function rpc(response: http.ServerResponse, body: string, tools?: (cursor?: string) => unknown) {
  const message = JSON.parse(body);
  if (!('id' in message)) {
    response.writeHead(202).end();
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'test', version: '1' },
        }
      : (tools?.(message.params?.cursor) ?? { tools: [] });
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}

test('MCP registry persists encrypted secrets independently and never returns values in snapshots', () =>
  fixture(async (connections, root) => {
    const secret = 'super-secret-token-mcp';
    const saved = await connections.save({
      name: 'Work tools',
      transport: 'http',
      url: 'https://example.test/mcp',
      auth: 'headers',
      headers: { Authorization: `Bearer ${secret}` },
    });
    assert.deepEqual(saved.headerKeys, ['Authorization']);
    assert.doesNotMatch(JSON.stringify(connections.snapshot()), /super-secret-token|secretFile/);
    for (const name of fs.readdirSync(path.join(root, 'mcp'))) {
      const file = path.join(root, 'mcp', name);
      assert.ok(!fs.readFileSync(file).includes(Buffer.from(secret)));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    const reload = new McpConnections(root, { codec });
    try {
      assert.equal((await reload.resolve([saved.id]))[0].headers.Authorization, `Bearer ${secret}`);
      const signature = reload.signature([saved.id]);
      await reload.save({ ...saved, name: 'Renamed' });
      assert.equal((await reload.resolve([saved.id]))[0].headers.Authorization, `Bearer ${secret}`);
      assert.notEqual(reload.signature([saved.id]), signature);
      const copy = reload.snapshot();
      copy[0].headerKeys.length = 0;
      assert.equal(reload.snapshot()[0].headerKeys.length, 1);
      await reload.save({ ...saved, headers: null });
      assert.deepEqual((await reload.resolve([saved.id]))[0].headers, {});
      assert.deepEqual(fs.readdirSync(path.join(root, 'mcp')), ['connections.json']);
      await reload.remove(saved.id);
      assert.equal(reload.snapshot().length, 0);
      await assert.rejects(reload.resolve([saved.id]), /ya no existe/);
    } finally {
      await reload.close();
    }
  }));

test('MCP input validation rejects shell strings, credential URLs, insecure remote HTTP and header injection', () => {
  const base = { name: 'Server', transport: 'http', url: 'https://example.test/mcp' };
  for (const url of [
    'http://example.test/mcp',
    'file:///etc/passwd',
    'https://user:secret@example.test',
    'https://example.test/mcp?api_key=secret',
    'https://example.test/#fragment',
  ])
    assert.equal(mcpConnectionInputSchema.safeParse({ ...base, url }).success, false, url);
  for (const url of [
    'https://example.test/mcp',
    'http://localhost:3000/mcp',
    'http://127.0.0.1/mcp',
    'http://[::1]:3000/mcp',
  ])
    assert.equal(mcpConnectionInputSchema.safeParse({ ...base, url }).success, true, url);
  for (const command of ['node; curl secret', 'node | sh', '$(cat secret)', 'node\n--version'])
    assert.equal(
      mcpConnectionInputSchema.safeParse({ name: 'Local', transport: 'stdio', command }).success,
      false,
    );
  assert.equal(
    mcpConnectionInputSchema.safeParse({
      name: 'Local',
      transport: 'stdio',
      command: '/Applications/My Tools/node',
      args: ['literal $(value)'],
    }).success,
    true,
  );
  assert.equal(
    mcpConnectionInputSchema.safeParse({
      ...base,
      headers: { Authorization: 'secret\r\nx-attack: value' },
    }).success,
    false,
  );
  assert.equal(
    mcpConnectionInputSchema.safeParse({ ...base, headers: { Host: 'attacker.test' } }).success,
    false,
  );
});

test('MCP refuses plaintext fallback and preserves an unreadable registry', () =>
  fixture(async (_connections, root) => {
    const unavailable = new McpConnections(root, { codec: { ...codec, available: () => false } });
    try {
      await assert.rejects(
        unavailable.save({
          name: 'Local',
          transport: 'stdio',
          command: 'node',
          env: { KEY: 'secret' },
        }),
        /almacén seguro/,
      );
      assert.equal(unavailable.snapshot().length, 0);
      assert.equal(fs.existsSync(path.join(root, 'mcp/connections.json')), false);
      await unavailable.save({
        name: 'Public',
        transport: 'http',
        url: 'https://example.test/mcp',
      });
    } finally {
      await unavailable.close();
    }
    fs.writeFileSync(path.join(root, 'mcp/connections.json'), 'corrupted');
    const corrupted = new McpConnections(root, { codec });
    try {
      await assert.rejects(
        corrupted.save({ name: 'Public', transport: 'http', url: 'https://example.test/mcp' }),
        /original se ha conservado/,
      );
      assert.equal(fs.readFileSync(path.join(root, 'mcp/connections.json'), 'utf8'), 'corrupted');
    } finally {
      await corrupted.close();
    }
  }));

test('MCP HTTP check uses configured fetch, discovers paginated tools and sanitizes upstream errors', () =>
  fixture(async (_connections, root) => {
    const secret = 'test-mcp-header-secret';
    let requests = 0;
    let fail = false;
    const server = await serverFixture((request, response, body) => {
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${secret}`) {
        response.writeHead(401).end();
        return;
      }
      if (fail) {
        response.writeHead(500).end(`Error includes ${secret}`);
        return;
      }
      rpc(response, body, (cursor) =>
        cursor
          ? {
              tools: [
                { name: 'second', inputSchema: { type: 'object' }, description: `Token ${secret}` },
              ],
            }
          : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'page2' },
      );
    });
    const connections = new McpConnections(root, {
      codec,
      fetch: async (url, options) => {
        assert.equal(typeof url, 'string', 'configured Electron transport requires a string URL');
        requests++;
        return fetch(url, options);
      },
    });
    try {
      const saved = await connections.save({
        name: 'Remote',
        transport: 'http',
        url: `${server.url}/mcp`,
        auth: 'headers',
        headers: { Authorization: `Bearer ${secret}` },
      });
      const checked = await connections.test(saved.id);
      assert.equal(checked.status, 'connected', checked.error);
      assert.deepEqual(
        checked.tools?.map((tool) => tool.name),
        ['first', 'second'],
      );
      assert.doesNotMatch(JSON.stringify(checked), /test-mcp-header-secret/);
      assert.ok(requests >= 4);
      fail = true;
      const error = await connections.test(saved.id);
      assert.equal(error.status, 'error');
      assert.doesNotMatch(error.error!, /test-mcp-header-secret/);
      assert.equal(error.tools, undefined);
    } finally {
      await connections.close();
      await server.close();
    }
  }));

test('MCP stdio check passes arguments literally, applies network environment and closes its subprocess', () =>
  fixture(async (_connections, root) => {
    const source = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      const result = m.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'pid_' + process.pid, inputSchema: { type: 'object' }, description: process.env.MCP_SECRET + ' ' + process.env.HTTPS_PROXY + ' ' + process.argv[1] }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });
  `;
    const connections = new McpConnections(
      root,
      { codec },
      () => {},
      () => ({ HTTPS_PROXY: 'http://proxy.test:1234' }),
    );
    try {
      const saved = await connections.save({
        name: 'Local',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', source, '$(literal)'],
        env: { MCP_SECRET: 'stdio-secret-value' },
      });
      const checked = await connections.test(saved.id);
      assert.equal(checked.status, 'connected', checked.error);
      assert.match(checked.tools![0].description!, /http:\/\/proxy.test:1234 \$\(literal\)/);
      assert.doesNotMatch(JSON.stringify(checked), /stdio-secret-value/);
      const pid = Number(checked.tools![0].name.slice(4));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      await connections.close();
    }
  }));

test('MCP close cancels an unresponsive check and reaps its subprocess', () =>
  fixture(async (_connections, root) => {
    const connections = new McpConnections(root, { codec });
    const saved = await connections.save({
      name: 'Hanging',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.stdin.resume();'],
    });
    const check = connections.test(saved.id);
    void check.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 150));
    const before = Date.now();
    await connections.close();
    assert.ok(Date.now() - before < 6000);
    await assert.rejects(check, /cerrado/);
  }));

test('MCP OAuth checks never open a browser; explicit authentication verifies state/PKCE, encrypts tokens and refreshes', () =>
  fixture(async (_connections, root) => {
    let registration: Record<string, unknown> = {};
    let challenge = '';
    let browserCalls = 0;
    let refreshCalls = 0;
    let invalidStateRejected = false;
    let validVerifier = false;
    let serverUrl = '';
    const server = await serverFixture((request, response, body) => {
      const json = (value: unknown) =>
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const url = new URL(request.url!, serverUrl);
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json({ resource: `${serverUrl}/mcp`, authorization_servers: [serverUrl] });
        return;
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        json({
          issuer: serverUrl,
          authorization_endpoint: `${serverUrl}/authorize`,
          token_endpoint: `${serverUrl}/token`,
          registration_endpoint: `${serverUrl}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (url.pathname === '/register') {
        registration = JSON.parse(body);
        json({ ...registration, client_id: 'fixture-client' });
        return;
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'refresh_token') {
          refreshCalls++;
          assert.equal(params.get('refresh_token'), 'oauth-refresh-secret');
          json({ access_token: 'oauth-renewed-secret', token_type: 'Bearer', expires_in: 3600 });
        } else {
          validVerifier =
            createHash('sha256').update(params.get('code_verifier')!).digest('base64url') ===
            challenge;
          json({
            access_token: 'oauth-access-secret',
            refresh_token: 'oauth-refresh-secret',
            token_type: 'Bearer',
            expires_in: 1,
          });
        }
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      if (!request.headers.authorization) {
        response.writeHead(401).end();
        return;
      }
      rpc(response, body, () => ({
        tools: [{ name: 'authorized_tool', inputSchema: { type: 'object' } }],
      }));
    });
    serverUrl = server.url;
    const connections = new McpConnections(root, {
      codec,
      openExternal: async (target) => {
        browserCalls++;
        const url = new URL(target);
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        challenge = url.searchParams.get('code_challenge')!;
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        assert.deepEqual(registration.redirect_uris, [callback.href]);
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', 'wrong-state');
        invalidStateRejected = (await fetch(callback)).status === 400;
        callback.searchParams.set('state', url.searchParams.get('state')!);
        assert.equal((await fetch(callback)).status, 200);
      },
    });
    try {
      const saved = await connections.save({
        name: 'OAuth',
        transport: 'http',
        url: `${serverUrl}/mcp`,
        auth: 'oauth',
      });
      assert.equal((await connections.test(saved.id)).status, 'needs-auth');
      assert.equal(browserCalls, 0);
      const initial = connections.signature([saved.id]);
      const checked = await connections.authenticate(saved.id);
      assert.equal(checked.status, 'connected', checked.error);
      assert.equal(browserCalls, 1);
      assert.equal(invalidStateRejected, true);
      assert.equal(validVerifier, true);
      assert.equal(refreshCalls, 1);
      assert.notEqual(connections.signature([saved.id]), initial);
      assert.equal(
        (await connections.resolve([saved.id]))[0].headers.Authorization,
        'Bearer oauth-renewed-secret',
      );
      assert.doesNotMatch(
        JSON.stringify(connections.snapshot()),
        /oauth-(access|refresh|renewed)-secret/,
      );
      for (const file of fs.readdirSync(path.join(root, 'mcp')))
        assert.doesNotMatch(
          fs.readFileSync(path.join(root, 'mcp', file)).toString(),
          /oauth-(access|refresh|renewed)-secret/,
        );
      const reload = new McpConnections(root, { codec });
      try {
        assert.equal(
          (await reload.resolve([saved.id]))[0].headers.Authorization,
          'Bearer oauth-renewed-secret',
        );
      } finally {
        await reload.close();
      }
    } finally {
      await connections.close();
      await server.close();
    }
  }));

test('cancelling MCP OAuth closes the loopback listener and cannot overwrite a later saved configuration', () =>
  fixture(async (_connections, root) => {
    let callbackUrl = '';
    let opened!: () => void;
    const browserOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const base = 'https://oauth.example.test';
    const connections = new McpConnections(root, {
      codec,
      fetch: async (resource, init) => {
        const url = String(resource);
        const result = url.includes('oauth-protected-resource')
          ? { resource: `${base}/mcp`, authorization_servers: [base] }
          : url.includes('oauth-authorization-server')
            ? {
                issuer: base,
                authorization_endpoint: `${base}/authorize`,
                token_endpoint: `${base}/token`,
                registration_endpoint: `${base}/register`,
                response_types_supported: ['code'],
                code_challenge_methods_supported: ['S256'],
              }
            : { ...JSON.parse(String(init?.body)), client_id: 'cancel-client' };
        return new Response(JSON.stringify(result), {
          headers: { 'content-type': 'application/json' },
        });
      },
      openExternal: async (url) => {
        callbackUrl = new URL(url).searchParams.get('redirect_uri')!;
        opened();
      },
    });
    try {
      const saved = await connections.save({
        name: 'Before',
        transport: 'http',
        url: `${base}/mcp`,
        auth: 'oauth',
      });
      const authentication = connections.authenticate(saved.id);
      await browserOpened;
      assert.equal(connections.snapshot()[0].authenticating, true);
      connections.cancelAuthentication(saved.id);
      await connections.save({ ...saved, name: 'After cancellation' });
      const result = await authentication;
      assert.equal(result.name, 'After cancellation');
      assert.equal(result.status, 'unchecked');
      assert.ok(!result.authenticating);
      assert.equal(
        fs.readdirSync(path.join(root, 'mcp')).filter((file) => file.endsWith('.enc')).length,
        0,
      );
      await assert.rejects(fetch(callbackUrl));
    } finally {
      await connections.close();
    }
  }));

test('MCP clears or replaces credentials even when the previous secure storage entry is unreadable', () =>
  fixture(async (connections, root) => {
    const saved = await connections.save({
      name: 'Old key',
      transport: 'http',
      url: 'https://example.test/mcp',
      auth: 'headers',
      headers: { Authorization: 'old-secret' },
    });
    const encrypted = fs.readdirSync(path.join(root, 'mcp')).find((file) => file.endsWith('.enc'))!;
    fs.writeFileSync(path.join(root, 'mcp', encrypted), 'corrupt');
    await assert.rejects(connections.resolve([saved.id]), /desbloquear/);
    await connections.save({ ...saved, headers: { Authorization: 'replacement-secret' } });
    assert.equal(
      (await connections.resolve([saved.id]))[0].headers.Authorization,
      'replacement-secret',
    );
    await connections.save({ ...saved, headers: null });
    assert.deepEqual((await connections.resolve([saved.id]))[0].headers, {});
  }));
