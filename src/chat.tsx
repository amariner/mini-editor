import { isCodex } from './shared';
import { conversationEntries, currentActivity, working } from './conversation';
import { CodexCatalogStatus } from './codex-catalog';
import { signatureModel, reportedTokens, compactTokens } from './task-signature';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  X,
  ArrowUp,
  Square,
  ChevronDown,
  ChevronRight,
  Check,
  ShieldCheck,
  Sparkles,
  Terminal as TerminalIcon,
  FileText,
  Pencil,
  Search,
  Globe,
  ListTodo,
  Bot,
  Wrench,
  CircleHelp,
  Map,
  Zap,
  Gauge,
  Bug,
  FlaskConical,
  Leaf,
} from 'lucide-react';
import type {
  Action,
  Approval,
  Block,
  Message,
  Session,
  SlashCommand,
  ImageAttachment,
  TokenOptimization,
} from './shared';
import {
  codexApprovals,
  efforts,
  permissionModes,
  defaultOptimization,
  savingLevels,
} from './shared';
import { Markdown } from './markdown';
export type Run = (a: Action) => Promise<any>;
const localCommands: SlashCommand[] = [
  { name: 'clear', description: 'Vaciar la conversación y empezar de cero' },
  { name: 'config', description: 'Abrir Ajustes y cuentas' },
  { name: 'model', description: 'Cambiar de modelo', argumentHint: '[modelo]' },
  { name: 'permissions', description: 'Cambiar el modo de permisos', argumentHint: '[modo]' },
  { name: 'effort', description: 'Nivel de esfuerzo', argumentHint: '[nivel]' },
  { name: 'cost', description: 'Coste y tokens de la sesión' },
  { name: 'context', description: 'Uso del contexto' },
  { name: 'status', description: 'Cuenta, modelo y versión' },
  { name: 'mcp', description: 'Estado de los servidores MCP' },
  { name: 'rename', description: 'Renombrar la sesión', argumentHint: '[nombre]' },
  { name: 'terminal', description: 'Abrir la terminal oficial de Claude Code' },
  { name: 'help', description: 'Lista de comandos' },
];
function basename(p: unknown) {
  return typeof p === 'string' ? p.split('/').filter(Boolean).slice(-2).join('/') : '';
}
export function toolMeta(b: Extract<Block, { type: 'tool_use' }>) {
  const i = b.input ?? {};
  switch (b.name) {
    case 'Bash':
      return {
        icon: TerminalIcon,
        color: 'var(--c-green)',
        summary: i.description || i.command || '',
      };
    case 'Read':
      return { icon: FileText, color: 'var(--c-blue)', summary: basename(i.file_path) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return {
        icon: Pencil,
        color: 'var(--c-purple)',
        summary: basename(i.file_path ?? i.notebook_path),
      };
    case 'Write':
      return { icon: Pencil, color: 'var(--c-purple)', summary: basename(i.file_path) };
    case 'Glob':
    case 'Grep':
      return { icon: Search, color: 'var(--c-cyan)', summary: i.pattern ?? '' };
    case 'WebFetch':
    case 'WebSearch':
      return { icon: Globe, color: 'var(--c-orange)', summary: i.url ?? i.query ?? '' };
    case 'TodoWrite':
      return {
        icon: ListTodo,
        color: 'var(--c-cyan)',
        summary: `${(i.todos ?? []).length} tareas`,
      };
    case 'Task':
    case 'Agent':
      return {
        icon: Bot,
        color: 'var(--c-purple)',
        summary: i.description ?? i.prompt?.slice(0, 80) ?? '',
      };
    case 'AskUserQuestion':
      return { icon: CircleHelp, color: 'var(--c-orange)', summary: 'Pregunta' };
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return {
        icon: Map,
        color: 'var(--c-blue)',
        summary: b.name === 'EnterPlanMode' ? 'Entrando en modo plan' : 'Plan listo',
      };
    case 'Skill':
      return { icon: Sparkles, color: 'var(--c-orange)', summary: i.skill ?? '' };
    default:
      return {
        icon: Wrench,
        color: 'var(--muted)',
        summary:
          typeof i === 'object'
            ? (Object.values(i)
                .find((v) => typeof v === 'string')
                ?.toString()
                .slice(0, 80) ?? '')
            : '',
      };
  }
}
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff">
      {before.split('\n').map((l, i) => (
        <div className="removed" key={'r' + i}>
          {l || ' '}
        </div>
      ))}
      {after.split('\n').map((l, i) => (
        <div className="added" key={'a' + i}>
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}
export function ToolInput({ name, input }: { name: string; input: any }) {
  const i = input ?? {};
  if (name === 'Bash') return <pre className="code">{i.command}</pre>;
  if (name === 'Edit') return <Diff before={i.old_string ?? ''} after={i.new_string ?? ''} />;
  if (name === 'MultiEdit')
    return (
      <>
        {(i.edits ?? []).map((e: any, k: number) => (
          <Diff key={k} before={e.old_string ?? ''} after={e.new_string ?? ''} />
        ))}
      </>
    );
  if (name === 'Write') return <pre className="code">{String(i.content ?? '').slice(0, 6000)}</pre>;
  if (name === 'Read' || name === 'Glob' || name === 'Grep')
    return (
      <pre className="code">{[i.file_path, i.pattern, i.path].filter(Boolean).join('  ')}</pre>
    );
  if (name === 'Task' || name === 'Agent') return <pre className="code">{i.prompt}</pre>;
  if (name === 'TodoWrite')
    return (
      <ul className="todos">
        {(i.todos ?? []).map((t: any, k: number) => (
          <li key={k} className={t.status}>
            <span className={`md-check ${t.status === 'completed' ? 'on' : ''}`} />
            {t.content}
          </li>
        ))}
      </ul>
    );
  const text = JSON.stringify(i, null, 2);
  return <pre className="code">{text.length > 4000 ? text.slice(0, 4000) + '…' : text}</pre>;
}
function ToolCard({ b }: { b: Extract<Block, { type: 'tool_use' }> }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(b);
  const Icon = meta.icon;
  const running = !b.done;
  return (
    <div className={`tool ${running ? 'running' : ''} ${b.isError ? 'failed' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon" style={{ color: b.isError ? 'var(--c-red)' : meta.color }}>
          <Icon size={14} />
        </span>
        <span className="tool-name">{b.name}</span>
        <span className="tool-summary">{meta.summary}</span>
        {running ? (
          <span className="tool-state">
            <i className="spinner" />
            {b.elapsed ? `${Math.round(b.elapsed)}s` : ''}
          </span>
        ) : b.isError ? (
          <span className="tool-state error">Error</span>
        ) : (
          <Check size={13} className="tool-ok" />
        )}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="tool-body">
          <ToolInput name={b.name} input={b.input} />
          {b.children?.length ? (
            <div className="children">
              {b.children.map((c, k) =>
                c.type === 'tool_use' ? (
                  <ToolCard key={c.id} b={c} />
                ) : c.type === 'text' && c.text.trim() ? (
                  <div className="child-text" key={k}>
                    <Markdown text={c.text} />
                  </div>
                ) : null,
              )}
            </div>
          ) : null}
          {b.result !== undefined && (
            <pre className={`result ${b.isError ? 'failed' : ''}`}>
              {b.result.length > 5000
                ? b.result.slice(0, 5000) + '\n…'
                : b.result || '(sin salida)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim() && !streaming) return null;
  return (
    <div className="thinking-block">
      <button onClick={() => setOpen((v) => !v)}>
        <Sparkles size={13} />
        {streaming && !text.trim() ? 'Razonando…' : 'Razonamiento'}
        {text.trim() && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </button>
      {open && text.trim() && <div className="thinking-text">{text}</div>}
    </div>
  );
}
export function MessageView({
  m,
  kind,
  showAuthor = true,
}: {
  m: Message;
  kind: 'claude' | 'codex';
  showAuthor?: boolean;
}) {
  if (m.role === 'user')
    return (
      <div className="row user">
        <div className="bubble">
          {m.attachments?.length ? (
            <div className="message-images">
              {m.attachments.map((i) => (
                <img key={i.id} src={i.preview} alt={i.name} title={i.name} />
              ))}
            </div>
          ) : null}
          {m.text}
        </div>
      </div>
    );
  if (m.role === 'system')
    return (
      <div className={`row system ${m.kind ?? 'info'}`}>
        <pre>{m.text}</pre>
      </div>
    );
  if (m.role === 'tool')
    return (
      <div className="row tool-row">
        <details>
          <summary>{m.text.split('\n')[0].slice(0, 110)}</summary>
          <pre>{m.text}</pre>
        </details>
      </div>
    );
  return (
    <div className="row assistant">
      {showAuthor && (
        <div className="author">
          <span className={`glyph ${kind}`}>{kind === 'codex' ? '◈' : '✳'}</span>
          {kind === 'codex' ? 'Codex' : 'Claude'}
          {m.model && <span className="model-tag">{m.model.replace(/^claude-/, '')}</span>}
        </div>
      )}
      {m.blocks
        ? m.blocks.map((b, k) =>
            b.type === 'text' ? (
              b.text.trim() ? (
                <Markdown key={k} text={b.text} />
              ) : null
            ) : b.type === 'thinking' ? (
              <Thinking key={k} text={b.text} streaming={!b.final} />
            ) : (
              <ToolCard key={b.id} b={b} />
            ),
          )
        : m.text && <Markdown text={m.text} />}
    </div>
  );
}
function ActivityMessages({ messages, kind }: { messages: Message[]; kind: 'claude' | 'codex' }) {
  return (
    <div className="activity-messages">
      {messages.map((m) => (
        <MessageView key={m.id} m={m} kind={kind} showAuthor={false} />
      ))}
    </div>
  );
}
export function ConversationMessages({
  session,
  kind,
}: {
  session: Session;
  kind: 'claude' | 'codex';
}) {
  return (
    <>
      {conversationEntries(session).map((entry) => {
        if (entry.type === 'message')
          return <MessageView key={entry.id} m={entry.message} kind={kind} />;
        if (entry.pending) return null;
        return (
          <div className="response-group" key={entry.id}>
            {entry.work.length > 0 && (
              <details className={`response-work ${entry.errors ? 'has-errors' : ''}`}>
                <summary>
                  <ChevronRight size={12} />
                  <span>
                    {entry.steps
                      ? `Ver ${entry.steps} ${entry.steps === 1 ? 'paso' : 'pasos'}`
                      : 'Ver actividad'}
                    {entry.errors
                      ? ` · ${entry.errors} ${entry.errors === 1 ? 'error' : 'errores'}`
                      : ''}
                  </span>
                </summary>
                <ActivityMessages messages={entry.work} kind={kind} />
              </details>
            )}
            {entry.answer && <MessageView m={entry.answer} kind={kind} showAuthor={false} />}
          </div>
        );
      })}
    </>
  );
}
export function ActivityDock({ session, kind }: { session: Session; kind: 'claude' | 'codex' }) {
  const [open, setOpen] = useState(false);
  const active = working(session);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  if (!active) return null;
  const activity = currentActivity(session);
  const last = activity?.messages.at(-1);
  const block = last?.blocks?.at(-1);
  let label = 'Preparando respuesta…';
  if (last?.role === 'tool') label = last.text.split('\n')[0];
  else if (block?.type === 'tool_use') {
    const meta = toolMeta(block);
    label = block.done ? 'Preparando respuesta…' : `${block.name} · ${meta.summary}`;
  } else if (block?.type === 'thinking') label = 'Razonando…';
  else if (block?.type === 'text') label = block.text;
  else if (last?.text) label = last.text;
  if (session.activity) label = session.activity;
  if (session.status === 'starting') label = 'Abriendo agente…';
  if (session.status === 'stopping') label = 'Deteniendo…';
  if (session.approvals.length || session.status === 'waiting') label = 'Esperando tu respuesta';
  label = label.replace(/\s+/g, ' ').trim().slice(0, 180) || 'Preparando respuesta…';
  return (
    <div className="activity-dock">
      {open && activity && (
        <div className="activity-log" id={`activity-${session.id}`}>
          <ActivityMessages messages={activity.messages} kind={kind} />
        </div>
      )}
      <button
        className="activity-current"
        aria-label="Ver progreso"
        aria-expanded={open}
        aria-controls={activity ? `activity-${session.id}` : undefined}
        disabled={!activity}
        onClick={() => setOpen((v) => !v)}
      >
        {session.approvals.length || session.status === 'waiting' ? (
          <CircleHelp size={12} />
        ) : (
          <i className="spinner" />
        )}
        <span className="activity-current-text" role="status" title={label}>
          {label}
        </span>
        {activity?.steps ? (
          <span className="activity-count">
            {activity.steps} {activity.steps === 1 ? 'paso' : 'pasos'}
          </span>
        ) : null}
        {activity?.errors ? (
          <span className="activity-count has-errors">
            {activity.errors} {activity.errors === 1 ? 'error' : 'errores'}
          </span>
        ) : null}
        {activity && <ChevronDown size={12} className={open ? 'expanded' : ''} />}
      </button>
    </div>
  );
}
function OptionTiles({
  q,
  value,
  onChange,
}: {
  q: any;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [other, setOther] = useState('');
  const toggle = (label: string) => {
    if (q.multiSelect)
      onChange(value.includes(label) ? value.filter((v) => v !== label) : [...value, label]);
    else onChange([label]);
  };
  return (
    <div className="question">
      <div className="question-head">
        {q.header && <span className="chip">{q.header}</span>}
        <strong>{q.question}</strong>
      </div>
      <div className="tiles">
        {(q.options ?? []).map((o: any) => (
          <button
            key={o.label}
            className={`tile ${value.includes(o.label) ? 'on' : ''}`}
            onClick={() => toggle(o.label)}
          >
            <span className="tile-title">{o.label}</span>
            {o.description && <span className="tile-desc">{o.description}</span>}
          </button>
        ))}
      </div>
      <input
        placeholder="Otra respuesta…"
        value={other}
        onChange={(e) => {
          setOther(e.target.value);
          onChange(e.target.value ? [e.target.value] : []);
        }}
      />
    </div>
  );
}
export function ClaudeApproval({
  approval,
  session,
  run,
}: {
  approval: Approval;
  session: Session;
  run: Run;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState('');
  const [showReason, setShowReason] = useState(false);
  const tool = approval.tool ?? '';
  const input = approval.input ?? {};
  const answer = (decision: 'accept' | 'always' | 'decline') =>
    run({
      type: 'approve',
      sessionId: session.id,
      requestId: approval.id,
      decision,
      answers:
        tool === 'AskUserQuestion'
          ? Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.join(', ')]))
          : undefined,
      message: reason || undefined,
    });
  if (tool === 'AskUserQuestion') {
    const questions: any[] = input.questions ?? [];
    const complete = questions.every((q) => answers[q.question]?.length);
    return (
      <section className="approval ask">
        <div className="approval-title">
          <CircleHelp size={16} />
          <strong>Claude necesita tu respuesta</strong>
        </div>
        {questions.map((q) => (
          <OptionTiles
            key={q.question}
            q={q}
            value={answers[q.question] ?? []}
            onChange={(v) => setAnswers({ ...answers, [q.question]: v })}
          />
        ))}
        <div className="approval-actions">
          <button className="primary" disabled={!complete} onClick={() => answer('accept')}>
            Enviar respuesta
          </button>
          <button
            className="quiet"
            onClick={() => run({ type: 'interrupt', sessionId: session.id })}
          >
            Interrumpir
          </button>
        </div>
      </section>
    );
  }
  const plan = tool === 'ExitPlanMode';
  const meta = toolMeta({ type: 'tool_use', id: '', name: tool, input });
  return (
    <section className="approval">
      <div className="approval-title">
        <ShieldCheck size={16} />
        <strong>
          {plan ? 'Claude ha preparado un plan' : (approval.title ?? `Claude quiere usar ${tool}`)}
        </strong>
      </div>
      {!plan && (
        <div className="approval-tool">
          <span className="tool-name">{tool}</span>
          <span className="tool-summary">{meta.summary}</span>
        </div>
      )}
      {plan ? (
        <p className="muted">
          Revisa el plan en la conversación. Puedes aprobarlo y dejar que edite archivos sin volver
          a preguntar, aprobarlo con permisos normales, o pedir cambios.
        </p>
      ) : (
        <ToolInput name={tool} input={input} />
      )}
      {approval.reason && <p className="muted">{approval.reason}</p>}
      {approval.blockedPath && (
        <p className="muted">Ruta fuera del proyecto: {approval.blockedPath}</p>
      )}
      {showReason && (
        <textarea
          autoFocus
          placeholder={
            plan
              ? 'Qué debería cambiar en el plan…'
              : 'Explica a Claude por qué lo rechazas (opcional)…'
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      <div className="approval-actions">
        <button className="primary" onClick={() => answer(plan ? 'always' : 'accept')}>
          {plan ? 'Aprobar y aceptar ediciones' : 'Permitir'}
        </button>
        <button onClick={() => answer(plan ? 'accept' : 'always')}>
          {plan ? 'Aprobar' : 'Permitir siempre'}
        </button>
        {showReason ? (
          <button className="danger" onClick={() => answer('decline')}>
            Rechazar
          </button>
        ) : (
          <button className="quiet" onClick={() => setShowReason(true)}>
            Rechazar…
          </button>
        )}
      </div>
    </section>
  );
}
export function CodexApproval({
  approval,
  session,
  run,
}: {
  approval: Approval;
  session: Session;
  run: Run;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = approval.method === 'item/tool/requestUserInput',
    unsupported = approval.method === 'mcpServer/elicitation/request';
  const p = approval.params;
  const available = p.availableDecisions;
  return (
    <section className="approval">
      <div className="approval-title">
        <ShieldCheck size={16} />
        <strong>
          {questions
            ? 'Codex necesita tu respuesta'
            : unsupported
              ? 'Solicitud MCP no compatible'
              : 'Codex necesita tu aprobación'}
        </strong>
      </div>
      <p className="muted">{p.reason ?? p.message ?? 'Revisa la acción antes de continuar.'}</p>
      {questions ? (
        (p.questions ?? []).map((q: any) => (
          <label className="field" key={q.id}>
            {q.question}
            {q.options?.length > 0 && (
              <select
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              >
                <option value="">Selecciona una respuesta</option>
                {q.options.map((o: any) => (
                  <option key={o.label} value={o.label}>
                    {o.label}
                    {o.description ? ` — ${o.description}` : ''}
                  </option>
                ))}
              </select>
            )}
            <input
              aria-label={q.question}
              type={q.isSecret ? 'password' : 'text'}
              placeholder="Escribe tu respuesta"
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            />
          </label>
        ))
      ) : (
        <pre className="code">
          {p.command ??
            session.messages.find((m) => m.id === p.itemId)?.text ??
            JSON.stringify(p.permissions ?? p.networkApprovalContext ?? p.changes ?? p, null, 2)}
        </pre>
      )}
      {p.cwd && <p className="muted">Directorio: {p.cwd}</p>}
      <div className="approval-actions">
        {!unsupported && (
          <button
            className="primary"
            disabled={available && !available.includes('accept')}
            onClick={() =>
              run({
                type: 'approve',
                sessionId: session.id,
                requestId: approval.id,
                decision: 'accept',
                answers,
              })
            }
          >
            {questions ? 'Enviar respuesta' : 'Aprobar una vez'}
          </button>
        )}
        {!questions && (
          <button
            className="danger"
            onClick={() =>
              run({
                type: 'approve',
                sessionId: session.id,
                requestId: approval.id,
                decision: 'decline',
              })
            }
          >
            Rechazar
          </button>
        )}
        <button className="quiet" onClick={() => run({ type: 'interrupt', sessionId: session.id })}>
          Interrumpir
        </button>
      </div>
    </section>
  );
}
function Popover({
  label,
  icon: Icon,
  children,
  title,
  active = false,
}: {
  active?: boolean;
  label: string;
  icon: any;
  title?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="popover-host" ref={ref}>
      <button
        className={`chip-btn ${open || active ? 'on' : ''}`}
        title={`${title ?? label} · ${label}`}
        aria-label={title ?? label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={13} />
      </button>
      {open && <div className="popover">{children(() => setOpen(false))}</div>}
    </div>
  );
}
export function Composer({
  session,
  optimization = defaultOptimization,
  draft,
  setDraft,
  run,
  onSend,
  images,
  setImages,
  onLocalCommand,
  footerControl,
}: {
  session: Session;
  optimization?: TokenOptimization;
  draft: string;
  setDraft: (v: string) => void;
  run: Run;
  images: ImageAttachment[];
  setImages: (images: ImageAttachment[]) => void;
  onSend: (text: string, images: ImageAttachment[]) => Promise<boolean>;
  onLocalCommand: (name: string, arg: string) => boolean;
  footerControl?: React.ReactNode;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [index, setIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [imageError, setImageError] = useState('');
  const sendingRef = useRef(false);
  const claude = !isCodex(session.profile);
  const config = session.config;
  const signature = signatureModel(session, optimization, !!draft.trim() || !!images.length);
  const tokens = reportedTokens(session);
  const tokenDetail = tokens
    ? `Tokens acumulados de esta conversación · Última lectura confirmada\nEntrada: ${tokens.input.toLocaleString('es-ES')} (incluye caché)\nSalida: ${tokens.output.toLocaleString('es-ES')}${claude ? '\nClaude actualiza el conteo al terminar cada respuesta.' : ' (incluye razonamiento)'}`
    : 'Tokens pendientes de la primera lectura del proveedor';
  const optimize = (patch: Partial<TokenOptimization>) =>
    run({
      type: 'configureOptimization',
      profile: session.profile,
      optimization: { ...optimization, ...patch },
    });
  const chooseModel = async (model: string) => {
    const changed = await run({
      type: claude ? 'configure' : 'configureCodex',
      sessionId: session.id,
      config: { model },
    });
    if (changed) await optimize({ autoModel: false });
  };
  const autoOption = (close: () => void) => (
    <button
      className={optimization.autoModel ? 'on' : ''}
      onClick={() => {
        void optimize({ autoModel: true });
        close();
      }}
    >
      <strong>Auto</strong>
    </button>
  );
  const working = session.status === 'working' || session.status === 'waiting';
  const enabled = claude
    ? ['ready', 'working', 'waiting', 'stopped', 'error'].includes(session.status) &&
      session.mode !== 'terminal'
    : ['ready', 'stopped', 'error'].includes(session.status);
  const commands = useMemo(() => {
    if (!claude || !draft.startsWith('/') || draft.includes('\n')) return [];
    const q = draft.slice(1).split(' ')[0].toLowerCase();
    if (draft.includes(' ')) return [];
    const remote = (session.info?.commands ?? []).filter(
      (c) => !localCommands.some((l) => l.name === c.name),
    );
    return [...localCommands, ...remote]
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 12);
  }, [draft, session.info?.commands, claude]);
  useEffect(() => setIndex(0), [commands.length]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [draft]);
  const send = async () => {
    const text = draft.trim();
    if ((!text && !images.length) || !enabled || sendingRef.current) return;
    if (!images.length && text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      if (onLocalCommand(name, rest.join(' '))) {
        setDraft('');
        return;
      }
    }
    sendingRef.current = true;
    setSending(true);
    setDraft('');
    try {
      const ok = await onSend(text, images);
      if (!ok) setDraft(text);
      else setImages([]);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const pick = (c: SlashCommand) => {
    setDraft('/' + c.name + (c.argumentHint ? ' ' : ''));
    area.current?.focus();
  };
  const mode = permissionModes.find(
    (m) => m.id === (session.info?.permissionMode ?? config?.permissionMode),
  );
  const modelName =
    session.info?.models.find((m) => m.value === config?.model)?.displayName ??
    (config?.model && config.model !== 'default' ? config.model : 'Por defecto');
  return (
    <div className="composer-area">
      {commands.length > 0 && (
        <div className="slash-menu">
          {commands.map((c, i) => (
            <button
              key={c.name}
              className={i === index ? 'on' : ''}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(c)}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-hint">{c.argumentHint}</span>
              <span className="slash-desc">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {imageError && (
        <div className="attachment-error" role="alert">
          {imageError}
        </div>
      )}
      <div className={`composer ${enabled ? 'enabled' : ''}`}>
        {images.length > 0 && (
          <div className="attachment-list">
            {images.map((i) => (
              <div className="attachment-thumb" key={i.id}>
                <img src={i.preview} alt={i.name} title={i.name} />
                <button
                  aria-label={`Quitar ${i.name}`}
                  title="Quitar imagen"
                  disabled={sending}
                  onClick={() => {
                    setImages(images.filter((x) => x.id !== i.id));
                    void run({
                      type: 'discardImages',
                      sessionId: session.id,
                      attachmentIds: [i.id],
                    });
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          aria-label="Mensaje"
          rows={1}
          placeholder={
            sending || session.status === 'starting'
              ? 'Conectando agente…'
              : working
                ? 'Escribe para encolar otro mensaje…'
                : 'Escribe una tarea…'
          }
          disabled={!enabled || sending}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (commands.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setIndex(
                (i) => (i + (e.key === 'ArrowDown' ? 1 : commands.length - 1)) % commands.length,
              );
              return;
            }
            if (
              commands.length &&
              (e.key === 'Tab' || (e.key === 'Enter' && draft !== '/' + commands[index].name))
            ) {
              e.preventDefault();
              pick(commands[index]);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-chips">
            <button
              className="chip-btn attach-image"
              aria-label="Adjuntar imágenes"
              title="Adjuntar imágenes · PNG, JPEG, GIF, WebP · Hasta 4 de 5 MB"
              disabled={!enabled || sending || picking || images.length >= 4}
              onClick={async () => {
                setPicking(true);
                setImageError('');
                try {
                  const chosen = (await run({ type: 'pickImages', sessionId: session.id })) as
                    ImageAttachment[] | undefined;
                  if (chosen?.length) {
                    if (images.length + chosen.length > 4) {
                      setImageError('Puedes adjuntar hasta 4 imágenes por mensaje.');
                      void run({
                        type: 'discardImages',
                        sessionId: session.id,
                        attachmentIds: chosen.map((i) => i.id),
                      });
                    } else setImages([...images, ...chosen]);
                  }
                } finally {
                  setPicking(false);
                }
              }}
            >
              <Plus size={16} />
            </button>
            <Popover
              label={
                savingLevels.find((l) => l.value === optimization.level)?.name ?? 'Desactivado'
              }
              icon={Leaf}
              active={optimization.level > 0}
              title="Ahorro de tokens"
            >
              {(close) => (
                <>
                  {savingLevels.map((level) => (
                    <button
                      key={level.value}
                      className={optimization.level === level.value ? 'on' : ''}
                      onClick={() => {
                        void optimize({ level: level.value });
                        close();
                      }}
                    >
                      <strong>{level.name}</strong>
                    </button>
                  ))}
                </>
              )}
            </Popover>
            {claude ? (
              <>
                <Popover
                  label={
                    optimization.autoModel
                      ? `Auto · ${session.optimization?.model ?? modelName}`
                      : modelName
                  }
                  icon={Sparkles}
                  active={optimization.autoModel}
                  title="Modelo"
                >
                  {(close) => (
                    <>
                      {autoOption(close)}
                      {(session.info?.models.length
                        ? session.info.models
                        : [{ value: 'default', displayName: 'Por defecto', description: '' }]
                      ).map((m) => (
                        <button
                          key={m.value}
                          className={
                            !optimization.autoModel && m.value === config?.model ? 'on' : ''
                          }
                          onClick={() => {
                            void chooseModel(m.value);
                            close();
                          }}
                        >
                          <strong>{m.displayName}</strong>
                        </button>
                      ))}
                    </>
                  )}
                </Popover>
                <Popover
                  label={mode?.name ?? 'Permisos'}
                  icon={ShieldCheck}
                  title="Modo de permisos (⇧⇥ para alternar)"
                >
                  {(close) => (
                    <>
                      {permissionModes.map((m) => (
                        <button
                          key={m.id}
                          className={m.id === mode?.id ? 'on' : ''}
                          onClick={() => {
                            void run({
                              type: 'configure',
                              sessionId: session.id,
                              config: {
                                permissionMode: m.id,
                                ...(m.id === 'bypassPermissions' ? { allowBypass: true } : {}),
                              },
                            });
                            close();
                          }}
                        >
                          <strong>{m.name}</strong>
                        </button>
                      ))}
                    </>
                  )}
                </Popover>
                <Popover
                  label={efforts.find((e) => e.id === config?.effort)?.name ?? 'Esfuerzo'}
                  icon={Gauge}
                  title="Esfuerzo de razonamiento"
                >
                  {(close) => (
                    <>
                      <button
                        className={!config?.effort ? 'on' : ''}
                        onClick={() => {
                          void run({
                            type: 'configure',
                            sessionId: session.id,
                            config: { effort: undefined },
                          });
                          close();
                        }}
                      >
                        <strong>Por defecto</strong>
                      </button>
                      {efforts.map((e) => (
                        <button
                          key={e.id}
                          className={e.id === config?.effort ? 'on' : ''}
                          onClick={() => {
                            void run({
                              type: 'configure',
                              sessionId: session.id,
                              config: { effort: e.id },
                            });
                            close();
                          }}
                        >
                          <strong>{e.name}</strong>
                        </button>
                      ))}
                    </>
                  )}
                </Popover>
              </>
            ) : (
              <>
                <Popover
                  label={
                    optimization.autoModel
                      ? `Auto · ${session.optimization?.model ?? 'Por defecto'}`
                      : (session.info?.models.find((m) => m.value === session.codexConfig?.model)
                          ?.displayName ??
                        session.codexConfig?.model ??
                        'Por defecto')
                  }
                  active={optimization.autoModel}
                  icon={Sparkles}
                  title="Modelo de Codex"
                >
                  {(close) => (
                    <>
                      {autoOption(close)}
                      <button
                        className={
                          !optimization.autoModel &&
                          (!session.codexConfig?.model || session.codexConfig.model === 'default')
                            ? 'on'
                            : ''
                        }
                        onClick={() => {
                          void chooseModel('default');
                          close();
                        }}
                      >
                        <strong>Por defecto</strong>
                      </button>
                      {(session.info?.models ?? []).map((m) => (
                        <button
                          key={m.value}
                          className={
                            !optimization.autoModel && m.value === session.codexConfig?.model
                              ? 'on'
                              : ''
                          }
                          onClick={() => {
                            void chooseModel(m.value);
                            close();
                          }}
                        >
                          <strong>{m.displayName}</strong>
                        </button>
                      ))}
                      <CodexCatalogStatus session={session} run={run} compact />
                    </>
                  )}
                </Popover>
                <Popover
                  label={
                    codexApprovals.find((a) => a.id === session.codexConfig?.approvalPolicy)
                      ?.name ?? 'Aprobaciones'
                  }
                  icon={ShieldCheck}
                  title="Política de aprobación"
                >
                  {(close) => (
                    <>
                      <button
                        className={
                          session.codexConfig?.sandbox === 'danger-full-access' &&
                          session.codexConfig.approvalPolicy === 'never'
                            ? 'on'
                            : ''
                        }
                        onClick={() => {
                          void run({
                            type: 'configureCodex',
                            sessionId: session.id,
                            config: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
                          });
                          close();
                        }}
                      >
                        <strong>Acceso total</strong>
                      </button>
                      {codexApprovals.map((a) => (
                        <button
                          key={a.id}
                          className={a.id === session.codexConfig?.approvalPolicy ? 'on' : ''}
                          onClick={() => {
                            void run({
                              type: 'configureCodex',
                              sessionId: session.id,
                              config: {
                                approvalPolicy: a.id,
                                ...(session.codexConfig?.sandbox === 'danger-full-access'
                                  ? { sandbox: 'workspace-write' as const }
                                  : {}),
                              },
                            });
                            close();
                          }}
                        >
                          <strong>{a.name}</strong>
                        </button>
                      ))}
                    </>
                  )}
                </Popover>
                {(() => {
                  const levels =
                    session.info?.models.find((m) =>
                      !session.codexConfig?.model || session.codexConfig.model === 'default'
                        ? m.isDefault
                        : m.value === session.codexConfig.model,
                    )?.supportedEffortLevels ?? [];
                  return levels.length ? (
                    <Popover
                      label={session.codexConfig?.effort ?? 'Esfuerzo'}
                      icon={Gauge}
                      title="Esfuerzo de razonamiento"
                    >
                      {(close) => (
                        <>
                          <button
                            className={!session.codexConfig?.effort ? 'on' : ''}
                            onClick={() => {
                              void run({
                                type: 'configureCodex',
                                sessionId: session.id,
                                config: { effort: undefined },
                              });
                              close();
                            }}
                          >
                            <strong>Por defecto</strong>
                          </button>
                          {levels.map((e) => (
                            <button
                              key={e}
                              className={e === session.codexConfig?.effort ? 'on' : ''}
                              onClick={() => {
                                void run({
                                  type: 'configureCodex',
                                  sessionId: session.id,
                                  config: { effort: e },
                                });
                                close();
                              }}
                            >
                              <strong>{e}</strong>
                            </button>
                          ))}
                        </>
                      )}
                    </Popover>
                  ) : null;
                })()}
              </>
            )}
          </div>
          {working ? (
            <button
              className="send stop"
              title="Interrumpir (Esc)"
              onClick={() => run({ type: 'interrupt', sessionId: session.id })}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className="send"
              title="Enviar"
              aria-label="Enviar"
              disabled={!enabled || sending || (!draft.trim() && !images.length)}
              onClick={send}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-footer">
        <div className="task-signature" aria-label="Modelo y tokens">
          <span
            className="task-signature-model"
            title={
              signature === 'Auto'
                ? 'El modelo se elige al enviar la tarea'
                : `Modelo seleccionado: ${signature}${optimization.autoModel ? ' · Auto' : ''}`
            }
          >
            {signature}
          </span>
          <span aria-hidden="true">·</span>
          <span className="task-signature-tokens" title={tokenDetail} aria-label={tokenDetail}>
            ↑{tokens ? compactTokens(tokens.input) : '—'} ↓
            {tokens ? compactTokens(tokens.output) : '—'}
          </span>
        </div>
        {footerControl}
      </div>
    </div>
  );
}
export function TodoPanel({ todos }: { todos: NonNullable<Session['todos']> }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="todo-panel">
      <button onClick={() => setOpen((v) => !v)}>
        <ListTodo size={14} />
        Tareas · {done}/{todos.length}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <ul className="todos">
          {todos.map((t, k) => (
            <li key={k} className={t.status}>
              <span
                className={`md-check ${t.status === 'completed' ? 'on' : ''} ${t.status === 'in_progress' ? 'half' : ''}`}
              />
              {t.status === 'in_progress' ? t.activeForm || t.content : t.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export const suggestions: { title: string; text: string; icon: any; color: string }[] = [
  {
    icon: Search,
    color: 'var(--c-blue)',
    title: 'Explica el proyecto',
    text: 'Explora este proyecto y explícame su estructura, tecnologías y puntos de entrada.',
  },
  {
    icon: ListTodo,
    color: 'var(--c-cyan)',
    title: 'Revisa los cambios',
    text: 'Revisa los cambios pendientes de git y señala errores o mejoras.',
  },
  {
    icon: Map,
    color: 'var(--c-purple)',
    title: 'Planifica una función',
    text: 'Entra en modo plan y propón cómo implementar: ',
  },
  {
    icon: Bug,
    color: 'var(--c-red)',
    title: 'Busca errores',
    text: 'Busca posibles errores o riesgos en el código y propón correcciones.',
  },
  {
    icon: FlaskConical,
    color: 'var(--c-green)',
    title: 'Escribe pruebas',
    text: 'Añade pruebas para la parte del proyecto que más lo necesite.',
  },
  {
    icon: FileText,
    color: 'var(--c-orange)',
    title: 'Documenta',
    text: 'Mejora la documentación del proyecto con lo que falte.',
  },
];
