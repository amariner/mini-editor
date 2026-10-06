import { isCodex } from './shared';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Folder,
  Plus,
  Search,
  Settings2,
  GitBranch,
  Globe,
  X,
  TerminalSquare,
  MessageSquare,
  Command,
  ShieldCheck,
  ExternalLink,
  RefreshCw,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { Action, Session, Snapshot, ImageAttachment } from './shared';
import { permissionModes } from './shared';
import { actionError, assertCompatibleAction, compatibleRuntime, RESTART_NOTICE } from './runtime';
import { TerminalView, live } from './terminal';
import { openSessionTab, sessionGroup } from './session-tabs';
import {
  ClaudeApproval,
  CodexApproval,
  Composer,
  ConversationMessages,
  ActivityDock,
  TodoPanel,
} from './chat';
import { UsageSwitcher } from './usage-switcher';
import { EditableName } from './editable-name';
import { useWorkspaceSplit } from './workspace-split';
import { ProjectMark } from './project-mark';
import { BrowserPanel } from './browser-panel';
import { AccountsSettings } from './accounts-settings';
import '@xterm/xterm/css/xterm.css';
import './style.css';
const statusLabels: Record<string, string> = {
  stopped: 'En espera',
  starting: 'Abriendo…',
  terminal: 'Terminal',
  ready: 'Lista',
  working: 'Trabajando',
  waiting: 'Esperándote',
  stopping: 'Cerrando…',
  error: 'Error',
};
function App() {
  const split = useWorkspaceSplit();
  const [state, setState] = useState<Snapshot>(),
    [error, setError] = useState(''),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(''),
    [searchIndex, setSearchIndex] = useState(0),
    [settings, setSettings] = useState(false),
    [sidebarCollapsed, setSidebarCollapsed] = useState(false),
    [navigating, setNavigating] = useState(false),
    [tabs, setTabs] = useState<Record<string, string[]>>({}),
    [closedSelection, setClosedSelection] = useState<string>(),
    [confirmClose, setConfirmClose] = useState<Session>(),
    [showDiff, setShowDiff] = useState(false),
    [showBrowser, setShowBrowser] = useState(false),
    [browserTab, setBrowserTab] = useState<string>(),
    [showTerminalPanel, setShowTerminalPanel] = useState(false),
    [diff, setDiff] = useState<any>(),
    [diffError, setDiffError] = useState(''),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [imageDrafts, setImageDrafts] = useState<Record<string, ImageAttachment[]>>({}),
    [busy, setBusy] = useState<Record<string, boolean>>({}),
    [removeId, setRemoveId] = useState<string>(),
    [editingName, setEditingName] = useState<{ kind: 'project' | 'session'; id: string }>(),
    [stick, setStick] = useState(true);
  const list = useRef<HTMLDivElement>(null),
    diffRequest = useRef(0),
    navigationInFlight = useRef(false),
    recentSessions = useRef<Record<string, string>>({}),
    stateRef = useRef<Snapshot | undefined>(undefined);
  stateRef.current = state;
  useEffect(() => {
    const off = window.desk.subscribe((e) => {
      if (e.type === 'state') setState(e.state);
      if (e.type === 'browserOpened') {
        setShowBrowser(true);
        setBrowserTab(e.tabId ?? e.sessionId);
      }
      if (e.type === 'shortcut') {
        if (e.action === 'search') {
          setSearch(true);
          setQuery('');
        } else setSettings(true);
      }
    });
    window.desk
      .invoke({ type: 'snapshot' })
      .then(setState)
      .catch((e) => setError(e.message));
    return off;
  }, []);
  const accountProfiles = state?.profiles ?? [];
  const project = state?.projects.find((p) => p.id === state.selectedProject),
    selectedSession = state?.sessions.find((s) => s.id === state.selectedSession),
    session = selectedSession?.id === closedSelection ? undefined : selectedSession,
    profile = selectedSession?.profile ?? accountProfiles[0]?.id,
    kind = isCodex(profile) ? 'codex' : 'claude';
  useEffect(() => {
    if (!selectedSession || selectedSession.id === closedSelection) return;
    setTabs((v) => ({
      ...v,
      [sessionGroup(selectedSession)]: openSessionTab(
        v[sessionGroup(selectedSession)] ?? [],
        selectedSession,
        stateRef.current!.sessions,
      ),
    }));
  }, [selectedSession?.id, closedSelection]);
  const openTabs = selectedSession
    ? (tabs[sessionGroup(selectedSession)] ?? [])
        .map((id) => state?.sessions.find((s) => s.id === id))
        .filter((s): s is Session => !!s)
    : [];
  // Session creation order keeps tabs stationary when navigating; MRU only controls eviction.
  openTabs.sort((a, b) => state!.sessions.indexOf(a) - state!.sessions.indexOf(b));
  const closeTab = async (s: Session) => {
    if (live(stateRef.current?.sessions.find((x) => x.id === s.id))) {
      setConfirmClose(s);
      return;
    }
    const remaining = (tabs[sessionGroup(s)] ?? []).filter((id) => id !== s.id);
    setTabs((v) => ({ ...v, [sessionGroup(s)]: remaining }));
    if (stateRef.current?.selectedSession === s.id) {
      setClosedSelection(s.id);
      if (remaining.length)
        await run({ type: 'select', projectId: s.projectId, sessionId: remaining.at(-1) });
    }
  };
  if (session) recentSessions.current[`${session.projectId}:${session.profile}`] = session.id;
  const switchProfile = (projectId: string, nextProfile: Session['profile']) => {
    const previousId = recentSessions.current[`${projectId}:${nextProfile}`];
    const sessionId = stateRef.current?.sessions.some((s) => s.id === previousId)
      ? previousId
      : undefined;
    return run({ type: 'select', projectId: projectId, profile: nextProfile, sessionId });
  };

  const run = async (action: Action) => {
    if (action.type === 'login') {
      setSettings(true);
      return;
    }
    if (
      action.type === 'newSession' &&
      (stateRef.current?.sessions.filter(
        (s) => s.projectId === action.projectId && s.profile === action.profile && live(s),
      ).length ?? 0) >= 5
    ) {
      setError(
        'Ya hay cinco agentes abiertos en esta cuenta y proyecto. Cierra una pestaña antes de crear otra.',
      );
      return;
    }
    const navigation = action.type === 'select' || action.type === 'newSession';
    if (navigation && navigationInFlight.current) return;
    if (navigation) {
      navigationInFlight.current = true;
      setNavigating(true);
    }
    const key = ('sessionId' in action ? action.sessionId : undefined) ?? action.type;
    setBusy((v) => ({ ...v, [key]: true }));
    try {
      setError('');
      assertCompatibleAction(stateRef.current, action);
      const r = await window.desk.invoke(action);
      if (action.type === 'restartApp') return r;
      const snap = await window.desk.invoke({ type: 'snapshot' });
      stateRef.current = snap;
      setState(snap);
      if (navigation) setClosedSelection(undefined);
      return r;
    } catch (e) {
      setError(actionError(e));
      return undefined;
    } finally {
      if (navigation) {
        navigationInFlight.current = false;
        setNavigating(false);
      }
      setBusy((v) => ({ ...v, [key]: false }));
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const s = stateRef.current?.sessions.find((x) => x.id === stateRef.current?.selectedSession);
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearch((v) => !v);
        setQuery('');
        setSearchIndex(0);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettings((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (s) void run({ type: 'newSession', projectId: s.projectId, profile: s.profile });
      } else if (
        e.key === 'Tab' &&
        e.shiftKey &&
        s &&
        !isCodex(s.profile) &&
        s.mode !== 'terminal'
      ) {
        const target = e.target as HTMLElement;
        if (target?.tagName === 'TEXTAREA' || target?.tagName === 'BODY') {
          e.preventDefault();
          const order = permissionModes
            .map((m) => m.id)
            .filter((m) => m !== 'bypassPermissions' && m !== 'dontAsk');
          const current = s.info?.permissionMode ?? s.config?.permissionMode ?? 'default';
          const next = order[(order.indexOf(current as any) + 1) % order.length];
          void run({ type: 'configure', sessionId: s.id, config: { permissionMode: next } });
        }
      } else if (e.key === 'Escape') {
        if (search || settings || confirmClose || removeId) {
          setSearch(false);
          setSettings(false);
          setConfirmClose(undefined);
          setRemoveId(undefined);
        } else if (s && (s.status === 'working' || s.status === 'waiting') && s.mode !== 'terminal')
          void run({ type: 'interrupt', sessionId: s.id });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [search, settings, confirmClose, removeId]);
  const refreshDiff = async () => {
    if (!project) return;
    const request = ++diffRequest.current;
    setDiffError('');
    try {
      const d = await window.desk.invoke({ type: 'diff', projectId: project.id });
      if (request === diffRequest.current) setDiff(d);
    } catch (e) {
      if (request === diffRequest.current) setDiffError((e as Error).message);
    }
  };
  useEffect(() => {
    setStick(true);
  }, [session?.id]);
  useEffect(() => {
    setDiff(undefined);
    setDiffError('');
  }, [project?.id]);
  useEffect(() => {
    void refreshDiff();
    const onFocus = () => void refreshDiff();
    window.addEventListener('focus', onFocus);
    return () => {
      diffRequest.current++;
      window.removeEventListener('focus', onFocus);
    };
  }, [project?.id, showDiff, session?.status, showTerminalPanel]);
  useEffect(() => {
    if (
      showTerminalPanel &&
      project &&
      !(!isCodex(session?.profile) && session?.mode === 'terminal')
    )
      void run({ type: 'openProjectTerminal', projectId: project.id });
  }, [project?.id, showTerminalPanel, session?.mode]);
  useEffect(() => {
    if (!project || !profile || !compatibleRuntime(state)) return;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        await window.desk.invoke({ type: 'refreshUsage', profile });
      } catch {
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [profile, project?.id, session?.status, state?.runtime?.protocol]);
  const last = session?.messages.at(-1);
  const lastBlocks = last?.blocks?.length ?? 0;
  const lastText = last?.blocks?.at(-1);
  useEffect(() => {
    if (stick && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [
    session?.id,
    session?.messages.length,
    lastBlocks,
    lastText && 'text' in lastText ? lastText.text.length : 0,
    lastText && 'result' in lastText ? lastText.result?.length : 0,
    session?.approvals.length,
    session?.status,
  ]);
  if (!state) return <div className="loading">Abriendo Agent Desk…{error}</div>;
  const results = [
    ...state.projects.map((p) => ({
      key: p.id,
      title: p.name,
      subtitle: p.path,
      projectId: p.id,
      sessionId: undefined as string | undefined,
    })),
    ...state.sessions.map((s) => ({
      key: s.id,
      title: s.title,
      subtitle: `${state.projects.find((p) => p.id === s.projectId)?.name} · ${accountProfiles.find((p) => p.id === s.profile)?.name} · ${statusLabels[s.status]}`,
      projectId: s.projectId,
      sessionId: s.id,
    })),
  ].filter((r) => `${r.title} ${r.subtitle}`.toLowerCase().includes(query.toLowerCase()));
  const choose = (r: (typeof results)[number]) => {
    void run({ type: 'select', projectId: r.projectId, sessionId: r.sessionId });
    setSearch(false);
  };
  const terminalMode = !isCodex(session?.profile) && session?.mode === 'terminal';
  const terminalSession =
    terminalMode && session ? session : state.terminals?.find((t) => t.projectId === project?.id);
  const toggleTerminal = () => {
    if (!project) return;
    setShowTerminalPanel((v) => !v);
    if (!showTerminalPanel && !terminalMode)
      void run({ type: 'openProjectTerminal', projectId: project.id });
    if (!showTerminalPanel && terminalMode && session && !live(session))
      void run({ type: 'start', sessionId: session.id });
  };
  const localCommand = (name: string, arg: string) => {
    if (!session) return false;
    if (name === 'login' || name === 'logout') {
      setSettings(true);
      return true;
    }
    if (name === 'config') {
      setSettings(true);
      return true;
    }
    if (name === 'terminal') {
      if (project) {
        setShowTerminalPanel(true);
        void run({ type: 'openProjectTerminal', projectId: project.id });
      }
      return true;
    }
    void arg;
    return false;
  };
  const sendText = async (s: Session, text: string, images: ImageAttachment[]) => {
    if (!compatibleRuntime(stateRef.current)) {
      setError(RESTART_NOTICE);
      return false; // Preserve the draft while the main process is out of date.
    }
    const result = await run({
      type: 'send',
      sessionId: s.id,
      text,
      attachmentIds: images.map((i) => i.id),
    });
    return result === true;
  };
  const browserPanel = (
    <BrowserPanel
      tabs={state.browsers ?? []}
      selected={browserTab}
      select={setBrowserTab}
      projectId={project?.id}
      sessionId={session?.id}
      projects={state.projects}
      blocked={split.dragging || search || settings || !!confirmClose || !!removeId || !!error}
      close={() => setShowBrowser(false)}
      onError={setError}
    />
  );
  return (
    <div className="app">
      <aside className={`sidebar compact ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="traffic-space" />
        <div className="section-label">
          <div className="project-tools">
            <button
              aria-label="Añadir proyecto"
              title="Añadir carpeta"
              onClick={() => run({ type: 'addProject' })}
            >
              <Plus size={15} />
            </button>
            {!sidebarCollapsed && (
              <button
                aria-label="Buscar proyectos y sesiones"
                title="Buscar (⌘K)"
                onClick={() => {
                  setSearch(true);
                  setQuery('');
                  setSearchIndex(0);
                }}
              >
                <Search size={15} />
              </button>
            )}
          </div>
        </div>
        <nav className="projects" aria-label="Proyectos">
          {state.projects.map((p) => (
            <div key={p.id} className={`project-block ${p.id === project?.id ? 'selected' : ''}`}>
              <div className="project-row">
                {editingName?.kind === 'project' && editingName.id === p.id ? (
                  <EditableName
                    value={p.name}
                    label="Nombre del proyecto"
                    close={() => setEditingName(undefined)}
                    save={(name) => void run({ type: 'renameProject', projectId: p.id, name })}
                  />
                ) : (
                  <button
                    className="project-name"
                    title={p.path}
                    aria-disabled={navigating}
                    aria-label={p.name}
                    aria-current={p.id === project?.id ? 'page' : undefined}
                    onClick={(e) => {
                      if (e.detail < 2) {
                        if (profile) void switchProfile(p.id, profile);
                        else void run({ type: 'select', projectId: p.id });
                      }
                    }}
                    onDoubleClick={() => {
                      setSidebarCollapsed(false);
                      setEditingName({ kind: 'project', id: p.id });
                    }}
                  >
                    <ProjectMark identity={p.path} />
                    <span className="project-label">{p.name}</span>
                    {state.sessions.some((s) => s.projectId === p.id && live(s)) && (
                      <i className="live-dot" />
                    )}
                  </button>
                )}
                <button
                  className="icon-btn ghost"
                  title="Quitar de la lista"
                  aria-label={`Quitar ${p.name}`}
                  onClick={() => setRemoveId(p.id)}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          ))}
          {!state.projects.length && (
            <p className="sidebar-hint">Añade una carpeta para empezar.</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            aria-label={sidebarCollapsed ? 'Expandir proyectos' : 'Plegar proyectos'}
            title={sidebarCollapsed ? 'Expandir proyectos' : 'Plegar proyectos'}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <button aria-label="Ajustes" title="Ajustes (⌘,)" onClick={() => setSettings(true)}>
            <Settings2 size={15} />
          </button>
        </div>
      </aside>
      <main>
        {(!compatibleRuntime(state) || state.runtime?.updateAvailable) && (
          <div className="runtime-notice" role="status">
            {state.runtime?.restartSupported && state.runtime.updateAvailable && (
              <button
                disabled={
                  state.sessions.some(live) ||
                  Object.values(state.accounts ?? {}).some((a) => !!a.busy) ||
                  busy.restartApp
                }
                onClick={() => void run({ type: 'restartApp' })}
              >
                Actualizar aplicación
              </button>
            )}
          </div>
        )}
        <header className="topbar">
          <div className="crumb">
            {project && profile && (
              <UsageSwitcher
                profiles={accountProfiles}
                profile={profile}
                usage={state.accounts?.[profile]?.usage}
                disabled={navigating}
                change={(next) => void switchProfile(project.id, next)}
              />
            )}
          </div>
          <div className="top-actions">
            <button
              className={showTerminalPanel ? 'on' : ''}
              disabled={!project}
              aria-label="Terminal"
              title="Terminal · Panel inferior"
              aria-pressed={showTerminalPanel}
              onClick={toggleTerminal}
            >
              <TerminalSquare size={17} />
            </button>

            <button
              className={showBrowser ? 'on' : ''}
              aria-label="Navegador"
              title="Navegador"
              aria-pressed={showBrowser}
              disabled={!compatibleRuntime(state)}
              onClick={() => setShowBrowser((v) => !v)}
            >
              <Globe size={17} />
            </button>
          </div>
        </header>
        {!project && showBrowser && compatibleRuntime(state) ? (
          browserPanel
        ) : !project ? (
          <div className="welcome">
            <p>
              {accountProfiles.length
                ? 'Abre una carpeta y conversa con Claude Code o Codex como en su terminal, pero con interfaz.'
                : 'Añade tu primera cuenta de Claude o Codex en Ajustes para empezar.'}
            </p>
            {!accountProfiles.length && (
              <button className="primary large" onClick={() => setSettings(true)}>
                <Plus size={16} />
                Añadir cuenta
              </button>
            )}
            <button className="primary large" onClick={() => run({ type: 'addProject' })}>
              <Plus size={16} />
              Añadir proyecto
            </button>
          </div>
        ) : (
          <div className="work-area">
            <div
              ref={split.ref}
              style={split.style}
              className={`workspace ${showDiff || showBrowser ? 'with-tools' : ''} ${split.dragging ? 'resizing' : ''}`}
            >
              <section className="conversation">
                <div className="session-tabs-bar">
                  <div className="session-tabs" role="tablist" aria-label="Conversaciones">
                    {openTabs.map((s) => (
                      <div
                        className={`session-tab ${live(s) ? 'running' : ''} ${s.id === session?.id ? 'selected' : ''}`}
                        key={s.id}
                      >
                        {editingName?.kind === 'session' && editingName.id === s.id ? (
                          <EditableName
                            value={s.title}
                            label="Nombre del chat"
                            close={() => setEditingName(undefined)}
                            save={(title) => void run({ type: 'rename', sessionId: s.id, title })}
                          />
                        ) : (
                          <button
                            role="tab"
                            aria-selected={s.id === session?.id}
                            aria-controls="conversation-content"
                            aria-disabled={navigating}
                            title={`${s.title} · ${live(s) ? 'Proceso abierto' : 'Proceso parado'}`}
                            aria-description={live(s) ? 'Proceso abierto' : 'Proceso parado'}
                            onClick={() =>
                              run({ type: 'select', projectId: project.id, sessionId: s.id })
                            }
                            onDoubleClick={() => setEditingName({ kind: 'session', id: s.id })}
                          >
                            <span>{s.title}</span>
                          </button>
                        )}
                        <button
                          className="tab-close"
                          aria-label={`Cerrar ${s.title}`}
                          title="Cerrar pestaña"
                          disabled={navigating || busy[s.id]}
                          onClick={() => void closeTab(s)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    className="icon-btn ghost new-tab"
                    title="Nueva conversación (⌘N) · Hasta 5 pestañas por cuenta"
                    disabled={navigating || !profile}
                    aria-label="Nueva conversación"
                    onClick={() =>
                      profile && run({ type: 'newSession', projectId: project.id, profile })
                    }
                  >
                    <Plus size={16} />
                  </button>
                </div>
                {!session && (
                  <div className="empty no-session">
                    <h2>{accountProfiles.length ? 'Sin pestañas abiertas' : 'Sin cuentas'}</h2>
                    <p>
                      {accountProfiles.length
                        ? 'Crea una conversación con + o recupera una anterior con ⌘K.'
                        : 'Añade una cuenta de Claude o Codex para conversar en este proyecto.'}
                    </p>
                    {!accountProfiles.length && (
                      <button className="primary" onClick={() => setSettings(true)}>
                        <Plus size={16} /> Añadir cuenta
                      </button>
                    )}
                  </div>
                )}
                {session && (
                  <>
                    {(state.coordination?.filter((a) => a.projectId === project.id).length ?? 0) >
                      1 && (
                      <div className="conv-head">
                        <div className="conv-title">
                          {(state.coordination?.filter((a) => a.projectId === project.id).length ??
                            0) > 1 && (
                            <span
                              className="coordination-status"
                              title={state.coordination
                                ?.filter((a) => a.projectId === project.id)
                                .map(
                                  (a) =>
                                    `${accountProfiles.find((p) => p.id === a.profile)?.name}: ${a.task || a.title} · ${a.paths.join(', ') || 'sin reservas'}`,
                                )
                                .join('\n')}
                            >
                              {state.coordination?.filter((a) => a.projectId === project.id).length}{' '}
                              agentes · coordinación compartida
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    {session.error && (
                      <div className="inline-notice">
                        <span>{session.error}</span>
                        {session.error.includes('/login') && (
                          <button onClick={() => run({ type: 'login', sessionId: session.id })}>
                            Iniciar sesión
                          </button>
                        )}
                      </div>
                    )}
                    <div
                      className="messages compact-conversation"
                      id="conversation-content"
                      role="tabpanel"
                      aria-label={session.title}
                      ref={list}
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
                      }}
                    >
                      {!session.messages.length && !session.approvals.length && (
                        <div className="chat-watermark" aria-hidden="true">
                          <span>✳</span>
                        </div>
                      )}
                      {terminalMode && (
                        <div className="inline-notice">
                          Esta conversación usa la terminal oficial. Ábrela con el icono Terminal o
                          crea una nueva pestaña para usar el chat.
                        </div>
                      )}
                      {isCodex(session.profile) && live(session) && !session.account && (
                        <div className="auth-card">
                          <ShieldCheck size={22} />
                          <h2>Conecta tu cuenta de ChatGPT</h2>
                          <p>
                            Inicia sesión mediante el flujo oficial de Codex. Agent Desk no solicita
                            claves ni copia credenciales.
                          </p>
                          <button
                            className="primary"
                            disabled={
                              session.loginPending ||
                              session.status === 'starting' ||
                              busy[session.id]
                            }
                            onClick={() => run({ type: 'login', sessionId: session.id })}
                          >
                            <ExternalLink size={14} />
                            {session.loginPending
                              ? 'Completa el acceso en el navegador'
                              : 'Gestionar cuenta en Ajustes'}
                          </button>
                          {session.loginPending && (
                            <button
                              className="quiet"
                              onClick={() => run({ type: 'cancelLogin', sessionId: session.id })}
                            >
                              Cancelar
                            </button>
                          )}
                        </div>
                      )}
                      <ConversationMessages session={session} kind={kind} />
                      {session.approvals.map((a) =>
                        a.method === 'claude/permission' ? (
                          <ClaudeApproval key={a.id} approval={a} session={session} run={run} />
                        ) : (
                          <CodexApproval key={a.id} approval={a} session={session} run={run} />
                        ),
                      )}
                    </div>
                    {!terminalMode && (
                      <>
                        {session.todos?.length ? <TodoPanel todos={session.todos} /> : null}
                        <ActivityDock
                          key={`activity-${session.id}`}
                          session={session}
                          kind={kind}
                        />
                      </>
                    )}
                    <div className="git-summary" aria-label="Resumen de cambios del proyecto">
                      <button
                        className="git-summary-project"
                        aria-label="Cambios de Git"
                        title={
                          diffError
                            ? 'No se pudo consultar Git. Pulsa para ver el detalle.'
                            : 'Ver cambios del proyecto'
                        }
                        aria-expanded={showDiff}
                        onClick={() => setShowDiff((v) => !v)}
                      >
                        <span>{project.name}</span>
                        <span className="git-summary-branch">
                          {diff?.branch ?? (diffError ? 'Git no disponible' : 'Cambios')}
                        </span>
                      </button>
                      {diff?.lines && !diffError && (
                        <button
                          className="git-summary-lines"
                          aria-label={`Ver cambios: ${diff.lines.added} líneas añadidas y ${diff.lines.removed} eliminadas`}
                          title="Líneas en cambios preparados y sin preparar. No incluye archivos sin seguimiento ni binarios."
                          aria-expanded={showDiff}
                          onClick={() => setShowDiff((v) => !v)}
                        >
                          <span className="git-added">
                            +{diff.lines.added.toLocaleString('es-ES')}
                          </span>
                          <span className="git-removed">
                            −{diff.lines.removed.toLocaleString('es-ES')}
                          </span>
                        </button>
                      )}
                    </div>
                    {!terminalMode && (
                      <>
                        <Composer
                          key={session.id}
                          session={session}
                          optimization={
                            accountProfiles.find((p) => p.id === session.profile)?.optimization
                          }
                          draft={drafts[session.id] ?? ''}
                          setDraft={(v) => setDrafts((d) => ({ ...d, [session.id]: v }))}
                          run={run}
                          images={imageDrafts[session.id] ?? []}
                          setImages={(images) =>
                            setImageDrafts((d) => ({ ...d, [session.id]: images }))
                          }
                          onSend={(text, images) => sendText(session, text, images)}
                          onLocalCommand={localCommand}
                        />
                      </>
                    )}
                  </>
                )}
              </section>
              {(showDiff || showBrowser) && split.separator}
              {(showDiff || showBrowser) && (
                <aside
                  className={`drawer tools-drawer ${[showDiff, showBrowser].filter(Boolean).length > 1 ? 'split' : ''} ${showBrowser ? 'with-browser' : ''}`}
                >
                  {showBrowser && compatibleRuntime(state) && browserPanel}
                  {showDiff && (
                    <section className="tool-pane diff-panel">
                      <div className="drawer-head">
                        <strong>
                          <GitBranch size={14} />
                        </strong>
                        <div>
                          <button title="Actualizar" onClick={refreshDiff}>
                            <RefreshCw size={14} />
                          </button>
                          <button title="Cerrar" onClick={() => setShowDiff(false)}>
                            <X size={16} />
                          </button>
                        </div>
                      </div>
                      <div className="drawer-body">
                        {diffError ? (
                          <p className="muted">{diffError}</p>
                        ) : !diff ? (
                          <p className="muted">Consultando Git…</p>
                        ) : !diff.status ? (
                          <div className="clean-git">
                            <Check size={22} />
                            <p>No hay cambios locales.</p>
                          </div>
                        ) : (
                          <div className="diff-body">
                            <h5>Archivos</h5>
                            <pre className="code">{diff.status}</pre>
                            {[
                              ['Sin preparar', diff.unstaged],
                              ['Preparados', diff.staged],
                            ].map(
                              ([label, text]) =>
                                text && (
                                  <section key={label}>
                                    <h5>{label}</h5>
                                    <pre className="diff">
                                      {text.split('\n').map((line: string, i: number) => (
                                        <div
                                          className={
                                            line.startsWith('+')
                                              ? 'added'
                                              : line.startsWith('-')
                                                ? 'removed'
                                                : ''
                                          }
                                          key={i}
                                        >
                                          {line || ' '}
                                        </div>
                                      ))}
                                    </pre>
                                  </section>
                                ),
                            )}
                          </div>
                        )}
                      </div>
                    </section>
                  )}
                </aside>
              )}
            </div>
            {showTerminalPanel && (
              <section className="tool-pane terminal-pane bottom-terminal">
                <div className="drawer-head">
                  <strong>
                    <TerminalSquare size={14} />
                  </strong>
                  <button
                    title="Ocultar terminal"
                    aria-label="Ocultar terminal"
                    onClick={() => setShowTerminalPanel(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                {terminalSession ? (
                  <TerminalView
                    key={terminalSession.id}
                    session={terminalSession}
                    visible
                    onError={setError}
                  />
                ) : (
                  <div className="inline-notice">
                    <button
                      onClick={() =>
                        project && run({ type: 'openProjectTerminal', projectId: project.id })
                      }
                    >
                      Conectar terminal
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button aria-label="Cerrar error" onClick={() => setError('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {search && (
        <div className="overlay" onClick={() => setSearch(false)}>
          <div
            className="palette"
            role="dialog"
            aria-label="Buscar proyectos y sesiones"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="palette-search">
              <Search size={17} />
              <input
                autoFocus
                placeholder="Buscar proyecto o sesión…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSearchIndex((i) => Math.min(i + 1, results.length - 1));
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSearchIndex((i) => Math.max(0, i - 1));
                  }
                  if (e.key === 'Enter' && results[searchIndex]) choose(results[searchIndex]);
                }}
              />
              <kbd>esc</kbd>
            </div>
            <div className="palette-results">
              {results.map((r, i) => (
                <button
                  key={r.key}
                  className={i === searchIndex ? 'on' : ''}
                  onClick={() => choose(r)}
                >
                  {r.sessionId ? <MessageSquare size={15} /> : <Folder size={15} />}
                  <span>
                    <strong>{r.title}</strong>
                    <small>{r.subtitle}</small>
                  </span>
                </button>
              ))}
              {!results.length && <p className="muted">No hay resultados.</p>}
            </div>
          </div>
        </div>
      )}
      {settings && (
        <AccountsSettings
          state={state}
          run={run}
          close={() => setSettings(false)}
          onError={setError}
        />
      )}
      {confirmClose && (
        <div className="overlay">
          <section className="modal small" role="dialog" aria-label="Cerrar conversación">
            <h2>¿Detener y cerrar la pestaña?</h2>
            <p className="muted">
              «{confirmClose.title}» tiene un agente abierto. Se detendrá antes de cerrar la
              pestaña. Podrás recuperar la conversación con ⌘K.
            </p>
            <div className="modal-actions">
              <button disabled={busy[confirmClose.id]} onClick={() => setConfirmClose(undefined)}>
                Cancelar
              </button>
              <button
                className="danger"
                disabled={busy[confirmClose.id]}
                onClick={async () => {
                  const s = confirmClose;
                  await run({ type: 'stop', sessionId: s.id });
                  if (!live(stateRef.current?.sessions.find((x) => x.id === s.id))) {
                    setConfirmClose(undefined);
                    await closeTab(s);
                  }
                }}
              >
                Detener y cerrar
              </button>
            </div>
          </section>
        </div>
      )}
      {removeId && (
        <div className="overlay">
          <section className="modal small" role="dialog">
            <h2>Quitar proyecto de la lista</h2>
            <p className="muted">
              Se quitan el acceso y las referencias de sesiones. Los archivos de la carpeta
              permanecen intactos.
            </p>
            <div className="modal-actions">
              <button onClick={() => setRemoveId(undefined)}>Cancelar</button>
              <button
                className="danger"
                onClick={() => {
                  void run({ type: 'removeProject', projectId: removeId });
                  setRemoveId(undefined);
                }}
              >
                Quitar
              </button>
            </div>
          </section>
        </div>
      )}
      <span className="hidden">
        <Command size={1} />
      </span>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
