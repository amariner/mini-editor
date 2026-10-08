import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Globe,
  X,
  ArrowUpRight,
  Plus,
  Moon,
  Play,
} from 'lucide-react';
import type { BrowserInput, BrowserState } from './browser-protocol';
export function BrowserPanel({
  tabs,
  selected,
  select,
  projectId,
  sessionId,
  projects,
  blocked,
  close,
  onError,
}: {
  tabs: BrowserState[];
  selected?: string;
  select: (id: string) => void;
  projectId?: string;
  sessionId?: string;
  projects: { id: string; name: string }[];
  blocked: boolean;
  close: () => void;
  onError: (message: string) => void;
}) {
  const state = tabs.find((tab) => tab.id === selected) ?? tabs[0];
  const host = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(state?.url ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setAddress(state?.url ?? ''), [state?.url, state?.id]);
  useEffect(() => {
    const tabId = state?.id;
    if (!tabId) return;
    let last = '';
    const sync = () => {
      const rect = host.current?.getBoundingClientRect();
      if (!rect) return;
      const bounds = {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: rect.width,
        height: rect.height,
      };
      const visible = !blocked && !!state.url && !state.suspended;
      const value = JSON.stringify({ bounds, visible });
      if (value === last) return;
      last = value;
      void window.desk
        .invoke({ type: 'browserPresent', tabId, bounds, visible })
        .catch((e) => onError(e.message));
    };
    const observer = new ResizeObserver(sync);
    if (host.current) observer.observe(host.current);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      void window.desk
        .invoke({
          type: 'browserPresent',
          tabId,
          visible: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        })
        .catch(() => {});
    };
  }, [state?.id, state?.url, state?.suspended, blocked]);
  const newTab = async (url?: string) => {
    const tab = await window.desk.invoke({ type: 'browserNew', projectId, sessionId, url });
    select(tab.id);
    return tab as BrowserState;
  };
  const act = async (input: BrowserInput, tabId = state?.id) => {
    setBusy(true);
    try {
      if (!tabId && input.action === 'navigate') {
        await newTab(input.url);
        return;
      }
      if (!tabId) return;
      await window.desk.invoke({ type: 'browserTab', tabId, input });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const title = (tab: BrowserState) => {
    if (!tab.url) return 'Nueva página';
    try {
      return new URL(tab.url).host;
    } catch {
      return tab.title;
    }
  };
  return (
    <section className="tool-pane browser-pane">
      <form
        className="browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void act({ action: 'navigate', url: address });
        }}
      >
        <button
          type="button"
          title="Atrás"
          aria-label="Atrás"
          disabled={!state?.canGoBack || busy}
          onClick={() => void act({ action: 'back' })}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          title="Adelante"
          aria-label="Adelante"
          disabled={!state?.canGoForward || busy}
          onClick={() => void act({ action: 'forward' })}
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          title="Recargar página"
          aria-label="Recargar página"
          disabled={!state?.url || busy}
          onClick={() => void act({ action: 'reload' })}
        >
          <RefreshCw size={13} className={state?.loading ? 'spinning' : ''} />
        </button>
        <input
          aria-label="Dirección web"
          placeholder="localhost:3000 o una URL"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
        />
        <button
          title="Ir a la dirección"
          aria-label="Ir a la dirección"
          disabled={!address.trim() || busy}
        >
          <ArrowUpRight size={13} />
        </button>
        <select
          aria-label="Zoom del navegador"
          title="Zoom"
          value={state?.zoom ?? 1}
          disabled={!state?.url || busy}
          onChange={(e) => void act({ action: 'zoom', factor: Number(e.target.value) })}
        >
          {[0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((zoom) => (
            <option key={zoom} value={zoom}>
              {Math.round(zoom * 100)}%
            </option>
          ))}
        </select>
        <button
          type="button"
          title="Suspender pestaña y liberar memoria"
          aria-label="Suspender pestaña"
          disabled={!state || state.suspended || busy}
          onClick={() => void act({ action: 'suspend' })}
        >
          <Moon size={13} />
        </button>
        <button
          type="button"
          aria-label="Nueva pestaña del navegador"
          title="Nueva pestaña"
          onClick={() => void newTab().catch((e) => onError(e.message))}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          className="browser-close"
          aria-label="Ocultar navegador"
          title="Ocultar navegador"
          onClick={close}
        >
          <X size={14} />
        </button>
      </form>
      {tabs.length > 0 && (
        <div className="browser-tabs-bar">
          <div className="browser-tabs" role="tablist" aria-label="Pestañas del navegador">
            {tabs.map((tab) => (
              <div
                className={`browser-tab ${tab.id === state?.id ? 'selected' : ''} ${tab.suspended ? 'suspended' : ''}`}
                key={tab.id}
              >
                <button
                  role="tab"
                  aria-selected={tab.id === state?.id}
                  aria-label={title(tab)}
                  title={`${projects.find((p) => p.id === tab.projectId)?.name ?? 'Navegador'} · ${tab.title}${tab.suspended ? ' · Suspendida' : ''}`}
                  onClick={() => {
                    select(tab.id);
                    if (tab.suspended && tab.url) void act({ action: 'reload' }, tab.id);
                  }}
                >
                  {tab.hostStatus ? (
                    <i
                      className={`host-dot ${tab.hostStatus}`}
                      title={
                        tab.hostStatus === 'online' ? 'Puerto disponible' : 'Puerto sin respuesta'
                      }
                    />
                  ) : tab.suspended ? (
                    <Moon size={10} />
                  ) : (
                    <Globe size={10} />
                  )}
                  <span>{title(tab)}</span>
                </button>
                <button
                  aria-label={`Cerrar pestaña ${title(tab)}`}
                  onClick={() => void act({ action: 'close' }, tab.id)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {state?.error && <p className="browser-error">{state.error}</p>}
      <div ref={host} className="browser-viewport">
        {(!state?.url || state.suspended) && (
          <div className="browser-empty">
            {state?.url ? (
              <button
                aria-label="Reanudar pestaña"
                title="Reanudar pestaña"
                onClick={() => void act({ action: 'reload' })}
              >
                <Play size={22} />
              </button>
            ) : (
              <Globe size={24} />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
