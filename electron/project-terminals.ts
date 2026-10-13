import * as pty from 'node-pty';
import { cleanEnv } from './core';
import { reapGroup } from './processes';
import type { DeskEvent, Project } from '../src/shared';

export class ProjectTerminals {
  readonly processes = new Map<string, { pty: pty.IPty; exit: Promise<void> }>();
  readonly buffers = new Map<string, { data: string; sequence: number }>();
  private pending = new Map<string, Promise<void>>();
  constructor(
    private emit: (event: DeskEvent) => void,
    private changed: () => void,
  ) {}
  snapshot() {
    const ids = new Set([
      ...this.processes.keys(),
      ...[...this.buffers.keys()].filter((id) => id.startsWith('freebuff:')),
    ]);
    return [...ids].map((id) => ({
      id,
      projectId: id.slice(id.indexOf(':') + 1),
      kind: id.startsWith('freebuff:') ? ('freebuff' as const) : ('shell' as const),
      status: this.processes.has(id) ? ('terminal' as const) : ('stopped' as const),
    }));
  }
  open(project: Project) {
    const id = `shell:${project.id}`;
    // -f avoids loading the user's shell customizations for this local terminal.
    this.spawn(
      id,
      project,
      process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
      ['-f'],
      cleanEnv(),
    );
  }
  openFreebuff(project: Project, binary?: string, network: Record<string, string> = {}) {
    if (!binary)
      throw new Error(
        'No se encontró Freebuff CLI. Selecciona su ejecutable en Ajustes → Herramientas y datos locales.',
      );
    // Only launch the official interactive product. No prompts, login tokens, headless flags,
    // trust bypasses or inference requests: the person operates the CLI directly.
    this.spawn(`freebuff:${project.id}`, project, binary, [], { ...cleanEnv(), ...network });
  }
  private spawn(
    id: string,
    project: Project,
    binary: string,
    args: string[],
    env: Record<string, string>,
  ) {
    if (this.pending.has(id)) throw new Error('Espera a que termine de cerrarse la terminal.');
    if (this.processes.has(id)) return;
    const terminal = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cwd: project.path,
      cols: 100,
      rows: 30,
      env,
    });
    this.buffers.set(id, { data: '', sequence: 0 });
    const exit = new Promise<void>((resolve) =>
      terminal.onExit(({ exitCode }) => {
        this.processes.delete(id);
        if (id.startsWith('freebuff:')) {
          const prior = this.buffers.get(id)!;
          const data = `\r\nFreebuff ha terminado (código ${exitCode}). Puedes volver a abrirlo desde este panel.\r\n`;
          const sequence = prior.sequence + 1;
          this.buffers.set(id, { data: (prior.data + data).slice(-2_000_000), sequence });
          this.emit({ type: 'terminal', sessionId: id, data, sequence });
        }
        this.changed();
        resolve();
      }),
    );
    this.processes.set(id, { pty: terminal, exit });
    terminal.onData((data) => {
      const prior = this.buffers.get(id)!;
      const sequence = prior.sequence + 1;
      this.buffers.set(id, { data: (prior.data + data).slice(-2_000_000), sequence });
      this.emit({ type: 'terminal', sessionId: id, data, sequence });
    });
    this.changed();
  }
  async stop(projectId: string) {
    const results = await Promise.allSettled([
      this.stopId(`shell:${projectId}`),
      this.stopFreebuff(projectId),
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  stopFreebuff(projectId: string) {
    return this.stopId(`freebuff:${projectId}`);
  }
  private stopId(id: string) {
    if (this.pending.has(id)) return this.pending.get(id)!;
    const rt = this.processes.get(id);
    if (!rt) return Promise.resolve();
    const result = (async () => {
      await reapGroup(rt.pty.pid);
      await rt.exit;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, result);
    return result;
  }
  async shutdown() {
    return Promise.allSettled([...this.processes.keys()].map((id) => this.stopId(id)));
  }
}
