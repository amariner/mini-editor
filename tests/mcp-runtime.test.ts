import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Manager } from '../electron/manager';
import { Rpc } from '../electron/rpc';
import {
  claudeMcpServers,
  codexMcpConfig,
  managedMcpName,
  type ResolvedMcpConnection,
} from '../electron/mcp-adapters';
import { effectiveMcpIds } from '../src/mcp-types';

const exec = promisify(execFile);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(run: (manager: Manager, root: string) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-mcp-runtime-')));
  const manager = new Manager(root, () => {});
  manager.state.profiles = [
    { id: 'claude-1', name: 'Claude', kind: 'claude' },
    { id: 'codex', name: 'Codex', kind: 'codex' },
  ];
  manager.state.projects = [{ id: 'p', name: 'Proyecto', path: root }];
  try {
    await run(manager, root);
  } finally {
    manager.runtimes.clear();
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Claude stdio preserves the selected cwd and literal argv without shell expansion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk mcp cwd-'));
  try {
    const literal = 'a space $(echo not-executed) `echo literal` ; * "quotes"';
    const resolved: ResolvedMcpConnection = {
      connection: {
        id: 'a-1',
        name: 'agent_desk',
        transport: 'stdio',
        auth: 'none',
        command: process.execPath,
        cwd: root,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],key:process.env.MCP_TEST_KEY}))',
          literal,
        ],
        envKeys: ['MCP_TEST_KEY'],
        headerKeys: [],
        revision: 1,
        status: 'unchecked',
      },
      env: { MCP_TEST_KEY: 'secret test value' },
      headers: {},
    };
    const servers = claudeMcpServers([resolved]);
    assert.equal(servers.agent_desk, undefined);
    const server = servers[managedMcpName('a-1')];
    assert.ok('command' in server);
    const result = await exec(server.command, server.args ?? [], {
      env: { ...process.env, ...server.env },
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: fs.realpathSync(root),
      arg: literal,
      key: 'secret test value',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider adapters use separate namespaces and native HTTP headers without replacing native MCP config', () => {
  const connection: ResolvedMcpConnection = {
    connection: {
      id: 'remote-1',
      name: 'agent_desk',
      transport: 'http',
      auth: 'headers',
      url: 'https://example.com/mcp',
      envKeys: [],
      headerKeys: ['Authorization'],
      revision: 2,
      status: 'connected',
    },
    env: {},
    headers: { Authorization: 'Bearer test' },
  };
  assert.deepEqual(claudeMcpServers([connection]), {
    'desk_remote-1': { type: 'http', url: 'https://example.com/mcp', headers: connection.headers },
  });
  const config: Record<string, unknown> = {
    'mcp_servers.native': { command: 'native' },
    ...codexMcpConfig([connection]),
  };
  assert.deepEqual(config['mcp_servers.native'], { command: 'native' });
  assert.deepEqual(config['mcp_servers.desk_remote-1'], {
    url: 'https://example.com/mcp',
    http_headers: connection.headers,
    required: true,
  });
  assert.equal(Object.hasOwn(config, 'mcp_servers'), false);
  assert.equal(Object.hasOwn(config, 'mcp_servers.agent_desk'), false);
});

