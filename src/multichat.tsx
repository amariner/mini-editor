import { FloatChatButton } from './floating-chat';
import { TeamIndicator } from './team';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Maximize2,
  X,
  LayoutGrid,
  Send,
  Square,
  Paperclip,
  Globe,
  GitBranch,
  RefreshCw,
  ChevronDown,
  Plus,
  Copy,
  Eye,
  EyeOff,
  Ellipsis,
  Pencil,
  FileDiff,
  ListTodo,
  Folder,
  ArrowDown,
  Trash2,
} from 'lucide-react';
import type { Action, Attachment, Profile, Session, Snapshot } from './shared';
import { providerKind, providerNames, isConnectedProvider } from './shared';
import { compatibleRuntime } from './runtime';
import {
  ClaudeApproval,
  CodexApproval,
  ProviderApproval,
  ActivityDock,
  ConversationMessages,
  TodoPanel,
  PendingMessages,
  ExecutionPanel,
} from './chat';
import { conversationEntries } from './conversation';
import { ChatActionsContext, type ChatActions } from './markdown';
import { EditableName } from './editable-name';
import { accountCardStyle } from './account-color';
import type { GitSnapshot } from './git-types';
import { cardStatus as status, isPending, lastTurnChanges, planProgress } from './supervision';
import { shortPath } from './activity';
import { readDroppedFiles } from './image-drop';
import {
  autoLayout,
  fitColumns,
  gridSizes,
  restoreLayout,
  type GridLayout,
} from './multichat-layout';

