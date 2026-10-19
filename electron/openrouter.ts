import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelInfo, Profile, ApiUsage } from '../src/shared';
import type { SecretCodec } from './proxy';
import { profileDirectory } from './core';
export interface ProviderServices {
  fetch?: typeof fetch;
  codec?: SecretCodec;
}
const endpoint = 'https://openrouter.ai/api/v1';
/** Classify upstream diagnostics without displaying prompts, keys or raw provider bodies. */
export function routerError(error: any, status?: number) {
  const code = Number(error?.code ?? status);
  const label = Number.isInteger(code) && code >= 100 && code <= 599 ? ` (${code})` : '';
  const hints: Record<number, string> = {
    401: 'Clave API no válida.',
    402: 'No hay crédito suficiente.',
    403: 'Acceso denegado por el proveedor.',
    407: 'El proxy requiere autenticación. Revisa el usuario y la contraseña en Ajustes → Red.',
    408: 'El proveedor agotó el tiempo de espera. Reintenta la respuesta.',
    429: 'El modelo ha alcanzado su límite de solicitudes o capacidad. Espera o selecciona otro modelo.',
    502: 'El proveedor del modelo falló durante la respuesta. Reintenta o selecciona otro modelo.',
    503: 'El modelo no está disponible ahora. Reintenta o selecciona otro modelo.',
  };
  const detail = typeof error?.message === 'string' ? error.message : '';
  const specific = /context.{0,30}(length|limit)|too many tokens/i.test(detail)
    ? 'El historial supera el contexto del modelo. Abre un chat nuevo o elige un modelo con más contexto.'
    : /tool.{0,50}(invalid|malformed|parse)|(?:invalid|malformed|parse).{0,50}(tool|function)/i.test(
          detail,
        )
      ? 'El proveedor devolvió una llamada a herramienta no válida. Reintenta o selecciona otro modelo con herramientas.'
      : undefined;
  return new Error(
    `OpenRouter${label}: ${specific ?? hints[code] ?? 'El proveedor interrumpió la respuesta sin un diagnóstico reconocido. Reintenta o selecciona otro modelo.'}`,
  );
}
const number = (v: unknown) =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0
    ? Number(v)
    : undefined;
export function routerModels(data: any, category?: string): ModelInfo[] {
  if (!Array.isArray(data?.data)) throw new Error('OpenRouter no devolvió un catálogo válido.');
  return data.data
    .filter(
      (m: any) =>
        typeof m.id === 'string' &&
        (!m.architecture?.output_modalities || m.architecture.output_modalities.includes('text')),
    )
    .map((m: any) => {
      const inputPrice = number(m.pricing?.prompt),
        outputPrice = number(m.pricing?.completion);
      return {
        value: m.id,
        displayName: m.name || m.id,
        description: m.description || '',
        inputPrice,
        outputPrice,
        free:
          inputPrice === 0 &&
          outputPrice === 0 &&
          Object.values(m.pricing ?? {}).every((v) => number(v) === 0),
        tools: m.supported_parameters?.includes('tools') ?? false,
        image: m.architecture?.input_modalities?.includes('image') ?? false,
        contextLength: number(m.context_length),
        categories: [
          ...(category ? [category] : []),
          ...(m.architecture?.input_modalities?.includes('image') ? ['vision'] : []),
          ...(m.supported_parameters?.includes('reasoning') ? ['reasoning'] : []),
        ],
      };
    });
}
export function routerUsage(data: any): ApiUsage {
  if (!data?.data || typeof data.data !== 'object')
    throw new Error('OpenRouter no devolvió el estado de la clave.');
  return {
    spent: number(data.data.usage),
    remaining: number(data.data.limit_remaining),
    limit: number(data.data.limit),
    checkedAt: Date.now(),
  };
}
export class OpenRouterService {
  readonly name: string = 'OpenRouter';
  constructor(
    protected root: string,
    readonly services: ProviderServices = {},
  ) {}
  protected file(profile: Profile) {
    if (!profile.startsWith('openrouter-')) throw new Error('Esta cuenta no es de OpenRouter.');
    return path.join(profileDirectory(this.root, profile), 'api-key.enc');
  }
  async key(profile: Profile) {
    const file = this.file(profile);
    let data: Buffer;
    try {
      data = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    if (!this.services.codec?.available())
      throw new Error('El almacén seguro del sistema no está disponible.');
    return this.services.codec.decrypt(data);
  }
  async connect(profile: Profile, key: string) {
    const file = this.file(profile);
    if (!this.services.codec?.available())
      throw new Error('No se puede guardar la clave sin el almacén seguro del sistema.');
    const usage = routerUsage(await this.json('/key', key));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file + '.tmp', this.services.codec.encrypt(key), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
    return usage;
  }
  async disconnect(profile: Profile) {
    await fs.rm(this.file(profile), { force: true });
  }
  async request(route: string, key: string | undefined, init: RequestInit = {}) {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(300_000)])
      : AbortSignal.timeout(30_000);
    const response = await (this.services.fetch ?? fetch)(endpoint + route, {
      ...init,
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Title': 'Agent Desk',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });
    if (!response.ok) {
      // Never echo server bodies, which can contain credentials or a submitted prompt.
      await response.body?.cancel().catch(() => {});
      throw routerError(undefined, response.status);
    }
    return response;
  }
  async json(route: string, key?: string, signal?: AbortSignal) {
    return (await this.request(route, key, { signal })).json();
  }
  async catalog(profile: Profile, signal?: AbortSignal, category?: string) {
    return routerModels(
      await this.json(
        '/models' + (category ? `?category=${encodeURIComponent(category)}` : ''),
        await this.key(profile),
        signal,
      ),
      category,
    );
  }
  async usage(profile: Profile) {
    const key = await this.key(profile);
    return key ? routerUsage(await this.json('/key', key)) : undefined;
  }
}
/** SSE framing independent of HTTP chunk boundaries, CRLF and keepalive comments. */
export async function* routerStream(body: ReadableStream<Uint8Array>, name = 'OpenRouter') {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    lines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
        if (!line && lines.length) {
          const data = lines.join('\n');
          lines = [];
          if (data === '[DONE]') return;
          const chunk = JSON.parse(data);
          if (chunk.error)
            throw new Error(routerError(chunk.error).message.replace('OpenRouter', name));
          yield chunk;
        }
      }
      if (done) throw new Error(`${name} cerró la conexión antes de completar la respuesta.`);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
