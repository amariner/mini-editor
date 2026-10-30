import React, { useEffect, useRef, useState } from 'react';
import type { Action, ProfileDefinition, AccountState, ModelInfo } from './shared';
import { googleMigrationURL, isGoogleClientUnavailable } from './google-access';
const categories = [
  ['', 'Todos los usos'],
  ['programming', 'Programación'],
  ['science', 'Ciencia'],
  ['technology', 'Tecnología'],
  ['marketing', 'Marketing'],
  ['translation', 'Traducción'],
  ['roleplay', 'Conversación y personajes'],
  ['academia', 'Estudio'],
  ['legal', 'Legal'],
  ['finance', 'Finanzas'],
  ['health', 'Salud'],
];
const usd = (v?: number) =>
  v === undefined ? 'No disponible' : `$${v.toLocaleString('es-ES', { maximumFractionDigits: 4 })}`;
export function ProviderAccountSettings({
  profile,
  account,
  disabled,
  run,
  antigravity = false,
}: {
  profile: ProfileDefinition;
  account?: AccountState;
  disabled: boolean;
  run: (a: Action) => Promise<any>;
  antigravity?: boolean;
}) {
  const openCode = profile.kind === 'opencode';
  const providerName = openCode ? 'OpenCode' : 'OpenRouter';
  const [cloudProject, setCloudProject] = useState(profile.googleCloudProject ?? '');
  const [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState('');
  const [selection, setSelection] = useState(
    profile.modelSelection ?? { freeOnly: openCode, models: [] },
  );
  const [saved, setSaved] = useState(false),
    sequence = useRef(0);
  const selectionSignature = JSON.stringify(profile.modelSelection);
  useEffect(() => {
    setSelection(profile.modelSelection ?? { freeOnly: openCode, models: [] });
  }, [selectionSignature]);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const load = async (categoryValue = category) => {
    const id = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await run({
        type: 'providerCatalog',
        profile: profile.id,
        category: categoryValue || undefined,
      });
      if (id === sequence.current) {
        if (Array.isArray(result)) setModels(result);
        else setError('No se pudo cargar el catálogo.');
      }
    } catch (e) {
      if (id === sequence.current) setError((e as Error).message);
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  };
  if (profile.kind === 'gemini' && antigravity)
    return (
      <details className="provider-settings settings-disclosure">
        <summary>Conexión con Antigravity</summary>
        <p className="muted">
          Gemini funciona mediante Antigravity CLI. Al conectar se verifica la sesión Google de
          Antigravity en macOS; si falta el acceso, complétalo en la terminal que aparece aquí y
          escribe /exit al terminar.
        </p>
        <p className="muted">
          Una sola cuenta de Agent Desk puede vincularse a esa sesión compartida. Desvincular aquí
          no cierra sesión en Antigravity. Para cambiar de Google, usa el acceso de Antigravity y
          vuelve a verificar esta cuenta.
        </p>
        <p className="muted">
          El chat admite texto y archivos del proyecto por su ruta. Si una herramienta necesita
          permiso, el chat la rechaza: pulsa Abrir terminal Antigravity, escribe «continúa» y
          aprueba la solicitud allí. El chat no muestra solicitudes de permiso de Antigravity.
        </p>
      </details>
    );
  if (profile.kind === 'gemini')
    return (
      <div className="provider-settings">
        <p className="muted">
          Esta conexión usa Gemini CLI y depende de que Google admita tu cuenta. Google está
          derivando el acceso personal a Antigravity. Para usar esa conexión, selecciona el
          ejecutable agy en Herramientas y datos locales. Reiniciar o cambiar la contraseña no
          resuelve un rechazo por cliente no admitido.
        </p>
        {isGoogleClientUnavailable(account?.error ?? '') && (
          <button
            disabled={disabled}
            onClick={() => void run({ type: 'browserNew', url: googleMigrationURL })}
          >
            Ver guía oficial de migración a Antigravity
          </button>
        )}
        <details>
          <summary>Cuenta de empresa · Proyecto de Google Cloud</summary>
          <p className="muted">
            Solo para cuentas con acceso empresarial compatible a Gemini Code Assist. Crear un
            proyecto no restablece el acceso personal que Google haya retirado.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const ok = await run({
                  type: 'configureGoogleAccount',
                  profile: profile.id,
                  cloudProject: cloudProject.trim(),
                });
                if (ok) setSaved(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Proyecto de Google Cloud
              <input
                aria-label={`Proyecto Google Cloud de ${profile.name}`}
                value={cloudProject}
                onChange={(e) => {
                  setCloudProject(e.target.value);
                  setSaved(false);
                }}
                placeholder="mi-proyecto-google"
                disabled={disabled || busy}
              />
            </label>
            <button disabled={disabled || busy} type="submit">
              Guardar proyecto
            </button>
            {saved && <span role="status">Proyecto guardado</span>}
          </form>
        </details>
      </div>
    );
  const visible = models.filter(
    (m) =>
      (!selection.freeOnly || m.free) &&
      `${m.displayName} ${m.value}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="provider-settings">
      {openCode && (
        <p className="muted">
          Inicia sesión con tu cuenta de OpenCode en el navegador o introduce una clave API. Después
          carga el catálogo y elige los modelos para tus chats.
        </p>
      )}
      {openCode && account?.loginCode && (
        <p role="status">
          Completa el acceso en el navegador. Código: <strong>{account.loginCode}</strong>. Al
          autorizar, la cuenta se conecta automáticamente.{' '}
          <button onClick={() => void run({ type: 'accountOpenLogin', profile: profile.id })}>
            Volver a abrir el navegador
          </button>
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const ok = await run({
              type: 'connectOpenRouter',
              profile: profile.id,
              apiKey: key.trim(),
            });
            if (ok) {
              setKey('');
              await load();
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Clave API de {providerName}
          <input
            type="password"
            autoComplete="off"
            aria-label={`Clave API de ${profile.name}`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              account?.status === 'signedIn'
                ? 'Conectada · introduce otra clave para cambiarla'
                : openCode
                  ? 'Clave de OpenCode Console'
                  : 'sk-or-…'
            }
            disabled={disabled || busy}
          />
        </label>
        <button disabled={disabled || busy || !key.trim()} type="submit">
          {busy
            ? openCode
              ? 'Guardando…'
              : 'Conectando…'
            : account?.status === 'signedIn'
              ? 'Cambiar clave'
              : openCode
                ? 'Guardar clave de OpenCode'
                : `Conectar ${providerName}`}
        </button>
        <small>
          La clave se guarda cifrada con el almacén del sistema. No se incluye en las
          conversaciones.
        </small>
      </form>
      {openCode && (
        <details className="settings-disclosure provider-help">
          <summary>Sobre la conexión</summary>
          <p className="muted">
            La clave API es una alternativa al acceso por navegador. Guardarla no envía consultas;
            la autenticación de la clave se comprobará al usarla. Los tokens del navegador se
            guardan cifrados y se renuevan automáticamente.
          </p>
        </details>
      )}
      {!openCode && account?.apiUsage && (
        <p className="muted">
          Consumo de la clave: {usd(account.apiUsage.spent)} · Crédito restante de la clave:{' '}
          {usd(account.apiUsage.remaining)}
        </p>
      )}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open && !models.length && !loading) void load();
        }}
      >
        <summary>Modelos · {selection.models.length} seleccionados</summary>
        <div className="provider-model-filters">
          <label>
            <input
              type="checkbox"
              checked={selection.freeOnly}
              onChange={(e) => {
                setSelection({ ...selection, freeOnly: e.target.checked });
                setSaved(false);
              }}
            />
            Mostrar solo modelos gratuitos
          </label>
          {/* Conditional: .provider-settings label sets display, which overrides [hidden]. */}
          {!openCode && (
            <label>
              Uso
              <select
                aria-label={`Uso de los modelos de ${profile.name}`}
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  void load(e.target.value);
                }}
              >
                {categories.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <input
            aria-label={`Buscar modelos de ${profile.name}`}
            placeholder="Buscar modelo…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button disabled={disabled || loading} onClick={() => void load()}>
            Actualizar catálogo
          </button>
        </div>
        <p className="muted">
          {openCode
            ? 'Catálogo de tu cuenta desde OpenCode Console; Models.dev se utiliza solo cuando Console no ofrece catálogo. Se muestran los modelos compatibles con Chat Completions; otros protocolos todavía no están incluidos. El chat usa el cliente oficial de OpenCode mediante ACP, con permisos dentro de Agent Desk. Se aplican los límites de tu cuenta y de cada promoción. PDF no admitido; usa texto o archivos del proyecto.'
            : 'El filtro de uso viene del catálogo de OpenRouter.'}{' '}
          «Herramientas» indica si puede actuar sobre el proyecto. Los precios son por millón de
          tokens de entrada / salida.
        </p>
        {loading ? (
          <p role="status">Cargando modelos…</p>
        ) : (
          <div className="provider-model-list">
            {visible.map((m) => (
              <label key={m.value} className="provider-model-row">
                <input
                  type="checkbox"
                  checked={selection.models.includes(m.value)}
                  disabled={disabled || busy}
                  onChange={(e) => {
                    setSaved(false);
                    setSelection({
                      ...selection,
                      models: e.target.checked
                        ? [...selection.models, m.value]
                        : selection.models.filter((v) => v !== m.value),
                    });
                  }}
                />
                <span>
                  <strong>{m.displayName}</strong>
                  <small>{m.value}</small>
                  <small>
                    {m.free
                      ? 'Gratis'
                      : `${usd(m.inputPrice === undefined ? undefined : m.inputPrice * 1e6)} / ${usd(m.outputPrice === undefined ? undefined : m.outputPrice * 1e6)}`}{' '}
                    · {m.tools ? 'Herramientas' : 'Solo conversación'}
                    {m.image ? ' · Visión' : ''}
                    {category ? ` · ${categories.find((c) => c[0] === category)?.[1]}` : ''}
                  </small>
                  <span className="provider-model-description">{m.description}</span>
                </span>
              </label>
            ))}
            {!visible.length && <p>No hay modelos para estos filtros.</p>}
          </div>
        )}
        <div className="account-actions">
          <button
            disabled={disabled || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const ok = await run({
                  type: 'selectProviderModels',
                  profile: profile.id,
                  selection,
                });
                if (ok) setSaved(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Guardar selección
          </button>
          <span role="status">
            {saved ? 'Selección guardada' : `${selection.models.length} seleccionados`}
          </span>
        </div>
        <p className="muted">
          Al activar «Solo gratuitos», los modelos de pago seleccionados quedan fuera del chat.
          Desactívalo para volver a utilizarlos.
        </p>
      </details>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
