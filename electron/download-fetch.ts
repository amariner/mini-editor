import { net } from 'electron';
import type { ProxySettings } from './proxy';

const proxyAuthError =
  'El proxy requiere autenticación (407). Revisa el usuario y la contraseña en Ajustes → Red y vuelve a descargar.';

function downloadUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('La descarga requiere un enlace HTTPS sin credenciales.');
  return url.href;
}

function downloadError(error: Error) {
  if (/ERR_(PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/.test(error.message))
    return new Error(
      'No se pudo conectar con el proxy configurado. Revisa el servidor y el puerto en Ajustes → Red y la conexión a la red corporativa o VPN.',
    );
  if (/ERR_(PROXY_AUTH|INVALID_AUTH_CREDENTIALS)/.test(error.message))
    return new Error(proxyAuthError);
  if (/ERR_CERT_|ERR_SSL_/.test(error.message))
    return new Error(
      'No se pudo validar la conexión segura de descarga. Comprueba que macOS confía en el certificado de la red corporativa.',
    );
  return error;
}

/**
 * Public files through Chromium's configured proxy, including proxy authentication.
 * Use a dedicated, nonpersistent session so browser/provider origin-auth caches stay isolated.
 */
export async function downloadFetch(
  session: Electron.Session,
  network: Pick<ProxySettings, 'credentials'>,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  init.signal?.throwIfAborted();
  url = downloadUrl(url);
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) || init.body != null)
    throw new Error('Las descargas solo admiten peticiones GET o HEAD sin cuerpo.');
  const headers = new Headers(init.headers);
  // These downloads are public. Proxy secrets are supplied only to a matching proxy challenge.
  for (const header of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(header);

  return new Promise((resolve, reject) => {
    const request = net.request({
      url,
      session,
      method,
      redirect: 'manual',
      // credentials: 'omit' also suppresses proxy login; disable cookies independently.
      useSessionCookies: false,
      headers: Object.fromEntries(headers),
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let authAttempts = 0;
    let redirects = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      controller?.error(error);
      reject(error);
      request.abort();
    };
    const touch = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () =>
          fail(
            new Error(
              'La descarga lleva 45 segundos sin recibir datos. Revisa la conexión y los ajustes de red e inténtalo de nuevo.',
            ),
          ),
        45_000,
      );
      timeout.unref();
    };
    const abort = () =>
      fail(init.signal?.reason ?? new DOMException('Descarga cancelada', 'AbortError'));
    request.on('login', (auth, callback) => {
      if (!auth.isProxy) return callback();
      try {
        const credentials = network.credentials(auth.host, auth.port);
        if (credentials && ++authAttempts <= 2)
          return callback(credentials.username, credentials.password);
        callback();
        fail(new Error(proxyAuthError));
      } catch (error) {
        callback();
        fail(error as Error);
      }
    });
    request.on('redirect', (_status, _method, target) => {
      if (finished) return;
      try {
        downloadUrl(target);
        if (init.redirect === 'error' || ++redirects > 10)
          throw new Error('La descarga contiene demasiadas redirecciones o no las permite.');
        touch();
        request.followRedirect();
      } catch (error) {
        fail(error as Error);
      }
    });
    request.on('error', (error) => fail(downloadError(error)));
    request.on('response', (response) => {
      if (finished) return;
      if (response.statusCode === 407) return fail(new Error(proxyAuthError));
      const headers = new Headers();
      for (const [name, values] of Object.entries(response.headers))
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
      // Electron's generated types omit the inherited Node Readable methods.
      const source = response as Electron.IncomingMessage & import('node:stream').Readable;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          response.on('end', () => {
            if (finished) return;
            finished = true;
            cleanup();
            value.close();
          });
          response.on('error', (error) => fail(downloadError(error)));
          response.on('aborted', () => fail(new Error('El servidor interrumpió la descarga.')));
          response.on('data', (chunk) => {
            if (finished) return;
            value.enqueue(new Uint8Array(chunk));
            touch();
            // Model files can be many GB: let the disk consumer control buffering.
            if ((value.desiredSize ?? 0) <= 0) {
              source.pause();
              clearTimeout(timeout);
            }
          });
        },
        pull() {
          if (finished) return;
          touch();
          source.resume();
        },
        cancel() {
          finished = true;
          cleanup();
          request.abort();
        },
      });
      const noBody = method === 'HEAD' || [204, 205, 304].includes(response.statusCode);
      resolve(new Response(noBody ? null : body, { status: response.statusCode, headers }));
      if (noBody) void body.cancel();
    });
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) return abort();
    touch();
    request.end();
  });
}
