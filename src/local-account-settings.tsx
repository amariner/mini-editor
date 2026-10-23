import React, { useEffect, useState } from 'react';
import type { Action, ModelInfo, ProfileDefinition } from './shared';
import type { LocalState } from '../electron/local';
const suggested =
  'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf';
export function LocalAccountSettings({
  profile,
  run,
  disabled,
}: {
  profile: ProfileDefinition;
  run: (action: Action) => Promise<any>;
  disabled: boolean;
}) {
  const [state, setState] = useState<LocalState>();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const refresh = async () => {
    const [status, catalog] = await Promise.all([
      run({ type: 'localStatus', profile: profile.id }),
      run({ type: 'providerCatalog', profile: profile.id }),
    ]);
    setState(status);
    if (Array.isArray(catalog)) setModels(catalog);
  };
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const status = await run({ type: 'localStatus', profile: profile.id });
        if (!disposed) setState(status);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void refresh().catch((e) => {
      if (!disposed) setError(e.message);
    });
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [profile.id]);
  const act = async (action: Action) => {
    setBusy(true);
    setError('');
    try {
      await run(action);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const blocked = disabled || busy || !!state?.busy;
  return (
    <div className="provider-settings local-settings">
      <p>
        Ejecuta modelos GGUF en este ordenador, sin cuenta ni Ollama. Agent Desk gestiona el motor
        llama.cpp.
      </p>
      <label>Carpeta de modelos</label>
      <p className="muted" style={{ overflowWrap: 'anywhere' }}>
        {state?.directory ?? 'Selecciona dónde guardar tus modelos.'}
      </p>
      <p className="muted">Detecta los GGUF de esta carpeta y sus subcarpetas sin copiarlos.</p>
      <div className="account-actions">
        <button
          disabled={blocked}
          onClick={() => void act({ type: 'localFolder', profile: profile.id })}
        >
          Seleccionar carpeta
        </button>
        <button
          disabled={blocked || !state?.directory}
          onClick={() => void act({ type: 'localImport', profile: profile.id })}
        >
          Importar GGUF
        </button>
        <button disabled={blocked} onClick={() => void refresh().catch((e) => setError(e.message))}>
          Actualizar modelos
        </button>
      </div>
      <p className="muted">
        {state?.engine
          ? 'Motor instalado · llama.cpp'
          : 'El motor se descarga una vez; los modelos se descargan por separado.'}
      </p>
      {!state?.engine && (
        <button
          disabled={blocked}
          onClick={() => void act({ type: 'localInstall', profile: profile.id })}
        >
          Descargar motor local
        </button>
      )}
      <label>
        Descargar modelo desde Hugging Face
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://huggingface.co/…/resolve/main/modelo.gguf"
          disabled={blocked}
        />
      </label>
      <div className="account-actions">
        <button
          disabled={blocked || !state?.directory || !url.trim()}
          onClick={() => void act({ type: 'localDownload', profile: profile.id, url: url.trim() })}
        >
          Descargar en la carpeta elegida
        </button>
        <button disabled={blocked} onClick={() => setUrl(suggested)}>
          Usar enlace de Qwen 3.5 9B
        </button>
      </div>
      <p className="muted">
        La descarga puede ocupar varios GB. Puedes usar cualquier GGUF de texto compatible con esta
        versión de llama.cpp. Las imágenes necesitan una integración adicional.
      </p>
      {(busy || state?.busy) && (
        <div role="status">
          {state?.busy ?? 'Preparando…'}{' '}
          {state?.downloaded
            ? `· ${(state.downloaded / 1e6).toFixed(0)} MB${state.total ? ` / ${(state.total / 1e6).toFixed(0)} MB` : ''}`
            : ''}
          <button onClick={() => void run({ type: 'localCancel', profile: profile.id })}>
            Cancelar descarga
          </button>
        </div>
      )}
      <label>
        Modelo predeterminado
        <select
          aria-label="Modelo local predeterminado"
          value={state?.defaultModel ?? ''}
          disabled={blocked}
          onChange={(e) => {
            const defaultModel = e.target.value;
            setState((previous) => (previous ? { ...previous, defaultModel } : previous));
            void act({
              type: 'localConfigure',
              profile: profile.id,
              context: state?.context ?? 8192,
              tools: state?.tools ?? false,
              defaultModel,
            });
          }}
        >
          <option value="">Primer modelo disponible</option>
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Memoria del contexto
        <select
          aria-label="Precisión de la caché de contexto"
          value={state?.cacheType ?? 'q8_0'}
          disabled={blocked}
          onChange={(e) => {
            const cacheType = e.target.value as 'q8_0' | 'q4_0';
            setState((previous) => (previous ? { ...previous, cacheType } : previous));
            void act({
              type: 'localConfigure',
              profile: profile.id,
              context: state?.context ?? 8192,
              tools: state?.tools ?? false,
              cacheType,
            });
          }}
        >
          <option value="q8_0">8 bits · Mayor fidelidad</option>
          <option value="q4_0">4 bits · Menos memoria, puede reducir precisión</option>
        </select>
      </label>
      <label>
        Contexto
        <select
          aria-label="Contexto del modelo local"
          value={state?.context ?? 8192}
          disabled={blocked}
          onChange={(e) => {
            const context = Number(e.target.value);
            setState((previous) => (previous ? { ...previous, context } : previous));
            void act({
              type: 'localConfigure',
              profile: profile.id,
              context,
              tools: state?.tools ?? false,
            });
          }}
        >
          {[2048, 4096, 8192, 16384, 32768, 65536, 131072].map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString('es-ES')} tokens
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        64K y 128K son opciones avanzadas: su viabilidad depende del modelo y de la memoria que
        utilicen otras aplicaciones. La precisión de la caché permite ajustar memoria y fidelidad.
        Las respuestas admiten hasta {state?.outputLimit ?? 2048} tokens, dentro del contexto total,
        que incluye historial, archivos y resultados de herramientas.
      </p>
      <label>
        <input
          type="checkbox"
          checked={state?.tools ?? false}
          disabled={blocked}
          onChange={(e) => {
            const tools = e.target.checked;
            setState((previous) => (previous ? { ...previous, tools } : previous));
            void act({
              type: 'localConfigure',
              profile: profile.id,
              context: state?.context ?? 8192,
              tools,
            });
          }}
        />{' '}
        Permitir herramientas del proyecto
      </label>
      <p className="muted">
        Actívalas solo para modelos con llamadas a herramientas. Se conservan los permisos del chat.
        Una generación local simultánea; el modelo se libera tras cinco minutos de inactividad.
      </p>
      {state?.running && (
        <div>
          <p>
            En memoria: {state.running} · {state.runningContext?.toLocaleString('es-ES')} tokens de
            contexto
          </p>
          <button
            disabled={blocked}
            onClick={() => void act({ type: 'localUnload', profile: profile.id })}
          >
            Liberar memoria
          </button>
        </div>
      )}
      <p>
        {models.length
          ? `${models.length} modelo(s) disponible(s) al iniciar un chat:`
          : 'No hay modelos GGUF compatibles en esta carpeta ni en sus subcarpetas.'}
      </p>
      <ul>
        {models.map((m) => (
          <li key={m.value}>
            <span style={{ overflowWrap: 'anywhere' }}>{m.displayName}</span>{' '}
            <button
              disabled={blocked}
              aria-label={`Mover ${m.displayName} a la papelera`}
              onClick={() => void act({ type: 'localDelete', profile: profile.id, model: m.value })}
            >
              Mover a la papelera
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
