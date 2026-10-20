import { TeamIndicator } from './team';
import React, { useEffect, useRef, useState } from 'react';
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
  Bot,
  Sparkles,
  Copy,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { Action, Attachment, Profile, Session, Snapshot } from './shared';
import { providerKind, providerNames, isConnectedProvider } from './shared';
import { sessionIsLive } from './session-tabs';
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
import {
  cardStatus as status,
  isPending,
  lastTurnChanges,
  planProgress,
  subagentLine,
} from './supervision';
import { shortPath } from './activity';
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
        <span>{plural(git.files.length, 'archivo', 'archivos')}</span>
      ) : null}
      {!!git.lines?.added && <span className="git-added">+{git.lines.added}</span>}
      {!!git.lines?.removed && <span className="git-removed">−{git.lines.removed}</span>}
      {!!git.ahead && <span title="Commits por subir">↑{git.ahead}</span>}
      {!!git.behind && <span title="Commits por bajar">↓{git.behind}</span>}
    </span>
  );
}

/** What a supervisor needs before the log: plan progress, changes of this turn, subagents. */
function Supervision({
  session,
  root,
  showChanges,
}: {
  session: Session;
  root?: string;
  showChanges?: () => void;
}) {
  const plan = planProgress(session);
  const changes = lastTurnChanges(session);
  const agents = subagentLine(session);
  if (!plan && !changes && !agents) return null;
  const files = changes?.files.map((f) => shortPath(f.path, root)) ?? [];
  return (
    <div className="multichat-supervision">
      {(plan || changes) && (
        <div className="multichat-supervision-row">
          {plan && (
            <div
              className="multichat-plan"
              role="progressbar"
              aria-label="Progreso del plan"
              aria-valuemin={0}
              aria-valuemax={plan.total}
              aria-valuenow={plan.done}
              aria-valuetext={`${plan.done} de ${plan.total} tareas${plan.current ? ` · ${plan.current}` : ''}`}
              title={plan.current ? `En curso: ${plan.current}` : undefined}
            >
              <span className="multichat-plan-count">
                {plan.done}/{plan.total}
              </span>
              <span className="multichat-plan-bar" aria-hidden="true">
                <i style={{ width: `${(plan.done / plan.total) * 100}%` }} />
              </span>
              <span className="multichat-plan-current">
                {plan.current ?? (plan.done === plan.total ? 'Plan completado' : 'Pendiente')}
              </span>
            </div>
          )}
          {changes && (
            <button
              className="multichat-changes"
              title={`Cambios de este turno:\n${files.slice(0, 12).join('\n')}${files.length > 12 ? `\n… y ${files.length - 12} más` : ''}`}
              aria-label={`${plural(files.length, 'archivo cambiado', 'archivos cambiados')} en este turno, ${changes.added} líneas añadidas y ${changes.removed} eliminadas. Ver cambios`}
              disabled={!showChanges}
              onClick={showChanges}
            >
              {plural(files.length, 'archivo', 'archivos')}
              {!!changes.added && <span className="git-added">+{changes.added}</span>}
              {!!changes.removed && <span className="git-removed">−{changes.removed}</span>}
            </button>
          )}
        </div>
      )}
      {agents && (
        <div className="multichat-agents" title={agents}>
          <Bot size={11} aria-hidden="true" />
          <span>{agents}</span>
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
  const [localError, setLocalError] = useState('');
  const sendingRef = useRef(false);
  const pickingRef = useRef(false);
  const preview = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
  const draft = controls.drafts[session.id] ?? '';
  const images = controls.images[session.id] ?? [];
  const messages = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const entryCount = conversationEntries(session).length;
  const tail = messages.slice(-1);
  const textOf = (m: Session['messages'][number]) =>
    m.blocks?.some((b) => b.type === 'text')
      ? m.blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n')
      : m.text;
  const lastText = tail.length ? textOf(tail[tail.length - 1]) : '';
  useEffect(() => {
    if (visible && following.current && preview.current)
      preview.current.scrollTop = preview.current.scrollHeight;
  }, [lastText, messages.length, visible, session.approvals.length]);
  const terminal = session.mode === 'terminal' || session.status === 'terminal';
  const pending = isPending(session);
  // Offered only on an empty field: a click fills the draft, never sends or replaces your text.
  const suggestion = !pending && !draft.trim() && !images.length ? session.suggestion : undefined;
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
    if (!enabled || (!text && !images.length) || sendingRef.current) return;
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
  const attach = async () => {
    if (!enabled || pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    try {
      const picked: Attachment[] | undefined = await controls.run({
        type: 'pickImages',
        sessionId: session.id,
      });
      if (picked?.length)
        controls.setImages((v) => ({ ...v, [session.id]: [...(v[session.id] ?? []), ...picked] }));
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
        onDragOver={dragOver}
        onDrop={drop}
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
          {servers.map((server) => (
            <button
              key={server.port}
              className="multichat-server"
              aria-label={`Abrir puerto ${server.port} de ${session.title}`}
              title={`Abrir ${server.url} en Chrome`}
              onClick={() => openDev(server.url)}
            >
              <Globe size={13} />
            </button>
          ))}
          {claude && (session.forkFrom ?? (session.attempted && session.reference)) && (
            <button
              className="multichat-fork"
              aria-label={`Duplicar ${session.title}`}
              title="Duplicar chat: mismo historial en otro worktree para probar otro enfoque"
              disabled={disabled || !compatible || pending || !!controls.busy[session.id]}
              onClick={() =>
                void controls.run({ type: 'forkSession', sessionId: session.id, isolate: true })
              }
            >
              <Copy size={13} />
            </button>
          )}
          <button
            className="multichat-expand"
            aria-label={`Ampliar ${session.title}`}
            title="Ampliar"
            disabled={disabled}
            onClick={open}
          >
            <Maximize2 size={13} />
          </button>
          <button
            className="multichat-hide"
            aria-label={`${hidden ? 'Mostrar' : 'Ocultar'} ${session.title} en el grid`}
            title={hidden ? 'Mostrar en el grid' : 'Ocultar del grid'}
            onClick={toggleHidden}
          >
            {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <button
            className="multichat-dismiss"
            draggable={false}
            onClick={dismiss}
            title="Eliminar chat"
            aria-label={`Retirar ${session.title} del grid`}
          >
            <X size={13} />
          </button>
        </div>
        <div className="multichat-info-line">
          <span className="multichat-account" title={`Cuenta: ${account}`}>
            {account}
          </span>
          <span className="multichat-folder" title={root ?? project}>
            {project}
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
          <button
            className="multichat-git-refresh"
            aria-label={`Actualizar Git de ${project}`}
            title="Actualizar estado de Git"
            disabled={gitBusy}
            onClick={refreshGit}
          >
            <RefreshCw size={11} className={gitBusy ? 'spinner' : ''} />
          </button>
        </div>
        {visible && !terminal && (
          <>
            <Supervision session={session} root={root} showChanges={actions.showChanges} />
            {!!session.todos?.length && <TodoPanel todos={session.todos} />}
            <ExecutionPanel session={session} />
          </>
        )}
        {visible && !terminal && !session.approvals.length && (
          <ActivityDock session={session} kind={providerKind(session.profile)} compact />
        )}
        <div
          className="multichat-preview compact-conversation"
          ref={preview}
          tabIndex={0}
          aria-label={`Conversación de ${session.title}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}
        >
          {entryCount > limit && (
            <button
              className="multichat-earlier"
              onClick={() => {
                following.current = false;
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
        {!terminal && (
          <PendingMessages
            session={session}
            run={controls.run}
            recover={(text, attachments) => {
              setDraft([draft, text].filter(Boolean).join('\n'));
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
        {!terminal && (
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
            {suggestion && (
              <button
                type="button"
                className="prompt-suggestion"
                title={`Usar como borrador: ${suggestion}`}
                aria-label={`Usar sugerencia como borrador: ${suggestion}`}
                onClick={() => {
                  setDraft(suggestion);
                  requestAnimationFrame(() => {
                    const field = textarea.current;
                    field?.focus();
                    field?.setSelectionRange(suggestion.length, suggestion.length);
                  });
                }}
              >
                <Sparkles size={11} aria-hidden="true" />
                <span>{suggestion}</span>
              </button>
            )}
            <div className="multichat-compose-row">
              <textarea
                ref={textarea}
                aria-label={`Mensaje para ${session.title}`}
                placeholder={pending ? 'Añade indicaciones…' : 'Escribe un mensaje…'}
                rows={1}
                value={draft}
                readOnly={sending}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
  opened,
  close,
  ...controls
}: {
  opened: string[];
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
  const refreshGit = async (projectId: string) => {
    if (gitPending.current.has(projectId)) return;
    gitPending.current.add(projectId);
    setGitBusy((v) => ({ ...v, [projectId]: true }));
    try {
      const value: GitSnapshot = await window.desk.invoke({ type: 'diff', projectId });
      setGit((v) => ({ ...v, [projectId]: { value } }));
    } catch (e) {
      setGit((v) => ({
        ...v,
        [projectId]: { error: e instanceof Error ? e.message : 'No se pudo consultar Git' },
      }));
    } finally {
      gitPending.current.delete(projectId);
      setGitBusy((v) => ({ ...v, [projectId]: false }));
    }
  };
  const section = useRef<HTMLElement>(null);
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
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setFit(fitColumns(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [dragged, setDragged] = useState<string>();
  const [target, setTarget] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const dragId = useRef<string | undefined>(undefined);
  const wasPending = useRef(new Map<string, boolean>());
  // Last card clicked or focused: its own finish is already in view.
  const touched = useRef<string | undefined>(undefined);
  const watching = useRef({ visible, selected: state.selectedSession });
  watching.current = { visible, selected: state.selectedSession };
  useEffect(() => {
    setTracked((previous) => {
      const next = previous.filter((id) => state.sessions.some((s) => s.id === id));
      for (const s of state.sessions)
        if (
          (sessionIsLive(s) || s.approvals.length || opened.includes(s.id)) &&
          !next.includes(s.id)
        )
          next.push(s.id);
      return next.length === previous.length && next.every((id, i) => previous[i] === id)
        ? previous
        : next;
    });
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
      const next = [...new Set([...ids, ...finished])].filter((id) =>
        state.sessions.some((s) => s.id === id && !isPending(s)),
      );
      return next.length === ids.length && next.every((id, i) => ids[i] === id) ? ids : next;
    });
  }, [state.sessions, opened.join('\0')]);
  useEffect(() => store(orderKey, tracked), [tracked]);
  const hiddenCount = tracked.filter(
    (id) => dismissed.includes(id) && state.sessions.some((s) => s.id === id),
  ).length;
  const sessions = tracked
    .filter((id) => showHidden || !dismissed.includes(id))
    .map((id) => state.sessions.find((s) => s.id === id))
    .filter((s): s is Session => !!s);
  const shape = layout.auto ? autoLayout(sessions.length, fit) : layout;
  const projectKey = JSON.stringify([...new Set(sessions.map((s) => s.projectId))].sort());
  useEffect(() => {
    if (!visible) return;
    const ids: string[] = JSON.parse(projectKey);
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
  const bar = (
    <div className="multichat-toolbar">
      <div className="multichat-summary">
        <strong>{plural(sessions.length, 'chat', 'chats')}</strong>
        {working > 0 && (
          <span className="working">
            <i />
            {working} trabajando
          </span>
        )}
        {attention.length > 0 && (
          <button
            className="attention"
            title="Ir al siguiente chat que requiere atención"
            onClick={() => jump(attention.map((s) => s.id))}
          >
            <i />
            {attention.length} {attention.length === 1 ? 'requiere' : 'requieren'} atención
          </button>
        )}
        {unseenShown.length > 0 && (
          <button
            className="done"
            title="Ir al siguiente chat terminado sin revisar"
            onClick={() => jump(unseenShown.map((s) => s.id))}
          >
            <i />
            {plural(unseenShown.length, 'terminado', 'terminados')} sin revisar
          </button>
        )}
        {overflow > 0 && <span>Desplaza para ver {overflow} más</span>}
        <button
          onClick={() => setShowHidden((v) => !v)}
          aria-pressed={showHidden}
          aria-label={showHidden ? 'Ocultar chats ocultos' : 'Ver chats ocultos'}
          title={showHidden ? 'Ocultar chats ocultos' : 'Ver chats ocultos'}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
          {hiddenCount > 0 &&
            (showHidden ? ` Ocultar ${hiddenCount} ocultos` : ` Ver ${hiddenCount} ocultos`)}
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
        <div className="multichat-scroll">
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