test('assignments are explicit, validate IDs, inherit project defaults and preserve explicit empty overrides', () =>
  fixture(async (m) => {
    const connection = await m.saveMcpConnection({
      name: 'Docs',
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    const project = m.project('p'),
      session = m.newSession('p', 'claude-1');
    assert.deepEqual(effectiveMcpIds(project, session), []);
    m.setProjectMcpConnections('p', [connection.id, connection.id]);
    assert.deepEqual(effectiveMcpIds(project, session), [connection.id]);
    m.setSessionMcpConnections(session.id, []);
    assert.deepEqual(effectiveMcpIds(project, session), []);
    m.setSessionMcpConnections(session.id, null);
    assert.deepEqual(effectiveMcpIds(project, session), [connection.id]);
    assert.throws(() => m.setSessionMcpConnections(session.id, ['missing']), /no está disponible/);
    session.mode = 'terminal';
    assert.throws(() => m.setSessionMcpConnections(session.id, [connection.id]), /Claude y Codex/);
    await m.deleteMcpConnection(connection.id);
    assert.deepEqual(project.mcpConnectionIds, []);
    assert.equal(session.mcpConnectionIds, undefined);
  }));

test('a revoked connection queues input until idle then restarts once, preserving conversation history', () =>
  fixture(async (m) => {
    const c = await m.saveMcpConnection({
      name: 'Docs',
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    const s = m.newSession('p', 'claude-1');
    m.setProjectMcpConnections('p', [c.id]);
    s.reference = 'existing-history';
    s.messages = [{ id: 'u1', role: 'user', text: 'Previous task', at: 1 }];
    s.status = 'working';
    const calls: string[] = [];
    const runtime = () => ({
      buffer: '',
      sequence: 0,
      mcpSignature: m.mcp.signature(effectiveMcpIds(m.project('p'), s)),
      mcpIds: [...effectiveMcpIds(m.project('p'), s)],
      claude: {
        send: (text: string) => {
          calls.push(`send:${text}`);
          s.status = 'working';
        },
      },
    });
    m.runtimes.set(s.id, runtime() as any);
    (m as any).stopRuntime = async () => {
      calls.push('stop');
      m.runtimes.delete(s.id);
      s.status = 'stopped';
    };
    (m as any).startRuntime = async () => {
      calls.push('start');
      m.runtimes.set(s.id, runtime() as any);
      s.status = 'ready';
    };
    await m.deleteMcpConnection(c.id);
    assert.equal(s.mcpPending, true);
    assert.deepEqual(s.mcpAppliedIds, [c.id]);
    await m.send(s.id, 'Follow up');
    assert.deepEqual(calls, []);
    assert.equal(s.pendingInputs?.[0].status, 'pending');
    assert.equal(s.status, 'working');
    s.status = 'ready';
    m.changed();
    for (let i = 0; i < 15 && s.pendingInputs?.length; i++) await tick();
    assert.deepEqual(calls, ['stop', 'start', 'send:Follow up']);
    assert.equal(s.reference, 'existing-history');
    assert.equal(s.messages[0].text, 'Previous task');
    assert.deepEqual(s.mcpAppliedIds, []);
    assert.equal(s.mcpPending, false);
    assert.equal(s.pendingInputs?.length, 0);
  }));

test('Codex injects managed config during thread resume and reports the exact applied selection', () =>
  fixture(async (m) => {
    const c = await m.saveMcpConnection({
      name: 'Local',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/tmp',
    });
    const s = m.newSession('p', 'codex');
    m.setSessionMcpConnections(s.id, [c.id]);
    s.reference = 'kept-thread';
    const calls: { method: string; params: any }[] = [];
    m.runtimes.set(s.id, {
      buffer: '',
      sequence: 0,
      rpc: {
        call: async (method: string, params: any) => {
          calls.push({ method, params });
          return { thread: { id: 'kept-thread' } };
        },
      } as any,
    });
    (m.coordinator as any).config = async () => ({ command: 'agent-desk-coordination' });
    await m.loadThread(s);
    assert.equal(calls[0].method, 'thread/resume');
    assert.equal(calls[0].params.threadId, 'kept-thread');
    assert.deepEqual(calls[0].params.config[`mcp_servers.${managedMcpName(c.id)}`], {
      command: 'node',
      args: ['server.js'],
      cwd: '/tmp',
      env: {},
      required: true,
    });
    assert.equal(
      calls[0].params.config['mcp_servers.agent_desk'].command,
      'agent-desk-coordination',
    );
    assert.deepEqual(s.mcpAppliedIds, [c.id]);
    assert.equal(s.mcpPending, false);
    await m.loadThread(s);
    assert.equal(calls.length, 1);
  }));

test('team children and forks retain explicit parent overrides, including disabled connections', () =>
  fixture(async (m) => {
    const c = await m.saveMcpConnection({
      name: 'Docs',
      transport: 'http',
      url: 'https://example.com/mcp',
    });
    m.setProjectMcpConnections('p', [c.id]);
    const s = m.newSession('p', 'claude-1');
    m.setSessionMcpConnections(s.id, []);
    s.attempted = true;
    m.teams.closed = true;
    const result = m.teams.call(s.id, { operation: 'spawn', title: 'Child', text: 'Task' }) as any;
    const child = m.session(result.sessionId);
    assert.deepEqual(child.mcpConnectionIds, []);
    assert.notEqual(child.mcpConnectionIds, s.mcpConnectionIds);
    const fork = await m.fork(s.id, false);
    assert.deepEqual(fork.mcpConnectionIds, []);
    assert.notEqual(fork.mcpConnectionIds, s.mcpConnectionIds);
  }));

test('native MCP handshake errors cannot echo credential-bearing upstream bodies to the renderer', () =>
  fixture(async (m) => {
    const s = m.newSession('p', 'codex');
    m.runtimes.set(s.id, {
      buffer: '',
      sequence: 0,
      rpc: {
        call: async () => {
          throw new Error(
            'required MCP servers failed to initialize: HTTP 403 <html>Authorization: Bearer do-not-expose</html>',
          );
        },
      } as any,
    });
    (m.coordinator as any).config = async () => ({ command: 'coordination' });
    await assert.rejects(m.loadThread(s), (error: Error) => {
      assert.match(error.message, /Ajustes → Conexiones/);
      assert.doesNotMatch(error.message, /do-not-expose|Authorization|<html>/);
      return true;
    });
    m.notification(s, {
      method: 'error',
      params: { error: { message: 'MCP handshake: Authorization Bearer do-not-expose' } },
    });
    assert.doesNotMatch(s.error!, /do-not-expose|Authorization/);
  }));

test(
  'native Codex initializes both managed transports using ephemeral thread configuration',
  {
    skip: !process.env.AGENT_DESK_TEST_CODEX,
    timeout: 30000,
  },
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-native-mcp-')));
    const httpMethods: string[] = [];
    const local = http.createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer fixture-only');
      let body = '';
      for await (const chunk of request) body += chunk;
      const m = JSON.parse(body);
      httpMethods.push(m.method);
      if (m.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        m.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'http-fixture', version: '1' },
            }
          : { tools: [{ name: 'fixture_http', inputSchema: { type: 'object' } }] };
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
    let rpc: Rpc | undefined;
    try {
      await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
      const port = (local.address() as { port: number }).port;
      const marker = path.join(root, 'stdio-started.json');
      const fixture = path.join(root, 'fixture.cjs');
      fs.writeFileSync(
        fixture,
        `
      const fs = require('node:fs');
      fs.writeFileSync(process.env.MCP_MARKER, JSON.stringify({cwd:process.cwd(),value:process.env.MCP_VALUE}));
      require('node:readline').createInterface({input:process.stdin}).on('line',line => {
        const m=JSON.parse(line); if(m.id===undefined)return;
        const result=m.method==='initialize'
          ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'stdio-fixture',version:'1'}}
          : {tools:[{name:'fixture_stdio',inputSchema:{type:'object'}}]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
      });
    `,
      );
      fs.mkdirSync(path.join(root, 'codex-profile'));
      rpc = new Rpc(
        process.env.AGENT_DESK_TEST_CODEX!,
        ['app-server', '--listen', 'stdio://'],
        root,
        {
          PATH: process.env.PATH,
          CODEX_HOME: path.join(root, 'codex-profile'),
          NO_PROXY: '127.0.0.1,localhost,::1',
          no_proxy: '127.0.0.1,localhost,::1',
        },
      );
      await rpc.initialize().catch((error) => {
        throw new Error(`${error.message}: ${rpc!.stderr}`);
      });
      const config = codexMcpConfig([
        {
          connection: {
            id: 'native-http',
            name: 'HTTP',
            transport: 'http',
            url: `http://127.0.0.1:${port}/mcp`,
            auth: 'headers',
            envKeys: [],
            headerKeys: ['Authorization'],
            revision: 1,
            status: 'unchecked',
          },
          env: {},
          headers: { Authorization: 'Bearer fixture-only' },
        },
        {
          connection: {
            id: 'native-stdio',
            name: 'Stdio',
            transport: 'stdio',
            command: process.execPath,
            args: [fixture],
            cwd: root,
            auth: 'none',
            envKeys: ['MCP_MARKER', 'MCP_VALUE'],
            headerKeys: [],
            revision: 1,
            status: 'unchecked',
          },
          env: { MCP_MARKER: marker, MCP_VALUE: 'fixture-env' },
          headers: {},
        },
      ]);
      const result = await rpc.call(
        'thread/start',
        { cwd: root, approvalPolicy: 'never', sandbox: 'read-only', config },
        15000,
      );
      assert.equal(typeof result.thread.id, 'string');
      for (
        let i = 0;
        i < 100 && (!httpMethods.includes('tools/list') || !fs.existsSync(marker));
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(httpMethods.includes('initialize'));
      assert.ok(httpMethods.includes('tools/list'));
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), {
        cwd: root,
        value: 'fixture-env',
      });
      // Flush native logs/state before checking that ephemeral overrides stayed out of the
      // isolated profile. This covers initialization only; no model turn runs in this test.
      await rpc.stop();
      const profile = path.join(root, 'codex-profile');
      const files = fs
        .readdirSync(profile, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      assert.ok(files.length > 0, 'The native profile must contain files for this check');
      for (const file of files) {
        const contents = fs.readFileSync(file);
        assert.equal(
          contents.includes(Buffer.from('fixture-only')),
          false,
          `HTTP credential persisted in ${path.relative(profile, file)}`,
        );
        assert.equal(
          contents.includes(Buffer.from('fixture-env')),
          false,
          `Stdio credential persisted in ${path.relative(profile, file)}`,
        );
      }
    } finally {
      await rpc?.stop();
      local.closeAllConnections();
      await new Promise<void>((resolve) => local.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
