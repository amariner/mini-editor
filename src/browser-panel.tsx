import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  Globe,
  ExternalLink,
  X,
  ArrowUpRight,
  Plus,
  Moon,
  Play,
  MoreHorizontal,
  MessageSquarePlus,
  Check,
} from 'lucide-react';
import type { BrowserInput, BrowserState } from './browser-protocol';
import { isAuthenticationURL } from './browser-urls';
import { navigateTabs } from './tab-keyboard';

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
  onCaptureContext,
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
  onCaptureContext?: (tab: BrowserState) => Promise<void>;
}) {
  const state =
    tabs.find((tab) => tab.id === selected) ?? tabs.find((tab) => tab.projectId === projectId);
  const host = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const currentTabId = useRef(state?.id);
  currentTabId.current = state?.id;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const operationInFlight = useRef(false);
  const syncBounds = useRef<() => void>(() => {});
  const present = useRef({ visible: false, onError });
  present.current = { visible: !blocked && !!state?.url && !state.suspended, onError };
  const optionsId = useId();
  const [address, setAddress] = useState(state?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [captured, setCaptured] = useState(false);
  const editingAddress = useRef(false);

  useEffect(() => {
    setAddress(state?.url ?? '');
    editingAddress.current = false;
    setCaptured(false);
    setOptionsOpen(false);
    if (
      !state?.url &&
      !blocked &&
      [null, document.body].includes(document.activeElement as HTMLElement)
    )
      addressInput.current?.focus();
  }, [state?.id]);
  useEffect(() => {
    if (!editingAddress.current) setAddress(state?.url ?? '');
    setCaptured(false);
  }, [state?.url]);

  // A URL/loading update must not detach the native page. Only the tab's lifecycle
  // owns hiding it. Resize events are coalesced; modal visibility is synchronized
  // immediately so the guest cannot cover a newly opened dialog.
  useEffect(() => {
    const tabId = state?.id;
    if (!tabId) return;
    let last = '';
    let frame = 0;
    let active = true;
    const sync = () => {
      frame = 0;
      if (!active) return;
      const rect = host.current?.getBoundingClientRect();
      if (!rect) return;
      const bounds = {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const visible = present.current.visible;
      const value = JSON.stringify({ bounds, visible });
      if (value === last) return;
      last = value;
      void window.desk.invoke({ type: 'browserPresent', tabId, bounds, visible }).catch((e) => {
        if (active) {
          last = '';
          present.current.onError(e.message);
        }
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    syncBounds.current = () => {
      cancelAnimationFrame(frame);
      sync();
    };
    const observer = new ResizeObserver(schedule);
    if (host.current) observer.observe(host.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    sync();
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      syncBounds.current = () => {};
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      void window.desk
        .invoke({
          type: 'browserPresent',
          tabId,
          visible: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        })
        .catch(() => {});
    };
  }, [state?.id]);
  useLayoutEffect(() => syncBounds.current(), [state?.url, state?.suspended, blocked]);
  useEffect(() => {
    if (!captured) return;
    const timer = window.setTimeout(() => setCaptured(false), 4000);
    return () => window.clearTimeout(timer);
  }, [captured]);

  const newTab = async (url?: string) => {
    const tab = await window.desk.invoke({ type: 'browserNew', projectId, sessionId, url });
    select(tab.id);
    return tab as BrowserState;
  };
  const act = async (input: BrowserInput, tabId = state?.id) => {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    const selectionAtStart = selectedRef.current;
    setBusy(true);
    try {
      if (input.action === 'new') {
        await newTab(input.url);
        return;
      }
      if (!tabId && input.action === 'navigate') {
        await newTab(input.url);
        return;
      }
      if (!tabId) return;
      await window.desk.invoke({ type: 'browserTab', tabId, input });
      if (
        input.action === 'close' &&
        tabId === state?.id &&
        selectedRef.current === selectionAtStart
      ) {
        const index = tabs.findIndex((tab) => tab.id === tabId);
        const next = tabs[index + 1] ?? tabs[index - 1];
        if (next) select(next.id);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  };
  const openExternal = async () => {
    if (!state || operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    try {
      await window.desk.invoke({ type: 'browserOpenExternal', tabId: state.id });
    } catch (error) {
      onError((error as Error).message);
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  };
  const captureContext = async () => {
    if (!state || !onCaptureContext || operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    try {
      await onCaptureContext(state);
      if (currentTabId.current === state.id) setCaptured(true);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      operationInFlight.current = false;
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
    <section
      className="tool-pane browser-pane"
      aria-label="Navegador integrado"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !optionsOpen) return;
        event.stopPropagation();
        setOptionsOpen(false);
        optionsButton.current?.focus();
      }}
    >
      <form
        className="browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim() && !busy) {
            editingAddress.current = false;
            addressInput.current?.blur();
            void act({ action: 'navigate', url: address });
          }
        }}
      >
        <div className="browser-navigation" role="group" aria-label="Navegación">
          <button
            type="button"
            title="Atrás"
            aria-label="Atrás"
            disabled={!state?.canGoBack || busy}
            onClick={() => void act({ action: 'back' })}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            title="Adelante"
            aria-label="Adelante"
            disabled={!state?.canGoForward || busy}
            onClick={() => void act({ action: 'forward' })}
          >
            <ArrowRight size={14} />
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
        </div>
        <div className="browser-address">
          <input
            ref={addressInput}
            aria-label="Dirección web"
            placeholder="URL o localhost:3000"
            value={address}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              editingAddress.current = true;
              setAddress(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.stopPropagation();
              setAddress(state?.url ?? '');
              editingAddress.current = false;
              e.currentTarget.blur();
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
          />
          <button
            title="Ir a la dirección"
            aria-label="Ir a la dirección"
            disabled={!address.trim() || busy}
          >
            <ArrowUpRight size={13} />
          </button>
        </div>
        <button
          ref={optionsButton}
          type="button"
          className={`browser-options-trigger ${optionsOpen ? 'on' : ''}`}
          aria-label="Opciones del navegador"
          title="Opciones del navegador"
          aria-expanded={optionsOpen}
          aria-controls={optionsId}
          onClick={() => setOptionsOpen((value) => !value)}
        >
          <MoreHorizontal size={16} />
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
      <div
        id={optionsId}
        className={`browser-options ${optionsOpen ? 'is-open' : ''}`}
        inert={!optionsOpen}
        aria-hidden={!optionsOpen}
      >
        <div className="browser-options-clip">
          <div
            className="browser-options-content"
            role="group"
            aria-label="Herramientas del navegador"
          >
            <label className="browser-zoom">
              <span>Zoom</span>
              <select
                aria-label="Zoom del navegador"
                title="Zoom"
                value={state?.zoom ?? 1}
                disabled={!state?.url || busy}
                onChange={(e) => void act({ action: 'zoom', factor: Number(e.target.value) })}
              >
                {[0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(
                  (zoom) => (
                    <option key={zoom} value={zoom}>
                      {Math.round(zoom * 100)}%
                    </option>
                  ),
                )}
              </select>
            </label>
            <button
              type="button"
              aria-label="Abrir en Chrome"
              title="Abrir en Chrome (o en el navegador predeterminado si no está instalado)"
              disabled={!state?.url || busy}
              onClick={() => void openExternal()}
            >
              <ExternalLink size={13} />
              <span>Abrir fuera</span>
            </button>
            <button
              type="button"
              title="Suspender pestaña y liberar memoria"
              aria-label="Suspender pestaña"
              disabled={!state?.url || state.suspended || busy}
              onClick={() => void act({ action: 'suspend' })}
            >
              <Moon size={13} />
              <span>Suspender</span>
            </button>
            {onCaptureContext && (
              <button
                type="button"
                className="browser-capture-context"
                aria-label="Añadir página al chat"
                title="Prepara captura y texto en el borrador, sin enviar"
                disabled={
                  !state?.url ||
                  state.projectId !== projectId ||
                  state.suspended ||
                  state.loading ||
                  busy
                }
                onClick={() => void captureContext()}
              >
                {captured ? <Check size={13} /> : <MessageSquarePlus size={13} />}
                <span role="status">{captured ? 'Añadida al borrador' : 'Al chat'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
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
                  tabIndex={tab.id === state?.id ? 0 : -1}
                  onKeyDown={navigateTabs}
                  aria-label={title(tab)}
                  title={`${projects.find((p) => p.id === tab.projectId)?.name ?? 'Navegador'} · ${tab.title}${tab.suspended ? ' · Suspendida' : ''}`}
                  onClick={() => {
                    select(tab.id);
                    if (tab.suspended && tab.url) void act({ action: 'reload' }, tab.id);
                  }}
                >
                  {tab.loading ? (
                    <RefreshCw size={10} className="spinning" />
                  ) : tab.hostStatus ? (
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
                  className="browser-tab-close"
                  aria-label={`Cerrar pestaña ${title(tab)}`}
                  disabled={busy}
                  onClick={() => void act({ action: 'close' }, tab.id)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="browser-new-tab"
            aria-label="Nueva pestaña del navegador"
            title="Nueva pestaña"
            disabled={busy}
            onClick={() => void act({ action: 'new' })}
          >
            <Plus size={14} />
          </button>
        </div>
      )}
      <div
        className={`browser-loading-track ${state?.loading ? 'is-loading' : ''}`}
        aria-hidden="true"
      >
        <span />
      </div>
      {state?.url && isAuthenticationURL(state.url) && (
        <div className="browser-login-hint">
          <span>
            Si el acceso falla aquí, inicia sesión en Chrome. Las sesiones de ambos navegadores son
            independientes.
          </span>
          <button disabled={busy} onClick={() => void openExternal()}>
            Abrir web en Chrome
          </button>
        </div>
      )}
      {state?.error && (
        <p className="browser-error" role="alert">
          {state.error}
        </p>
      )}
      <div ref={host} className="browser-viewport">
        {(!state?.url || state.suspended) && (
          <div className="browser-empty">
            <div className="browser-empty-symbol">
              {state?.url ? <Moon size={23} /> : <Globe size={23} />}
            </div>
            <strong>{state?.url ? 'Pestaña en pausa' : 'Tu proyecto, en vivo'}</strong>
            <p>
              {state?.url
                ? 'Reanuda cuando quieras continuar.'
                : 'Abre una URL o arranca tu servidor local.'}
            </p>
            {state?.url ? (
              <button
                aria-label="Reanudar pestaña"
                disabled={busy}
                onClick={() => void act({ action: 'reload' })}
              >
                <Play size={13} />
                <span>Reanudar</span>
              </button>
            ) : (
              <button onClick={() => addressInput.current?.focus()}>
                <ArrowUpRight size={13} />
                Abrir dirección
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
