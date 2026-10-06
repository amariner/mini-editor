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
    return [...this.processes.keys()].map((id) => ({
      id,
      projectId: id.slice(6),
      status: 'terminal' as const,
    }));
  }
  open(project: Project) {
    const id = `shell:${project.id}`;
    if (this.processes.has(id)) return;
    // -f avoids changing/loading the user's shell customizations for this local terminal.
    const terminal = pty.spawn(process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', ['-f'], {
      name: 'xterm-256color',
      cwd: project.path,
      cols: 100,
      rows: 30,
      env: cleanEnv(),
    });
    this.buffers.set(id, { data: '', sequence: 0 });
    const exit = new Promise<void>((resolve) =>
      terminal.onExit(() => {
        this.processes.delete(id);
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
  stop(projectId: string) {
    const id = `shell:${projectId}`;
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
    return Promise.allSettled([...this.processes.keys()].map((id) => this.stop(id.slice(6))));
  }
}
