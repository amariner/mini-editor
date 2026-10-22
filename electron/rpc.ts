import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { codexRpcError } from './codex-errors';
export class Rpc extends EventEmitter {
  process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private stopping?: Promise<void>;
  private pending = new Map<
    number,
    { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  closed = false;
  stderr = '';
  constructor(
    binary: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private jsonRpc = false,
  ) {
    super();
    this.process = spawn(binary, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch {
        this.emit('protocolError', 'Respuesta JSON no válida de app-server.');
      }
    });
    this.process.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    this.process.stdin.on('error', () => {});
    this.process.on('error', (e) => this.finish(e.message));
    this.process.on('close', (code) => this.finish(`app-server terminó (${code ?? 'señal'}).`));
  }
  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.emit('closed', reason);
  }
  receive(msg: any) {
    if (msg.method) {
      this.emit(msg.id !== undefined ? 'request' : 'notification', msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(codexRpcError(msg.error.message, msg.error.code));
    else p.resolve(msg.result);
  }
  send(msg: unknown) {
    if (this.stopping) throw new Error('El servidor se está cerrando.');
    if (this.closed) throw new Error('El servidor está detenido.');
    this.process.stdin.write(
      JSON.stringify(this.jsonRpc ? { jsonrpc: '2.0', ...(msg as object) } : msg) + '\n',
    );
  }
  call(method: string, params: unknown = {}, timeout = 30000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Tiempo agotado en ${method}. Detén y reabre la sesión antes de reintentar.`),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  respond(id: string | number, result: unknown) {
    this.send({ id, result });
  }
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'agent_desk', title: 'Agent Desk', version: '0.1.0' },
    });
    this.send({ method: 'initialized', params: {} });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.closed) return Promise.resolve();
    const work = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined, force: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(force);
        this.removeListener('closed', onClosed);
      };
      const onClosed = () => {
        cleanup();
        resolve();
      };
      this.once('closed', onClosed);
      const signal = (s: NodeJS.Signals) => {
        try {
          if (this.process.pid) process.kill(-this.process.pid, s);
          else this.process.kill(s);
        } catch {
          try {
            this.process.kill(s);
          } catch (error) {
            cleanup();
            reject(error);
          }
        }
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('No se ha confirmado el cierre del proceso. La carpeta sigue bloqueada.'));
      }, 7000);
      force = setTimeout(() => signal('SIGKILL'), 3000);
      signal('SIGTERM');
    });
    this.stopping = work.finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
