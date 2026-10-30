import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BrowserSessions, restorableCookies } from '../electron/browser-sessions';

const readCookies = (session: Electron.Session) => session.cookies.get({ session: true });

function fixture(root: string, project = 'p') {
  let values: Electron.Cookie[] = [];
  const session = {
    storagePath: path.join(root, project),
    cookies: {
      async get(filter: Electron.CookiesGetFilter) {
        return values.filter((c) => filter.session === undefined || c.session === filter.session);
      },
      async set(c: Electron.CookiesSetDetails) {
        values.push({
          ...c,
          name: c.name!,
          value: c.value!,
          domain: c.domain || new URL(c.url).hostname,
          hostOnly: !c.domain,
          session: c.expirationDate === undefined,
          sameSite: c.sameSite!,
        });
      },
    },
  } as unknown as Electron.Session;
  return {
    session,
    seed: (cookies: Electron.Cookie[]) => {
      values = cookies;
    },
    all: () => values,
  };
}
const cookie: Electron.Cookie = {
  name: '__Host-login',
  value: 'private-login-value',
  domain: 'login.example',
  path: '/',
  hostOnly: true,
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  session: true,
};
function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'unknown' as const,
    encryptString(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data: Buffer) {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

test('clean restart restores encrypted session cookies with original scope and flags', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-session-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const crypto = encryption();
  // macOS and Windows do not expose the Linux backend query.
  const { getSelectedStorageBackend: _backend, ...nativeCrypto } = crypto;
  const before = fixture(root);
  const store = new BrowserSessions(nativeCrypto, root, readCookies);
  await store.restore(before.session);
  before.seed([
    cookie,
    { ...cookie, name: 'domain', domain: '.example', hostOnly: false },
    { ...cookie, name: 'persistent', session: false, expirationDate: Date.now() / 1000 + 3600 },
  ]);
  await store.save(before.session);
  const dir = path.join(root, 'browser-sessions');
  const [file] = await fs.readdir(dir);
  const data = await fs.readFile(path.join(dir, file));
  assert.equal(data.includes(Buffer.from(cookie.value)), false);
  if (process.platform !== 'win32')
    assert.equal((await fs.stat(path.join(dir, file))).mode & 0o777, 0o600);
  const other = fixture(root, 'q');
  await new BrowserSessions(crypto, root).restore(other.session);
  assert.deepEqual(other.all(), []);
  const after = fixture(root);
  const restored = new BrowserSessions(nativeCrypto, root, readCookies);
  await Promise.all([restored.restore(after.session), restored.restore(after.session)]);
  assert.equal(after.all().length, 2);
  const { url: _url, ...hostCookie } = after.all()[0] as Electron.Cookie & { url: string };
  assert.deepEqual(hostCookie, cookie);
  assert.equal(after.all()[1].domain, '.example');
  assert.equal(after.all()[1].hostOnly, false);
  assert.deepEqual(
    await fs.readdir(dir),
    [],
    'Consumed snapshots cannot revive a logout after a crash',
  );
  await restored.save(after.session);
  await restored.forget(after.session);
  assert.deepEqual(await fs.readdir(dir), []);
  after.seed([]);
  await restored.save(after.session);
  const loggedOut = fixture(root);
  await new BrowserSessions(crypto, root).restore(loggedOut.session);
  assert.deepEqual(loggedOut.all(), []);
});

test('missing encryption, plaintext backend and corrupt snapshots never expose cookies or block startup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-session-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const crypto = encryption();
  for (const overrides of [
    { isEncryptionAvailable: () => false },
    { getSelectedStorageBackend: () => 'basic_text' as const },
  ]) {
    const f = fixture(root);
    const store = new BrowserSessions({ ...crypto, ...overrides }, root, readCookies);
    await store.restore(f.session);
    f.seed([cookie]);
    await store.save(f.session);
    assert.deepEqual(await fs.readdir(root), []);
  }
  const f = fixture(root);
  const store = new BrowserSessions(crypto, root, readCookies);
  await store.restore(f.session);
  f.seed([cookie]);
  await store.save(f.session);
  const dir = path.join(root, 'browser-sessions');
  const [file] = await fs.readdir(dir);
  await fs.writeFile(path.join(dir, file), 'corrupt');
  const after = fixture(root);
  await new BrowserSessions(crypto, root).restore(after.session);
  assert.deepEqual(after.all(), []);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('CHIPS cookies never become unpartitioned cookies during restoration', () => {
  const plain = {
    ...cookie,
    sameSite: 'Lax' as const,
    session: true,
    domain: 'login.example',
    path: '/',
    secure: true,
    httpOnly: true,
  };
  const result = restorableCookies([
    plain,
    { ...plain, partitionKey: { topLevelSite: 'https://one.example', hasCrossSiteAncestor: true } },
    { ...plain, partitionKey: { topLevelSite: 'https://two.example', hasCrossSiteAncestor: true } },
    { ...plain, partitionKeyOpaque: true },
    { ...plain, session: false },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].hostOnly, true);
  assert.equal(result[0].sameSite, 'lax');
});
