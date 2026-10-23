import React, { useEffect, useRef, useState } from 'react';
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
  const [activeAction, setActiveAction] = useState<Action['type']>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false);
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
  useEffect(() => {
    if (cancelling && !activeAction && state && !state.busy) {
      setNotice('Descarga cancelada.');
      setCancelling(false);
      cancelRequested.current = false;
    }
  }, [cancelling, activeAction, state]);
  const act = async (action: Action) => {
    setActiveAction(action.type);
    setError('');
    setNotice('');
    cancelRequested.current = false;
    try {
      await run(action);
      if (action.type === 'localInstall') setNotice('Motor instalado. Listo para usar.');
      if (action.type === 'localDownload') setNotice('Modelo descargado. Listo para usar.');
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (cancelRequested.current && /abort|cancel/i.test(message))
        setNotice('Descarga cancelada.');
      else setError(message);
      // Clear the last progress state after a failure without replacing its useful error.
      await refresh().catch(() => {});
    } finally {
      setActiveAction(undefined);
      setCancelling(false);
      cancelRequested.current = false;
    }
  };
  const cancelDownload = async () => {
    cancelRequested.current = true;
    setCancelling(true);
    setError('');
    try {
      await run({ type: 'localCancel', profile: profile.id });
      if (!activeAction) await refresh();
    } catch (e) {
      cancelRequested.current = false;
      setCancelling(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const busy = !!activeAction || !!state?.busy;
  const blocked = disabled || busy;
  const installing = activeAction === 'localInstall' || !!state?.busy?.includes('motor');
  const downloading =
    installing || activeAction === 'localDownload' || !!state?.busy?.startsWith('Descargando');
  const stage = cancelling
    ? 'Cancelando descarga…'
    : (state?.busy ?? (downloading ? 'Preparando descarga…' : 'Actualizando…'));
  const downloaded = state?.busy ? state.downloaded : 0;
  const total = state?.busy ? state.total : undefined;
  const progress = total ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;
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
      <div className="local-engine-download">
        {(!state?.engine || installing) && (
          <button
            className="local-engine-button"
            disabled={blocked}
            aria-busy={installing}
            onClick={() => void act({ type: 'localInstall', profile: profile.id })}
          >
            {installing && <span className="local-download-spinner" aria-hidden="true" />}
            {installing ? stage : 'Descargar motor local'}
          </button>
        )}
        <div className="local-download-feedback" role="status" aria-live="polite">
          {busy ? (
            <>
              <div className="local-download-status">
                <span>
                  {!installing && <span className="local-download-spinner" aria-hidden="true" />}
                  {installing ? 'Instalando motor local' : stage}
                </span>
                {downloading && (
                  <button disabled={cancelling} onClick={() => void cancelDownload()}>
                    {cancelling ? 'Cancelando…' : 'Cancelar'}
                  </button>
                )}
              </div>
              {downloading && (
                <>
                  <progress max={100} value={progress} aria-label="Progreso de la descarga" />
                  <span className="local-download-size">
                    {downloaded > 0
                      ? `${(downloaded / 1e6).toFixed(1)} MB${total ? ` de ${(total / 1e6).toFixed(1)} MB · ${progress}%` : ''}`
                      : 'Conectando con el servidor…'}
                  </span>
                </>
              )}
            </>
          ) : notice ? (
            <span>{notice}</span>
          ) : null}
        </div>
        {error && (
          <p className="account-error local-download-error" role="alert">
            {error}
          </p>
        )}
      </div>
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
    </div>
  );
}
