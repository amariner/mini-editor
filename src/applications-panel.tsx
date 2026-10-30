import React, { useEffect, useRef, useState } from 'react';
import { AppWindow, Download, FolderOpen, RefreshCw, Search, Terminal } from 'lucide-react';
import { actionError } from './runtime';
import type { ApplicationAction, ApplicationSnapshot } from './applications-types';
import './applications.css';

export function ApplicationsPanel({
  snapshot,
  compatible,
  run,
}: {
  snapshot?: ApplicationSnapshot;
  compatible: boolean;
  run: (action: ApplicationAction) => Promise<any>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'app' | 'cli'>('all');
  const [pending, setPending] = useState<string>();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const initialRefresh = useRef(false);
  const inFlight = useRef(false);
  const busy = !!snapshot?.busy || !!pending;
  async function perform(action: ApplicationAction) {
    if (!compatible || inFlight.current) return;
    inFlight.current = true;
    setPending(action.type);
    setResult(undefined);
    try {
      const response = await run(action);
      if (action.type === 'applicationInstall' && response?.ok)
        setResult({
          ok: true,
          message: `${response.name ?? 'Aplicación'} instalada en tu carpeta Applications.`,
        });
      return response;
    } catch (error) {
      setResult({ ok: false, message: actionError(error) });
    } finally {
      setPending(undefined);
      inFlight.current = false;
    }
  }
  useEffect(() => {
    if (compatible && !snapshot?.updatedAt && !snapshot?.busy && !initialRefresh.current) {
      initialRefresh.current = true;
      void perform({ type: 'applicationRefresh' });
    }
  }, [compatible, snapshot?.updatedAt, snapshot?.busy]);

  const items = (snapshot?.items ?? []).filter(
    (item) =>
      (filter === 'all' || item.kind === filter) &&
      `${item.name} ${item.path} ${item.capabilities.join(' ')}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return (
    <section
      className="applications-settings"
      aria-label="Aplicaciones del equipo"
      aria-busy={busy}
    >
      <div className="applications-heading">
        <div>
          <h3>Aplicaciones del equipo</h3>
          <p className="muted">
            Aplicaciones y herramientas disponibles para trabajar desde Agent Desk.
          </p>
        </div>
        <button
          type="button"
          disabled={!compatible || busy}
          onClick={() => void perform({ type: 'applicationRefresh' })}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {snapshot?.busy === 'refreshing' ? 'Buscando…' : 'Actualizar'}
        </button>
      </div>
      {snapshot?.supported && (
        <div className="applications-install">
          <div>
            <strong>Instalar para mi usuario</strong>
            <p>
              Selecciona una aplicación .app descargada o de un disco montado. Se guardará en tu
              carpeta Applications.
            </p>
          </div>
          <button
            type="button"
            disabled={!compatible || busy}
            onClick={() => void perform({ type: 'applicationInstall' })}
          >
            <Download size={15} aria-hidden="true" />
            {snapshot.busy === 'installing' ? 'Instalando…' : 'Elegir aplicación'}
          </button>
        </div>
      )}
      {(result || snapshot?.error) && (
        <p
          className={`applications-result ${result?.ok ? 'success' : 'error'}`}
          role={result?.ok ? 'status' : 'alert'}
        >
          {result?.message ?? snapshot?.error}
        </p>
      )}
      <div className="applications-filter">
        <label className="applications-search">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Buscar aplicaciones"
            type="search"
            placeholder="Buscar aplicaciones o herramientas"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div role="group" aria-label="Tipo de aplicación">
          {(
            [
              ['all', 'Todas'],
              ['app', 'Aplicaciones'],
              ['cli', 'Herramientas CLI'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              className={filter === value ? 'selected' : ''}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="applications-count muted" aria-live="polite">
        {items.length} {items.length === 1 ? 'resultado' : 'resultados'}
      </p>
      <div className="applications-list">
        {items.map((item) => (
          <article className="application-row" key={item.id}>
            <span className="application-symbol">
              {item.kind === 'app' ? (
                <AppWindow size={20} aria-hidden="true" />
              ) : (
                <Terminal size={20} aria-hidden="true" />
              )}
            </span>
            <div className="application-description">
              <div className="application-title">
                <strong>{item.name}</strong>
                {item.version && <span className="muted">{item.version}</span>}
                <span className="application-scope">
                  {item.scope === 'user' ? 'Mi usuario' : 'Equipo'}
                </span>
              </div>
              <p className="application-path" title={item.path}>
                {item.path}
              </p>
              <p className="application-capabilities">{item.capabilities.join(' · ')}</p>
            </div>
            <div className="application-actions">
              {item.kind === 'app' && (
                <button
                  type="button"
                  disabled={!compatible || busy}
                  onClick={() => void perform({ type: 'applicationOpen', id: item.id })}
                  aria-label={`Abrir ${item.name}`}
                >
                  Abrir
                </button>
              )}
              {snapshot?.supported && (
                <button
                  type="button"
                  className="icon"
                  disabled={!compatible || busy}
                  onClick={() => void perform({ type: 'applicationReveal', id: item.id })}
                  aria-label={`Mostrar ${item.name} en Finder`}
                  title="Mostrar en Finder"
                >
                  <FolderOpen size={16} />
                </button>
              )}
            </div>
          </article>
        ))}
        {!items.length && (
          <p className="applications-empty muted">
            {snapshot?.busy === 'refreshing'
              ? 'Buscando aplicaciones instaladas…'
              : query
                ? 'No hay aplicaciones que coincidan con la búsqueda.'
                : 'No se han encontrado aplicaciones. Actualiza la lista para volver a buscar.'}
          </p>
        )}
      </div>
    </section>
  );
}
