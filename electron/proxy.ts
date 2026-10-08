import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import {
  defaultProxy,
  type ProxyConfig,
  type ProxyUpdate,
  type ProxySnapshot,
} from '../src/proxy-types';

const hostSchema = z
  .string()
  .trim()
  .max(253)
  .refine((host) => {
    if (!host) return true;
    if (/[\s/@?#\\]/.test(host)) return false;
    try {
      return new URL(`http://${host}`).hostname === host.toLowerCase();
    } catch {
      return false;
    }
  }, 'Indica un servidor sin protocolo, ruta ni credenciales.');
export const proxySchema = z.object({
  mode: z.enum(['system', 'manual']),
  protocol: z.enum(['http', 'https']),
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  username: z
    .string()
    .max(300)
    .refine((v) => !/[\r\n\0]/.test(v)),
  caFile: z.string().max(4096),
});
export const proxyUpdateSchema = proxySchema.extend({
  password: z.string().max(4096).optional(),
  clearPassword: z.boolean().optional(),
});
export type SecretCodec = {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
};
function endpoint(c: ProxyConfig) {
  return `${c.protocol}://${c.host}:${c.port}`;
}
function sameIdentity(a: ProxyConfig, b: ProxyConfig) {
  return endpoint(a) === endpoint(b) && a.username === b.username;
}
export function readCorporateCA(file: string) {
  if (!file) return undefined;
  if (!path.isAbsolute(file))
    throw new Error('Selecciona un certificado PEM con una ruta absoluta.');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2_000_000)
    throw new Error('El certificado PEM debe ser un archivo de hasta 2 MB.');
  const pem = fs.readFileSync(file, 'utf8');
  if (/PRIVATE KEY/.test(pem))
    throw new Error('Selecciona certificados públicos CA, no una clave privada.');
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certs?.length) throw new Error('El archivo no contiene certificados PEM válidos.');
  for (const cert of certs) new X509Certificate(cert);
  return pem;
}
export class ProxySettings {
  private config: ProxyConfig = { ...defaultProxy };
  private encryptedPassword?: string;
  private loadError?: string;
  private file: string;
  constructor(
    root: string,
    private codec: SecretCodec,
  ) {
    this.file = path.join(root, 'network.json');
    if (!fs.existsSync(this.file)) return;
    try {
      const saved = proxySchema
        .extend({ encryptedPassword: z.string().max(20000).optional() })
        .parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      const { encryptedPassword, ...config } = saved;
      this.config = config;
      this.encryptedPassword = encryptedPassword;
    } catch {
      this.loadError =
        'No se pudo leer la configuración de red. Revisa y guarda los ajustes; el archivo original se ha conservado.';
    }
  }
  snapshot(): ProxySnapshot {
    return {
      ...this.config,
      hasPassword: !!this.encryptedPassword,
      secureStorage: this.codec.available(),
      error: this.loadError,
    };
  }
  private password() {
    if (!this.encryptedPassword) return '';
    try {
      if (!this.codec.available()) throw new Error();
      return this.codec.decrypt(Buffer.from(this.encryptedPassword, 'base64'));
    } catch {
      throw new Error(
        'No se pudo desbloquear la contraseña del proxy. Vuelve a introducirla en Ajustes → Red.',
      );
    }
  }
  private prepare(input: ProxyUpdate) {
    const { password, clearPassword, ...config } = proxyUpdateSchema.parse(input);
    if (config.mode === 'manual' && !config.host) throw new Error('Indica el servidor del proxy.');
    readCorporateCA(config.caFile);
    const secret = clearPassword
      ? ''
      : password !== undefined
        ? password
        : sameIdentity(config, this.config)
          ? this.password()
          : '';
    if (secret && !config.username)
      throw new Error('Indica el usuario del proxy para guardar una contraseña.');
    return { config, secret };
  }
  save(input: ProxyUpdate) {
    const { config, secret } = this.prepare(input);
    if (secret && !this.codec.available())
      throw new Error(
        'El almacenamiento seguro no está disponible. La contraseña no se guardará en texto plano.',
      );
    const encryptedPassword = secret ? this.codec.encrypt(secret).toString('base64') : undefined;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ ...config, encryptedPassword }), {
      mode: 0o600,
    });
    fs.renameSync(this.file + '.tmp', this.file);
    this.config = config;
    this.encryptedPassword = encryptedPassword;
    this.loadError = undefined;
    return this.snapshot();
  }
  environment(): Record<string, string> {
    if (this.loadError) throw new Error(this.loadError);
    const c = this.config;
    const env: Record<string, string> = {};
    if (c.mode === 'manual') {
      if (!c.host) throw new Error('Falta el servidor del proxy. Revisa Ajustes → Red.');
      const url = new URL(endpoint(c));
      if (c.username) {
        url.username = c.username;
        url.password = this.password();
      }
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'])
        env[key] = url.href;
      env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
    }
    if (c.caFile) {
      readCorporateCA(c.caFile);
      env.NODE_EXTRA_CA_CERTS = env.CODEX_CA_CERTIFICATE = env.SSL_CERT_FILE = c.caFile;
    }
    return env;
  }
  browserConfig() {
    if (this.loadError) throw new Error(this.loadError);
    return this.config.mode === 'manual'
      ? {
          mode: 'fixed_servers' as const,
          proxyRules: endpoint(this.config),
          proxyBypassRules: 'localhost;127.0.0.1;[::1]',
        }
      : { mode: 'system' as const };
  }
  credentials(host: string, port: number) {
    const c = this.config;
    if (
      c.mode !== 'manual' ||
      !c.username ||
      host.replace(/^\[|\]$/g, '').toLowerCase() !== c.host.replace(/^\[|\]$/g, '').toLowerCase() ||
      port !== c.port
    )
      return;
    return { username: c.username, password: this.password() };
  }
  redact(message: string) {
    let clean = message.replace(/https?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, '[proxy]@');
    try {
      const secret = this.password();
      if (secret)
        for (const value of [secret, encodeURIComponent(secret)])
          clean = clean.split(value).join('[oculto]');
    } catch {
      /* Never surface a decryption error while formatting another error. */
    }
    return clean;
  }
  async test(input: ProxyUpdate, provider: 'codex' | 'claude') {
    const { config, secret } = this.prepare(input);
    if (config.mode !== 'manual')
      throw new Error('Detecta o introduce un proxy manual para probarlo.');
    const host = provider === 'codex' ? 'chatgpt.com' : 'api.anthropic.com';
    const pem = readCorporateCA(config.caFile);
    const ca = pem ? [...tls.rootCertificates, pem] : undefined;
    return new Promise<{ ok: boolean; message: string }>((resolve) => {
      let tunnel: import('node:net').Socket | undefined;
      let secure: tls.TLSSocket | undefined;
      let settled = false;
      const finish = (ok: boolean, message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        secure?.destroy();
        tunnel?.destroy();
        req.destroy();
        resolve({ ok, message });
      };
      const req = (config.protocol === 'https' ? https : http).request({
        hostname: config.host.replace(/^\[|\]$/g, ''),
        port: config.port,
        method: 'CONNECT',
        path: `${host}:443`,
        agent: false,
        ca,
        headers: {
          Host: `${host}:443`,
          ...(config.username
            ? {
                'Proxy-Authorization': `Basic ${Buffer.from(`${config.username}:${secret}`).toString('base64')}`,
              }
            : {}),
        },
      });
      const timer = setTimeout(
        () =>
          finish(
            false,
            'El proxy no respondió en 12 segundos. Comprueba el servidor, el puerto y la conexión corporativa.',
          ),
        12000,
      );
      req.on('error', (e: NodeJS.ErrnoException) =>
        finish(
          false,
          /CERT|TLS|SSL|VERIFY/.test(e.code ?? '')
            ? 'No se pudo validar el certificado TLS. Selecciona el certificado CA corporativo.'
            : 'No se pudo conectar con el proxy. Comprueba servidor, puerto y conexión corporativa.',
        ),
      );
      req.on('connect', (res, socket, head) => {
        tunnel = socket;
        if (settled) {
          socket.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          finish(
            false,
            res.statusCode === 407
              ? 'El proxy requiere autenticación (407). Revisa usuario, contraseña y el método de autenticación admitido por TI.'
              : `El proxy rechazó la conexión (HTTP ${res.statusCode ?? 'desconocido'}).`,
          );
          return;
        }
        if (head.length) socket.unshift(head);
        secure = tls.connect({ socket, servername: host, ca, rejectUnauthorized: true });
        secure.once('secureConnect', () =>
          finish(
            true,
            `Conexión HTTPS con ${provider === 'codex' ? 'ChatGPT' : 'Claude'} validada a través del proxy. La cuenta se comprueba por separado.`,
          ),
        );
        secure.once('error', () =>
          finish(
            false,
            'El túnel se abrió, pero falló la validación TLS. Revisa el certificado CA corporativo.',
          ),
        );
      });
      req.end();
    });
  }
}
