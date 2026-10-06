// Opt-in subscription-backed test. Uses official isolated profiles, never reads credentials.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
if (!process.env.AGENT_DESK_PROFILES_DIR)
  throw new Error('Define AGENT_DESK_PROFILES_DIR con los perfiles oficiales autenticados.');
const output = path.resolve('dist-electron/coordination-live-check.cjs');
await build({
  stdin: {
    loader: 'ts',
    resolveDir: process.cwd(),
    contents: `
import {Manager} from './electron/manager';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
(async()=>{
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-live-coordination-')));
const folder=path.join(root,'project');fs.mkdirSync(folder);
const manager=new Manager(path.join(root,'data'),()=>{},process.env.AGENT_DESK_PROFILES_DIR);
const wait=async(check:()=>boolean,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return; if(manager.state.sessions.some(s=>s.approvals.length)) throw new Error(JSON.stringify(manager.state.sessions.filter(s=>s.approvals.length).map(s=>({profile:s.profile,approvals:s.approvals}))));await new Promise(r=>setTimeout(r,150));}throw new Error('Timeout');};
try{
 manager.addAccount('claude', 'Claude 1');manager.addAccount('claude', 'Claude 2');manager.addAccount('codex', 'Codex');
 await manager.discover();const project=await manager.addProject(folder);
 const claude=manager.session(manager.state.selectedSession!);const codex=manager.newSession(project.id,'codex');
 await manager.configure(claude.id,{model:'haiku'});
 await Promise.all([manager.start(claude.id),manager.start(codex.id)]);
 if(!claude.account || !codex.account) { console.log('AUTH_REQUIRED: falta acceso oficial en uno de los perfiles; no se enviaron tareas.'); return; }
 const model=codex.info?.models.find(m=>m.value.includes('luna')) ?? codex.info?.models.find(m=>m.isDefault);
 if(model) await manager.configureCodex(codex.id,{model:model.value,effort:model.supportedEffortLevels?.includes('low')?'low':undefined});
 const prompt=(file:string)=>'Prueba de coordinación de Agent Desk. No leas, crees ni modifiques archivos y no ejecutes comandos. Usa exclusivamente la herramienta MCP agent_desk coordinate: primero status, luego claim de '+file+'. Para esta prueba conserva la reserva hasta que cerremos la sesión; no llames release. Responde brevemente con el resultado real de la reserva.';
 await Promise.all([manager.send(claude.id,prompt('claude-test.txt')),manager.send(codex.id,prompt('codex-test.txt'))]);
 await wait(()=>[claude,codex].every(s=>s.status==='ready' && s.messages.some(m=>m.role==='assistant')));
 assert.ok(!claude.error && !codex.error,claude.error??codex.error);
 assert.ok(manager.coordinator.snapshot().find(p=>p.sessionId===claude.id)?.paths.includes('claude-test.txt'),'Claude no reservó el archivo');
 assert.ok(manager.coordinator.snapshot().find(p=>p.sessionId===codex.id)?.paths.includes('codex-test.txt'),'Codex no reservó el archivo');
 await manager.send(codex.id,'Otra comprobación: intenta reservar claude-test.txt mediante coordinate claim. Ya está reservado por otra cuenta; informa del rechazo y no modifiques nada. Mantén tus reservas hasta cerrar la sesión.');
 await wait(()=>codex.status==='ready' && codex.messages.some(m=>m.role==='tool' && m.text.includes('Archivos reservados')));
 assert.ok(!manager.coordinator.snapshot().find(p=>p.sessionId===codex.id)?.paths.includes('claude-test.txt'));
 const reference=codex.reference;
 await manager.stop(codex.id);await manager.start(codex.id);
 assert.equal(codex.reference,reference);
 assert.ok(codex.messages.some(m=>m.role==='user'));
 const servers=await manager.runtimes.get(codex.id)!.rpc!.call('mcpServerStatus/list',{threadId:reference});
 assert.ok(servers.data.some((m:any)=>m.name==='agent_desk'&&Object.keys(m.tools??{}).length));
 assert.deepEqual(fs.readdirSync(folder),[]);
 console.log('PASS LIVE: simultaneous subscription-backed Claude/Codex turns, actual MCP status/claims, Codex conflict rejection, persisted conversation resume and MCP reconnect. No project file changed.');
}finally{const results=await manager.shutdown();assert.ok(results.every(r=>r.status==='fulfilled'));}
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
