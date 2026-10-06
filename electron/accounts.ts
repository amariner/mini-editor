import { codexUsage, type SubscriptionUsage } from '../src/subscription-usage';
import { isCodex } from '../src/shared';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { Rpc } from './rpc';
import { claudeAccount, codexAccount } from './account-state';
import { cleanEnv, profileDirectory } from './core';
import { reapGroup } from './processes';
import type { AccountState, Profile, DeskEvent } from '../src/shared';
const exec = promisify(execFile);

type Login = {
  rpc?: Rpc;
  loginId?: string;
  terminal?: pty.IPty;
  exited?: Promise<void>;
  cancelling?: boolean;
};
export class Accounts {
  readonly state = {} as Record<Profile, AccountState>;
  readonly logins = new Map<Profile, Login>();
  readonly buffers = new Map<string, { data: string; sequence: number }>();
  private jobs = new Set<Promise<unknown>>();
  private closing = false;
  private revisions = new Map<Profile, number>();
  revision(profile: Profile) {
    return this.revisions.get(profile) ?? 0;
  }
  constructor(
    private root: string,
    private tools: () => { claude?: string; codex?: string },
    private changed: () => void,
    private emit: (event: DeskEvent) => void,
    private prepare: (profile: Profile, stopSessions: boolean) => Promise<void>,
  ) {}
  register(profile: Profile) {
    this.state[profile] ??= { status: 'unknown' };
  }
  get active() {
    return this.jobs.size > 0 || this.logins.size > 0;
  }
  changing(profile: Profile) {
    if (!this.state[profile]) throw new Error('Esta cuenta no existe. Añádela en Ajustes.');
    return !!this.state[profile].busy;
  }
  private update(profile: Profile, patch: Partial<AccountState>) {
    if (patch.status === 'signedOut' || patch.status === 'unknown') patch.usage = undefined;
    Object.assign(this.state[profile], patch);
    this.changed();
  }
  private async job<T>(
    profile: Profile,
    busy: NonNullable<AccountState['busy']>,
    fn: () => Promise<T>,
  ) {
    if (this.closing) throw new Error('Agent Desk se está cerrando.');
    if (this.changing(profile))
      throw new Error('Ya hay una operación de cuenta en curso para este perfil.');
    if (busy !== 'checking') this.revisions.set(profile, this.revision(profile) + 1);
    this.update(profile, { busy, error: undefined });
    const work = (async () => {
      try {
        return await fn();
      } catch (error) {
        this.update(profile, { status: 'unknown', error: (error as Error).message });
        throw error;
      } finally {
        if (!this.logins.has(profile) && this.state[profile].busy === busy)
          this.update(profile, { busy: undefined });
      }
    })();
    this.jobs.add(work);
    try {
      return await work;
    } finally {
      this.jobs.delete(work);
    }
  }
  private async context(profile: Profile) {
    const binary = this.tools()[isCodex(profile) ? 'codex' : 'claude'];
    if (!binary) throw new Error('No se encontró el ejecutable oficial. Selecciónalo en Ajustes.');
    const dir = profileDirectory(this.root, profile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return {
      binary,
      cwd: dir,
      env: { ...cleanEnv(), [isCodex(profile) ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: dir },
    };
  }
  private async rpc(profile: Profile) {
    const ctx = await this.context(profile);
    const rpc = new Rpc(
      ctx.binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'model_provider="openai"',
      ],
      ctx.cwd,
      ctx.env,
    );
    try {
      await rpc.initialize();
      return rpc;
    } catch (error) {
      await rpc.stop();
      throw error;
    }
  }
  setUsage(profile: Profile, usage: SubscriptionUsage) {
    if (!this.changing(profile) && this.state[profile].status !== 'signedOut')
      this.update(profile, { usage });
  }
  async readUsage(profile: Profile) {
    return this.job(profile, 'checking', async () => {
      const rpc = await this.rpc(profile);
      try {
        const account = codexAccount(await rpc.call('account/read', { refreshToken: false }));
        this.update(profile, account);
        if (account.status !== 'signedIn') {
          this.update(profile, {
            usage: {
              windows: [],
              checkedAt: Date.now(),
              unavailable: 'Inicia sesión para consultar el uso.',
            },
          });
          return;
        }
        try {
          this.update(profile, { usage: codexUsage(await rpc.call('account/rateLimits/read')) });
        } catch {
          this.update(profile, {
            usage: {
              windows: [],
              checkedAt: Date.now(),
              unavailable: 'Esta versión o cuenta de Codex no comunica los límites de uso.',
            },
          });
        }
      } finally {
        await rpc.stop();
      }
    });
  }
  private async read(profile: Profile) {
    if (isCodex(profile)) {
      const rpc = await this.rpc(profile);
      try {
        const result = await rpc.call('account/read', { refreshToken: false });
        this.update(profile, { ...codexAccount(result), error: undefined });
      } finally {
        await rpc.stop();
      }
    } else {
      const ctx = await this.context(profile);
      let stdout: string;
      try {
        ({ stdout } = await exec(ctx.binary, ['auth', 'status', '--json'], {
          ...ctx,
          timeout: 15000,
          maxBuffer: 128 * 1024,
        }));
      } catch (e) {
        // The official CLI exits nonzero when signed out; still returns status JSON.
        if (typeof (e as any).stdout !== 'string' || !(e as any).stdout.trim())
          throw new Error(
            'No se pudo consultar Claude Code. Comprueba el ejecutable y vuelve a intentarlo.',
          );
        stdout = (e as any).stdout;
      }
      let result: any;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new Error('Esta versión de Claude Code no devolvió un estado de cuenta válido.');
      }
      this.update(profile, { ...claudeAccount(result), error: undefined });
    }
  }
  async refresh(profile: Profile) {
    return this.job(profile, 'checking', () => this.read(profile));
  }
  async login(profile: Profile, stopSessions: boolean) {
    return this.job(profile, 'signingIn', async () => {
      await this.prepare(profile, stopSessions);
      this.update(profile, { status: 'unknown', label: undefined, plan: undefined });
      if (isCodex(profile)) {
        const rpc = await this.rpc(profile);
        const login: Login = { rpc };
        this.logins.set(profile, login);
        rpc.on('notification', (event) => {
          if (
            event.method === 'account/login/completed' &&
            event.params.loginId === login.loginId &&
            !login.cancelling
          )
            void this.finish(
              profile,
              login,
              event.params.success
                ? undefined
                : (event.params.error ?? 'No se completó el acceso.'),
            );
        });
        rpc.on('closed', () => {
          if (this.logins.get(profile) === login && !login.cancelling)
            void this.finish(profile, login, 'El servidor de autenticación se ha cerrado.');
        });
        try {
          const result = await rpc.call('account/login/start', { type: 'chatgpt' });
          login.loginId = result.loginId;
          const url = new URL(result.authUrl);
          if (
            url.protocol !== 'https:' ||
            !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)
          )
            throw new Error('Codex devolvió una URL de autenticación no reconocida.');
          this.update(profile, { cancellable: true });
          return url.href;
        } catch (error) {
          await this.finish(profile, login, (error as Error).message);
          throw error;
        }
      }
      const ctx = await this.context(profile);
      const terminal = pty.spawn(ctx.binary, ['auth', 'login', '--claudeai'], {
        cwd: ctx.cwd,
        env: ctx.env,
        name: 'xterm-256color',
        cols: 90,
        rows: 20,
      });
      const login: Login = { terminal };
      const terminalId = `account:${profile}`;
      this.buffers.set(terminalId, { data: '', sequence: 0 });
      this.logins.set(profile, login);
      terminal.onData((data) => {
        const buffer = this.buffers.get(terminalId);
        if (!buffer) return;
        buffer.data = (buffer.data + data).slice(-150000);
        buffer.sequence++;
        this.emit({ type: 'terminal', sessionId: terminalId, data, sequence: buffer.sequence });
      });
      login.exited = new Promise<void>((resolve) =>
        terminal.onExit(({ exitCode }) => {
          resolve();
          if (!login.cancelling)
            void this.finish(
              profile,
              login,
              exitCode === 0 ? undefined : 'Claude Code no completó el inicio de sesión.',
            );
        }),
      );
      this.update(profile, { terminalId, cancellable: true });
    });
  }
  private track<T>(work: Promise<T>) {
    this.jobs.add(work);
    void work.then(
      () => this.jobs.delete(work),
      () => this.jobs.delete(work),
    );
    return work;
  }
  private finish(profile: Profile, login: Login, error?: string) {
    if (this.logins.get(profile) !== login || login.cancelling) return Promise.resolve();
    return this.track(this.closeLogin(profile, login, false, error));
  }
  cancel(profile: Profile) {
    const login = this.logins.get(profile);
    if (!login || !this.state[profile].cancellable)
      return Promise.reject(new Error('El acceso todavía no está listo para cancelarse.'));
    if (login.cancelling)
      return Promise.reject(new Error('Se está confirmando el cierre de la autenticación.'));
    return this.track(this.closeLogin(profile, login, true));
  }
  private async closeLogin(profile: Profile, login: Login, cancel: boolean, error?: string) {
    login.cancelling = true;
    this.update(profile, { busy: 'cancelling', cancellable: false });
    try {
      if (cancel && login.rpc && login.loginId) {
        try {
          await login.rpc.call('account/login/cancel', { loginId: login.loginId });
        } catch (e) {
          error = (e as Error).message;
        }
      }
      await login.rpc?.stop();
      if (login.terminal) {
        await reapGroup(login.terminal.pid);
        await login.exited;
      }
      this.logins.delete(profile);
      this.buffers.delete(`account:${profile}`);
      this.update(profile, {
        terminalId: undefined,
        status: 'unknown',
        label: undefined,
        plan: undefined,
      });
      if (error) this.update(profile, { error });
      else if (!this.closing) {
        try {
          await this.read(profile);
        } catch (e) {
          this.update(profile, { status: 'unknown', error: (e as Error).message });
        }
      }
    } catch (e) {
      this.update(profile, { status: 'unknown', error: (e as Error).message });
      // Keep the handle and profile locked so the user can retry confirmed cleanup.
      if (cancel) throw e;
    } finally {
      login.cancelling = false;
      this.update(profile, {
        busy: this.logins.has(profile) ? 'signingIn' : undefined,
        cancellable: this.logins.has(profile),
      });
    }
  }
  async logout(profile: Profile, stopSessions: boolean) {
    return this.job(profile, 'signingOut', async () => {
      await this.prepare(profile, stopSessions);
      if (isCodex(profile)) {
        const rpc = await this.rpc(profile);
        try {
          await rpc.call('account/logout');
        } finally {
          await rpc.stop();
        }
      } else {
        const ctx = await this.context(profile);
        try {
          await exec(ctx.binary, ['auth', 'logout'], {
            ...ctx,
            timeout: 15000,
            maxBuffer: 128 * 1024,
          });
        } catch {
          throw new Error(
            'Claude Code no confirmó el cierre de sesión. Comprueba la versión instalada y reintenta.',
          );
        }
      }
      this.update(profile, {
        status: 'signedOut',
        label: undefined,
        plan: undefined,
        error: undefined,
      });
    });
  }
  terminal(id: string) {
    for (const [profile, login] of this.logins)
      if (id === `account:${profile}`) return login.terminal;
  }
  async shutdown() {
    this.closing = true;
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    const results = await Promise.allSettled(
      [...this.logins.keys()].map((profile) => this.cancel(profile)),
    );
    this.closing = false;
    return results;
  }
}
