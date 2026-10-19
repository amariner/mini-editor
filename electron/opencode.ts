import fs from 'node:fs/promises';
import path from 'node:path';
import type { Profile, ModelInfo, ApiUsage } from '../src/shared';
import { profileDirectory } from './core';
import { OpenRouterService, routerError } from './openrouter';
import {
  beginDevice,
  pollDevice,
  refreshCredential,
  oauthSchema,
  consoleURL,
  type DeviceAttempt,
  type OpenCodeCredential,
} from './opencode-auth';

export const freeDeepSeek = 'deepseek-v4.1-flash-free';
const compatible = '@ai-sdk/openai-compatible';
const baseURL = 'https://opencode.ai/inference/openai/v1';
type Catalog = {
  at: number;
  models: ModelInfo[];
  routes: Map<string, { url: string; model: string }>;
};
const numeric = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
function safeInferenceURL(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    // Only OpenCode's OpenAI-compatible inference routes can receive credentials.
    if (
      url.origin !== 'https://opencode.ai' ||
      !/^\/inference\/(?:[a-z0-9-]+\/)*openai\/v1\/?$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href.replace(/\/$/, '') + '/chat/completions';
  } catch {
    return undefined;
  }
}
export function openCodeModels(data: any, config?: any): Catalog {
  const provider =
    data?.opencode ??
    (config?.providers ? { npm: compatible, api: baseURL, models: {} } : undefined);
  if (!provider?.models || typeof provider.models !== 'object')
    throw new Error('OpenCode: catálogo de modelos no válido.');
  const routes: Catalog['routes'] = new Map();
  const models: ModelInfo[] = [];
  const providers =
    config?.providers && Object.keys(config.providers).length
      ? Object.entries(config.providers)
      : [['opencode', undefined]];
  for (const [providerID, raw] of providers) {
    const overlay = raw as any;
    const canonical = data?.[overlay?.canonical ?? providerID] ?? provider;
    const available = overlay?.models ?? canonical.models;
    for (const [id, item] of Object.entries(available ?? {})) {
      const m: any = item;
      if (!m || m.disabled || m.status === 'deprecated') continue;
      const original = canonical.models?.[m.modelID ?? id] ?? canonical.models?.[id] ?? {};
      const pkg = (
        m.package ??
        overlay?.package ??
        original.provider?.npm ??
        canonical.npm
      )?.replace(/^aisdk:/, '');
      const url = safeInferenceURL(
        m.settings?.baseURL ??
          overlay?.settings?.baseURL ??
          original.provider?.api ??
          canonical.api ??
          baseURL,
      );
      if (pkg !== compatible || !url) continue;
      if (m.modalities?.output && !m.modalities.output.includes('text')) continue;
      const costs = Array.isArray(m.cost)
        ? m.cost
        : m.cost
          ? [m.cost]
          : original.cost
            ? [original.cost]
            : [];
      const input = costs.length
        ? Math.max(...costs.map((c: any) => numeric(c.input) ?? Infinity))
        : undefined;
      const output = costs.length
        ? Math.max(...costs.map((c: any) => numeric(c.output) ?? Infinity))
        : undefined;
      const value = providerID === 'opencode' ? id : `${providerID}/${id}`;
      routes.set(value, { url, model: m.modelID ?? id });
      models.push({
        value,
        displayName: m.name ?? original.name ?? id,
        description: m.description ?? original.description ?? '',
        inputPrice: input !== undefined && Number.isFinite(input) ? input / 1e6 : undefined,
        outputPrice: output !== undefined && Number.isFinite(output) ? output / 1e6 : undefined,
        free:
          costs.length > 0 &&
          costs.every(
            (c: any) =>
              numeric(c.input) === 0 &&
              numeric(c.output) === 0 &&
              Object.values(c.cache ?? {}).every((v) => numeric(v) === 0) &&
              ['cache_read', 'cache_write'].every((k) => c[k] === undefined || numeric(c[k]) === 0),
          ),
        tools: m.capabilities?.tools ?? m.tool_call ?? original.tool_call ?? false,
        image:
          m.capabilities?.input?.includes('image') ??
          m.modalities?.input?.includes('image') ??
          original.modalities?.input?.includes('image') ??
          false,
        contextLength: numeric(m.limit?.context ?? original.limit?.context),
        categories: ['programming'],
      });
    }
  }
  if (!models.length)
    throw new Error('OpenCode no ofrece modelos compatibles con este chat para la cuenta.');
  return { at: Date.now(), models, routes };
}
export class OpenCodeService extends OpenRouterService {
  override readonly name = 'OpenCode';
  private catalogs = new Map<Profile, Catalog>();
  private catalogJobs = new Map<Profile, Promise<ModelInfo[]>>();
  private generations = new Map<Profile, number>();
  private invalidate(profile: Profile) {
    this.generations.set(profile, (this.generations.get(profile) ?? 0) + 1);
    this.catalogs.delete(profile);
    this.catalogJobs.delete(profile);
  }
  private identities = new Map<string, { profile: Profile; orgID?: string }>();
  private refreshing = new Map<Profile, Promise<string>>();
  protected override file(profile: Profile) {
    if (!profile.startsWith('opencode-')) throw new Error('Esta cuenta no es de OpenCode.');
    return path.join(profileDirectory(this.root, profile), 'api-key.enc');
  }
  private async save(profile: Profile, value: string, signal?: AbortSignal, replace = true) {
    const file = this.file(profile);
    if (!this.services.codec?.available())
      throw new Error('No se puede guardar el acceso sin el almacén seguro del sistema.');
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(file + '.tmp', this.services.codec.encrypt(value), { mode: 0o600 });
      signal?.throwIfAborted();
      await fs.rename(file + '.tmp', file);
    } finally {
      await fs.rm(file + '.tmp', { force: true });
    }
    if (replace) this.invalidate(profile);
    for (const [key, identity] of this.identities)
      if (identity.profile === profile) this.identities.delete(key);
  }
  override async connect(profile: Profile, key: string): Promise<ApiUsage> {
    if (!key.trim() || /[\r\n]/.test(key)) throw new Error('Introduce una clave API válida.');
    await this.save(profile, key.trim());
    return { checkedAt: Date.now() };
  }
  private async credential(profile: Profile) {
    const raw = await super.key(profile);
    if (!raw?.startsWith('{')) return { raw };
    try {
      return { oauth: oauthSchema.parse(JSON.parse(raw)) };
    } catch {
      throw new Error('El acceso guardado de OpenCode no es válido. Inicia sesión otra vez.');
    }
  }
  override async key(profile: Profile): Promise<string | undefined> {
    const pending = this.refreshing.get(profile);
    if (pending) return pending;
    const credential = await this.credential(profile);
    if (!credential.oauth) {
      if (credential.raw) this.identities.set(credential.raw, { profile });
      return credential.raw;
    }
    let oauth = credential.oauth;
    if (oauth.expires <= Date.now() + 60_000) {
      // Serialize refresh-token rotation per account.
      const existing = this.refreshing.get(profile);
      if (existing) return existing;
      const work = (async () => {
        oauth = await refreshCredential(this.consoleJSON, oauth);
        await this.save(profile, JSON.stringify(oauth), undefined, false);
        this.identities.set(oauth.access, { profile, orgID: oauth.orgID });
        return oauth.access;
      })();
      this.refreshing.set(profile, work);
      try {
        return await work;
      } finally {
        this.refreshing.delete(profile);
      }
    }
    this.identities.set(oauth.access, { profile, orgID: oauth.orgID });
    return oauth.access;
  }
  consoleJSON = async (
    route: string,
    body?: object,
    signal?: AbortSignal,
    token?: string,
    orgID?: string,
  ) => {
    const response = await (this.services.fetch ?? fetch)(consoleURL + route, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'agent-desk/0.1.0',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(orgID ? { 'x-org-id': orgID } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (route === '/api/v2/config' && response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    // Device polling uses expected 400 authorization_pending / slow_down responses.
    if (!response.ok && !(route === '/auth/device/token' && response.status === 400)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `OpenCode (${response.status}): ${response.status === 429 ? 'Demasiados intentos. Espera antes de volver a iniciar sesión.' : response.status === 401 ? 'El acceso ha caducado. Inicia sesión otra vez.' : response.status === 403 ? 'La cuenta requiere autorización adicional en OpenCode Console.' : 'No se pudo completar la conexión con Console.'}`,
      );
    }
    return response.json();
  };
  async beginLogin(profile: Profile, signal?: AbortSignal) {
    this.file(profile);
    if (!this.services.codec?.available())
      throw new Error('El almacén seguro del sistema no está disponible.');
    return beginDevice(this.consoleJSON, signal);
  }
  async completeLogin(profile: Profile, attempt: DeviceAttempt, signal: AbortSignal) {
    const credential = await pollDevice(this.consoleJSON, attempt, signal);
    await this.save(profile, JSON.stringify(credential), signal);
    return credential;
  }
  override async disconnect(profile: Profile) {
    await this.refreshing.get(profile)?.catch(() => {});
    await super.disconnect(profile);
    this.invalidate(profile);
    for (const [key, identity] of this.identities)
      if (identity.profile === profile) this.identities.delete(key);
  }
  override async request(route: string, key: string | undefined, init: RequestInit = {}) {
    if (route !== '/chat/completions' || init.method !== 'POST')
      throw new Error('Ruta de OpenCode no admitida.');
    const payload = JSON.parse(String(init.body));
    const identity = key ? this.identities.get(key) : undefined;
    const target = identity && this.catalogs.get(identity.profile)?.routes.get(payload.model);
    if (!target)
      throw new Error('Actualiza el catálogo y selecciona un modelo compatible de OpenCode.');
    const response = await (this.services.fetch ?? fetch)(target.url, {
      ...init,
      body: JSON.stringify({ ...payload, model: target.model }),
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(30_000),
      redirect: 'error',
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        'Content-Type': 'application/json',
        'User-Agent': 'agent-desk/0.1.0',
        Authorization: `Bearer ${key}`,
        ...(identity.orgID ? { 'x-org-id': identity.orgID } : {}),
      },
    });
    if (!response.ok) {
      // Classify a known restriction without displaying raw provider bodies, prompts or tokens.
      let officialClientOnly = false;
      if (response.status === 403) {
        const diagnostic = await response.json().catch(() => undefined);
        officialClientOnly =
          diagnostic?.error?.type === 'FreeTierError' || diagnostic?._tag === 'FreeTierError';
      }
      await response.body?.cancel().catch(() => {});
      if (officialClientOnly)
        throw new Error(
          'OpenCode restringe este modelo gratuito a su cliente oficial. El acceso por navegador está conectado, pero no habilita esta promoción en Agent Desk. Usa el cliente oficial de OpenCode o selecciona un modelo permitido por tu cuenta. No se ha cambiado a ningún modelo de pago.',
        );
      throw new Error(
        routerError(undefined, response.status).message.replace('OpenRouter', this.name),
      );
    }
    return response;
  }
  override async catalog(profile: Profile, signal?: AbortSignal): Promise<ModelInfo[]> {
    this.file(profile);
    signal?.throwIfAborted();
    const previous = this.catalogs.get(profile);
    if (previous && Date.now() - previous.at < 60_000) return previous.models;
    let work = this.catalogJobs.get(profile);
    if (!work) {
      const generation = this.generations.get(profile) ?? 0;
      work = this.loadCatalog(profile, generation);
      this.catalogJobs.set(profile, work);
      void work
        .finally(() => {
          if (this.catalogJobs.get(profile) === work) this.catalogJobs.delete(profile);
        })
        .catch(() => {});
    }
    // Each caller can cancel its wait without aborting another chat's shared catalog load.
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      work!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private async loadCatalog(profile: Profile, generation: number): Promise<ModelInfo[]> {
    try {
      const token = await this.key(profile);
      const identity = token ? this.identities.get(token) : undefined;
      // Console supplies names, costs, limits, capabilities and routing. Do not depend on
      // an unrelated download when the authenticated catalog is already complete.
      const config = token
        ? await this.consoleJSON('/api/v2/config', undefined, undefined, token, identity?.orgID)
        : undefined;
      if (config?.policies?.length || config?.experimental?.policies?.length)
        throw new Error(
          'Esta organización tiene políticas administradas. Utiliza el cliente oficial de OpenCode para aplicarlas.',
        );
      let data: any;
      if (!config?.providers || !Object.keys(config.providers).length) {
        const response = await (this.services.fetch ?? fetch)('https://models.dev/api.json', {
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('No se pudo cargar el catálogo público de OpenCode.');
        data = await response.json();
      }
      const catalog = openCodeModels(data, config);
      if ((this.generations.get(profile) ?? 0) !== generation)
        throw new Error('La cuenta de OpenCode ha cambiado. Vuelve a cargar los modelos.');
      this.catalogs.set(profile, catalog);
      return catalog.models;
    } catch (error) {
      if ((error as Error).name === 'TimeoutError')
        throw new Error(
          'OpenCode tardó demasiado en devolver el catálogo. Pulsa Actualizar catálogo para reintentar.',
        );
      throw error;
    }
  }
  async summary(profile: Profile) {
    const credential = await this.credential(profile);
    return credential.oauth
      ? { label: credential.oauth.email ?? 'OpenCode', plan: credential.oauth.orgName ?? 'Console' }
      : { label: 'OpenCode', plan: 'API' };
  }
  override async usage(profile: Profile): Promise<ApiUsage | undefined> {
    return (await this.key(profile)) ? { checkedAt: Date.now() } : undefined;
  }
}
