import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

type Encryption = Pick<
  Electron.SafeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString'
> &
  Partial<Pick<Electron.SafeStorage, 'getSelectedStorageBackend'>>;
const savedCookies = z.array(
  z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    hostOnly: z.boolean(),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    sameSite: z.enum(['unspecified', 'no_restriction', 'lax', 'strict']),
  }),
);

// Electron's Cookie type drops CHIPS partition keys. Read through CDP and leave
// partitioned cookies to Chromium rather than restoring them with broader scope.
export function restorableCookies(
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    session: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    partitionKey?: unknown;
    partitionKeyOpaque?: boolean;
  }>,
) {
  return cookies
    .filter((c) => c.session && !c.partitionKey && !c.partitionKeyOpaque)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      hostOnly: !c.domain.startsWith('.'),
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite:
        c.sameSite === 'None' ? 'no_restriction' : (c.sameSite?.toLowerCase() ?? 'unspecified'),
    }));
}

/** Restore session cookies on a clean restart without changing their lifetime or scope.
 * Persistent cookies remain in Chromium's store. Never save credentials in plaintext.
 */
export class BrowserSessions {
  private sessions = new Map<Electron.Session, Promise<void>>();
  constructor(
    private encryption: Encryption,
    private root?: string,
    private readCookies?: (session: Electron.Session) => Promise<unknown>,
  ) {}
  private file(session: Electron.Session) {
    if (!this.root || !session.storagePath) return undefined;
    const key = createHash('sha256').update(session.storagePath).digest('hex');
    return path.join(this.root, 'browser-sessions', key + '.enc');
  }
  private available() {
    return (
      this.encryption.isEncryptionAvailable() &&
      this.encryption.getSelectedStorageBackend?.() !== 'basic_text'
    );
  }
  restore(session: Electron.Session): Promise<void> {
    let ready = this.sessions.get(session);
    if (!ready) {
      ready = this.load(session);
      this.sessions.set(session, ready);
    }
    return ready;
  }
  private async load(session: Electron.Session) {
    const file = this.file(session);
    if (!file) return;
    try {
      // Consume before navigating: a logout followed by a crash must never revive
      // the previous login. Abnormal exits fall back to Chromium's durable cookies.
      const data = await fs.readFile(file);
      await fs.rm(file, { force: true });
      if (!this.available()) return;
      const cookies = savedCookies.parse(JSON.parse(this.encryption.decryptString(data)));
      for (const cookie of cookies) {
        const { hostOnly, domain, ...details } = cookie;
        const url = `${cookie.secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${cookie.path}`;
        await session.cookies
          .set({ ...details, url, ...(hostOnly ? {} : { domain }) })
          .catch(() => {});
      }
    } catch {
      // Missing/corrupt data or an unavailable key must not prevent browsing.
    }
  }
  async save(session: Electron.Session) {
    if (!this.sessions.has(session)) return;
    await this.sessions.get(session);
    const file = this.file(session);
    if (!file) return;
    if (!this.available()) {
      await fs.rm(file, { force: true });
      return;
    }
    const cookies = savedCookies.parse(await this.readCookies?.(session));
    if (!cookies.length) {
      await fs.rm(file, { force: true });
      return;
    }
    const data = this.encryption.encryptString(JSON.stringify(savedCookies.parse(cookies)));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file + '.tmp', data, { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  }
  async forget(session: Electron.Session) {
    await this.sessions.get(session);
    const file = this.file(session);
    if (file) await fs.rm(file, { force: true });
  }
}
