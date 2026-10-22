import { FloatChatButton, FloatingChatHeader, DetachedChat } from './floating-chat';
import { floatingChatId } from './floating-chat-state';
import { useTextDrafts, useImageDrafts, initializeDraftLifetime } from './chat-drafts';
import { ProjectChats, TeamIndicator } from './team';
import { Multichat } from './multichat';
import { GitBar } from './git-bar';
import { IsolationBar } from './isolation-bar';
import type { GitSnapshot } from './git-types';
import { providerKind, providerNames, isCodex } from './shared';
import { useInterfacePreferences } from './interface-settings';
import { useModalFocus } from './modal-focus';
import { navigateTabs } from './tab-keyboard';
import React, {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  LayoutGrid,
  ArrowLeft,
  Folder,
  Plus,
  Search,
  Settings2,
  GitBranch,
  Globe,
  X,
  Terminal,
  MessageSquare,
  Command,
  ShieldCheck,
  ExternalLink,
  RefreshCw,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  PanelBottomOpen,
  ArrowDown,
  Maximize2,
  Minimize2,
  Inbox,
} from 'lucide-react';
import type { Action, Session, Snapshot, Attachment, RewindResult } from './shared';
import { permissionModes } from './shared';
import { actionError, assertCompatibleAction, compatibleRuntime, RESTART_NOTICE } from './runtime';
import { antigravityPermissionNeeded } from './antigravity-permissions';
import { TerminalView } from './lazy-terminal';
import { sessionIsLive as live } from './session-tabs';
import { openSessionTab, sessionGroup, sessionAccountLocked } from './session-tabs';
import {
  ClaudeApproval,
  ProviderApproval,
  CodexApproval,
  Composer,
  ConversationMessages,
  ActivityDock,
  TodoPanel,
  PendingMessages,
  ExecutionPanel,
} from './chat';
import { UsageSwitcher, UsageWindowDetail } from './usage-switcher';
import { EditableName } from './editable-name';
import { useWorkspaceSplit } from './workspace-split';
import { DeskMark, ProjectMark } from './project-mark';
import { captureBrowserContext } from './browser-context';
import type { BrowserState } from './browser-protocol';
import { attentionItems } from './attention';
import { AttentionPanel } from './attention-panel';
import { ChatActionsContext, type ChatActions } from './markdown';
import { applyStyles, resetStyles, savedStyles } from './custom-styles';
import { accountCardStyle } from './account-color';
import { isLocalPage, workspaceAvailability } from './workspace-availability';
import { SnapshotSync } from './snapshot-sync';
import { searchWorkspace } from './workspace-search';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import './shell-polish.css';
import './settings-polish.css';
import './chat-polish.css';
import './multichat-polish.css';
import './browser-polish.css';
import './attention.css';
import './motion.css';
import './floating-chat.css';
import './onboarding.css';
const AccountsSettings = React.lazy(() =>
  import('./accounts-settings').then((module) => ({ default: module.AccountsSettings })),
);
const BrowserPanel = React.lazy(() =>
  import('./browser-panel').then((module) => ({ default: module.BrowserPanel })),
);
const floatingSessionId = floatingChatId(window.location.hash);
if (floatingSessionId) document.documentElement.classList.add('floating-chat-document');
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
  const [drafts, setDrafts] = useTextDrafts();
  const [imageDrafts, setImageDrafts] = useImageDrafts();
  const split = useWorkspaceSplit();
  const terminalSplit = useWorkspaceSplit({
    storageKey: 'agent-desk.terminal-chat-width',
    cssVariable: '--terminal-chat-width',
    label: 'Ancho del panel de terminal',
    minChat: 260,
    minTools: 320,
  });
  const [state, setState] = useState<Snapshot>(),
    [error, setError] = useState(''),
    [multichat, setMultichat] = useState<'off' | 'grid' | 'focused'>('off'),
    [hiddenChats, setHiddenChats] = useState<string[]>(() => {
      try {
        const saved = JSON.parse(localStorage.getItem('agent-desk.multichat-dismissed.v1') ?? '[]');
        return Array.isArray(saved)
          ? saved.filter((id): id is string => typeof id === 'string')
          : [];
      } catch {
        return [];
      }
    }),
    [topbarSlot, setTopbarSlot] = useState<HTMLDivElement | null>(null),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(''),
    [searchIndex, setSearchIndex] = useState(0),
    [settings, setSettings] = useState(false),
    [attentionOpen, setAttentionOpen] = useState(false),
    [unreadCompleted, setUnreadCompleted] = useState<Set<string>>(() => new Set()),
    [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
      try {
        return localStorage.getItem('agent-desk.sidebar-collapsed') === 'true';
      } catch {
        return false;
      }
    }),
    [draggedProject, setDraggedProject] = useState<string>(),
    [projectDrop, setProjectDrop] = useState<string>(),
    [navigating, setNavigating] = useState(false),
    [tabs, setTabs] = useState<Record<string, string[]>>({}),
    [closedSelection, setClosedSelection] = useState<string>(),
    [confirmClose, setConfirmClose] = useState<{ session: Session; remove: boolean }>(),
    [showDiff, setShowDiff] = useState(false),
    [showBrowser, setShowBrowser] = useState(false),
    [browserTab, setBrowserTab] = useState<string>(),
    [showTerminalPanel, setShowTerminalPanel] = useState(false),
    [terminalTarget, setTerminalTarget] = useState<'default' | 'freebuff'>('default'),
    [terminalExpanded, setTerminalExpanded] = useState(false),
    [terminalPosition, setTerminalPosition] = useState<'bottom' | 'right'>(() => {
      try {
        return localStorage.getItem('agent-desk.terminal-position') === 'right'
          ? 'right'
          : 'bottom';
      } catch {
        return 'bottom';
      }
    }),
    [diff, setDiff] = useState<GitSnapshot>(),
    [diffError, setDiffError] = useState(''),
    [busy, setBusy] = useState<Record<string, boolean>>({}),
    [removeId, setRemoveId] = useState<string>(),
    [editingName, setEditingName] = useState<{ kind: 'project' | 'session'; id: string }>(),
    [stick, setStick] = useState(true),
    [seen, setSeen] = useState<Record<string, number>>({});
  const appearance = useInterfacePreferences(setError);
  useModalFocus(search || settings || attentionOpen || !!confirmClose || !!removeId);
  useEffect(() => {
    try {
      localStorage.setItem('agent-desk.sidebar-collapsed', String(sidebarCollapsed));
    } catch {}
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (state && !state.freebuffEnabled && terminalTarget === 'freebuff') {
      setTerminalTarget('default');
      setShowTerminalPanel(false);
    }
  }, [state?.freebuffEnabled, terminalTarget]);
  useEffect(() => {
    try {
      localStorage.setItem('agent-desk.terminal-position', terminalPosition);
    } catch {}
  }, [terminalPosition]);
  const list = useRef<HTMLDivElement>(null),
    diffRequest = useRef(0),
    diffReads = useRef(0),
    navigationInFlight = useRef(false),
    pendingActions = useRef(new Map<string, number>()),
    recentSessions = useRef<Record<string, string | null>>({}),
    stateRef = useRef<Snapshot | undefined>(undefined);
  const projectDrag = useRef<string | undefined>(undefined);
  const suppressProjectClick = useRef(false);
  const finishProjectDrag = () => {
    projectDrag.current = undefined;
    setDraggedProject(undefined);
    setProjectDrop(undefined);
    setTimeout(() => {
      suppressProjectClick.current = false;
    }, 100);
  };
  stateRef.current = state;
  // Chats being deleted vanish at once and stay hidden from intermediate broadcasts.
  const deleting = useRef(new Set<string>());
  const visibleState = (snapshot: Snapshot): Snapshot => {
    initializeDraftLifetime(snapshot.runtime?.instanceId);
    const pinned = snapshot.sessions.find((s) => s.id === floatingSessionId);
    const snap = floatingSessionId
      ? { ...snapshot, selectedSession: pinned?.id, selectedProject: pinned?.projectId }
      : snapshot;
    return deleting.current.size
      ? { ...snap, sessions: snap.sessions.filter((s) => !deleting.current.has(s.id)) }
      : snap;
  };
  const snapshotSync = useMemo(
    () =>
      new SnapshotSync<Snapshot>(
        () => window.desk.invoke({ type: 'snapshot' }),
        (snapshot) => {
          stateRef.current = visibleState(snapshot);
          setState(stateRef.current);
        },
      ),
    [],
  );
  useEffect(() => {
    const draftStorageError = () =>
      setError(
        'No se pudo guardar el borrador en este equipo. Se conserva mientras la app siga abierta; copia el texto antes de cerrarla.',
      );
    window.addEventListener('agent-desk:draft-storage-error', draftStorageError);
    const off = window.desk.subscribe((e) => {
      if (e.type === 'state') snapshotSync.receive(e.state);
      if (e.type === 'chatDocked' && !floatingSessionId) {
        setClosedSelection(undefined);
        setMultichat('off');
      }
      if (e.type === 'browserOpened' && !floatingSessionId) {
        setShowBrowser(true);
        setBrowserTab(e.tabId ?? e.sessionId);
      }
      if (e.type === 'shortcut') {
        if (e.action === 'resetStyles') resetStyles();
        else if (e.action === 'search') {
          setAttentionOpen(false);
          setSettings(false);
          setSearch(true);
          setQuery('');
          setSearchIndex(0);
        } else {
          setAttentionOpen(false);
          setSearch(false);
          setSettings(true);
        }
      }
    });
    void snapshotSync.refresh().catch((e) => setError(actionError(e)));
    return () => {
      off();
      window.removeEventListener('agent-desk:draft-storage-error', draftStorageError);
      snapshotSync.invalidate();
    };
  }, []);
  const accountProfiles = state?.profiles ?? [];
  const project = state?.projects.find((p) => p.id === state.selectedProject),
    selectedSession = state?.sessions.find((s) => s.id === state.selectedSession),
    session =
      selectedSession && selectedSession.id === closedSelection ? undefined : selectedSession,
    profile = selectedSession?.profile ?? state?.defaultProfile ?? accountProfiles[0]?.id,
    kind = providerKind(profile);
  const availability = workspaceAvailability(state);
  const { hasAccounts, hasProjects, hasChats, canBrowse } = availability;
  const onboarding = !floatingSessionId && (!hasAccounts || !hasProjects);
  const gridVisible = hasChats && multichat === 'grid';
  const browserVisible = canBrowse && showBrowser && !onboarding;
  useEffect(() => {
    if (!hasChats) setMultichat('off');
  }, [hasChats]);
  useEffect(() => {
    if (!canBrowse) setShowBrowser(false);
  }, [canBrowse, project?.id]);
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
  }, [selectedSession?.id, closedSelection, hiddenChats]);
  const openTabs = selectedSession
    ? (tabs[sessionGroup(selectedSession)] ?? [])
        .map((id) => state?.sessions.find((s) => s.id === id))
        .filter((s): s is Session => !!s)
    : [];
  // Session creation order keeps tabs stationary when navigating; MRU only controls eviction.
  openTabs.sort((a, b) => state!.sessions.indexOf(a) - state!.sessions.indexOf(b));
  useEffect(() => {
    try {
      localStorage.setItem('agent-desk.multichat-dismissed.v1', JSON.stringify(hiddenChats));
    } catch {}
  }, [hiddenChats]);
  const closeTab = async (s: Session, remove = false, confirmed = false) => {
    if (!confirmed && (remove || live(stateRef.current?.sessions.find((x) => x.id === s.id)))) {
      setConfirmClose({ session: s, remove });
      return;
    }
    const wasSelected = stateRef.current?.selectedSession === s.id;
    if (remove) {
      deleting.current.add(s.id);
      if (stateRef.current) {
        snapshotSync.receive(stateRef.current);
      }
      const deleted = await run({ type: 'deleteSession', sessionId: s.id });
      deleting.current.delete(s.id);
      if (!deleted) {
        // A failed cleanup keeps the chat; restore it from the persisted state.
        await snapshotSync.refresh().catch(() => {});
        return;
      }
      const withoutDeleted = <T,>(values: Record<string, T>) => {
        const { [s.id]: removed, ...remaining } = values;
        return remaining;
      };
      setDrafts(withoutDeleted);
      setImageDrafts(withoutDeleted);
      setHiddenChats((ids) => ids.filter((id) => id !== s.id));
    }
    const remaining = (tabs[sessionGroup(s)] ?? []).filter((id) => id !== s.id);
    setTabs((v) => ({ ...v, [sessionGroup(s)]: remaining }));
    if (wasSelected || recentSessions.current[s.projectId] === s.id)
      recentSessions.current[s.projectId] = remaining.at(-1) ?? null;
    if (wasSelected) {
      setClosedSelection(s.id);
      await run({ type: 'select', projectId: s.projectId, sessionId: remaining.at(-1) ?? null });
    }
  };
  if (session) recentSessions.current[session.projectId] = session.id;
  const selectProjectBrowser = (projectId?: string) => {
    setBrowserTab(stateRef.current?.browsers?.find((tab) => tab.projectId === projectId)?.id);
  };
  useEffect(() => {
    selectProjectBrowser(project?.id);
  }, [project?.id]);
  const switchProject = async (projectId: string) => {
    // null records an explicitly closed project; undefined means it has not been visited yet.
    const previousId = recentSessions.current[projectId];
    const available = stateRef.current?.sessions.filter((s) => s.projectId === projectId) ?? [];
    const sessionId =
      previousId === null
        ? null
        : (available.find((s) => s.id === previousId)?.id ?? available.at(-1)?.id ?? null);
    const result = await run({ type: 'select', projectId, sessionId });
    if (stateRef.current?.selectedProject === projectId) {
      setMultichat('off');
      selectProjectBrowser(projectId);
    }
    return result;
  };

  const run = async (action: Action) => {
    if ((action.type === 'select' && action.sessionId) || action.type === 'newSession')
      setClosedSelection(undefined);
    if (action.type === 'login') {
      setSettings(true);
      return;
    }
    const navigation =
      action.type === 'select' ||
      action.type === 'newSession' ||
      action.type === 'changeSessionAccount';
    if (navigation && navigationInFlight.current) return;
    if (navigation) {
      navigationInFlight.current = true;
      setNavigating(true);
    }
    const key =
      action.type === 'refreshModels'
        ? `models:${action.sessionId}`
        : (('sessionId' in action ? action.sessionId : undefined) ?? action.type);
    pendingActions.current.set(key, (pendingActions.current.get(key) ?? 0) + 1);
    setBusy((v) => ({ ...v, [key]: true }));
    try {
      setError('');
      assertCompatibleAction(stateRef.current, action);
      const r = await window.desk.invoke(action);
      if (action.type === 'restartApp') return r;
      // The action has already succeeded. A refresh failure must not invite a
      // duplicate send or restore attachments that the provider has accepted.
      await snapshotSync
        .refresh()
        .catch((e) =>
          setError(`La acción se completó, pero no se pudo actualizar la vista: ${actionError(e)}`),
        );
      if (navigation) {
        setClosedSelection(undefined);
      }
      return r;
    } catch (e) {
      setError(actionError(e));
      return undefined;
    } finally {
      if (navigation) {
        navigationInFlight.current = false;
        setNavigating(false);
      }
      const remaining = (pendingActions.current.get(key) ?? 1) - 1;
      if (remaining) pendingActions.current.set(key, remaining);
      else {
        pendingActions.current.delete(key);
        setBusy((v) => {
          const next = { ...v };
          delete next[key];
          return next;
        });
      }
    }
  };
  const runRef = useRef(run);
  runRef.current = run;
  // Links, file paths and code blocks in the chat act on this project and its panels.
  const chatActions = useMemo<ChatActions>(() => {
    if (!project) return {};
    const shell = `shell:${project.id}`;
    return {
      root: session?.worktree?.cwd ?? project.path,
      openUrl: (url) =>
        void runRef.current({
          type: 'browserNew',
          projectId: project.id,
          sessionId: session?.id,
          url,
        }),
      openPath: (path) =>
        void runRef.current({
          type: 'openPath',
          projectId: project.id,
          sessionId: session?.id,
          path,
        }),
      revealPath: (path) =>
        void runRef.current({
          type: 'openPath',
          projectId: project.id,
          sessionId: session?.id,
          path,
          reveal: true,
        }),
      runCommand: async (command) => {
        setTerminalTarget('default');
        const fresh = !stateRef.current?.terminals?.some((t) => t.id === shell);
        setShowTerminalPanel(true);
        await runRef.current({ type: 'openProjectTerminal', projectId: project.id });
        if (fresh) await new Promise((resolve) => setTimeout(resolve, 600));
        // Bracketed paste: the shell shows the command and waits for Enter.
        await runRef.current({
          type: 'terminalWrite',
          sessionId: shell,
          data: `\x1b[200~${command}\x1b[201~`,
        });
        document.querySelector<HTMLElement>('.terminal-pane .xterm-helper-textarea')?.focus();
      },
      showChanges: () => setShowDiff(true),
      reuse: (text) => {
        if (!session) return;
        setDrafts((d) => ({ ...d, [session.id]: text }));
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
        );
      },
      rewind: async (message, dryRun) =>
        session
          ? ((await runRef.current({
              type: 'rewindFiles',
              sessionId: session.id,
              messageId: message.id,
              dryRun,
            })) as RewindResult | undefined)
          : undefined,
    };
  }, [project?.id, project?.path, session?.id, session?.worktree?.cwd]);
  // History starts read; new completions remain in the queue until their chat is visible.
  const readBaseline = useRef(false);
  const attentionStatuses = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!state) return;
    const initial = !readBaseline.current;
    readBaseline.current = true;
    const reading = () =>
      document.hasFocus() &&
      !document.hidden &&
      stick &&
      multichat !== 'grid' &&
      !attentionOpen &&
      !search &&
      !settings &&
      !confirmClose &&
      !removeId
        ? session?.id
        : undefined;
    const completed = state.sessions
      .filter(
        (s) =>
          attentionStatuses.current[s.id] === 'working' &&
          s.status === 'ready' &&
          s.id !== reading(),
      )
      .map((s) => s.id);
    attentionStatuses.current = Object.fromEntries(state.sessions.map((s) => [s.id, s.status]));
    const markRead = () => {
      const active = reading();
      // A completion belongs to this snapshot, not to every later focus event.
      const newlyCompleted = completed.splice(0);
      setSeen((previous) => {
        const next: Record<string, number> = {};
        for (const s of state.sessions)
          next[s.id] = s.id === active || initial ? s.messages.length : (previous[s.id] ?? 0);
        return Object.keys(previous).length === state.sessions.length &&
          state.sessions.every((s) => previous[s.id] === next[s.id])
          ? previous
          : next;
      });
      setUnreadCompleted((previous) => {
        const next = new Set(
          [...previous, ...newlyCompleted].filter(
            (id) => id !== active && state.sessions.some((s) => s.id === id),
          ),
        );
        return next.size === previous.size && [...next].every((id) => previous.has(id))
          ? previous
          : next;
      });
    };
    markRead();
    window.addEventListener('focus', markRead);
    document.addEventListener('visibilitychange', markRead);
    return () => {
      window.removeEventListener('focus', markRead);
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [
    state?.sessions,
    session?.id,
    multichat,
    stick,
    attentionOpen,
    search,
    settings,
    confirmClose,
    removeId,
  ]);
  // Only the editor emits notifications; floating renderers share its state.
  // System notification when a background turn finishes or needs an answer.
  const lastStatus = useRef<Record<string, { status: string; approvals: number }>>({});
  useEffect(() => {
    if (!state) return;
    if (floatingSessionId) return;
    const previous = lastStatus.current;
    const next: typeof previous = {};
    for (const s of state.sessions) {
      next[s.id] = { status: s.status, approvals: s.approvals.length };
      const before = previous[s.id];
      if (!before || !appearance.preferences.notifications) continue;
      const finished = before.status === 'working' && s.status === 'ready';
      const asks = s.approvals.length > before.approvals;
      const focused = document.hasFocus() && s.id === state.selectedSession;
      if ((!finished && !asks) || focused || typeof Notification === 'undefined') continue;
      try {
        const agent = providerNames[providerKind(s.profile)];
        const n = new Notification(
          asks ? `${agent} necesita tu respuesta` : `${agent} ha terminado`,
          {
            body: `${state.projects.find((p) => p.id === s.projectId)?.name ?? ''} · ${s.title}`,
            silent: !asks,
          },
        );
        n.onclick = () => {
          window.focus();
          void runRef.current({ type: 'select', projectId: s.projectId, sessionId: s.id });
        };
      } catch {
        /* notifications unavailable */
      }
    }
    lastStatus.current = next;
  }, [state]);
  useEffect(() => {
    if (
      !state ||
      !compatibleRuntime(state) ||
      !session ||
      session.mode === 'terminal' ||
      session.modelsLoading ||
      session.modelsError ||
      session.info?.models.length
    )
      return;
    if (!['stopped', 'error'].includes(session.status)) return;
    void run({ type: 'refreshModels', sessionId: session.id });
  }, [
    session?.id,
    session?.profile,
    state?.runtime?.protocol,
    JSON.stringify(state?.profiles?.find((p) => p.id === session?.profile)?.modelSelection),
  ]);
  const sessionIds = state?.sessions.map((s) => s.id).join(',');
  useEffect(() => {
    if (!state) return;
    const ids = new Set([...state.sessions.map((s) => s.id), ...deleting.current]);
    const projects = new Set(state.projects.map((p) => p.id));
    const prune = <T,>(values: Record<string, T>) => {
      const entries = Object.entries(values).filter(([id]) => ids.has(id));
      return entries.length === Object.keys(values).length ? values : Object.fromEntries(entries);
    };
    setDrafts(prune);
    setImageDrafts(prune);
    setTabs((v) =>
      Object.fromEntries(
        Object.entries(v)
          .filter(([id]) => projects.has(id))
          .map(([id, tabs]) => [id, tabs.filter((tab) => ids.has(tab))]),
      ),
    );
    for (const id of Object.keys(recentSessions.current))
      if (!projects.has(id)) delete recentSessions.current[id];
    setDiff(undefined);
  }, [sessionIds]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (floatingSessionId && (e.metaKey || e.ctrlKey) && ['n', 'k'].includes(e.key)) {
        e.preventDefault();
        return;
      }
      // Modal controls own their keystrokes; never create a chat or change permissions behind one.
      const modal = search || settings || attentionOpen || confirmClose || removeId;
      const attentionShortcut =
        (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a';
      if (
        modal &&
        e.key !== 'Escape' &&
        !((e.metaKey || e.ctrlKey) && ['k', ','].includes(e.key)) &&
        !(attentionOpen && attentionShortcut)
      )
        return;
      const s = stateRef.current?.sessions.find((x) => x.id === stateRef.current?.selectedSession);
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (confirmClose || removeId) return;
        setAttentionOpen(false);
        setSettings(false);
        setSearch((v) => !v);
        setQuery('');
        setSearchIndex(0);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        if (confirmClose || removeId) return;
        setAttentionOpen(false);
        setSearch(false);
        setSettings((v) => !v);
      } else if (attentionShortcut) {
        e.preventDefault();
        setAttentionOpen((open) => !open);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (s) void run({ type: 'newSession', projectId: s.projectId });
      } else if (
        e.key === 'Tab' &&
        e.shiftKey &&
        s &&
        providerKind(s.profile) === 'claude' &&
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
        if (search || settings || attentionOpen || confirmClose || removeId) {
          e.preventDefault();
          setSearch(false);
          setSettings(false);
          setAttentionOpen(false);
          setConfirmClose(undefined);
          setRemoveId(undefined);
        } else if (multichat === 'focused') {
          e.preventDefault();
          setMultichat('grid');
        } else if (multichat === 'grid') {
          return;
        } else if (s && (s.status === 'working' || s.status === 'waiting') && s.mode !== 'terminal')
          void run({ type: 'interrupt', sessionId: s.id });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [search, settings, attentionOpen, confirmClose, removeId, multichat]);
  const refreshDiff = async () => {
    if (!project) return;
    const request = ++diffRequest.current;
    diffReads.current++;
    setDiffError('');
    try {
      const d = await window.desk.invoke({
        type: 'diff',
        projectId: project.id,
        sessionId: session?.worktree ? session.id : undefined,
        ...(compatibleRuntime(stateRef.current) ? { summaryOnly: !showDiff } : {}),
      });
      if (request === diffRequest.current) setDiff(d);
    } catch (e) {
      if (request === diffRequest.current) setDiffError((e as Error).message);
    } finally {
      diffReads.current--;
    }
  };
  useEffect(() => {
    setStick(true);
  }, [session?.id]);
  // A permission or question blocks the agent: bring it into view even after scrolling up.
  const approvals = session?.approvals.length ?? 0;
  const previousApprovals = useRef(approvals);
  useEffect(() => {
    if (approvals > previousApprovals.current) setStick(true);
    previousApprovals.current = approvals;
  }, [approvals, session?.id]);
  useEffect(() => {
    setDiff(undefined);
    setDiffError('');
  }, [project?.id, session?.worktree?.path]);
  useEffect(() => {
    if (!project || !hasAccounts || gridVisible) return;
    const refresh = () => {
      if (!document.hidden && diffReads.current === 0) void refreshDiff();
    };
    if (!document.hidden) void refreshDiff();
    const onFocus = refresh;
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, showDiff || showTerminalPanel ? 15000 : 30000);
    return () => {
      diffRequest.current++;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(timer);
    };
  }, [project?.id, hasAccounts, gridVisible, showDiff, showTerminalPanel, session?.worktree?.path]);
  useEffect(() => {
    if (
      showTerminalPanel &&
      terminalTarget === 'default' &&
      project &&
      !(!isCodex(session?.profile) && session?.mode === 'terminal')
    )
      void run({ type: 'openProjectTerminal', projectId: project.id });
  }, [project?.id, showTerminalPanel, session?.mode, terminalTarget]);
  useEffect(() => setTerminalTarget('default'), [project?.id, session?.id]);
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
    // Working/waiting/ready transitions can occur many times in one turn. Account
    // quota polling belongs to the account, not to every change in agent activity.
  }, [profile, project?.id, state?.runtime?.protocol]);
  const last = session?.messages.at(-1);
  const lastBlocks = last?.blocks?.length ?? 0;
  const lastText = last?.blocks?.at(-1);
  useEffect(() => {
    if (stick && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [
    session?.id,
    session?.messages.length,
    last?.text.length,
    lastBlocks,
    lastText && 'text' in lastText ? lastText.text.length : 0,
    lastText && 'result' in lastText ? lastText.result?.length : 0,
    session?.approvals.length,
    session?.status,
    multichat,
    stick,
  ]);
  const deferredQuery = useDeferredValue(query);
  // Opening/clearing the palette must show its full list immediately; otherwise
  // fast arrow navigation would still operate on the previous filtered list.
  const searchQuery = query.trim() ? deferredQuery : query;
  const results = useMemo(
    () => (search && state ? searchWorkspace(state, searchQuery, statusLabels) : []),
    [search, state, searchQuery],
  );
  const selectedSearchIndex = Math.min(searchIndex, Math.max(0, results.length - 1));
  useLayoutEffect(() => {
    if (search)
      document
        .querySelector<HTMLElement>('.palette-results .on')
        ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [search, selectedSearchIndex, results]);
  if (!state)
    return (
      <div className="loading" role={error ? 'alert' : 'status'}>
        {error ? (
          <>
            <p>No se pudo abrir Agent Desk: {error}</p>
            <button
              onClick={() => {
                setError('');
                void snapshotSync.refresh().catch((e) => setError(actionError(e)));
              }}
            >
              Reintentar
            </button>
          </>
        ) : (
          'Abriendo Agent Desk…'
        )}
      </div>
    );
  const attention = attentionItems(state.sessions, seen, unreadCompleted);
  const choose = (r: (typeof results)[number]) => {
    void run({ type: 'select', projectId: r.projectId, sessionId: r.sessionId });
    setSearch(false);
  };
  const tabState = (s: Session) =>
    s.approvals.length || s.status === 'waiting'
      ? 'waiting'
      : s.status === 'working' || s.status === 'starting'
        ? 'working'
        : s.status === 'error' || s.error
          ? 'error'
          : s.id !== session?.id && (seen[s.id] ?? s.messages.length) < s.messages.length
            ? 'unread'
            : 'idle';
  const terminalMode = !isCodex(session?.profile) && session?.mode === 'terminal';
  const antigravityChat =
    providerKind(session?.profile) === 'gemini' &&
    /[/\\]agy(?:\.exe)?$/.test(state.tools.gemini ?? '');
  const needsGeminiPermission = antigravityChat && antigravityPermissionNeeded(session);
  const reviewGeminiPermission = async () => {
    if (!session) return;
    const ok = await run({ type: 'continueAntigravity', sessionId: session.id });
    if (ok && stateRef.current?.selectedSession === session.id) {
      setTerminalTarget('default');
      setShowTerminalPanel(true);
      setStick(true);
    }
  };
  const returnToChat = async () => {
    if (!session) return;
    if (live(session)) await run({ type: 'stop', sessionId: session.id });
    setShowTerminalPanel(false);
    if (!(await run({ type: 'setMode', sessionId: session.id, mode: 'chat' })))
      setShowTerminalPanel(true);
  };
  const freebuffPanel = !!state.freebuffEnabled && terminalTarget === 'freebuff';
  const terminalSession = freebuffPanel
    ? state.terminals?.find((t) => t.id === `freebuff:${project?.id}`)
    : terminalMode && session
      ? session
      : state.terminals?.find((t) => t.id === `shell:${project?.id}`);
  const openFreebuff = async () => {
    if (!project) return;
    const opened = await run({ type: 'openFreebuff', projectId: project.id });
    if (!opened || stateRef.current?.selectedProject !== project.id) return;
    setTerminalTarget('freebuff');
    setShowTerminalPanel(true);
    setSettings(false);
  };
  const toggleTerminal = () => {
    if (!project) return;
    setShowTerminalPanel((v) => !v);
    if (!showTerminalPanel && freebuffPanel) {
      void openFreebuff();
      return;
    }
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
        setTerminalTarget('default');
        setShowTerminalPanel(true);
        void run({ type: 'openProjectTerminal', projectId: project.id });
      }
      return true;
    }
    void arg;
    return false;
  };
  const sendText = async (s: Session, text: string, images: Attachment[]) => {
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
  const addBrowserContext = async (tab: BrowserState) => {
    const target = session;
    if (!target || target.mode === 'terminal' || target.projectId !== tab.projectId)
      throw new Error('Abre un chat del mismo proyecto para añadir esta página.');
    const evidence = await captureBrowserContext(tab, (action) => window.desk.invoke(action));
    const stillExists = () => stateRef.current?.sessions.some((s) => s.id === target.id);
    if (!stillExists()) throw new Error('El chat se ha cerrado antes de completar la captura.');
    const attachments: Attachment[] = await window.desk.invoke({
      type: 'dropImages',
      sessionId: target.id,
      images: [evidence.image],
    });
    if (!attachments.length) throw new Error('No se pudo añadir la captura al borrador.');
    if (!stillExists()) {
      await window.desk
        .invoke({
          type: 'discardImages',
          sessionId: target.id,
          attachmentIds: attachments.map((a) => a.id),
        })
        .catch(() => {});
      throw new Error('El chat se ha cerrado antes de completar la captura.');
    }
    setDrafts((drafts) => ({
      ...drafts,
      [target.id]: [drafts[target.id]?.trimEnd(), evidence.text].filter(Boolean).join('\n\n'),
    }));
    setImageDrafts((images) => ({
      ...images,
      [target.id]: [...(images[target.id] ?? []), ...attachments],
    }));
    if (stateRef.current?.selectedSession === target.id)
      requestAnimationFrame(() =>
        document.querySelector<HTMLTextAreaElement>('.workspace .composer textarea')?.focus(),
      );
  };
  const terminalButton = (
    <button
      className={`terminal-toggle ${showTerminalPanel ? 'on' : ''}`}
      disabled={!project}
      aria-label="Terminal"
      title={`Terminal · Panel ${terminalPosition === 'right' ? 'derecho' : 'inferior'}`}
      aria-pressed={showTerminalPanel}
      onClick={toggleTerminal}
    >
      <Terminal size={17} />
    </button>
  );
  const toggleBrowser = async () => {
    if (!canBrowse) return;
    if (browserVisible && !gridVisible) {
      setShowBrowser(false);
      return;
    }
    // A manually selected tab can belong to another project. Hiding the panel
    // must not change that selection when its page is still available.
    const tab =
      state.browsers?.find(
        (t) => t.id === browserTab && t.url && (!isLocalPage(t.url) || t.hostStatus === 'online'),
      ) ?? availability.browserTabs[0];
    setMultichat('off');
    if (tab) {
      setBrowserTab(tab.id);
      setShowBrowser(true);
      if (tab.suspended)
        await run({
          type: 'browserTab',
          tabId: tab.id,
          input: { action: 'navigate', url: tab.url },
        });
    } else {
      const server = availability.servers[0];
      if (server) {
        // Keep existing tabs reachable if creating a preview fails (for example
        // at the saved-tab limit), so the user can close one and retry.
        setBrowserTab(undefined);
        setShowBrowser(true);
        await run({
          type: 'browserNew',
          projectId: server.projectId,
          sessionId: state.sessions.some((s) => s.id === server.sessionId)
            ? server.sessionId
            : undefined,
          url: server.url,
        });
      }
    }
  };
  const browserPanel = browserVisible && (
    <React.Suspense
      fallback={
        <div className="tool-pane muted" role="status">
          Abriendo navegador…
        </div>
      }
    >
      <BrowserPanel
        tabs={state.browsers ?? []}
        selected={browserTab}
        select={setBrowserTab}
        projectId={project?.id}
        sessionId={session?.id}
        projects={state.projects}
        blocked={
          split.dragging ||
          terminalSplit.dragging ||
          search ||
          settings ||
          attentionOpen ||
          !!confirmClose ||
          !!removeId ||
          !!error
        }
        close={() => setShowBrowser(false)}
        onError={setError}
        onCaptureContext={
          session && session.mode !== 'terminal' && compatibleRuntime(state)
            ? addBrowserContext
            : undefined
        }
      />
    </React.Suspense>
  );
  const floatingPreferences = state.floatingChats?.find((f) => f.sessionId === session?.id);
  // A floating window wears its account colour; the page paints it with the chosen transparency.
  const { backgroundColor: floatingTint, ...floatingAccountStyle } =
    (floatingSessionId &&
      accountCardStyle(state.profiles?.find((p) => p.id === session?.profile)?.color)) ||
    {};
  if (floatingTint)
    (floatingAccountStyle as Record<string, unknown>)['--floating-tint'] = floatingTint;
  const detached = !floatingSessionId && !!floatingPreferences;
  return (
    <div
      className={`app ${onboarding ? 'onboarding' : ''} ${floatingSessionId ? 'floating-chat-app' : ''}`}
      style={
        {
          ...appearance.style,
          ...(floatingSessionId
            ? {
                ...floatingAccountStyle,
                '--floating-window-opacity': `${(floatingPreferences?.opacity ?? 1) * 100}%`,
              }
            : {}),
        } as React.CSSProperties
      }
    >
      {hasAccounts && (
        <aside
          className={`sidebar compact ${sidebarCollapsed ? 'collapsed' : ''} ${!hasProjects ? 'onboarding-sidebar' : ''}`}
        >
          {hasProjects && (
            <>
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
                  <div
                    key={p.id}
                    className={`project-block ${p.id === project?.id ? 'selected' : ''} ${draggedProject === p.id ? 'dragging' : ''} ${projectDrop === p.id ? 'drop-target' : ''}`}
                    data-project-id={p.id}
                    onDragOver={(e) => {
                      if (!projectDrag.current || projectDrag.current === p.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setProjectDrop(p.id);
                    }}
                    onDrop={(e) => {
                      const source = projectDrag.current;
                      if (!source || source === p.id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      finishProjectDrag();
                      void run({ type: 'moveProject', projectId: source, targetProjectId: p.id });
                    }}
                  >
                    <div className="project-row">
                      {editingName?.kind === 'project' && editingName.id === p.id ? (
                        <EditableName
                          value={p.name}
                          label="Nombre del proyecto"
                          close={() => setEditingName(undefined)}
                          save={(name) =>
                            void run({ type: 'renameProject', projectId: p.id, name })
                          }
                        />
                      ) : (
                        <button
                          className="project-name"
                          draggable={compatibleRuntime(state) && !navigating && !busy.moveProject}
                          onDragStart={(e) => {
                            projectDrag.current = p.id;
                            suppressProjectClick.current = true;
                            setDraggedProject(p.id);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('application/x-agent-desk-project', p.id);
                          }}
                          onDragEnd={finishProjectDrag}
                          onKeyDown={(e) => {
                            if (
                              !compatibleRuntime(state) ||
                              busy.moveProject ||
                              !e.altKey ||
                              !['ArrowUp', 'ArrowDown'].includes(e.key)
                            )
                              return;
                            e.preventDefault();
                            const projects = stateRef.current?.projects ?? [];
                            const index = projects.findIndex((x) => x.id === p.id);
                            const target = projects[index + (e.key === 'ArrowUp' ? -1 : 1)];
                            if (target)
                              void run({
                                type: 'moveProject',
                                projectId: p.id,
                                targetProjectId: target.id,
                              }).then(() =>
                                requestAnimationFrame(() =>
                                  document
                                    .querySelector<HTMLButtonElement>(
                                      `[data-project-id="${CSS.escape(p.id)}"] .project-name`,
                                    )
                                    ?.focus(),
                                ),
                              );
                          }}
                          title={`${p.path} · Arrastra para ordenar · Alt + ↑/↓ para mover`}
                          aria-disabled={navigating}
                          aria-label={p.name}
                          aria-current={p.id === project?.id ? 'page' : undefined}
                          onClick={(e) => {
                            if (e.detail < 2 && !suppressProjectClick.current) {
                              void switchProject(p.id);
                            }
                          }}
                          onDoubleClick={() => {
                            if (suppressProjectClick.current) return;
                            setSidebarCollapsed(false);
                            setEditingName({ kind: 'project', id: p.id });
                          }}
                        >
                          <ProjectMark identity={p.path} />
                          <span className="project-label">{p.name}</span>
                          {state.sessions.some((s) => s.projectId === p.id && live(s)) && (
                            <i
                              className={`live-dot ${state.sessions.some((s) => s.projectId === p.id && s.approvals.length) ? 'waiting' : ''}`}
                            />
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
                    <ProjectChats
                      state={state}
                      projectId={p.id}
                      hiddenChats={[]}
                      remove={(s) => void closeTab(s, true)}
                      open={(s) => {
                        setClosedSelection(undefined);
                        setMultichat('off');
                        void run({ type: 'select', projectId: s.projectId, sessionId: s.id });
                      }}
                    />
                  </div>
                ))}
              </nav>
            </>
          )}
          <div className="sidebar-bottom sidebar-controls">
            <button
              aria-label={sidebarCollapsed ? 'Expandir proyectos' : 'Plegar proyectos'}
              title={sidebarCollapsed ? 'Expandir proyectos' : 'Plegar proyectos'}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((v) => !v)}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
            <button aria-label="Ajustes" title="Ajustes (⌘,)" onClick={() => setSettings(true)}>
              <Settings2 size={15} />
            </button>
          </div>
        </aside>
      )}
      <main>
        {(!compatibleRuntime(state) || state.runtime?.updateAvailable) && (
          <div className="runtime-notice" role="status">
            <RefreshCw size={13} aria-hidden="true" />
            <span title={RESTART_NOTICE}>
              {compatibleRuntime(state)
                ? 'Actualización preparada'
                : 'Actualiza la app para continuar'}
            </span>
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
          <div className="topbar-slot" ref={setTopbarSlot} />
          <div className="top-actions">
            {hasChats && (attention.length > 0 || attentionOpen) && (
              <button
                className={`attention-trigger ${attentionOpen ? 'on' : ''}`}
                aria-label="Centro de atención"
                title={`${attention.length} chats por revisar · ⌘⇧A`}
                aria-haspopup="dialog"
                aria-expanded={attentionOpen}
                onClick={() => setAttentionOpen((open) => !open)}
              >
                <Inbox size={17} />
                {!!attention.length && <span className="attention-badge">{attention.length}</span>}
              </button>
            )}
            {hasChats && multichat === 'focused' && (
              <button
                className="multichat-back"
                onClick={() => setMultichat('grid')}
                title="Volver a Multichat (Esc)"
                aria-label="Volver al grid"
              >
                <ArrowLeft size={15} />
              </button>
            )}
            {hasChats && (
              <button
                className={gridVisible ? 'on' : ''}
                aria-label="Multichat"
                title="Multichat · Todos los proyectos"
                aria-pressed={gridVisible}
                onClick={() => setMultichat((v) => (v === 'grid' ? 'off' : 'grid'))}
              >
                <LayoutGrid size={17} />
              </button>
            )}
            {canBrowse && (
              <button
                className={browserVisible ? 'on' : ''}
                aria-label="Navegador"
                title="Navegador"
                aria-pressed={browserVisible}
                disabled={!compatibleRuntime(state)}
                onClick={() => void toggleBrowser()}
              >
                <Globe size={17} />
              </button>
            )}
          </div>
        </header>
        {!floatingSessionId && hasChats && (
          <Multichat
            dismissed={hiddenChats}
            toggleHidden={(id) =>
              setHiddenChats((ids) =>
                ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
              )
            }
            close={(s) => void closeTab(s, true)}
            drafts={drafts}
            setDrafts={setDrafts}
            images={imageDrafts}
            setImages={setImageDrafts}
            busy={busy}
            run={run}
            send={sendText}
            openDev={(s, url) =>
              void run({
                type: 'openDevInChrome',
                sessionId: s.id,
                port: Number(new URL(url).port || (new URL(url).protocol === 'https:' ? 443 : 80)),
              })
            }
            actionsFor={(s) => {
              const activate = async () => {
                await run({ type: 'select', projectId: s.projectId, sessionId: s.id });
                if (stateRef.current?.selectedSession !== s.id) return false;
                setMultichat('focused');
                return true;
              };
              return {
                root: s.worktree?.cwd ?? state.projects.find((p) => p.id === s.projectId)?.path,
                openUrl: async (url) => {
                  if (await activate()) {
                    setShowBrowser(true);
                    await run({ type: 'browserNew', projectId: s.projectId, sessionId: s.id, url });
                  }
                },
                openPath: (path) =>
                  void run({ type: 'openPath', projectId: s.projectId, sessionId: s.id, path }),
                revealPath: (path) =>
                  void run({
                    type: 'openPath',
                    projectId: s.projectId,
                    sessionId: s.id,
                    path,
                    reveal: true,
                  }),
                rewind: async (message, dryRun) =>
                  (await run({
                    type: 'rewindFiles',
                    sessionId: s.id,
                    messageId: message.id,
                    dryRun,
                  })) as RewindResult | undefined,
                showChanges: async () => {
                  if (await activate()) setShowDiff(true);
                },
                reuse: (text) => {
                  setDrafts((v) => ({ ...v, [s.id]: text }));
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLTextAreaElement>(
                        `[data-session-id="${CSS.escape(s.id)}"] textarea`,
                      )
                      ?.focus(),
                  );
                },
                runCommand: async (command) => {
                  if (!(await activate())) return;
                  setTerminalTarget('default');
                  setShowTerminalPanel(true);
                  const shell = `shell:${s.projectId}`;
                  const fresh = !stateRef.current?.terminals?.some((t) => t.id === shell);
                  await run({ type: 'openProjectTerminal', projectId: s.projectId });
                  if (fresh) await new Promise((resolve) => setTimeout(resolve, 600));
                  await run({
                    type: 'terminalWrite',
                    sessionId: shell,
                    data: `\x1b[200~${command}\x1b[201~`,
                  });
                  document
                    .querySelector<HTMLElement>('.terminal-pane .xterm-helper-textarea')
                    ?.focus();
                },
              };
            }}
            state={state}
            visible={gridVisible}
            toolbar={topbarSlot}
            disabled={navigating}
            open={async (s) => {
              await run({ type: 'select', projectId: s.projectId, sessionId: s.id });
              if (stateRef.current?.selectedSession === s.id) setMultichat('focused');
            }}
          />
        )}
        {gridVisible ? null : onboarding || !project ? (
          <div className="welcome">
            <DeskMark size={42} />
            <h1>{hasAccounts ? 'Tu espacio de trabajo' : 'Empieza con tu cuenta'}</h1>
            <p>
              {hasAccounts
                ? 'Abre un proyecto para empezar.'
                : 'Añade una cuenta para empezar a trabajar con tus agentes.'}
            </p>
            {!hasAccounts ? (
              <button className="primary large" onClick={() => setSettings(true)}>
                <Plus size={16} />
                Añadir cuenta
              </button>
            ) : (
              <button className="primary large" onClick={() => run({ type: 'addProject' })}>
                <Plus size={16} />
                Añadir proyecto
              </button>
            )}
          </div>
        ) : (
          <div
            ref={terminalSplit.ref}
            style={terminalSplit.style}
            className={`work-area ${showTerminalPanel && terminalPosition === 'right' ? 'terminal-at-right' : ''} ${terminalSplit.dragging ? 'resizing' : ''}`}
          >
            <div
              ref={split.ref}
              style={split.style}
              className={`workspace ${showDiff || browserVisible ? 'with-tools' : ''} ${split.dragging ? 'resizing' : ''}`}
            >
              <ChatActionsContext.Provider value={chatActions}>
                <section className="conversation">
                  {floatingSessionId && session ? (
                    <FloatingChatHeader
                      session={session}
                      project={project.name}
                      preferences={floatingPreferences}
                      run={run}
                    />
                  ) : (
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
                                save={(title) =>
                                  void run({ type: 'rename', sessionId: s.id, title })
                                }
                              />
                            ) : (
                              <button
                                role="tab"
                                className={`tab-${tabState(s)}`}
                                aria-selected={s.id === session?.id}
                                tabIndex={s.id === session?.id ? 0 : -1}
                                onKeyDown={navigateTabs}
                                aria-controls="conversation-content"
                                aria-disabled={navigating}
                                title={`${s.title} · ${live(s) ? 'Proceso abierto' : 'Proceso parado'}`}
                                aria-description={live(s) ? 'Proceso abierto' : 'Proceso parado'}
                                onClick={() =>
                                  run({ type: 'select', projectId: project.id, sessionId: s.id })
                                }
                                onDoubleClick={() => setEditingName({ kind: 'session', id: s.id })}
                              >
                                <i className="tab-state" aria-hidden="true" />
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
                      {session && (
                        <FloatChatButton
                          session={session}
                          floating={detached}
                          run={run}
                          disabled={!!busy[session.id] || !compatibleRuntime(state)}
                        />
                      )}
                      {session && (
                        <TeamIndicator
                          key={session.id}
                          session={session}
                          sessions={state.sessions}
                          open={(s) => {
                            setClosedSelection(undefined);
                            void run({ type: 'select', projectId: s.projectId, sessionId: s.id });
                          }}
                        />
                      )}
                      <button
                        className="icon-btn ghost new-tab"
                        title="Nueva conversación (⌘N)"
                        disabled={navigating || !profile}
                        aria-label="Nueva conversación"
                        onClick={() =>
                          profile && run({ type: 'newSession', projectId: project.id })
                        }
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  )}
                  {!session && (
                    <div className="empty no-session">
                      <DeskMark size={36} />
                      <h2>{accountProfiles.length ? 'Todo listo' : 'Conecta tu cuenta'}</h2>
                      <p>
                        {accountProfiles.length
                          ? 'Empieza un chat o recupera uno con ⌘K.'
                          : 'Elige un proveedor en Ajustes para empezar.'}
                      </p>
                      {!!accountProfiles.length && (
                        <button
                          className="primary"
                          disabled={navigating || !profile}
                          onClick={() =>
                            profile && run({ type: 'newSession', projectId: project.id })
                          }
                        >
                          <Plus size={16} /> Nuevo chat
                        </button>
                      )}
                      {!accountProfiles.length && (
                        <button className="primary" onClick={() => setSettings(true)}>
                          <Plus size={16} /> Añadir cuenta
                        </button>
                      )}
                    </div>
                  )}
                  {session && detached && <DetachedChat session={session} run={run} />}
                  {session && !detached && (
                    <>
                      <IsolationBar
                        session={session}
                        sessions={state.sessions}
                        run={run}
                        disabled={navigating || !!busy[session.id] || !compatibleRuntime(state)}
                      />
                      {(state.coordination?.filter((a) => a.projectId === project.id).length ?? 0) >
                        1 && (
                        <div className="conv-head">
                          <div className="conv-title">
                            {(state.coordination?.filter((a) => a.projectId === project.id)
                              .length ?? 0) > 1 && (
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
                                {
                                  state.coordination?.filter((a) => a.projectId === project.id)
                                    .length
                                }{' '}
                                agentes · coordinación compartida
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                      {antigravityChat && !terminalMode && !needsGeminiPermission && (
                        <div className="inline-notice">
                          <span>
                            Gemini · chat. Las solicitudes de permiso se revisan en su panel
                            integrado.
                          </span>
                          <button
                            disabled={
                              !compatibleRuntime(state) ||
                              ['working', 'waiting', 'starting', 'stopping'].includes(
                                session.status,
                              ) ||
                              (!terminalMode && !session.reference?.startsWith('agy:'))
                            }
                            onClick={async () => {
                              if (live(session)) await run({ type: 'stop', sessionId: session.id });
                              const ok = await run({
                                type: 'setMode',
                                sessionId: session.id,
                                mode: terminalMode ? 'chat' : 'terminal',
                              });
                              if (!ok) return;
                              setShowTerminalPanel(!terminalMode);
                              if (!terminalMode)
                                await run({ type: 'start', sessionId: session.id });
                            }}
                          >
                            {terminalMode ? 'Volver al chat' : 'Abrir terminal Antigravity'}
                          </button>
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
                            <DeskMark size={72} />
                          </div>
                        )}
                        {terminalMode && !antigravityChat && (
                          <div className="inline-notice">
                            Esta conversación usa la terminal oficial. Ábrela con el icono Terminal
                            o crea una nueva pestaña para usar el chat.
                          </div>
                        )}
                        {isCodex(session.profile) &&
                          session.status === 'ready' &&
                          !session.account && (
                            <div className="auth-card">
                              <ShieldCheck size={22} />
                              <h2>Conecta tu cuenta de ChatGPT</h2>
                              <p>
                                Inicia sesión mediante el flujo oficial de Codex. Agent Desk no
                                solicita claves ni copia credenciales.
                              </p>
                              <button
                                className="primary"
                                disabled={session.loginPending || busy[session.id]}
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
                                  onClick={() =>
                                    run({ type: 'cancelLogin', sessionId: session.id })
                                  }
                                >
                                  Cancelar
                                </button>
                              )}
                            </div>
                          )}
                        <ConversationMessages session={session} kind={kind} />
                        {needsGeminiPermission && !terminalMode && (
                          <section
                            className="gemini-permission-card"
                            aria-label="Permiso de Gemini"
                          >
                            <ShieldCheck size={20} aria-hidden="true" />
                            <div>
                              <strong>Gemini necesita tu permiso</strong>
                              <p>
                                Revisa la solicitud aquí mismo y continúa la tarea. No hace falta
                                abrir otra pestaña ni escribir comandos.
                              </p>
                              <button
                                className="primary"
                                disabled={
                                  !compatibleRuntime(state) ||
                                  !!busy[session.id] ||
                                  ['working', 'waiting', 'starting', 'stopping'].includes(
                                    session.status,
                                  )
                                }
                                onClick={reviewGeminiPermission}
                              >
                                {busy[session.id] ? 'Abriendo revisión…' : 'Revisar y continuar'}
                              </button>
                              <small>
                                El panel de Antigravity se abrirá{' '}
                                {terminalPosition === 'right' ? 'a la derecha' : 'debajo'}. Tú
                                decides qué acciones autorizar.
                              </small>
                            </div>
                          </section>
                        )}
                        {antigravityChat && terminalMode && !showTerminalPanel && (
                          <button
                            className="gemini-show-panel"
                            onClick={() => setShowTerminalPanel(true)}
                          >
                            Mostrar panel de Gemini
                          </button>
                        )}
                        {session.approvals.map((a, i) =>
                          a.method.startsWith('provider/') ? (
                            <ProviderApproval key={a.id} approval={a} session={session} run={run} />
                          ) : a.method === 'claude/permission' ? (
                            <ClaudeApproval
                              key={a.id}
                              approval={a}
                              session={session}
                              run={run}
                              index={i}
                              total={session.approvals.length}
                            />
                          ) : (
                            <CodexApproval
                              key={a.id}
                              approval={a}
                              session={session}
                              run={run}
                              index={i}
                              total={session.approvals.length}
                            />
                          ),
                        )}
                        {!stick && session.messages.length > 0 && (
                          <button
                            className="jump-latest"
                            aria-label="Ir al final"
                            title="Ir al final"
                            onClick={() => {
                              setStick(true);
                              list.current?.scrollTo({
                                top: list.current.scrollHeight,
                                behavior: 'smooth',
                              });
                            }}
                          >
                            <ArrowDown size={14} />
                          </button>
                        )}
                      </div>
                      {!terminalMode && (
                        <>
                          {session.todos?.length &&
                          (live(session) || session.todos.some((t) => t.status !== 'completed')) ? (
                            <TodoPanel todos={session.todos} />
                          ) : null}
                          <ExecutionPanel session={session} />
                          <ActivityDock
                            key={`activity-${session.id}`}
                            session={session}
                            kind={kind}
                          />
                        </>
                      )}
                      <div className={`desk-input ${terminalMode ? 'solo' : ''}`}>
                        <GitBar
                          key={project.id}
                          project={project}
                          state={diff}
                          error={diffError}
                          expandedDiff={showDiff}
                          onDiff={() => setShowDiff((v) => !v)}
                          refresh={refreshDiff}
                          compatible={compatibleRuntime(state)}
                          locked={state.sessions.some(
                            (s) => s.projectId === project.id && live(s) && !s.worktree,
                          )}
                          sessionId={session.worktree ? session.id : undefined}
                          agentBusy={['starting', 'working', 'waiting', 'stopping'].includes(
                            session.status,
                          )}
                        />
                        {!terminalMode && (
                          <>
                            <PendingMessages
                              session={session}
                              run={run}
                              recover={(text, attachments) => {
                                setDrafts((d) => ({
                                  ...d,
                                  [session.id]: [d[session.id], text].filter(Boolean).join('\n'),
                                }));
                                setImageDrafts((d) => ({
                                  ...d,
                                  [session.id]: [
                                    ...(d[session.id] ?? []),
                                    ...attachments.filter(
                                      (a) => !d[session.id]?.some((x) => x.id === a.id),
                                    ),
                                  ],
                                }));
                              }}
                            />
                            <Composer
                              key={`${session.id}:${session.profile}`}
                              disabled={navigating || !!busy[session.id]}
                              accountControl={
                                <UsageSwitcher
                                  profiles={accountProfiles}
                                  profile={session.profile}
                                  locked={sessionAccountLocked(session)}
                                  disabled={
                                    navigating ||
                                    !!busy[session.id] ||
                                    !compatibleRuntime(state) ||
                                    ['starting', 'stopping'].includes(session.status)
                                  }
                                  change={(next) =>
                                    void run({
                                      type: 'changeSessionAccount',
                                      sessionId: session.id,
                                      profile: next,
                                    })
                                  }
                                />
                              }
                              footerControl={terminalButton}
                              usageDetail={
                                <UsageWindowDetail
                                  profile={session.profile}
                                  usage={state.accounts?.[session.profile]?.usage}
                                  apiUsage={state.accounts?.[session.profile]?.apiUsage}
                                  stats={session.stats}
                                />
                              }
                              session={session}
                              accountName={
                                accountProfiles.find((p) => p.id === session.profile)?.name ??
                                session.profile
                              }
                              optimization={
                                accountProfiles.find((p) => p.id === session.profile)?.optimization
                              }
                              draft={drafts[session.id] ?? ''}
                              setDraft={(value) =>
                                setDrafts((d) => ({
                                  ...d,
                                  [session.id]:
                                    typeof value === 'function'
                                      ? value(d[session.id] ?? '')
                                      : value,
                                }))
                              }
                              run={run}
                              images={imageDrafts[session.id] ?? []}
                              setImages={(value) =>
                                setImageDrafts((d) => ({
                                  ...d,
                                  [session.id]:
                                    typeof value === 'function'
                                      ? value(d[session.id] ?? [])
                                      : value,
                                }))
                              }
                              onSend={(text, images) => sendText(session, text, images)}
                              onLocalCommand={localCommand}
                            />
                          </>
                        )}
                      </div>
                    </>
                  )}
                  {(!session || terminalMode) && (
                    <div className="conversation-footer">{terminalButton}</div>
                  )}
                </section>
              </ChatActionsContext.Provider>
              {(showDiff || browserVisible) && split.separator}
              {(showDiff || browserVisible) && (
                <aside
                  className={`drawer tools-drawer ${[showDiff, browserVisible].filter(Boolean).length > 1 ? 'split' : ''} ${browserVisible ? 'with-browser' : ''}`}
                >
                  {browserVisible && compatibleRuntime(state) && browserPanel}
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
                        ) : !diff.repository ? (
                          <p className="muted">Esta carpeta no es un repositorio Git.</p>
                        ) : !diff.status ? (
                          <div className="clean-git">
                            <Check size={22} />
                            <p>No hay cambios locales.</p>
                          </div>
                        ) : (
                          <div className="diff-body">
                            {diff.diffError && <p className="muted">{diff.diffError}</p>}
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
            {showTerminalPanel && terminalPosition === 'right' && terminalSplit.separator}
            {showTerminalPanel && (
              <section
                key="terminal-panel"
                className={`tool-pane terminal-pane ${terminalPosition === 'right' ? 'right-terminal' : 'bottom-terminal'} ${freebuffPanel || (antigravityChat && terminalMode) ? 'gemini-terminal' : ''} ${terminalExpanded ? 'terminal-expanded' : ''}`}
                aria-label={
                  freebuffPanel
                    ? 'Terminal oficial de Freebuff'
                    : antigravityChat && terminalMode
                      ? 'Permisos y ejecución de Gemini'
                      : 'Terminal del proyecto'
                }
              >
                <header className="drawer-head terminal-panel-heading">
                  <strong>
                    {freebuffPanel
                      ? 'Freebuff · CLI oficial'
                      : antigravityChat && terminalMode
                        ? 'Gemini · permisos y ejecución'
                        : terminalMode
                          ? 'Terminal del agente'
                          : 'Consola del proyecto'}
                  </strong>
                  {antigravityChat && terminalMode && !freebuffPanel && (
                    <span>Responde a las solicitudes en este panel</span>
                  )}
                  <div>
                    {freebuffPanel ? (
                      <>
                        <button onClick={() => setTerminalTarget('default')}>
                          {terminalMode ? 'Terminal del agente' : 'Consola'}
                        </button>
                        <button
                          disabled={
                            !!busy.openFreebuff || !!busy.stopFreebuff || !compatibleRuntime(state)
                          }
                          onClick={() =>
                            terminalSession && live(terminalSession)
                              ? void run({ type: 'stopFreebuff', projectId: project.id })
                              : void openFreebuff()
                          }
                        >
                          {terminalSession && live(terminalSession)
                            ? 'Detener Freebuff'
                            : 'Abrir Freebuff'}
                        </button>
                      </>
                    ) : state.freebuffEnabled ? (
                      <button
                        disabled={
                          !compatibleRuntime(state) || !state.tools.freebuff || !!busy.openFreebuff
                        }
                        onClick={() => void openFreebuff()}
                        title="Abrir Freebuff CLI con tu cuenta en este proyecto"
                      >
                        Freebuff
                      </button>
                    ) : null}
                    <button
                      aria-label={
                        terminalPosition === 'right'
                          ? 'Mover terminal abajo'
                          : 'Mover terminal a la derecha'
                      }
                      title={
                        terminalPosition === 'right'
                          ? 'Mover terminal abajo'
                          : 'Mover terminal a la derecha'
                      }
                      onClick={() => {
                        setTerminalPosition((v) => (v === 'right' ? 'bottom' : 'right'));
                        setTerminalExpanded(false);
                      }}
                    >
                      {terminalPosition === 'right' ? (
                        <PanelBottomOpen size={16} />
                      ) : (
                        <PanelRightOpen size={16} />
                      )}
                    </button>
                    {terminalPosition === 'bottom' && (
                      <button
                        aria-label={terminalExpanded ? 'Reducir terminal' : 'Ampliar terminal'}
                        title={terminalExpanded ? 'Reducir terminal' : 'Ampliar terminal'}
                        aria-pressed={terminalExpanded}
                        onClick={() => setTerminalExpanded((v) => !v)}
                      >
                        {terminalExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                      </button>
                    )}
                    {antigravityChat && terminalMode && !freebuffPanel && (
                      <button
                        disabled={!!busy[session!.id]}
                        onClick={returnToChat}
                        title="Detener la terminal y volver al chat"
                      >
                        Detener y volver al chat
                      </button>
                    )}
                    <button
                      aria-label="Ocultar panel de terminal"
                      title="Ocultar panel sin detener la sesión"
                      onClick={() => setShowTerminalPanel(false)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </header>
                {terminalSession ? (
                  <TerminalView
                    key={terminalSession.id}
                    session={terminalSession}
                    visible
                    onError={setError}
                    scrollableScreen={!freebuffPanel && antigravityChat && terminalMode}
                    placement={terminalPosition}
                  />
                ) : (
                  <div className="inline-notice" role="status">
                    Abriendo terminal…
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>
      {attentionOpen && (
        <AttentionPanel
          items={attention}
          projects={state.projects}
          onClose={() => setAttentionOpen(false)}
          onSelect={async (target) => {
            await run({ type: 'select', projectId: target.projectId, sessionId: target.id });
            if (stateRef.current?.selectedSession !== target.id) return;
            setMultichat('off');
            selectProjectBrowser(target.projectId);
            setAttentionOpen(false);
            requestAnimationFrame(() =>
              document.querySelector<HTMLTextAreaElement>('.workspace .composer textarea')?.focus(),
            );
          }}
        />
      )}
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
            aria-modal="true"
            aria-label="Buscar proyectos y sesiones"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="palette-search">
              <Search size={17} />
              <input
                data-autofocus
                aria-label="Buscar proyecto o sesión"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls="palette-results"
                aria-activedescendant={
                  results[selectedSearchIndex] ? `palette-result-${selectedSearchIndex}` : undefined
                }
                placeholder="Buscar proyecto o sesión…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
                  const currentResults =
                    query === searchQuery ? results : searchWorkspace(state, query, statusLabels);
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSearchIndex((i) => Math.max(0, Math.min(i + 1, currentResults.length - 1)));
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSearchIndex((i) => Math.max(0, i - 1));
                  }
                  if (e.key === 'Enter') {
                    // Typing stays deferred, but an immediate Enter must select
                    // the current query rather than ignore it or open stale results.
                    const target = currentResults[Math.min(searchIndex, currentResults.length - 1)];
                    if (target) {
                      e.preventDefault();
                      choose(target);
                    }
                  }
                }}
              />
              <kbd>esc</kbd>
            </div>
            <div
              className="palette-results"
              id="palette-results"
              role="listbox"
              aria-label="Proyectos y sesiones"
              aria-busy={query !== searchQuery}
            >
              {results.map((r, i) => (
                <button
                  key={r.key}
                  id={`palette-result-${i}`}
                  role="option"
                  aria-selected={i === selectedSearchIndex}
                  tabIndex={-1}
                  className={i === selectedSearchIndex ? 'on' : ''}
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
        <React.Suspense
          fallback={
            <div className="overlay">
              <div className="modal muted" role="status">
                Abriendo ajustes…
              </div>
            </div>
          }
        >
          <AccountsSettings
            onOpenFreebuff={openFreebuff}
            state={state}
            appearance={appearance}
            run={run}
            close={() => setSettings(false)}
            onError={setError}
          />
        </React.Suspense>
      )}
      {confirmClose && (
        <div className="overlay">
          <section
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-label={confirmClose.remove ? 'Eliminar conversación' : 'Cerrar conversación'}
          >
            <h2>{confirmClose.remove ? '¿Eliminar el chat?' : '¿Detener y cerrar la pestaña?'}</h2>
            <p className="muted">
              {confirmClose.remove
                ? `Se eliminará definitivamente «${confirmClose.session.title}», su historial y sus adjuntos. Esta acción no se puede deshacer. Si tiene un agente abierto, se detendrá primero. Los demás chats se conservan.`
                : `Se detendrá el agente de «${confirmClose.session.title}». La conversación se conserva en el proyecto.`}
            </p>
            <div className="modal-actions">
              <button
                disabled={busy[confirmClose.session.id]}
                onClick={() => setConfirmClose(undefined)}
              >
                Cancelar
              </button>
              <button
                className="danger"
                disabled={busy[confirmClose.session.id]}
                onClick={async () => {
                  const { session: s, remove } = confirmClose;
                  if (remove) {
                    // Deletion stops the agent itself; never leave the dialog stuck on a failed stop.
                    setConfirmClose(undefined);
                    await closeTab(s, true, true);
                    return;
                  }
                  if (live(stateRef.current?.sessions.find((x) => x.id === s.id)))
                    await run({ type: 'stop', sessionId: s.id });
                  if (!live(stateRef.current?.sessions.find((x) => x.id === s.id))) {
                    setConfirmClose(undefined);
                    await closeTab(s, remove, true);
                  }
                }}
              >
                {confirmClose.remove
                  ? live(state.sessions.find((s) => s.id === confirmClose.session.id))
                    ? 'Detener y eliminar'
                    : 'Eliminar chat'
                  : 'Detener y cerrar'}
              </button>
            </div>
          </section>
        </div>
      )}
      {removeId && (
        <div className="overlay">
          <section
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-label="Quitar proyecto"
          >
            <h2>Quitar proyecto de la lista</h2>
            <p className="muted">
              Se detendrán todos sus chats y terminales y se borrarán sus conversaciones, adjuntos y
              datos del navegador guardados por la app. Los archivos de la carpeta permanecen
              intactos.
            </p>
            <div className="modal-actions">
              <button disabled={busy.removeProject} onClick={() => setRemoveId(undefined)}>
                Cancelar
              </button>
              <button
                className="danger"
                disabled={busy.removeProject}
                onClick={async () => {
                  const id = removeId;
                  await run({ type: 'removeProject', projectId: id });
                  if (!stateRef.current?.projects.some((p) => p.id === id)) setRemoveId(undefined);
                }}
              >
                {busy.removeProject ? 'Deteniendo y limpiando…' : 'Quitar proyecto y chats'}
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
// Saved user CSS applies before the first paint.
applyStyles(savedStyles());
createRoot(document.getElementById('root')!).render(<App />);
