// Real providers and MCP transports, isolated project/profiles, no model calls.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
const output = path.resolve('dist-electron/concurrency-check.cjs');
await build({
  stdin: {
    loader: 'ts',
    resolveDir: process.cwd(),
    contents: `
import {Manager} from './electron/manager';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
(async()=>{
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-desk-concurrent-')));
const folder=path.join(root,'project');fs.mkdirSync(folder);
const manager=new Manager(path.join(root,'data'),()=>{});
const clients=[];
try{
  manager.addAccount('claude', 'Claude 1');manager.addAccount('claude', 'Claude 2');manager.addAccount('codex', 'Codex');
 await manager.discover();
  const p=await manager.addProject(folder);
  const one=manager.session(manager.state.selectedSession!);
  const two=manager.newSession(p.id,'claude-2');
  const codex=manager.newSession(p.id,'codex');
  await Promise.all([one,two,codex].map(s=>manager.start(s.id)));
  assert.equal(manager.runtimes.size,3);
  assert.ok([one,two,codex].every(s=>s.status==='ready'));
  for(const s of [one,two]) {
    await manager.runtimes.get(s.id)!.claude!.mcpStatus();
    assert.ok(s.info?.mcpServers.some((m:any)=>m.name==='agent_desk'&&m.status==='connected'),JSON.stringify(s.info?.mcpServers));
  }
  // thread/start starts MCP servers without sending a model task.
  await manager.loadThread(codex);
  const rpc=manager.runtimes.get(codex.id)!.rpc!;
  const status=await rpc.call('mcpServerStatus/list',{threadId:codex.reference});
  assert.ok(status.data.some((m:any)=>m.name==='agent_desk'&&Object.keys(m.tools??{}).length),JSON.stringify(status));
  for(const s of [one,codex]) {
    const config=await manager.coordinator.config(s.id);
    const client=new Client({name:'agent-desk-test',version:'1.0.0'});
    await client.connect(new StdioClientTransport(config));clients.push(client);
  }
  const invoke=async(client:any,args:any)=>JSON.parse((await client.callTool({name:'coordinate',arguments:args})).content[0].text);
  assert.equal((await invoke(clients[0],{operation:'claim',paths:['a.txt'],summary:'Task A'})).ok,true);
  assert.equal((await invoke(clients[1],{operation:'claim',paths:['b.txt'],summary:'Task B'})).ok,true);
  assert.equal((await invoke(clients[1],{operation:'claim',paths:['a.txt']})).ok,false);
  await manager.stop(one.id);
  assert.equal(manager.runtimes.size,2);
  assert.equal((await invoke(clients[1],{operation:'claim',paths:['a.txt']})).ok,true);
  const reference=codex.reference;
  await manager.stop(codex.id);
  await manager.start(codex.id);
  await manager.loadThread(codex);
  assert.notEqual(codex.reference,reference); // Empty thread has no persisted rollout.
  const resumed=await manager.runtimes.get(codex.id)!.rpc!.call('mcpServerStatus/list',{threadId:codex.reference});
  assert.ok(resumed.data.some((m:any)=>m.name==='agent_desk'&&Object.keys(m.tools??{}).length));
  assert.deepEqual(fs.readdirSync(folder),[]);
  console.log('PASS: 3 real provider processes, isolated accounts, Claude and Codex MCP connected, actual bridge claims/conflicts, independent stop, Codex empty-thread recovery reconnects coordinator; project untouched.');
}finally{
  await Promise.allSettled(clients.map(c=>c.close()));
  const result=await manager.shutdown();
  assert.ok(result.every(r=>r.status==='fulfilled'));
}
})().catch(e=>{console.error(e);process.exitCode=1;});
`,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  external: ['node-pty', '@anthropic-ai/claude-agent-sdk'],
});
const child = spawn(electron, [output], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