const orderKey = 'agent-desk.multichat-order.v1';
const layoutKey = 'agent-desk.multichat-layout.v1';
const mac = /Mac/i.test(navigator.platform);
const modKey = mac ? '⌘' : 'Ctrl+';
function savedLayout(): GridLayout {
  try {
    return restoreLayout(JSON.parse(localStorage.getItem(layoutKey) ?? 'null'));
  } catch {
    return restoreLayout(null);
  }
}
function savedIds(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === 'string'))]
      : [];
  } catch {
    return [];
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Portalled so the menu stays usable at every card size, including the bottom row. */
function CardMenu({
  title,
  color,
  visible,
  children,
}: {
  title: string;
  color?: string;
  visible: boolean;
  children: React.ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const panel = menu.current.getBoundingClientRect();
      menu.current.style.left = `${Math.max(8, Math.min(anchor.right - panel.width, innerWidth - panel.width - 8))}px`;
      menu.current.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - panel.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (menu.current) observer.observe(menu.current);
    menu.current?.querySelector<HTMLButtonElement>('button:enabled')?.focus();
    const outside = (event: Event) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        className="multichat-menu-trigger"
        type="button"
        title="Más opciones"
        aria-label={`Opciones de ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Ellipsis size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            className="multichat-card-menu"
            role="menu"
            aria-label={`Opciones de ${title}`}
            style={accountCardStyle(color)}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button:enabled')) close(true);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                close(true);
              } else if (event.key === 'Tab') {
                // Continue naturally from the trigger in the card's tab order.
                close(true);
              } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const items = [
                  ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:enabled') ?? []),
                ];
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                        items.length;
                items[next]?.focus();
              }
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

type ChatControls = {
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  images: Record<string, Attachment[]>;
  setImages: React.Dispatch<React.SetStateAction<Record<string, Attachment[]>>>;
  busy: Record<string, boolean>;
  run: (action: Action) => Promise<any>;
  send: (session: Session, text: string, images: Attachment[]) => Promise<boolean>;
};

/** Only what differs from a clean, synced branch earns space in the card. */
function GitSummary({ git, error }: { git?: GitSnapshot; error?: string }) {
  if (error)
    return (
      <span className="multichat-git error" title={error}>
        <GitBranch size={11} />
        Error de Git
      </span>
    );
  if (!git?.repository) return null;
  const conflicts = git.counts?.conflicts ?? 0;
  return (
    <span
      className="multichat-git"
      title={git.upstream ? `${git.branch} → ${git.upstream}` : git.branch}
    >
      <GitBranch size={11} />
      <span className="multichat-branch">{git.branch}</span>
      {conflicts ? (
        <span className="conflicts">{plural(conflicts, 'conflicto', 'conflictos')}</span>
      ) : git.files.length ? (
        <span
          className="multichat-file-count"
          title={plural(git.files.length, 'archivo', 'archivos')}
        >
          <FileDiff size={11} aria-hidden="true" />
          {git.files.length}
        </span>
      ) : null}
      {!!git.lines?.added && <span className="git-added">+{git.lines.added}</span>}
      {!!git.lines?.removed && <span className="git-removed">−{git.lines.removed}</span>}
      {!!git.ahead && <span title="Commits por subir">↑{git.ahead}</span>}
      {!!git.behind && <span title="Commits por bajar">↓{git.behind}</span>}
    </span>
  );
}

/** A single glanceable row; the full plan is available on demand. */
function Supervision({
  session,
  root,
  showChanges,
}: {
  session: Session;
  root?: string;
  showChanges?: () => void;
}) {
  const [showPlan, setShowPlan] = useState(false);
  const planId = useId();
  const plan =
    planProgress(session) ??
    (session.todos?.length
      ? {
          done: session.todos.filter((task) => task.status === 'completed').length,
          total: session.todos.length,
          current: undefined,
        }
      : undefined);
  const changes = lastTurnChanges(session);
  if (!plan && !changes) return null;
  const files = changes?.files.map((f) => shortPath(f.path, root)) ?? [];
  return (
    <div className="multichat-supervision">
      <div className="multichat-supervision-row">
        {plan && (
          <button
            className="multichat-plan-toggle"
            title={`${plan.done}/${plan.total} tareas · ${plan.current ?? (plan.done === plan.total ? 'Plan completado' : 'Pendiente')}`}
            aria-label={`Ver tareas de ${session.title}`}
            aria-expanded={showPlan}
            aria-controls={showPlan ? planId : undefined}
            onClick={() => setShowPlan((value) => !value)}
          >
            <ListTodo size={13} aria-hidden="true" />
            <span
              className="multichat-plan"
              role="progressbar"
              aria-label="Progreso del plan"
              aria-valuemin={0}
              aria-valuemax={plan.total}
              aria-valuenow={plan.done}
              aria-valuetext={`${plan.done} de ${plan.total} tareas${plan.current ? ` · ${plan.current}` : ''}`}
            >
              <span className="multichat-plan-count">
                {plan.done}/{plan.total}
              </span>
              <span className="multichat-plan-bar" aria-hidden="true">
                <i style={{ width: `${(plan.done / plan.total) * 100}%` }} />
              </span>
            </span>
            <ChevronDown size={11} className={showPlan ? 'expanded' : ''} />
          </button>
        )}
        {changes && (
          <button
            className="multichat-changes"
            title={`Cambios de este turno:\n${files.slice(0, 12).join('\n')}${files.length > 12 ? `\n… y ${files.length - 12} más` : ''}`}
            aria-label={`${plural(files.length, 'archivo cambiado', 'archivos cambiados')} en este turno, ${changes.added} líneas añadidas y ${changes.removed} eliminadas. Ver cambios`}
            disabled={!showChanges}
            onClick={showChanges}
          >
            <FileDiff size={12} aria-hidden="true" />
            <span>{files.length}</span>
            {!!changes.added && <span className="git-added">+{changes.added}</span>}
            {!!changes.removed && <span className="git-removed">−{changes.removed}</span>}
          </button>
        )}
      </div>
      {showPlan && !!session.todos?.length && (
        <div id={planId} className="multichat-plan-details">
          <TodoPanel todos={session.todos} defaultOpen />
        </div>
      )}
    </div>
  );
}

/** New chat from the grid: choose project and account, the card appears ready to write. */
function NewChatPicker({
  state,
  disabled,
  create,
}: {
  state: Snapshot;
  disabled: boolean;
  create: (projectId: string, profile: Profile) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const profiles = state.profiles ?? [];
  const [projectId, setProjectId] = useState('');
  const [profile, setProfile] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const project = state.projects.some((p) => p.id === projectId)
    ? projectId
    : (state.selectedProject ?? state.projects[0]?.id ?? '');
  const account = profiles.some((p) => p.id === profile)
    ? profile
    : (state.defaultProfile ?? profiles[0]?.id ?? '');
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="multichat-new"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        className="multichat-new-button"
        aria-label="Nuevo chat"
        aria-expanded={open}
        title="Nuevo chat en cualquier proyecto"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={14} />
      </button>
      {open && (
        <form
          className="multichat-new-menu"
          aria-label="Nuevo chat"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!project || !account || creating) return;
            setCreating(true);
            try {
              if (await create(project, account as Profile)) setOpen(false);
            } finally {
              setCreating(false);
            }
          }}
        >
          {!state.projects.length || !profiles.length ? (
            <p>
              {!state.projects.length
                ? 'Abre una carpeta desde la barra lateral para crear chats.'
                : 'Añade una cuenta en Ajustes para crear chats.'}
            </p>
          ) : (
            <>
              <label>
                Proyecto
                <select autoFocus value={project} onChange={(e) => setProjectId(e.target.value)}>
                  {state.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Cuenta
                <select value={account} onChange={(e) => setProfile(e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {state.accounts?.[p.id]?.status === 'signedOut' ? ' · sin sesión' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={creating || disabled}>
                {creating ? 'Creando…' : 'Crear chat'}
              </button>
            </>
          )}
        </form>
      )}
    </div>
  );
}

function LayoutPicker({
  layout,
  shape,
  setLayout,
}: {
  layout: GridLayout;
  shape: { rows: number; columns: number };
  setLayout: (layout: GridLayout) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ rows: number; columns: number }>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    setHover(undefined);
    trigger.current?.focus();
  };
  const choose = (next: GridLayout) => {
    setLayout(next);
    close();
  };
  const shown = hover ?? (layout.auto ? undefined : layout);
  const describe = (s: { rows: number; columns: number }) =>
    `${plural(s.columns, 'columna', 'columnas')} × ${plural(s.rows, 'fila', 'filas')}`;
  return (
    <div
      className="multichat-layout"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        className="multichat-layout-button"
        aria-label="Distribución del grid"
        aria-expanded={open}
        title={`Distribución: ${layout.auto ? 'automática, ' : ''}${describe(shape)}`}
        onClick={() => setOpen((v) => !v)}
      >
        {layout.auto && <span>Auto</span>}
        {shape.columns} × {shape.rows}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="multichat-layout-menu" role="group" aria-label="Elegir distribución">
          <button
            className={`multichat-layout-auto ${layout.auto ? 'on' : ''}`}
            aria-pressed={layout.auto}
            onClick={() => choose({ ...layout, auto: true })}
          >
            Automática
            <small>Se adapta a los chats en marcha</small>
          </button>
          <div
            className="multichat-layout-matrix"
            onMouseLeave={() => setHover(undefined)}
            onKeyDown={(e) => {
              const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[e.key];
              if (!step) return;
              e.preventDefault();
              const cells = [...e.currentTarget.querySelectorAll('button')];
              const index = cells.indexOf(e.target as HTMLButtonElement);
              cells[Math.min(cells.length - 1, Math.max(0, index + step))]?.focus();
            }}
          >
            {gridSizes.flatMap((rows) =>
              gridSizes.map((columns) => (
                <button
                  key={`${rows}-${columns}`}
                  aria-label={describe({ rows, columns })}
                  aria-pressed={!layout.auto && layout.rows === rows && layout.columns === columns}
                  className={shown && rows <= shown.rows && columns <= shown.columns ? 'on' : ''}
                  onMouseEnter={() => setHover({ rows, columns })}
                  onFocus={() => setHover({ rows, columns })}
                  onClick={() => choose({ auto: false, rows, columns })}
                />
              )),
            )}
          </div>
          <span className="multichat-layout-size" aria-hidden="true">
            {shown ? `${shown.columns} × ${shown.rows}` : 'Elige columnas × filas'}
          </span>
        </div>
      )}
    </div>
  );
}

function Card({
  session,
  teamSessions,
  openTeamChat,
  index,
  project,
  account,
  actions,
  color,
  git,
  gitError,
  gitBusy,
  refreshGit,
  servers,
  openDev,
  root,
  open,
  dismiss,
  hidden,
  toggleHidden,
  disabled,
  visible,
  compatible,
  floating,
  unseen,
  seen,
  controls,
  dragging,
  dropTarget,
  dragStart,
  dragEnd,
  dragOver,
  drop,
  move,
}: {
  session: Session;
  teamSessions: Session[];
  openTeamChat: (s: Session) => void;
  index: number;
  project: string;
  account: string;
  actions: ChatActions;
  color?: string;
  git?: GitSnapshot;
  gitError?: string;
  gitBusy: boolean;
  refreshGit: () => void;
  servers: NonNullable<Snapshot['devServers']>;
  openDev: (url: string) => void;
  root?: string;
  open: () => void;
  dismiss: () => void;
  hidden: boolean;
  toggleHidden: () => void;
  disabled: boolean;
  visible: boolean;
  compatible: boolean;
  floating: boolean;
  unseen: boolean;
  seen: () => void;
  controls: ChatControls;
  dragging: boolean;
  dropTarget: boolean;
  dragStart: (e: React.DragEvent) => void;
  dragEnd: () => void;
  dragOver: (e: React.DragEvent) => void;
  drop: (e: React.DragEvent) => void;
  move: (direction: number) => void;
}) {
  const [tone, label] = status(session);
  const [limit, setLimit] = useState(20);
  const [editingTitle, setEditingTitle] = useState(false);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [localError, setLocalError] = useState('');
  const sendingRef = useRef(false);
  const pickingRef = useRef(false);
  const preview = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
  const previousScroll = useRef<{ top: number; height: number } | undefined>(undefined);
  const draft = controls.drafts[session.id] ?? '';
  const images = controls.images[session.id] ?? [];
  const messages = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const entries = useMemo(
    () => conversationEntries(session),
    [session.messages, session.status, session.approvals.length],
  );
  const entryCount = entries.length;
  const tail = messages.slice(-1);
  const textOf = (m: Session['messages'][number]) =>
    m.blocks?.some((b) => b.type === 'text')
      ? m.blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n')
      : m.text;
  const lastText = tail.length ? textOf(tail[tail.length - 1]) : '';
  useLayoutEffect(() => {
    const before = previousScroll.current;
    const viewport = preview.current;
    if (!before || !viewport) return;
    viewport.scrollTop = before.top + viewport.scrollHeight - before.height;
    previousScroll.current = undefined;
  }, [limit]);
  useEffect(() => {
    if (visible && following.current && preview.current)
      preview.current.scrollTop = preview.current.scrollHeight;
  }, [lastText, messages.length, visible, session.approvals.length]);
  useEffect(() => {
    const viewport = preview.current;
    const transcript = content.current;
    if (!visible || !viewport || !transcript) return;
    // Resizing a card or loading an image also changes the last message's position.
    // Follow only while the reader has chosen to stay at the end of the conversation.
    const observer = new ResizeObserver(() => {
      if (following.current) {
        viewport.scrollTop = viewport.scrollHeight;
        setShowLatest(false);
      } else {
        setShowLatest(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight >= 30);
      }
    });
    observer.observe(viewport);
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [visible]);
  const terminal = session.mode === 'terminal' || session.status === 'terminal';
  const pending = isPending(session);
  const claude =
    providerKind(session.profile) === 'claude' && !isConnectedProvider(session.profile);
  const enabled =
    compatible &&
    !disabled &&
    !controls.busy[session.id] &&
    !sending &&
    !picking &&
    !terminal &&
    ['ready', 'working', 'waiting', 'starting', 'stopped', 'error'].includes(session.status);
  const setDraft = (value: string) => controls.setDrafts((v) => ({ ...v, [session.id]: value }));
  const submit = async () => {
    const text = draft.trim();
    if (!enabled || (!text && !images.length) || sendingRef.current || pickingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setLocalError('');
    following.current = true;
    try {
      if (await controls.send(session, text, images)) {
        controls.setDrafts((v) => (v[session.id] === draft ? { ...v, [session.id]: '' } : v));
        const ids = new Set(images.map((i) => i.id));
        controls.setImages((v) => ({
          ...v,
          [session.id]: (v[session.id] ?? []).filter((i) => !ids.has(i.id)),
        }));
      } else setLocalError('No se pudo enviar. Tu borrador se conserva.');
    } catch {
      setLocalError('No se pudo enviar. Tu borrador se conserva.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const attach = async (files?: File[]) => {
    if (!enabled || pickingRef.current || sendingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    setLocalError('');
    try {
      const picked: Attachment[] | undefined = await controls.run(
        files
          ? { type: 'dropImages', sessionId: session.id, images: await readDroppedFiles(files) }
          : { type: 'pickImages', sessionId: session.id },
      );
      if (picked?.length)
        controls.setImages((v) => ({ ...v, [session.id]: [...(v[session.id] ?? []), ...picked] }));
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : 'No se pudieron adjuntar los archivos.',
      );
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  };
  return (
    <ChatActionsContext.Provider value={actions}>
      <article
        className={`multichat-card ${tone} ${unseen ? 'unseen' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-target' : ''}`}
        style={accountCardStyle(color)}
        data-session-id={session.id}
        aria-label={`${project} · ${session.title} · ${unseen ? 'Terminado sin revisar' : label}`}
        onPointerDown={seen}
        onFocus={seen}
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = enabled && !floating ? 'copy' : 'none';
          } else dragOver(e);
        }}
        onDrop={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return drop(e);
          e.preventDefault();
          e.stopPropagation();
          if (enabled && !floating) void attach(Array.from(e.dataTransfer.files));
          else setLocalError('Espera a que el chat esté disponible para adjuntar archivos.');
        }}
      >
        {/* The whole header is the drag handle; the title keeps rename and keyboard moves. */}
        <div
          className="multichat-card-head"
          draggable={!editingTitle}
          onDragStart={(e) => {
            if ((e.target as HTMLElement).closest('button:not(.multichat-title)')) {
              e.preventDefault();
              return;
            }
            dragStart(e);
          }}
          onDragEnd={dragEnd}
        >
          <i className="multichat-dot" title={unseen ? 'Terminado sin revisar' : label} />
          {editingTitle ? (
            <EditableName
              value={session.title}
              label={`Nombre de ${session.title}`}
              close={() => setEditingTitle(false)}
              save={(title) => void controls.run({ type: 'rename', sessionId: session.id, title })}
            />
          ) : (
            <button
              className="multichat-title"
              onDoubleClick={() => setEditingTitle(true)}
              onClick={(e) => {
                if (e.detail === 0) setEditingTitle(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'F2') {
                  e.preventDefault();
                  setEditingTitle(true);
                } else if (
                  e.altKey &&
                  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
                ) {
                  e.preventDefault();
                  move(['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1);
                }
              }}
              disabled={disabled || !compatible}
              title={`${session.title}\nDoble clic para renombrar · Arrastra para ordenar`}
              aria-label={`Renombrar ${session.title}`}
              aria-keyshortcuts="F2 Alt+ArrowLeft Alt+ArrowRight"
            >
              <strong>{session.title}</strong>
            </button>
          )}
          <TeamIndicator session={session} sessions={teamSessions} open={openTeamChat} compact />
          {index < 9 && (
            <kbd className="multichat-key" aria-hidden="true">
              {modKey}
              {index + 1}
            </kbd>
          )}
          <FloatChatButton
            session={session}
            floating={floating}
            run={controls.run}
            disabled={disabled || !compatible || !!controls.busy[session.id]}
          />
          <button
            className="multichat-expand"
            aria-label={`Ampliar ${session.title}`}
            title="Ampliar"
            disabled={disabled}
            onClick={open}
          >
            <Maximize2 size={14} />
          </button>
          <CardMenu title={session.title} color={color} visible={visible}>
            {servers.map((server) => (
              <button
                key={server.port}
                className="multichat-server"
                role="menuitem"
                aria-label={`Abrir puerto ${server.port} de ${session.title}`}
                title={`Abrir ${server.url} en Chrome`}
                onClick={() => openDev(server.url)}
              >
                <Globe size={14} />
                <span>Abrir en navegador</span>
                <kbd>:{server.port}</kbd>
              </button>
            ))}
            <button
              role="menuitem"
              disabled={disabled || !compatible}
              onClick={() => setEditingTitle(true)}
            >
              <Pencil size={14} />
              <span>Renombrar</span>
              <kbd>F2</kbd>
            </button>
            {claude && (session.forkFrom ?? (session.attempted && session.reference)) && (
              <button
                className="multichat-fork"
                role="menuitem"
                aria-label={`Duplicar ${session.title}`}
                title="Mismo historial en otro worktree para probar otro enfoque"
                disabled={disabled || !compatible || pending || !!controls.busy[session.id]}
                onClick={() =>
                  void controls.run({ type: 'forkSession', sessionId: session.id, isolate: true })
                }
              >
                <Copy size={14} />
                <span>Duplicar en otro worktree</span>
              </button>
            )}
            <button
              role="menuitem"
              className="multichat-git-refresh"
              aria-label={`Actualizar Git de ${project}`}
              disabled={gitBusy}
              onClick={refreshGit}
            >
              <RefreshCw size={14} className={gitBusy ? 'spinner' : ''} />
              <span>Actualizar Git</span>
            </button>
            <div className="multichat-menu-divider" role="separator" />
            <button
              className="multichat-hide"
              role="menuitem"
              aria-label={`${hidden ? 'Mostrar' : 'Ocultar'} ${session.title} en el grid`}
              onClick={toggleHidden}
            >
              {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
              <span>{hidden ? 'Mostrar en el grid' : 'Ocultar del grid'}</span>
            </button>
            <button
              className="multichat-dismiss"
              role="menuitem"
              onClick={dismiss}
              aria-label={`Eliminar ${session.title}`}
              title="Eliminar la conversación y sus adjuntos"
            >
              <Trash2 size={14} />
              <span>Eliminar chat</span>
            </button>
          </CardMenu>
        </div>
        <div className="multichat-info-line">
          <span className="multichat-account" title={`Cuenta: ${account}`}>
            {account}
          </span>
          <span className="multichat-folder" title={root ?? project}>
            <Folder size={11} aria-hidden="true" />
            <span>{project}</span>
          </span>
          {session.worktree ? (
            <span
              className="multichat-git multichat-worktree"
              title={`Worktree aislado · ${session.worktree.branch} → ${session.worktree.base}\n${session.worktree.cwd}`}
            >
              <GitBranch size={11} />
              <span className="multichat-branch">{session.worktree.branch}</span>
            </span>
          ) : (
            <GitSummary git={git} error={gitError} />
          )}
        </div>
        {visible && !terminal && (
          <>
            <Supervision session={session} root={root} showChanges={actions.showChanges} />
            <ExecutionPanel session={session} />
          </>
        )}
        {visible && !terminal && !session.approvals.length && (
          <ActivityDock session={session} kind={providerKind(session.profile)} compact />
        )}
        <div className="multichat-history">
          <div
            className="multichat-preview compact-conversation"
            ref={preview}
            tabIndex={0}
            aria-label={`Conversación de ${session.title}`}
            onScroll={(e) => {
              const el = e.currentTarget;
              following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
              setShowLatest(!following.current);
            }}
          >
            <div className="multichat-history-content" ref={content}>
              {entryCount > limit && (
                <button
                  className="multichat-earlier"
                  onClick={() => {
                    following.current = false;
                    if (preview.current)
                      previousScroll.current = {
                        top: preview.current.scrollTop,
                        height: preview.current.scrollHeight,
                      };
                    setLimit((v) => v + 20);
                  }}
                >
                  Ver mensajes anteriores
                </button>
              )}
              <ConversationMessages
                session={session}
                kind={providerKind(session.profile)}
                limit={limit}
                entries={entries}
              />
              {!session.messages.length && !terminal && (
                <p className="multichat-hint">Escribe abajo para empezar.</p>
              )}
              {terminal && (
                <button className="multichat-earlier" onClick={open}>
                  Abrir terminal en el chat
                </button>
              )}
            </div>
          </div>
          {showLatest && (
            <button
              type="button"
              className="multichat-latest"
              aria-label={`Ir al último mensaje de ${session.title}`}
              title="Último mensaje"
              onClick={() => {
                following.current = true;
                setShowLatest(false);
                preview.current?.scrollTo({ top: preview.current.scrollHeight });
              }}
            >
              <ArrowDown size={14} />
            </button>
          )}
        </div>
        {/* Pinned outside the scroll so the decision stays in reach while reading the context. */}
        {visible && session.approvals.length > 0 && (
          <div className="multichat-approvals" aria-label={`Solicitudes de ${session.title}`}>
            {session.approvals.map((a, i) =>
              a.method.startsWith('provider/') ? (
                <ProviderApproval key={a.id} approval={a} session={session} run={controls.run} />
              ) : a.method === 'claude/permission' ? (
                <ClaudeApproval
                  key={a.id}
                  approval={a}
                  session={session}
                  run={controls.run}
                  index={i}
                  total={session.approvals.length}
                />
              ) : (
                <CodexApproval
                  key={a.id}
                  approval={a}
                  session={session}
                  run={controls.run}
                  index={i}
                  total={session.approvals.length}
                />
              ),
            )}
          </div>
        )}
        {(localError || session.error) && (
          <div className="multichat-error" role={localError ? 'status' : undefined}>
            {localError || session.error}
          </div>
        )}
        {!terminal && !floating && (
          <PendingMessages
            session={session}
            run={controls.run}
            recover={(text, attachments) => {
              controls.setDrafts((current) => ({
                ...current,
                [session.id]: [current[session.id], text].filter(Boolean).join('\n'),
              }));
              controls.setImages((d) => ({
                ...d,
                [session.id]: [
                  ...(d[session.id] ?? []),
                  ...attachments.filter((a) => !d[session.id]?.some((x) => x.id === a.id)),
                ],
              }));
            }}
          />
        )}
        {floating && (
          <button
            className="multichat-floating-notice"
            onClick={() =>
              void controls.run({ type: 'floatingChat', sessionId: session.id, operation: 'focus' })
            }
          >
            Chat en ventana flotante · Mostrar
          </button>
        )}
        {!terminal && !floating && (
          <form
            className="multichat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {images.length > 0 && (
              <div className="multichat-attachments">
                {images.map((a) => (
                  <span key={a.id}>
                    {a.name}
                    <button
                      type="button"
                      aria-label={`Quitar ${a.name}`}
                      disabled={sending || picking || !!controls.busy[session.id]}
                      onClick={() => {
                        controls.setImages((v) => ({
                          ...v,
                          [session.id]: (v[session.id] ?? []).filter((i) => i.id !== a.id),
                        }));
                        void controls.run({
                          type: 'discardImages',
                          sessionId: session.id,
                          attachmentIds: [a.id],
                        });
                      }}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="multichat-compose-row">
              <textarea
                ref={textarea}
                aria-label={`Mensaje para ${session.title}`}
                placeholder={pending ? 'Añade indicaciones…' : 'Escribe un mensaje…'}
                rows={1}
                value={draft}
                readOnly={sending}
                aria-busy={sending || picking}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (!files.length) return;
                  e.preventDefault();
                  void attach(files);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  } else if (e.key === 'Escape') e.currentTarget.blur();
                }}
              />
              <button
                type="button"
                aria-label={`Adjuntar a ${session.title}`}
                title="Adjuntar archivos"
                disabled={!enabled}
                onClick={() => void attach()}
              >
                <Paperclip size={13} />
              </button>
              {['working', 'waiting'].includes(session.status) && (
                <button
                  type="button"
                  className="multichat-stop"
                  aria-label={`Interrumpir ${session.title}`}
                  title="Interrumpir"
                  disabled={!compatible || !!controls.busy[session.id]}
                  onClick={() => void controls.run({ type: 'interrupt', sessionId: session.id })}
                >
                  <Square size={10} />
                </button>
              )}
              <button
                type="submit"
                aria-label={`Enviar a ${session.title}`}
                title={
                  enabled
                    ? 'Enviar · Enter (Shift + Enter: nueva línea)'
                    : 'Espera a que el chat esté disponible'
                }
                disabled={!enabled || (!draft.trim() && !images.length)}
              >
                <Send size={13} />
              </button>
            </div>
          </form>
        )}
      </article>
    </ChatActionsContext.Provider>
  );
}

// Kept mounted while reading a chat: drafts, order and finished sessions retain their place.
export function Multichat({
  state,
  visible,
  toolbar,
  open,
  disabled,
  openDev,
  actionsFor,
  dismissed,
  toggleHidden,
  close,
  ...controls
}: {
  dismissed: string[];
  toggleHidden: (id: string) => void;
  close: (session: Session) => void;
  state: Snapshot;
  visible: boolean;
  /** Top bar slot for the grid controls; they render above the grid without one. */
  toolbar?: HTMLElement | null;
  open: (session: Session) => void;
  openDev: (session: Session, url: string) => void;
  actionsFor: (session: Session) => ChatActions;
  disabled: boolean;
} & ChatControls) {
  const [git, setGit] = useState<Record<string, { value?: GitSnapshot; error?: string }>>({});
  const [gitBusy, setGitBusy] = useState<Record<string, boolean>>({});
  const gitPending = useRef(new Set<string>());
  const projectIds = useRef(new Set<string>());
  projectIds.current = new Set(state.projects.map((project) => project.id));
  const existingProjects = state.projects.map((project) => project.id).join('\0');
  useEffect(() => {
    const prune = <T,>(values: Record<string, T>) => {
      const entries = Object.entries(values).filter(([id]) => projectIds.current.has(id));
      return entries.length === Object.keys(values).length ? values : Object.fromEntries(entries);
    };
    setGit(prune);
    setGitBusy(prune);
  }, [existingProjects]);
  const refreshGit = async (projectId: string) => {
    if (!projectIds.current.has(projectId) || gitPending.current.has(projectId)) return;
    gitPending.current.add(projectId);
    setGitBusy((v) => ({ ...v, [projectId]: true }));
    try {
      const value: GitSnapshot = await window.desk.invoke({
        type: 'diff',
        projectId,
        ...(compatibleRuntime(state) ? { summaryOnly: true } : {}),
      });
      if (projectIds.current.has(projectId)) setGit((v) => ({ ...v, [projectId]: { value } }));
    } catch (e) {
      if (projectIds.current.has(projectId))
        setGit((v) => ({
          ...v,
          [projectId]: { error: e instanceof Error ? e.message : 'No se pudo consultar Git' },
        }));
    } finally {
      gitPending.current.delete(projectId);
      if (projectIds.current.has(projectId)) setGitBusy((v) => ({ ...v, [projectId]: false }));
    }
  };
  const section = useRef<HTMLElement>(null);
  const gridViewport = useRef<HTMLDivElement>(null);
  const [tracked, setTracked] = useState<string[]>(() => savedIds(orderKey));
  const [showHidden, setShowHidden] = useState(false);
  const previouslyDismissed = useRef(dismissed);
  useEffect(() => {
    if (dismissed.some((id) => !previouslyDismissed.current.includes(id))) setShowHidden(false);
    previouslyDismissed.current = dismissed;
  }, [dismissed]);
  useEffect(() => {
    if (!visible) setShowHidden(false);
  }, [visible]);
  const [unseen, setUnseen] = useState<string[]>([]);
  const [layout, setLayout] = useState(savedLayout);
  const [fit, setFit] = useState(4);
  const [showKeys, setShowKeys] = useState(false);
  useEffect(() => store(layoutKey, layout), [layout]);
  const [dragged, setDragged] = useState<string>();
  const [target, setTarget] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const dragId = useRef<string | undefined>(undefined);
  const wasPending = useRef(new Map<string, boolean>());
  // Last card clicked or focused: its own finish is already in view.
  const touched = useRef<string | undefined>(undefined);
  const watching = useRef({ visible, selected: state.selectedSession });
  watching.current = { visible, selected: state.selectedSession };
  const sessionById = useMemo(
    () => new Map(state.sessions.map((session) => [session.id, session])),
    [state.sessions],
  );
  useEffect(() => {
    setTracked((previous) => {
      const next = previous.filter((id) => sessionById.has(id));
      const included = new Set(next);
      // Restored, stopped chats belong to the grid too, even before a tab is opened.
      for (const s of state.sessions) if (!included.has(s.id)) next.push(s.id);
      return next.length === previous.length && next.every((id, i) => previous[i] === id)
        ? previous
        : next;
    });
    for (const id of wasPending.current.keys())
      if (!sessionById.has(id)) wasPending.current.delete(id);
    // A chat that finishes while you look elsewhere stays marked until you touch its card.
    const finished: string[] = [];
    for (const s of state.sessions) {
      const pending = isPending(s);
      const watched = watching.current.visible
        ? touched.current === s.id
        : watching.current.selected === s.id;
      if (wasPending.current.get(s.id) && !pending && status(s)[0] === 'done' && !watched)
        finished.push(s.id);
      wasPending.current.set(s.id, pending);
    }
    setUnseen((ids) => {
      const next = [...new Set([...ids, ...finished])].filter(
        (id) => sessionById.has(id) && !isPending(sessionById.get(id)!),
      );
      return next.length === ids.length && next.every((id, i) => ids[i] === id) ? ids : next;
    });
  }, [state.sessions, sessionById]);
  useEffect(() => store(orderKey, tracked), [tracked]);
  const hiddenCount = tracked.filter((id) => dismissed.includes(id) && sessionById.has(id)).length;
  const sessions = tracked
    .filter((id) => showHidden || !dismissed.includes(id))
    .map((id) => sessionById.get(id))
    .filter((s): s is Session => !!s);
  useEffect(() => {
    const viewport = gridViewport.current;
    if (!viewport) return;
    // Measure the actual card area, excluding gutters and outer padding.
    const observer = new ResizeObserver(([entry]) => setFit(fitColumns(entry.contentRect.width)));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [visible, sessions.length > 0]);
  const shape = layout.auto ? autoLayout(sessions.length, fit) : layout;
  const projectKey = JSON.stringify([...new Set(sessions.map((s) => s.projectId))].sort());
  useEffect(() => {
    if (!visible) return;
    const ids: string[] = JSON.parse(projectKey);
    if (!ids.length) return;
    const update = () => {
      if (!document.hidden) for (const id of ids) void refreshGit(id);
    };
    update();
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [visible, projectKey]);
  const order = useRef<string[]>([]);
  order.current = sessions.map((s) => s.id);
  const lastJump = useRef<string | undefined>(undefined);
  const focusCard = (id: string) => {
    const card = section.current?.querySelector<HTMLElement>(
      `[data-session-id="${CSS.escape(id)}"]`,
    );
    if (!card) return;
    lastJump.current = id;
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    (
      card.querySelector<HTMLElement>('.multichat-approvals button:enabled') ??
      card.querySelector<HTMLElement>('textarea') ??
      card.querySelector<HTMLElement>('.multichat-preview')
    )?.focus({ preventScroll: true });
  };
  const jump = (ids: string[]) => {
    if (!ids.length) return;
    focusCard(ids[(ids.indexOf(lastJump.current ?? '') + 1) % ids.length]);
  };
  // ⌘1–9 jumps to a card; holding the modifier reveals the numbers.
  useEffect(() => {
    if (!visible) return;
    let timer: number | undefined;
    const hide = () => {
      clearTimeout(timer);
      setShowKeys(false);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === (mac ? 'Meta' : 'Control')) {
        clearTimeout(timer);
        timer = window.setTimeout(() => setShowKeys(true), 350);
        return;
      }
      hide();
      if (
        (mac ? e.metaKey : e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        /^[1-9]$/.test(e.key) &&
        !document.querySelector('[role="dialog"]')
      ) {
        const id = order.current[Number(e.key) - 1];
        if (!id) return;
        e.preventDefault();
        focusCard(id);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', hide);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', hide);
      window.removeEventListener('blur', hide);
    };
  }, [visible]);
  const attention = sessions.filter((s) => ['attention', 'error'].includes(status(s)[0]));
  const working = sessions.filter((s) => status(s)[0] === 'working').length;
  const unseenShown = sessions.filter((s) => unseen.includes(s.id));
  const overflow = sessions.length - shape.rows * shape.columns;
  const reorder = (source: string, destination: string) => {
    if (source === destination) return;
    setTracked((ids) => {
      const from = ids.indexOf(source),
        to = ids.indexOf(destination);
      if (from < 0 || to < 0) return ids;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, source);
      return next;
    });
    setAnnouncement('Orden de los chats actualizado');
  };
  const endDrag = () => {
    dragId.current = undefined;
    setDragged(undefined);
    setTarget(undefined);
  };
  const focusNext = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focusNext.current && order.current.includes(focusNext.current)) {
      focusCard(focusNext.current);
      focusNext.current = undefined;
    }
  });
  const createChat = async (projectId: string, profile: Profile) => {
    const created: Session | undefined = await controls.run({
      type: 'newSession',
      projectId,
      profile,
    });
    if (!created?.id) return false;
    // A new chat is stopped until its first message; track it so its card is there to write in.
    setTracked((ids) => (ids.includes(created.id) ? ids : [...ids, created.id]));
    focusNext.current = created.id;
    return true;
  };
  // Keep only ordering/attention bookkeeping while hidden. Drafts and attachments
  // live in the shared store, so switching views does not retain hidden transcripts.
  if (!visible) return null;
  const bar = (
    <div className="multichat-toolbar">
      <div className="multichat-summary">
        <strong>{plural(sessions.length, 'chat', 'chats')}</strong>
        {working > 0 && (
          <span
            className="working"
            role="img"
            title={plural(working, 'chat trabajando', 'chats trabajando')}
            aria-label={`${working} trabajando`}
          >
            <i />
            {working}
          </span>
        )}
        {attention.length > 0 && (
          <button
            className="attention"
            aria-label={`${attention.length} ${attention.length === 1 ? 'requiere' : 'requieren'} atención`}
            title="Ir al siguiente chat que requiere atención"
            onClick={() => jump(attention.map((s) => s.id))}
          >
            <i />
            {attention.length}
          </button>
        )}
        {unseenShown.length > 0 && (
          <button
            className="done"
            aria-label={`${plural(unseenShown.length, 'terminado', 'terminados')} sin revisar`}
            title="Ir al siguiente chat terminado sin revisar"
            onClick={() => jump(unseenShown.map((s) => s.id))}
          >
            <i />
            {unseenShown.length}
          </button>
        )}
        {overflow > 0 && (
          <span
            className="multichat-overflow"
            role="img"
            aria-label={`${overflow} chats más al desplazar`}
            title={`Desplaza para ver ${overflow} chats más`}
          >
            <ArrowDown size={12} />
            {overflow}
          </span>
        )}
        <button
          onClick={() => setShowHidden((v) => !v)}
          aria-pressed={showHidden}
          aria-label={showHidden ? 'Ocultar chats ocultos' : 'Ver chats ocultos'}
          title={showHidden ? 'Ocultar chats ocultos' : 'Ver chats ocultos'}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
          {hiddenCount > 0 && <span>{hiddenCount}</span>}
        </button>
      </div>
      <div className="multichat-tools">
        <NewChatPicker state={state} disabled={disabled} create={createChat} />
        {sessions.length > 0 && (
          <LayoutPicker layout={layout} shape={shape} setLayout={setLayout} />
        )}
      </div>
    </div>
  );
  return (
    <section
      ref={section}
      className={`multichat ${showKeys ? 'show-keys' : ''}`}
      hidden={!visible}
      aria-label="Multichat"
    >
      {visible && (toolbar ? createPortal(bar, toolbar) : bar)}
      <span className="multichat-announcement" role="status">
        {announcement}
      </span>
      {sessions.length ? (
        <div className="multichat-scroll" ref={gridViewport}>
          <div
            className={`multichat-grid ${layout.auto ? 'auto' : ''}`}
            style={
              {
                '--grid-columns': shape.columns,
                '--grid-rows': shape.rows,
              } as React.CSSProperties
            }
          >
            {sessions.map((s, i) => (
              <Card
                key={s.id}
                session={s}
                teamSessions={state.sessions}
                openTeamChat={open}
                index={i}
                actions={actionsFor(s)}
                visible={visible}
                controls={controls}
                floating={!!state.floatingChats?.some((f) => f.sessionId === s.id)}
                compatible={compatibleRuntime(state)}
                project={state.projects.find((p) => p.id === s.projectId)?.name ?? 'Proyecto'}
                root={state.projects.find((p) => p.id === s.projectId)?.path}
                account={
                  state.profiles?.find((p) => p.id === s.profile)?.name ??
                  providerNames[providerKind(s.profile)]
                }
                color={state.profiles?.find((p) => p.id === s.profile)?.color}
                git={git[s.projectId]?.value}
                gitError={git[s.projectId]?.error}
                gitBusy={!!gitBusy[s.projectId]}
                refreshGit={() => void refreshGit(s.projectId)}
                servers={(state.devServers ?? []).filter(
                  (server) => server.sessionId === s.id && server.projectId === s.projectId,
                )}
                openDev={(url) => openDev(s, url)}
                disabled={disabled}
                unseen={unseen.includes(s.id)}
                seen={() => {
                  touched.current = s.id;
                  setUnseen((ids) => (ids.includes(s.id) ? ids.filter((id) => id !== s.id) : ids));
                }}
                open={() => open(s)}
                hidden={dismissed.includes(s.id)}
                toggleHidden={() => toggleHidden(s.id)}
                dismiss={() => {
                  setShowHidden(false);
                  close(s);
                }}
                dragging={dragged === s.id}
                dropTarget={target === s.id}
                dragStart={(e) => {
                  dragId.current = s.id;
                  setDragged(s.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('application/x-agent-desk-chat', s.id);
                }}
                dragEnd={endDrag}
                dragOver={(e) => {
                  if (dragId.current && dragId.current !== s.id) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setTarget(s.id);
                  }
                }}
                drop={(e) => {
                  if (!dragId.current) return;
                  e.preventDefault();
                  e.stopPropagation();
                  reorder(dragId.current, s.id);
                  endDrag();
                }}
                move={(direction) => {
                  const destination = sessions[i + direction];
                  if (destination) reorder(s.id, destination.id);
                }}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="empty">
          <LayoutGrid size={28} />
          <h2>No hay chats en marcha</h2>
          <p>Crea uno con + o inicia un chat en cualquier proyecto para verlo aquí.</p>
        </div>
      )}
    </section>
  );
}
