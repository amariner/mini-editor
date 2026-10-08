import { codexUsage, type SubscriptionUsage } from '../src/subscription-usage';
import { isCodex } from '../src/shared';
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import { Rpc } from './rpc';
import { fetchCodexModels } from './codex-models';
import { readClaudeModels } from './claude';
import { claudeAccount, codexAccount } from './account-state';
import { cleanEnv, profileDirectory } from './core';
import { reapGroup } from './processes';
import type { AccountState, Profile, DeskEvent } from '../src/shared';
const exec = promisify(execFile);
// Cold Claude startup can take over 40 seconds on macOS before any auth output.
const CLAUDE_AUTH_TIMEOUT_MS = 60000;

type Check = { cancelled: boolean; stop?: () => Promise<void>; work?: Promise<void> };

type Login = {
  rpc?: Rpc;
  loginId?: string;
  terminal?: pty.IPty;
  exited?: Promise<void>;
  cancelling?: boolean;
  startupTimer?: ReturnType<typeof setTimeout>;
};
export class Accounts {
  readonly state = {} as Record<Profile, AccountState>;
  readonly logins = new Map<Profile, Login>();
  readonly buffers = new Map<string, { data: string; sequence: number }>();
  private jobs = new Set<Promise<unknown>>();
  private closing = false;
  private checks = new Map<Profile, Check>();
  private removals = new Set<Profile>();
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
    private networkEnvironment: () => Record<string, string> = () => ({}),
  ) {}
  register(profile: Profile) {
    this.state[profile] ??= { status: 'unknown' };
  }
  get active() {
    return this.jobs.size > 0 || this.logins.size > 0 || this.removals.size > 0;
  }
  removing(profile: Profile) {
    return this.removals.has(profile);
  }
  changing(profile: Profile) {
    if (!this.state[profile]) throw new Error('Esta cuenta no existe. Añádela en Ajustes.');
    return this.removals.has(profile) || !!this.state[profile].busy;
  }
  private update(profile: Profile, patch: Partial<AccountState>) {
    if (!this.state[profile] || this.checks.get(profile)?.cancelled) return;
    if (patch.status === 'signedOut' || patch.status === 'unknown') patch.usage = undefined;
    Object.assign(this.state[profile], patch);
    this.changed();
  }
  private async job<T>(
    profile: Profile,
    busy: NonNullable<AccountState['busy']>,
    fn: () => Promise<T>,
    usageOnly = false,
  ) {
    if (this.closing) throw new Error('Agent Desk se está cerrando.');
    if ((this.removals.has(profile) && busy !== 'removing') || this.state[profile]?.busy)
      throw new Error('Ya hay una operación de cuenta en curso para este perfil.');
    if (!this.state[profile]) throw new Error('Esta cuenta no existe. Añádela en Ajustes.');
    if (busy !== 'checking') this.revisions.set(profile, this.revision(profile) + 1);
    this.update(profile, usageOnly ? { busy } : { busy, error: undefined });
    const work = (async () => {
      try {
        return await fn();
      } catch (error) {
        if (!usageOnly)
          this.update(profile, { status: 'unknown', error: (error as Error).message });
        throw error;
      } finally {
        if (!this.logins.has(profile) && this.state[profile]?.busy === busy)
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
      env: {
        ...cleanEnv(),
        ...this.networkEnvironment(),
        [isCodex(profile) ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: dir,
      },
    };
  }
  private async rpc(profile: Profile, check?: Check) {
    const ctx = await this.context(profile);
    if (check?.cancelled) throw new Error('Comprobación cancelada.');
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
    if (check) check.stop = () => rpc.stop();
    try {
      await rpc.initialize();
      return rpc;
    } catch (error) {
      await rpc.stop();
      throw error;
    }
  }
  async readModels(profile: Profile, signal: AbortSignal) {
    if (!this.state[profile] || this.removing(profile))
      throw new Error('La cuenta no está disponible.');
    const ctx = await this.context(profile);
    signal.throwIfAborted();
    if (!isCodex(profile)) return readClaudeModels(ctx.binary, ctx.cwd, ctx.env, signal);
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
    const cancel = () => {
      void rpc.stop().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await rpc.initialize();
      return await fetchCodexModels((method, params) => rpc.call(method, params));
    } finally {
      signal.removeEventListener('abort', cancel);
      await rpc.stop();
    }
  }
  setUsage(profile: Profile, usage: SubscriptionUsage) {
    if (
      this.state[profile] &&
      !this.changing(profile) &&
      this.state[profile].status !== 'signedOut'
    )
      this.update(profile, { usage });
  }
  async readUsage(profile: Profile) {
    return this.check(
      profile,
      async (check) => {
        let rpc: Rpc | undefined;
        try {
          // Usage polling must not validate or invalidate authentication. In particular,
          // account/read may need network routing even with a saved ChatGPT login.
          if (this.state[profile].status === 'signedOut') {
            this.update(profile, {
              usage: {
                windows: [],
                checkedAt: Date.now(),
                unavailable: 'Inicia sesión para consultar el uso.',
              },
            });
            return;
          }
          rpc = await this.rpc(profile, check);
          this.update(profile, { usage: codexUsage(await rpc.call('account/rateLimits/read')) });
        } catch (error) {
          this.update(profile, {
            usage: { windows: [], checkedAt: Date.now(), unavailable: (error as Error).message },
          });
        } finally {
          await rpc?.stop();
        }
      },
      true,
    );
  }
  private check(profile: Profile, fn: (check: Check) => Promise<void>, usageOnly = false) {
    // Reserve synchronously, including while the CLI context is being created.
    if (this.changing(profile))
      return Promise.reject(new Error('Ya hay una operación de cuenta en curso para este perfil.'));
    const check: Check = { cancelled: false };
    this.checks.set(profile, check);
    check.work = this.job(
      profile,
      'checking',
      async () => {
        try {
          await fn(check);
        } catch (error) {
          if (!check.cancelled) throw error;
        }
      },
      usageOnly,
    ).finally(() => {
      this.checks.delete(profile);
      if (this.state[profile]?.busy === 'checking') this.update(profile, { busy: undefined });
    });
    return check.work;
  }
  private async stopCheck(check: Check) {
    check.cancelled = true;
    await check.stop?.();
    await check.work;
  }
  private claudeStatus(ctx: Awaited<ReturnType<Accounts['context']>>, check?: Check) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(ctx.binary, ['auth', 'status', '--json'], {
        cwd: ctx.cwd,
        env: ctx.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      let failure: Error | undefined;
      const stop = async () => {
        if (child.pid) await reapGroup(child.pid);
      };
      if (check) check.stop = stop;
      const timer = setTimeout(() => {
        failure = new Error(
          'Claude Code no ha respondido en 60 segundos al comprobar la cuenta. El acceso sigue sin verificar.',
        );
        void stop().catch(reject);
      }, CLAUDE_AUTH_TIMEOUT_MS);
      child.stdout.on('data', (data: Buffer) => {
        if (failure) return;
        stdout += data.toString();
        if (Buffer.byteLength(stdout) > 128 * 1024) {
          failure = new Error('La respuesta de Claude Code es demasiado grande.');
          void stop().catch(reject);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `No se pudo arrancar Claude Code (${(error as NodeJS.ErrnoException).code ?? 'error'}). Revisa el ejecutable en Herramientas y datos locales.`,
          ),
        );
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        // The official CLI also returns JSON with a nonzero exit code when signed out.
        else if (code !== 0 && !stdout.trim())
          reject(
            new Error(
              `Claude Code terminó sin comunicar el estado de la cuenta (código ${code ?? 'señal'}). Comprueba el ejecutable en Herramientas y datos locales.`,
            ),
          );
        else resolve(stdout);
      });
    });
  }
  private async read(profile: Profile, check?: Check) {
    if (isCodex(profile)) {
      const rpc = await this.rpc(profile, check);
      try {
        const result = await rpc.call('account/read', { refreshToken: false });
        this.update(profile, { ...codexAccount(result), error: undefined });
      } finally {
        await rpc.stop();
      }
    } else {
      const ctx = await this.context(profile);
      if (check?.cancelled) return;
      const stdout = await this.claudeStatus(ctx, check);
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
    return this.check(profile, (check) => this.read(profile, check));
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
      // A CLI that never reaches its OAuth prompt must not leave a blank, locked login forever.
      login.startupTimer = setTimeout(() => {
        if (this.logins.get(profile) !== login || login.cancelling) return;
        void this.track(
          this.closeLogin(
            profile,
            login,
            true,
            'Claude Code no ha iniciado el acceso en 60 segundos. No llegó a generar el enlace del navegador. Revisa el ejecutable en Herramientas y datos locales y vuelve a intentarlo.',
            false,
          ),
        ).catch(() => {});
      }, CLAUDE_AUTH_TIMEOUT_MS);
      const terminalId = `account:${profile}`;
      this.buffers.set(terminalId, { data: '', sequence: 0 });
      this.logins.set(profile, login);
      terminal.onData((data) => {
        if (stripVTControlCharacters(data).trim()) {
          clearTimeout(login.startupTimer);
          if (this.state[profile]?.loginStarting) this.update(profile, { loginStarting: false });
        }
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
      this.update(profile, { terminalId, cancellable: true, loginStarting: true });
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
  private async closeLogin(
    profile: Profile,
    login: Login,
    cancel: boolean,
    error?: string,
    refresh = true,
  ) {
    login.cancelling = true;
    clearTimeout(login.startupTimer);
    this.update(profile, {
      busy: cancel ? 'cancelling' : 'verifying',
      cancellable: false,
      loginStarting: false,
    });
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
      else if (!this.closing && refresh && (!cancel || isCodex(profile))) {
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
            timeout: CLAUDE_AUTH_TIMEOUT_MS,
            killSignal: 'SIGKILL',
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
  remove(profile: Profile, confirmed: boolean, commit: () => Promise<void>) {
    return this.track(this.removeProfile(profile, confirmed, commit));
  }
  private async removeProfile(profile: Profile, confirmed: boolean, commit: () => Promise<void>) {
    if (!confirmed) throw new Error('Confirma la eliminación de esta cuenta.');
    this.changing(profile); // Reject unknown profiles before touching any local data.
    if (this.removals.has(profile)) throw new Error('Esta cuenta ya se está eliminando.');
    this.removals.add(profile);
    this.revisions.set(profile, this.revision(profile) + 1);
    try {
      const check = this.checks.get(profile);
      if (check) await this.stopCheck(check);
      const login = this.logins.get(profile);
      if (login && this.state[profile].cancellable && !login.cancelling)
        await this.track(this.closeLogin(profile, login, true, undefined, false));
      return await this.job(profile, 'removing', async () => {
        await this.prepare(profile, true);
        await commit();
        this.buffers.delete(`account:${profile}`);
        delete this.state[profile];
        this.changed();
      });
    } finally {
      this.removals.delete(profile);
    }
  }

  terminal(id: string) {
    for (const [profile, login] of this.logins)
      if (id === `account:${profile}`) return login.terminal;
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.checks.values()].map((check) => this.stopCheck(check)));
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    const results = await Promise.allSettled(
      [...this.logins.keys()].map((profile) => this.cancel(profile)),
    );
    this.closing = false;
    return results;
  }
}
