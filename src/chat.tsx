import { ReadAloudButton } from './read-aloud-button';
import {
  providerNames,
  providerKind,
  isConnectedProvider,
  type ProviderKind,
  isCodex,
} from './shared';
import {
  codexApprovalChoices,
  codexPermissionLabel,
  codexPermissionModes,
} from './codex-permissions';
import { readDroppedFiles } from './image-drop';
import { conversationEntries, currentActivity, working } from './conversation';
import { CodexCatalogStatus } from './codex-catalog';
import { signatureModel, reportedTokens, compactTokens } from './task-signature';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Paperclip,
  Plus,
  X,
  Square,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  CornerDownLeft,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Terminal as TerminalIcon,
  FileText,
  FilePlus,
  FileDiff,
  FolderSearch,
  Pencil,
  Search,
  Globe,
  ListTodo,
  Bot,
  Wrench,
  CircleHelp,
  Map,
  Gauge,
  Bug,
  FlaskConical,
  Leaf,
  Brain,
  TriangleAlert,
  OctagonX,
  Info,
  Waypoints,
  Undo2,
} from 'lucide-react';
import type {
  Action,
  Approval,
  Message,
  Session,
  SlashCommand,
  Attachment,
  TokenOptimization,
} from './shared';
import { efforts, permissionModes, defaultOptimization, savingLevels } from './shared';
import { CodeBlock, Markdown, useChatActions } from './markdown';
import { antigravityDenied } from './antigravity-permissions';
import {
  duration,
  fileChanges,
  lineDiff,
  shortPath,
  stepFromBlock,
  summarize,
  workItems,
  type DiffLine,
  type Step,
  type StepKind,
  type ToolBlock,
} from './activity';
export type Run = (a: Action) => Promise<any>;
const localCommands: SlashCommand[] = [
  { name: 'clear', description: 'Vaciar la conversación y empezar de cero' },
  { name: 'copy', description: 'Copiar la última respuesta' },
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
const ICONS: Record<StepKind, typeof FileText> = {
  command: TerminalIcon,
  read: FileText,
  search: Search,
  list: FolderSearch,
  edit: Pencil,
  create: FilePlus,
  web: Globe,
  agent: Bot,
  todo: ListTodo,
  browser: Globe,
  coordinate: Waypoints,
  plan: Map,
  question: CircleHelp,
  skill: Sparkles,
  tool: Wrench,
};
const VERBS: Record<StepKind, [done: string, running: string]> = {
  command: ['Ejecutó', 'Ejecutando'],
  read: ['Leyó', 'Leyendo'],
  search: ['Buscó', 'Buscando'],
  list: ['Listó', 'Listando'],
  edit: ['Editó', 'Editando'],
  create: ['Escribió', 'Escribiendo'],
  web: ['Consultó', 'Consultando'],
  agent: ['Delegó', 'Delegando'],
  todo: ['Tareas', 'Actualizando tareas'],
  browser: ['Navegó', 'Navegando'],
  coordinate: ['Coordinó', 'Coordinando'],
  plan: ['Planificó', 'Planificando'],
  question: ['Preguntó', 'Preguntando'],
  skill: ['Skill', 'Usando skill'],
  tool: ['Usó', 'Usando'],
};
/** Live seconds for running work; one interval per mounted consumer. */
function useNow(active: boolean, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [active, every]);
  return now;
}
export function prettyModel(id?: string) {
  if (!id) return '';
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id);
  if (modern)
    return `${modern[1][0].toUpperCase()}${modern[1].slice(1)} ${modern[2]}${modern[3] ? '.' + modern[3] : ''}`;
  const legacy = /^claude-(\d+)(?:-(\d+))?-([a-z]+)/.exec(id);
  if (legacy)
    return `${legacy[3][0].toUpperCase()}${legacy[3].slice(1)} ${legacy[1]}${legacy[2] ? '.' + legacy[2] : ''}`;
  return id;
}
function copyText(text: string) {
  return navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  );
}
function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  return (
    <button
      className={`msg-action ${done ? 'done' : ''}`}
      aria-label={done ? 'Copiado' : label}
      title={done ? 'Copiado' : label}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          clearTimeout(reset.current);
          reset.current = setTimeout(() => setDone(false), 1400);
        }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
function DiffView({ diff }: { diff: DiffLine[] }) {
  // Long unchanged runs collapse to three lines of context on each side.
  const rows: (DiffLine | { type: 'gap'; count: number })[] = [];
  let run: DiffLine[] = [];
  const flush = (end: boolean) => {
    const keepHead = rows.length ? 3 : 0;
    const keepTail = end ? 0 : 3;
    if (run.length > keepHead + keepTail + 2) {
      rows.push(...run.slice(0, keepHead));
      rows.push({ type: 'gap', count: run.length - keepHead - keepTail });
      rows.push(...run.slice(run.length - keepTail));
    } else rows.push(...run);
    run = [];
  };
  for (const line of diff.slice(0, 2000)) {
    if (line.type === ' ') run.push(line);
    else {
      flush(false);
      rows.push(line);
    }
  }
  flush(true);
  return (
    <pre className="diff">
      {rows.map((r, i) =>
        r.type === 'gap' ? (
          <div className="gap" key={i}>
            ⋯ {r.count} {r.count === 1 ? 'línea' : 'líneas'} sin cambios
          </div>
        ) : (
          <div
            className={r.type === '+' ? 'added' : r.type === '-' ? 'removed' : 'context'}
            key={i}
          >
            <span className="sign" aria-hidden="true">
              {r.type === ' ' ? ' ' : r.type === '+' ? '+' : '−'}
            </span>
            {r.text || ' '}
          </div>
        ),
      )}
    </pre>
  );
}
function UnifiedDiff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text
        .split('\n')
        .slice(0, 2000)
        .map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith('@@')
                ? 'hunk'
                : line.startsWith('+') && !line.startsWith('+++')
                  ? 'added'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'removed'
                    : 'context'
            }
          >
            {line || ' '}
          </div>
        ))}
    </pre>
  );
}
const extension = (file: unknown) =>
  typeof file === 'string' && file.includes('.') ? file.slice(file.lastIndexOf('.') + 1) : '';
function Output({ text, error }: { text?: string; error?: boolean }) {
  if (text === undefined) return null;
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  return (
    <pre className={`result ${error ? 'failed' : ''}`}>
      {clean.length > 8000 ? clean.slice(0, 8000) + '\n…' : clean || '(sin salida)'}
    </pre>
  );
}
// Tools whose successful result only acknowledges what the input already shows.
const QUIET_RESULTS = new Set(['TodoWrite', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
function BlockDetail({ b }: { b: ToolBlock }) {
  const i = b.input ?? {};
  const { root } = useChatActions();
  let input: React.ReactNode;
  switch (b.name) {
    case 'Bash':
      input = <CodeBlock code={String(i.command ?? '')} lang="bash" />;
      break;
    case 'Edit':
      input = <DiffView diff={lineDiff(i.old_string ?? '', i.new_string ?? '')} />;
      break;
    case 'MultiEdit':
      input = (Array.isArray(i.edits) ? i.edits : []).map((e: any, k: number) => (
        <DiffView key={k} diff={lineDiff(e?.old_string ?? '', e?.new_string ?? '')} />
      ));
      break;
    case 'Write':
      input = (
        <CodeBlock code={String(i.content ?? '').slice(0, 12000)} lang={extension(i.file_path)} />
      );
      break;
    case 'NotebookEdit':
      input = (
        <CodeBlock code={String(i.new_source ?? '')} lang={i.cell_type === 'code' ? 'py' : ''} />
      );
      break;
    case 'Task':
    case 'Agent':
      input = i.prompt ? <div className="step-prompt">{String(i.prompt)}</div> : null;
      break;
    case 'TodoWrite':
      input = <TodoList todos={Array.isArray(i.todos) ? i.todos : []} />;
      break;
    case 'ExitPlanMode':
      input = i.plan ? <Markdown text={String(i.plan)} /> : null;
      break;
    case 'Read':
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'WebFetch':
    case 'WebSearch':
      input = (
        <div className="step-params">
          {[shortPath(i.file_path ?? i.path, root), i.pattern, i.glob, i.url, i.query, i.prompt]
            .filter((v) => typeof v === 'string' && v)
            .map((v, k) => (
              <code key={k}>{String(v)}</code>
            ))}
        </div>
      );
      break;
    default: {
      const text = JSON.stringify(i, null, 2);
      input = <pre className="code">{text.length > 4000 ? text.slice(0, 4000) + '…' : text}</pre>;
    }
  }
  return (
    <>
      {input}
      {b.children?.length ? (
        <div className="children">
          <WorkFeed
            items={workItems([{ id: b.id, role: 'assistant', text: '', blocks: b.children }], root)}
          />
        </div>
      ) : null}
      {b.result !== undefined &&
      (b.name === 'Task' || b.name === 'Agent') &&
      !b.isError &&
      b.result.trim() ? (
        <div className="step-answer">
          <Markdown text={b.result.slice(0, 20000)} />
        </div>
      ) : (
        b.result !== undefined &&
        (b.isError || !QUIET_RESULTS.has(b.name)) && <Output text={b.result} error={b.isError} />
      )}
    </>
  );
}
function MessageDetail({ m }: { m: Message }) {
  const t = m.tool;
  if (!t) return <Output text={m.text} error={m.kind === 'error'} />;
  if (antigravityDenied(m))
    return (
      <div className="permission-detail">
        <p>Esta acción no se ha ejecutado. Antigravity requiere tu autorización.</p>
        {t.command && <pre className="code">{t.command}</pre>}
        <details>
          <summary>Detalles técnicos</summary>
          <Output text={t.output} />
        </details>
      </div>
    );
  if (t.kind === 'command')
    return (
      <>
        <CodeBlock code={t.command ?? ''} lang="bash" />
        <Output text={t.output} error={t.status === 'failed'} />
        {t.exitCode !== undefined && t.exitCode !== 0 && (
          <p className="step-note">Código de salida {t.exitCode}</p>
        )}
      </>
    );
  if (t.kind === 'edit')
    return (
      <>
        {(t.files ?? []).map((f) => (
          <div className="step-file" key={f.path}>
            <code>{f.path}</code>
            <UnifiedDiff text={f.diff} />
          </div>
        ))}
      </>
    );
  if (t.kind === 'web')
    return (
      <div className="step-params">
        <code>{t.query}</code>
      </div>
    );
  return (
    <>
      {t.command && <pre className="code">{t.command}</pre>}
      <Output text={t.output} error={t.status === 'failed'} />
    </>
  );
}
// Targets that are code (commands, patterns, paths) use the monospaced face.
const MONO = new Set<StepKind>(['command', 'search', 'list', 'read', 'edit', 'create']);
function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const permission = antigravityDenied(step.message);
  const Icon = ICONS[step.kind];
  const target = step.kind === 'command' ? step.label || step.detail : step.label;
  const ms =
    step.ms ?? (step.running ? undefined : step.block?.elapsed && step.block.elapsed * 1000);
  return (
    <div
      className={`tool step k-${step.kind} ${step.running ? 'running' : ''} ${permission ? 'permission-blocked' : step.error ? 'failed' : ''}`}
    >
      <button
        className="tool-head"
        aria-expanded={open}
        title={step.detail && step.detail !== target ? step.detail : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-icon" aria-hidden="true">
          <Icon size={13} />
        </span>
        <span className="tool-name">
          {permission ? 'No ejecutado' : VERBS[step.kind][step.running ? 1 : 0]}
        </span>
        <span className={`tool-summary ${MONO.has(step.kind) ? 'mono' : ''}`}>{target}</span>
        {(step.added || step.removed) && !step.running ? (
          <span className="step-lines">
            {step.added ? <span className="git-added">+{step.added}</span> : null}
            {step.removed ? <span className="git-removed">−{step.removed}</span> : null}
          </span>
        ) : null}
        {step.running ? (
          <span className="tool-state">
            <i className="spinner" />
            {step.block?.elapsed ? `${Math.round(step.block.elapsed)} s` : ''}
          </span>
        ) : permission ? (
          <span className="tool-state">Sin permiso</span>
        ) : step.error ? (
          <span className="tool-state error">{step.exit ? `exit ${step.exit}` : 'Error'}</span>
        ) : step.exit ? (
          <span className="tool-state">exit {step.exit}</span>
        ) : ms && ms >= 1500 ? (
          <span className="tool-state">{duration(ms)}</span>
        ) : null}
        <ChevronRight size={12} className={`tool-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="tool-body">
          {step.block ? (
            <BlockDetail b={step.block} />
          ) : step.message ? (
            <MessageDetail m={step.message} />
          ) : null}
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
      <button aria-expanded={open} disabled={!text.trim()} onClick={() => setOpen((v) => !v)}>
        <Brain size={12} />
        {streaming ? 'Razonando…' : 'Razonamiento'}
        {text.trim() && <ChevronRight size={12} className={`tool-chevron ${open ? 'open' : ''}`} />}
      </button>
      {open && text.trim() && <div className="thinking-text">{text}</div>}
    </div>
  );
}
function WorkFeed({ items }: { items: ReturnType<typeof workItems> }) {
  return (
    <div className="activity-messages">
      {items.map((w) =>
        w.type === 'step' ? (
          <StepRow key={w.step.id} step={w.step} />
        ) : w.type === 'thinking' ? (
          <Thinking key={w.id} text={w.text} streaming={w.streaming} />
        ) : (
          <div className="step-text" key={w.id}>
            <Markdown text={w.text} />
          </div>
        ),
      )}
    </div>
  );
}
function SystemNote({ m }: { m: Message }) {
  const kind = m.kind ?? 'info';
  // The contextual permission card replaces this older CLI recovery instruction.
  if (kind === 'warning' && m.text.startsWith('Gemini necesita permiso')) return null;
  if (kind === 'compact')
    return (
      <div className="row system compact" role="note">
        <span>{m.text}</span>
      </div>
    );
  if (kind === 'command')
    return (
      <div className="row system command">
        <pre>{m.text}</pre>
      </div>
    );
  const Icon = kind === 'error' ? OctagonX : kind === 'warning' ? TriangleAlert : Info;
  return (
    <div className={`row system ${kind}`} role={kind === 'error' ? 'alert' : 'note'}>
      <Icon size={13} aria-hidden="true" />
      <pre>{m.text}</pre>
    </div>
  );
}
export function AttachmentPreview({ attachment: file }: { attachment: Attachment }) {
  if (file.preview) return <img src={file.preview} alt={file.name} title={file.name} />;
  const size =
    file.size == null
      ? ''
      : file.size < 1024 * 1024
        ? `${Math.ceil(file.size / 1024)} KB`
        : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : 'ARCHIVO';
  return (
    <div className="attachment-file" title={file.name}>
      <FileText size={22} aria-hidden="true" />
      <div>
        <strong>{file.name}</strong>
        <span>
          {extension}
          {size ? ` · ${size}` : ''}
        </span>
      </div>
    </div>
  );
}
/** "Deshacer cambios de este turno": preview with a dry run, then restore on confirmation. */
function useRewindTurn(m: Message) {
  const { rewind } = useChatActions();
  const [preview, setPreview] = useState<import('./shared').RewindResult>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  // Duplicated chats reuse message ids without checkpoints: never carry a preview across.
  useEffect(() => {
    setPreview(undefined);
    setDone('');
  }, [m.checkpoint]);
  if (!rewind || !m.checkpoint) return { button: null, panel: null };
  const check = async (dryRun: boolean) => {
    setBusy(true);
    setDone('');
    try {
      const r = await rewind(m, dryRun);
      if (dryRun) setPreview(r);
      else {
        setPreview(undefined);
        if (r) setDone(`${r.filesChanged?.length ?? 0} archivos restaurados.`);
      }
    } finally {
      setBusy(false);
    }
  };
  const files = preview?.filesChanged?.length ?? 0;
  return {
    button: (
      <button
        className="msg-action"
        aria-label="Deshacer cambios de este turno"
        title="Deshacer cambios de este turno: restaura los archivos que Claude editó desde este mensaje"
        disabled={busy}
        onClick={() => void check(true)}
      >
        <Undo2 size={13} />
      </button>
    ),
    panel:
      preview || done ? (
        <div className="rewind-confirm" role={preview ? 'alertdialog' : 'status'}>
          {!preview ? (
            <span>{done}</span>
          ) : files ? (
            <span>
              Se restaurarán {files} {files === 1 ? 'archivo' : 'archivos'} (+
              {preview.insertions ?? 0} −{preview.deletions ?? 0}) al estado anterior a este
              mensaje, también los cambios de turnos posteriores. Solo cubre ediciones de Claude, no
              comandos de terminal. La conversación no cambia.
            </span>
          ) : (
            <span>No hay cambios de archivos que deshacer desde este mensaje.</span>
          )}
          {!!files && (
            <button className="danger" disabled={busy} onClick={() => void check(false)}>
              Deshacer
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => {
              setPreview(undefined);
              setDone('');
            }}
          >
            {files ? 'Cancelar' : 'Cerrar'}
          </button>
        </div>
      ) : null,
  };
}
function UserMessage({ m }: { m: Message }) {
  const { reuse } = useChatActions();
  const long = m.text.length > 900 || m.text.split('\n').length > 14;
  const [expanded, setExpanded] = useState(false);
  const rewind = useRewindTurn(m);
  return (
    <div className="row user" title={m.at ? new Date(m.at).toLocaleString('es-ES') : undefined}>
      <div className="bubble">
        {m.attachments?.length ? (
          <div className="message-images">
            {m.attachments.map((i) => (
              <AttachmentPreview key={i.id} attachment={i} />
            ))}
          </div>
        ) : null}
        {long ? <div className={`bubble-text ${expanded ? '' : 'clamped'}`}>{m.text}</div> : m.text}
        {long && (
          <button
            className="bubble-more"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Mostrar menos' : 'Mostrar todo'}
          </button>
        )}
      </div>
      {m.text && (
        <div className="msg-actions">
          <CopyButton text={m.text} label="Copiar mensaje" />
          {reuse && (
            <button
              className="msg-action"
              aria-label="Reutilizar mensaje"
              title="Reutilizar en el cuadro de mensaje"
              onClick={() => reuse(m.text)}
            >
              <CornerDownLeft size={13} />
            </button>
          )}
          {rewind.button}
        </div>
      )}
      {rewind.panel}
    </div>
  );
}
const answerText = (m: Message) =>
  m.blocks
    ? m.blocks
        .flatMap((b) => (b.type === 'text' && b.text.trim() ? [b.text.trim()] : []))
        .join('\n\n')
    : m.text;
export function MessageView({
  m,
  kind,
  showAuthor = true,
}: {
  m: Message;
  kind: ProviderKind;
  showAuthor?: boolean;
}) {
  if (m.role === 'user') return <UserMessage m={m} />;
  if (m.role === 'system') return <SystemNote m={m} />;
  if (m.role === 'tool') return <WorkFeed items={workItems([m])} />;
  return (
    <div className="row assistant">
      {showAuthor && (
        <div className="author">
          <span className={`glyph ${kind}`}>{kind === 'codex' ? '◈' : '✳'}</span>
          {providerNames[kind]}
          {m.model && <span className="model-tag">{prettyModel(m.model)}</span>}
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
              <WorkFeed key={b.id} items={[{ type: 'step', step: stepFromBlock(b) }]} />
            ),
          )
        : m.text && <Markdown text={m.text} />}
    </div>
  );
}
function TurnChanges({ messages }: { messages: Message[] }) {
  const { root, openPath, showChanges } = useChatActions();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const files = fileChanges(messages);
  if (!files.length) return null;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <section className="turn-changes" aria-label="Archivos cambiados en esta respuesta">
      <header>
        <button
          className="turn-changes-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? id : undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          <FileDiff size={13} aria-hidden="true" />
          <strong>
            {files.length} {files.length === 1 ? 'archivo cambiado' : 'archivos cambiados'}
          </strong>
          <ChevronRight size={12} aria-hidden="true" />
        </button>
        <span className="step-lines">
          <span className="git-added">+{added}</span>
          <span className="git-removed">−{removed}</span>
        </span>
        {showChanges && (
          <button
            className="turn-changes-open"
            aria-label="Ver cambios de esta respuesta"
            title="Ver cambios"
            onClick={showChanges}
          >
            <FileDiff size={14} aria-hidden="true" />
          </button>
        )}
      </header>
      {expanded && (
        <ul id={id}>
          {files.slice(0, 8).map((f) => (
            <li key={f.path}>
              {openPath ? (
                <button
                  className="turn-file"
                  title={`${f.path} · Abrir`}
                  onClick={() => openPath(f.path)}
                >
                  {shortPath(f.path, root)}
                </button>
              ) : (
                <span className="turn-file">{shortPath(f.path, root)}</span>
              )}
              {f.created && <span className="turn-tag">nuevo</span>}
              <span className="step-lines">
                {f.added ? <span className="git-added">+{f.added}</span> : null}
                {f.removed ? <span className="git-removed">−{f.removed}</span> : null}
              </span>
            </li>
          ))}
          {files.length > 8 && <li className="turn-more">y {files.length - 8} más</li>}
        </ul>
      )}
    </section>
  );
}
function ResponseGroup({
  entry,
  kind,
}: {
  entry: Extract<ReturnType<typeof conversationEntries>[number], { type: 'response' }>;
  kind: ProviderKind;
}) {
  const { root } = useChatActions();
  const items = workItems(entry.work, root);
  const progress = items.filter((w) => w.type === 'text');
  // An interrupted turn may have no final answer; keep its last narration in sight.
  const showProgress = entry.pending || !entry.answer;
  const details = showProgress ? items.filter((w) => w.type !== 'text') : items;
  const steps = items.flatMap((w) => (w.type === 'step' ? [w.step] : []));
  const blocked = steps.filter((step) => antigravityDenied(step.message)).length;
  const errors = Math.max(0, entry.errors - blocked);
  const ms = [...entry.messages].reverse().find((m) => m.durationMs)?.durationMs;
  const model = prettyModel(entry.answer?.model ?? entry.messages.find((m) => m.model)?.model);
  const summary =
    summarize(steps.filter((step) => !antigravityDenied(step.message))) ||
    (blocked
      ? `${blocked} ${blocked === 1 ? 'acción sin ejecutar' : 'acciones sin ejecutar'}`
      : items.some((w) => w.type === 'thinking')
        ? 'Razonó'
        : 'Ver actividad');
  const time = duration(ms);
  const text = entry.answer ? answerText(entry.answer) : '';
  const at = entry.answer?.at ?? [...entry.messages].reverse().find((m) => m.at)?.at;
  const clock = at
    ? new Date(at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : '';
  return (
    <div className="response-group">
      {showProgress &&
        progress.map((w) => (
          <div className="row assistant progress-message" key={w.id}>
            <Markdown text={w.text} />
          </div>
        ))}
      {!entry.pending && details.length > 0 && (
        <details className={`response-work ${errors ? 'has-errors' : ''}`}>
          <summary>
            <span className="work-summary" title={summary}>
              {summary}
            </span>
            {time && <span className="work-time">{time}</span>}
            {blocked > 0 && <span className="work-permissions">Requiere permiso</span>}
            {errors ? (
              <span className="work-errors">
                {errors} {errors === 1 ? 'error' : 'errores'}
              </span>
            ) : null}
            <ChevronRight size={12} />
          </summary>
          <WorkFeed items={details} />
        </details>
      )}
      {entry.answer && <MessageView m={entry.answer} kind={kind} showAuthor={false} />}
      {!entry.pending && <TurnChanges messages={entry.messages} />}
      {!entry.pending && (text || model || clock) && (
        <div className="msg-actions response-actions">
          {text && (
            <>
              <CopyButton text={text} label="Copiar respuesta" />
              <ReadAloudButton text={text} />
            </>
          )}
          <span className="msg-meta">
            {[model, !entry.work.length && time ? time : '', clock].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
    </div>
  );
}
export function ConversationMessages({
  session,
  kind,
  limit,
  entries: suppliedEntries,
}: {
  session: Session;
  kind: ProviderKind;
  limit?: number;
  entries?: ReturnType<typeof conversationEntries>;
}) {
  const entries = useMemo(
    () => suppliedEntries ?? conversationEntries(session),
    [suppliedEntries, session.messages, session.status, session.approvals.length],
  );
  const visible = limit === undefined ? entries : entries.slice(-limit);
  return (
    <>
      {visible.map((entry) => {
        if (entry.type === 'message')
          return <MessageView key={entry.id} m={entry.message} kind={kind} />;
        return <ResponseGroup key={entry.id} entry={entry} kind={kind} />;
      })}
    </>
  );
}
// Claude Code's spinner shows a playful verb while nothing more specific is happening.
const MUSINGS = [
  'Cavilando',
  'Maquinando',
  'Rumiando',
  'Tramando',
  'Hilando',
  'Cocinando',
  'Destilando',
  'Barruntando',
  'Urdiendo',
  'Elucubrando',
  'Tejiendo',
  'Puliendo',
];
function musing(seed: string) {
  let h = 7;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${MUSINGS[Math.abs(h) % MUSINGS.length]}…`;
}
// Turn start per session, for providers that do not timestamp user messages.
const turnStarts: Record<string, { key: string; at: number }> = {};
function turnStart(session: Session) {
  const user = [...session.messages].reverse().find((m) => m.role === 'user');
  if (user?.at) return user.at;
  const key = session.turnId ?? user?.id ?? '';
  const known = turnStarts[session.id];
  if (known?.key === key) return known.at;
  turnStarts[session.id] = { key, at: Date.now() };
  return turnStarts[session.id].at;
}
export function ActivityDock({
  session,
  kind,
  compact = false,
}: {
  session: Session;
  kind: ProviderKind;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { root } = useChatActions();
  const active = working(session);
  const now = useNow(active);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  if (!active) return null;
  const activity = currentActivity(session);
  const items = activity ? workItems(activity.messages, root) : [];
  const last = items.at(-1);
  const waiting = !!session.approvals.length || session.status === 'waiting';
  const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
  const idle = kind === 'claude' ? musing(lastUser?.id ?? session.id) : 'Trabajando…';
  let label = idle;
  if (last?.type === 'step') {
    const s = last.step;
    label = s.running
      ? s.kind === 'command' && s.detail
        ? s.detail
        : `${VERBS[s.kind][1]} ${s.label}`.trim()
      : idle;
  } else if (last?.type === 'thinking') label = last.streaming ? 'Razonando…' : idle;
  else if (last?.type === 'text') label = 'Redactando respuesta…';
  if (session.activity && session.activity !== 'Pensando…') label = session.activity;
  if (compact) {
    const steps = items.flatMap((item) => (item.type === 'step' ? [item.step] : []));
    const step = [...steps].reverse().find((step) => step.running) ?? steps.at(-1);
    if (step) {
      const detail = step.detail && step.detail !== step.label ? ` · ${step.detail}` : '';
      label = `${step.running ? '' : 'Último paso: '}${VERBS[step.kind][step.running ? 1 : 0]} ${step.label}${detail}`;
      if (session.activity && session.activity !== 'Pensando…' && !step.running)
        label = `${session.activity} · ${label}`;
    } else if (!session.activity || session.activity === 'Pensando…') {
      label =
        last?.type === 'text'
          ? 'Redactando respuesta…'
          : last?.type === 'thinking'
            ? 'Razonando…'
            : 'Preparando la respuesta…';
    }
  }
  if (session.status === 'starting') label = 'Abriendo agente…';
  if (session.status === 'stopping') label = 'Deteniendo…';
  if (waiting)
    label =
      compact && session.approvals.length
        ? `Esperando tu respuesta · ${session.approvals[0].title ?? session.approvals[0].tool ?? 'Solicitud de permiso'}`
        : 'Esperando tu respuesta';
  label = label.replace(/\s+/g, ' ').trim().slice(0, 180) || idle;
  const elapsed = session.status === 'starting' ? 0 : Math.max(0, now - turnStart(session));
  const steps = activity?.steps ?? 0;
  return (
    <div
      className={`activity-dock ${waiting ? 'waiting' : ''} ${compact ? 'compact-activity' : ''}`}
    >
      {open && activity && (
        <div className="activity-log" id={`activity-${session.id}`}>
          <WorkFeed items={items.filter((w) => w.type !== 'text')} />
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
        {waiting ? (
          <CircleHelp size={12} className="dock-wait" />
        ) : (
          <span className={`dock-spinner ${kind}`} aria-hidden="true" />
        )}
        <span className="activity-current-text" role="status" title={label}>
          {label}
        </span>
        {elapsed >= 1000 && <span className="activity-time">{duration(elapsed)}</span>}
        {steps ? (
          <span className="activity-count">
            {steps} {steps === 1 ? 'paso' : 'pasos'}
          </span>
        ) : null}
        {activity?.errors ? (
          <span className="activity-count has-errors">
            {activity.errors} {activity.errors === 1 ? 'error' : 'errores'}
          </span>
        ) : null}
        {!waiting && !compact && <kbd className="activity-esc">esc</kbd>}
        {activity && <ChevronDown size={12} className={open ? 'expanded' : ''} />}
      </button>
    </div>
  );
}
/** Digits pick options inside approval cards when focus is not in a text field. */
function digit(e: React.KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select')) return 0;
  return /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
}
/** Cards take the keyboard only when the user is not typing something else. */
function canTakeFocus() {
  const a = document.activeElement;
  // Never pull the caret out of a field the user is in, even an empty composer.
  return !a || a === document.body;
}
function useApprovalFocus() {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (canTakeFocus()) primary.current?.focus({ preventScroll: true });
  }, []);
  return primary;
}
function OptionTiles({
  q,
  value,
  onChange,
  autoFocus,
}: {
  q: any;
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
}) {
  const [other, setOther] = useState('');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus && canTakeFocus()) first.current?.focus({ preventScroll: true });
  }, []);
  const options: any[] = q.options ?? [];
  const toggle = (label: string) => {
    setOther('');
    if (q.multiSelect)
      onChange(value.includes(label) ? value.filter((v) => v !== label) : [...value, label]);
    else onChange([label]);
  };
  return (
    <div
      className="question"
      onKeyDown={(e) => {
        const n = digit(e);
        if (n && options[n - 1]) {
          e.preventDefault();
          toggle(options[n - 1].label);
        }
      }}
    >
      <div className="question-head">
        {q.header && <span className="chip">{q.header}</span>}
        <strong>{q.question}</strong>
        {q.multiSelect && <span className="muted">Puedes elegir varias</span>}
      </div>
      <div className="tiles">
        {options.map((o, k) => (
          <button
            key={o.label}
            ref={k === 0 ? first : undefined}
            className={`tile ${value.includes(o.label) ? 'on' : ''}`}
            aria-pressed={value.includes(o.label)}
            onClick={() => toggle(o.label)}
          >
            <span className="tile-title">
              {k < 9 && <kbd aria-hidden="true">{k + 1}</kbd>}
              {o.label}
            </span>
            {o.description && <span className="tile-desc">{o.description}</span>}
          </button>
        ))}
      </div>
      <input
        placeholder="Otra respuesta…"
        aria-label={`Otra respuesta: ${q.question}`}
        value={other}
        onChange={(e) => {
          setOther(e.target.value);
          onChange(e.target.value ? [e.target.value] : []);
        }}
      />
    </div>
  );
}
function askTitle(step: Step) {
  switch (step.kind) {
    case 'command':
      return 'Claude quiere ejecutar un comando';
    case 'edit':
      return 'Claude quiere editar un archivo';
    case 'create':
      return 'Claude quiere escribir un archivo';
    case 'read':
      return 'Claude quiere leer un archivo';
    case 'search':
    case 'list':
      return 'Claude quiere buscar en archivos';
    case 'web':
      return 'Claude quiere consultar la web';
    case 'browser':
      return 'Claude quiere usar el navegador';
    case 'agent':
      return 'Claude quiere lanzar un subagente';
    default:
      return `Claude quiere usar ${step.name}`;
  }
}
/** What "Permitir siempre" will remember, from the rule suggestions of Claude Code. */
function alwaysHint(suggestions: any[] = []) {
  for (const s of suggestions) {
    if (s?.type === 'addRules' && Array.isArray(s.rules) && s.rules.length)
      return s.rules
        .map((r: any) => (r?.ruleContent ? `${r.toolName}(${r.ruleContent})` : r?.toolName))
        .filter(Boolean)
        .join(', ');
    if (s?.type === 'setMode' && s.mode)
      return `modo ${permissionModes.find((m) => m.id === s.mode)?.name ?? s.mode}`;
    if (s?.type === 'addDirectories' && Array.isArray(s.directories))
      return s.directories.join(', ');
  }
  return '';
}
function Counter({ index = 0, total = 1 }: { index?: number; total?: number }) {
  return total > 1 ? (
    <span className="approval-count">
      {index + 1} de {total}
    </span>
  ) : null;
}
export function ClaudeApproval({
  approval,
  session,
  run,
  index,
  total,
}: {
  approval: Approval;
  session: Session;
  run: Run;
  index?: number;
  total?: number;
}) {
  const { root } = useChatActions();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [reason, setReason] = useState('');
  const [showReason, setShowReason] = useState(false);
  const primary = useApprovalFocus();
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
      <section className="approval ask" aria-label="Pregunta de Claude">
        <div className="approval-title">
          <CircleHelp size={15} />
          <strong>Claude necesita tu respuesta</strong>
          <Counter index={index} total={total} />
        </div>
        {questions.map((q, k) => (
          <OptionTiles
            key={q.question}
            q={q}
            autoFocus={k === 0}
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
  const step = stepFromBlock(
    { type: 'tool_use', id: String(approval.id), name: tool, input },
    root,
  );
  const remember = alwaysHint(approval.suggestions);
  const actions = [
    () => answer(plan ? 'always' : 'accept'),
    () => answer(plan ? 'accept' : 'always'),
    () => (showReason ? answer('decline') : setShowReason(true)),
  ];
  const Icon = ICONS[step.kind];
  return (
    <section
      className={`approval ${plan ? 'plan' : ''}`}
      aria-label={plan ? 'Plan de Claude' : 'Permiso solicitado'}
      onKeyDown={(e) => {
        const n = digit(e);
        if (n && actions[n - 1]) {
          e.preventDefault();
          void actions[n - 1]();
        }
      }}
    >
      <div className="approval-title">
        {plan ? <Map size={15} /> : <ShieldAlert size={15} />}
        <strong>{plan ? 'Claude ha preparado un plan' : askTitle(step)}</strong>
        <Counter index={index} total={total} />
      </div>
      {!plan && (
        <div className="approval-tool">
          <Icon size={13} aria-hidden="true" />
          <span className="tool-name">{tool}</span>
          <span className="tool-summary">{step.kind === 'command' ? step.detail : step.label}</span>
          {step.added || step.removed ? (
            <span className="step-lines">
              {step.added ? <span className="git-added">+{step.added}</span> : null}
              {step.removed ? <span className="git-removed">−{step.removed}</span> : null}
            </span>
          ) : null}
        </div>
      )}
      <div className="approval-preview">
        {plan ? (
          input.plan ? (
            <Markdown text={String(input.plan)} />
          ) : (
            <p className="muted">Revisa el plan en la conversación.</p>
          )
        ) : (
          <BlockDetail b={{ type: 'tool_use', id: String(approval.id), name: tool, input }} />
        )}
      </div>
      {approval.title && !plan && <p className="muted">{approval.title}</p>}
      {approval.reason && <p className="muted">{approval.reason}</p>}
      {approval.blockedPath && (
        <p className="approval-warning">
          <TriangleAlert size={13} /> Ruta fuera del proyecto: <code>{approval.blockedPath}</code>
        </p>
      )}
      {showReason && (
        <textarea
          autoFocus
          aria-label={plan ? 'Cambios para el plan' : 'Motivo del rechazo'}
          placeholder={
            plan
              ? 'Qué debería cambiar en el plan…'
              : 'Explica a Claude qué debe hacer en su lugar (opcional)…'
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void answer('decline');
            }
          }}
        />
      )}
      <div className="approval-actions">
        <button ref={primary} className="primary" onClick={actions[0]}>
          <kbd aria-hidden="true">1</kbd>
          {plan ? 'Aprobar y aceptar ediciones' : 'Permitir'}
        </button>
        <button
          onClick={actions[1]}
          title={!plan && remember ? `No volver a preguntar: ${remember}` : undefined}
        >
          <kbd aria-hidden="true">2</kbd>
          {plan ? 'Aprobar' : 'Permitir siempre'}
        </button>
        {showReason ? (
          <button className="danger" onClick={() => void answer('decline')}>
            {plan ? 'Pedir cambios' : 'Rechazar'}
          </button>
        ) : (
          <button className="quiet" onClick={() => setShowReason(true)}>
            <kbd aria-hidden="true">3</kbd>
            {plan ? 'Pedir cambios…' : 'Rechazar…'}
          </button>
        )}
        <span className="approval-hint">esc interrumpe</span>
      </div>
      {!plan && remember && <p className="approval-remember">Siempre: {remember}</p>}
    </section>
  );
}
export function ProviderApproval({
  approval,
  session,
  run,
}: {
  approval: Approval;
  session: Session;
  run: (a: Action) => Promise<any>;
}) {
  const externalRead = approval.method === 'provider/read-external';
  const readScope = approval.input as { path?: string; directory?: string } | undefined;
  return (
    <section className="approval" aria-label="Permiso solicitado">
      <div className="approval-title">
        <ShieldAlert size={15} />
        <strong>{approval.title ?? 'Permiso solicitado'}</strong>
      </div>
      {externalRead ? (
        <>
          <p>El modelo solicita leer esta ruta:</p>
          <pre className="provider-approval-content">{readScope?.path}</pre>
          {readScope?.directory !== readScope?.path && (
            <>
              <p>Carpeta que puedes autorizar para este chat:</p>
              <pre className="provider-approval-content">{readScope?.directory}</pre>
            </>
          )}
          <p>
            Autorizar la carpeta incluye sus subcarpetas, solo para lectura. Se recuerda hasta
            detener el chat o reiniciar la app. El contenido leído se envía al modelo.
          </p>
        </>
      ) : (
        <pre className="provider-approval-content">
          {JSON.stringify(approval.input ?? approval.params, null, 2)}
        </pre>
      )}
      <div className="approval-actions">
        <button
          className="primary"
          onClick={() =>
            void run({
              type: 'approve',
              sessionId: session.id,
              requestId: approval.id,
              decision: 'accept',
            })
          }
        >
          Permitir una vez
        </button>
        {externalRead && (
          <button
            onClick={() =>
              void run({
                type: 'approve',
                sessionId: session.id,
                requestId: approval.id,
                decision: 'always',
              })
            }
          >
            Permitir carpeta en este chat
          </button>
        )}
        <button
          onClick={() =>
            void run({
              type: 'approve',
              sessionId: session.id,
              requestId: approval.id,
              decision: 'decline',
            })
          }
        >
          Rechazar
        </button>
      </div>
    </section>
  );
}
export function CodexApproval({
  approval,
  session,
  run,
  index,
  total,
}: {
  approval: Approval;
  session: Session;
  run: Run;
  index?: number;
  total?: number;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const primary = useApprovalFocus();
  const questions = approval.method === 'item/tool/requestUserInput',
    unsupported = approval.method === 'mcpServer/elicitation/request';
  const p = approval.params;
  const choices = codexApprovalChoices(approval.method, p);
  const permissions = approval.method === 'item/permissions/requestApproval';
  const item = session.messages.find((m) => m.id === p.itemId);
  const decide = (decision: 'accept' | 'always' | 'decline') =>
    run({
      type: 'approve',
      sessionId: session.id,
      requestId: approval.id,
      decision,
      answers: decision === 'accept' ? answers : undefined,
    });
  return (
    <section
      className="approval"
      aria-label="Solicitud de Codex"
      onKeyDown={(e) => {
        const n = digit(e);
        const choice = n ? choices[n - 1] : undefined;
        if (!questions && choice) {
          e.preventDefault();
          void decide(choice.decision);
        }
      }}
    >
      <div className="approval-title">
        <ShieldAlert size={15} />
        <strong>
          {questions
            ? 'Codex necesita tu respuesta'
            : unsupported
              ? 'Solicitud MCP no compatible'
              : permissions
                ? 'Codex solicita acceso adicional'
                : item?.tool?.kind === 'edit'
                  ? 'Codex quiere modificar archivos'
                  : p.command
                    ? 'Codex quiere ejecutar un comando'
                    : 'Codex necesita tu aprobación'}
        </strong>
        <Counter index={index} total={total} />
      </div>
      {(p.reason ?? p.message) && <p className="muted">{p.reason ?? p.message}</p>}
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
      ) : permissions ? (
        <div className="approval-preview">
          {p.permissions?.network?.enabled && <p>Acceso a la red</p>}
          {(['read', 'write'] as const).map((access) =>
            p.permissions?.fileSystem?.[access]?.map((path: string) => (
              <p key={`${access}:${path}`}>
                {access === 'read' ? 'Leer' : 'Escribir'}: <code>{path}</code>
              </p>
            )),
          )}
          <details>
            <summary>Ver todos los accesos solicitados</summary>
            <pre className="code">{JSON.stringify(p.permissions, null, 2)}</pre>
          </details>
        </div>
      ) : p.command ? (
        <CodeBlock code={String(p.command)} lang="bash" />
      ) : item?.tool ? (
        <div className="approval-preview">
          <MessageDetail m={item} />
        </div>
      ) : (
        <pre className="code">
          {item?.text ??
            JSON.stringify(p.permissions ?? p.networkApprovalContext ?? p.changes ?? p, null, 2)}
        </pre>
      )}
      {p.cwd && <p className="muted">Directorio: {p.cwd}</p>}
      {p.grantRoot && (
        <p className="muted">
          Carpeta solicitada: <code>{p.grantRoot}</code>
        </p>
      )}
      {p.networkApprovalContext && (
        <p className="muted">
          Acceso de red: <code>{p.networkApprovalContext.host}</code>
        </p>
      )}
      {p.additionalPermissions && (
        <pre className="code">{JSON.stringify(p.additionalPermissions, null, 2)}</pre>
      )}
      {permissions && (
        <p className="muted">
          Elige cuánto tiempo permitir estos accesos. No cambia el modo general del chat.
        </p>
      )}
      <div className="approval-actions">
        {questions ? (
          <button
            ref={primary}
            className="primary"
            disabled={(p.questions ?? []).some((q: any) => !answers[q.id]?.trim())}
            onClick={() => void decide('accept')}
          >
            Enviar respuesta
          </button>
        ) : (
          choices.map((choice, i) => (
            <button
              key={choice.decision}
              ref={i === 0 ? primary : undefined}
              className={choice.decision === 'decline' ? 'danger' : i === 0 ? 'primary' : ''}
              title={choice.hint}
              onClick={() => void decide(choice.decision)}
            >
              <kbd aria-hidden="true">{i + 1}</kbd>
              {choice.label}
            </button>
          ))
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
  text,
}: {
  active?: boolean;
  label: string;
  icon: any;
  title?: string;
  /** Visible label, only for non-default states worth noticing. */
  text?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !ref.current || !panel.current) return;
    const boundary = ref.current.closest('.conversation') ?? document.documentElement;
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !popup) return;
      const bounds = boundary.getBoundingClientRect();
      const left = Math.max(8, bounds.left + 8);
      const right = Math.min(window.innerWidth - 8, bounds.right - 8);
      popup.style.maxWidth = `${Math.max(120, right - left)}px`;
      const width = popup.getBoundingClientRect().width;
      popup.style.left = `${Math.max(left - anchor.left, Math.min(0, right - anchor.left - width))}px`;
      popup.style.maxHeight = `${Math.max(48, Math.min(360, anchor.top - Math.max(8, bounds.top) - 12))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(boundary);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k, true);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k, true);
    };
  }, [open]);
  return (
    <div className="popover-host" ref={ref}>
      <button
        ref={trigger}
        className={`chip-btn ${open || active ? 'on' : ''} ${text ? 'labeled' : ''}`}
        title={`${title ?? label} · ${label}`}
        aria-label={title ?? label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => {
            const buttons =
              panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (buttons?.length) buttons[e.key === 'ArrowUp' ? buttons.length - 1 : 0].focus();
          });
        }}
      >
        <Icon size={13} />
        {text && <span className="chip-text">{text}</span>}
      </button>
      {open && (
        <div
          className="popover"
          id={id}
          ref={panel}
          role="dialog"
          aria-label={title ?? label}
          onKeyDown={(e) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            if ((e.target as HTMLElement).matches('input, textarea, select')) return;
            const buttons = Array.from(
              panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
            );
            if (!buttons.length) return;
            e.preventDefault();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? buttons.length - 1
                  : (index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
            buttons[next].focus();
          }}
          onBlur={(e) => {
            if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
          }}
        >
          <div className="popover-heading">
            {title ?? label}
            <span>{label !== title ? label : ''}</span>
          </div>
          {children(close)}
        </div>
      )}
    </div>
  );
}
// Modes other than asking show their name on the chip, so they are seen without a menu.
const NOTABLE_MODES = new Set(['plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
function ContextGauge({ percent }: { percent?: number }) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const r = 5,
    c = 2 * Math.PI * r;
  return (
    <span
      className={`task-signature-context ${p >= 95 ? 'full' : p >= 80 ? 'high' : ''}`}
      aria-label={
        percent === undefined ? 'Contexto sin datos' : `Contexto usado: ${Math.round(p)} %`
      }
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r={r} className="gauge-track" />
        <circle
          cx="6"
          cy="6"
          r={r}
          className="gauge-fill"
          strokeDasharray={`${(p / 100) * c} ${c}`}
          transform="rotate(-90 6 6)"
        />
      </svg>
      {percent === undefined ? '' : `${Math.round(p)}%`}
    </span>
  );
}
type Menu =
  | { type: 'slash'; items: SlashCommand[] }
  | { type: 'files'; items: string[]; start: number; end: number };
export function Composer({
  session,
  accountName,
  accountControl,
  disabled = false,
  optimization = defaultOptimization,
  draft,
  setDraft,
  run,
  onSend,
  images,
  setImages,
  onLocalCommand,
  footerControl,
  footerStartRef,
  usageDetail,
}: {
  session: Session;
  accountName: string;
  accountControl?: React.ReactNode;
  disabled?: boolean;
  optimization?: TokenOptimization;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  run: Run;
  images: Attachment[];
  setImages: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onSend: (text: string, images: Attachment[]) => Promise<boolean>;
  onLocalCommand: (name: string, arg: string) => boolean;
  footerControl?: React.ReactNode;
  /** Stable host for the repository control, whose state survives chat changes. */
  footerStartRef?: React.Ref<HTMLDivElement>;
  /** Consumption window shown in the context hover card. */
  usageDetail?: React.ReactNode;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [index, setIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [imageError, setImageError] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string }>();
  const [toolsOpen, setToolsOpen] = useState(false);
  const insightId = useId();
  const menuId = useId();
  const flashReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashReset.current), []);
  const tools = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const [files, setFiles] = useState<{ query: string; items: string[] }>({ query: '', items: [] });
  const [recall, setRecall] = useState(-1);
  const pickingRef = useRef(false);
  const sendingRef = useRef(false);
  const connected = isConnectedProvider(session.profile);
  const claude = providerKind(session.profile) === 'claude';
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
      type: connected ? 'configureProvider' : claude ? 'configure' : 'configureCodex',
      sessionId: session.id,
      config: { model },
    });
    if (changed && !connected) await optimize({ autoModel: false });
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
  useEffect(() => {
    if (!toolsOpen) return;
    const outside = (e: MouseEvent) => {
      if (!tools.current?.contains(e.target as Node)) setToolsOpen(false);
    };
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [toolsOpen]);
  const working = session.status === 'working' || session.status === 'waiting';
  const enabled =
    !disabled &&
    session.mode !== 'terminal' &&
    ['ready', 'working', 'waiting', 'starting', 'stopped', 'error'].includes(session.status);
  const attach = async (files?: File[]) => {
    if (!enabled || sendingRef.current || pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    setImageError('');
    try {
      const chosen: Attachment[] | undefined = await run(
        files
          ? { type: 'dropImages', sessionId: session.id, images: await readDroppedFiles(files) }
          : { type: 'pickImages', sessionId: session.id },
      );
      if (chosen?.length) {
        setImages((current) => [...current, ...chosen]);
      }
    } catch (error) {
      setImageError((error as Error).message);
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  };
  useEffect(() => {
    const target = area.current?.closest('.conversation');
    if (!target) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const reset = () => {
      depth = 0;
      target.classList.remove('image-drop-active');
    };
    const enter = (event: Event) => {
      const e = event as DragEvent;
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      if (enabled && !sendingRef.current && !pickingRef.current)
        target.classList.add('image-drop-active');
    };
    const over = (event: Event) => {
      const e = event as DragEvent;
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer)
        e.dataTransfer.dropEffect =
          enabled && !sendingRef.current && !pickingRef.current ? 'copy' : 'none';
    };
    const leave = () => {
      if (--depth <= 0) reset();
    };
    const drop = (event: Event) => {
      const e = event as DragEvent;
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      reset();
      if (!enabled || sendingRef.current || pickingRef.current) {
        setImageError('Espera a que el chat esté disponible para adjuntar archivos.');
        return;
      }
      void attach(Array.from(e.dataTransfer?.files ?? []));
    };
    target.addEventListener('dragenter', enter);
    target.addEventListener('dragover', over);
    target.addEventListener('dragleave', leave);
    target.addEventListener('drop', drop);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => {
      reset();
      target.removeEventListener('dragenter', enter);
      target.removeEventListener('dragover', over);
      target.removeEventListener('dragleave', leave);
      target.removeEventListener('drop', drop);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
    };
  }, [enabled, session.id]);
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
  // `@` before the caret opens a fuzzy list of project files (Git's view of the folder).
  const mention = useMemo(() => {
    const before = draft.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    return m ? { start: caret - m[2].length - 1, end: caret, query: m[2] } : undefined;
  }, [draft, caret]);
  useEffect(() => {
    if (!mention) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const items = await window.desk.invoke({
          type: 'listFiles',
          projectId: session.projectId,
          query: mention.query,
        });
        if (!cancelled && Array.isArray(items))
          setFiles({ query: mention.query, items: items.slice(0, 12) });
      } catch {
        if (!cancelled) setFiles({ query: mention.query, items: [] });
      }
    }, 70);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention?.query, session.projectId]);
  const menuKey = mention ? `@${mention.start}:${mention.query}` : commands.length ? draft : '';
  const menu: Menu | undefined =
    menuKey && menuKey === dismissed
      ? undefined
      : mention && files.items.length && files.query === mention.query
        ? { type: 'files', items: files.items, start: mention.start, end: mention.end }
        : commands.length
          ? { type: 'slash', items: commands }
          : undefined;
  const menuSize = menu?.items.length ?? 0;
  useEffect(() => setIndex(0), [menuKey, menuSize, menu?.type]);
  const selected = Math.max(0, Math.min(index, menuSize - 1));
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [draft]);
  const history = useMemo(
    () => [
      ...new Set(
        [...session.messages]
          .reverse()
          .filter((m) => m.role === 'user' && m.text.trim())
          .map((m) => m.text),
      ),
    ],
    [session.id, session.messages.length],
  );
  const edit = (value: string, cursor = value.length) => {
    setDraft(value);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
      setCaret(cursor);
    });
  };
  const send = async () => {
    const text = draft.trim();
    if ((!text && !images.length) || !enabled || sendingRef.current || pickingRef.current) return;
    if (!images.length && text === '/copy') {
      const last = conversationEntries(session)
        .reverse()
        .find((e) => e.type === 'response' && e.answer);
      const value = last?.type === 'response' && last.answer ? answerText(last.answer) : '';
      setDraft('');
      const copied = !!value && !!(await copyText(value));
      setFlash({
        ok: copied,
        text: copied
          ? 'Última respuesta copiada'
          : value
            ? 'No se ha podido copiar'
            : 'No hay ninguna respuesta que copiar',
      });
      clearTimeout(flashReset.current);
      flashReset.current = setTimeout(() => setFlash(undefined), 1800);
      return;
    }
    if (!images.length && text.startsWith('/')) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      if (onLocalCommand(name, rest.join(' '))) {
        setDraft('');
        return;
      }
    }
    sendingRef.current = true;
    setSending(true);
    setImageError('');
    setRecall(-1);
    try {
      const ok = await onSend(text, images);
      if (ok) {
        // A pending send can finish after switching views or recovering another message.
        // Remove only the submitted content; preserve any newer draft and attachments.
        setDraft((current) => (current === draft ? '' : current));
        const sentIds = new Set(images.map((attachment) => attachment.id));
        setImages((current) => current.filter((attachment) => !sentIds.has(attachment.id)));
      } else setImageError('No se pudo enviar. Tu borrador se conserva.');
    } catch {
      setImageError('No se pudo enviar. Tu borrador se conserva.');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const pick = (k: number) => {
    if (!menu) return;
    if (menu.type === 'slash') {
      const c = menu.items[k];
      edit('/' + c.name + (c.argumentHint ? ' ' : ''));
    } else {
      const file = menu.items[k];
      const insert = `@${file} `;
      edit(draft.slice(0, menu.start) + insert + draft.slice(menu.end), menu.start + insert.length);
    }
  };
  const mode = permissionModes.find(
    (m) => m.id === (session.info?.permissionMode ?? config?.permissionMode),
  );
  const modelName =
    session.info?.models.find((m) => m.value === config?.model)?.displayName ??
    (config?.model && config.model !== 'default' ? config.model : 'Por defecto');
  const effortName = efforts.find((e) => e.id === config?.effort)?.name;
  const context = claude ? session.stats?.contextPercent : undefined;
  return (
    <div className="composer-area">
      {!claude && session.notice && (
        <p className="codex-permission-timing" role="status">
          {session.notice}
        </p>
      )}
      {menu && (
        <div
          className="slash-menu"
          id={menuId}
          role="listbox"
          aria-label={menu.type === 'slash' ? 'Comandos' : 'Archivos del proyecto'}
        >
          {menu.type === 'slash'
            ? menu.items.map((c, i) => (
                <button
                  key={c.name}
                  id={`${menuId}-${i}`}
                  role="option"
                  aria-selected={i === selected}
                  className={i === selected ? 'on' : ''}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-hint">{c.argumentHint}</span>
                  <span className="slash-desc">{c.description}</span>
                </button>
              ))
            : menu.items.map((file, i) => {
                const slash = file.lastIndexOf('/');
                return (
                  <button
                    key={file}
                    id={`${menuId}-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    className={`file-option ${i === selected ? 'on' : ''}`}
                    onMouseEnter={() => setIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(i)}
                  >
                    <FileText size={12} aria-hidden="true" />
                    <span className="slash-name">{file.slice(slash + 1)}</span>
                    <span className="slash-desc">{slash > 0 ? file.slice(0, slash) : ''}</span>
                  </button>
                );
              })}
        </div>
      )}
      <div
        className={`composer ${enabled ? 'enabled' : ''} ${mode && claude ? `mode-${mode.id}` : ''}`}
      >
        {imageError && (
          <div className="attachment-error" role="alert">
            {imageError}
          </div>
        )}
        {flash && (
          <div className={`composer-flash ${flash.ok ? '' : 'off'}`} role="status">
            {flash.ok && <Check size={12} />} {flash.text}
          </div>
        )}
        {images.length > 0 && (
          <div className="attachment-list">
            {images.map((i) => (
              <div className="attachment-thumb" key={i.id}>
                <AttachmentPreview attachment={i} />
                <button
                  aria-label={`Quitar ${i.name}`}
                  title="Quitar archivo"
                  disabled={sending || picking}
                  onClick={() => {
                    setImages((current) => current.filter((x) => x.id !== i.id));
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
          aria-autocomplete="list"
          aria-controls={menu ? menuId : undefined}
          aria-activedescendant={menu ? `${menuId}-${selected}` : undefined}
          rows={1}
          placeholder={
            sending || session.status === 'starting'
              ? 'Conectando agente…'
              : working
                ? 'Añade indicaciones…'
                : 'Escribe una tarea…'
          }
          // readOnly instead of disabled: the caret stays in the composer while a message is sent.
          readOnly={!enabled || sending}
          aria-disabled={!enabled || sending}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
            setRecall(-1);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            // File pastes become attachments; ordinary text pastes stay untouched.
            const pasted = Array.from(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            void attach(
              pasted.map((f, i) =>
                f.name && !/^image\.\w+$/.test(f.name)
                  ? f
                  : new File(
                      [f],
                      `captura-${Date.now()}${i ? `-${i}` : ''}.${f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`,
                      { type: f.type },
                    ),
              ),
            );
          }}
          onKeyDown={(e) => {
            // IME uses Enter, arrows and Escape to choose characters before committing text.
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : menuSize - 1)) % menuSize);
              return;
            }
            if (menu && e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(menuKey);
              return;
            }
            if (
              menu &&
              (e.key === 'Tab' ||
                (e.key === 'Enter' &&
                  !e.shiftKey &&
                  (menu.type === 'files' || draft !== '/' + menu.items[selected].name)))
            ) {
              e.preventDefault();
              pick(selected);
              return;
            }
            const el = e.currentTarget;
            const firstLine = !draft.slice(0, el.selectionStart).includes('\n');
            if (
              e.key === 'ArrowUp' &&
              !e.shiftKey &&
              history.length &&
              firstLine &&
              (!draft || draft === history[recall])
            ) {
              const next = Math.min(recall + 1, history.length - 1);
              e.preventDefault();
              setRecall(next);
              edit(history[next]);
              return;
            }
            if (e.key === 'ArrowDown' && recall >= 0 && draft === history[recall]) {
              e.preventDefault();
              const next = recall - 1;
              setRecall(next);
              edit(next >= 0 ? history[next] : '');
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bar">
          <div
            ref={tools}
            className={`composer-tools ${toolsOpen ? 'open' : ''}`}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || !toolsOpen) return;
              e.preventDefault();
              setToolsOpen(false);
              tools.current?.querySelector<HTMLButtonElement>('.tools-toggle')?.focus();
            }}
          >
            <button
              className="chip-btn tools-toggle"
              aria-label={toolsOpen ? 'Ocultar herramientas' : 'Herramientas del chat'}
              title="Adjuntar, modelo, esfuerzo y permisos"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((v) => !v)}
            >
              <Plus size={15} />
            </button>
            <div className="composer-chips" inert={!toolsOpen}>
              <button
                className="chip-btn attach-image"
                aria-label="Adjuntar archivos"
                title="Adjuntar archivos · PDF, CSV, Office, texto, código e imágenes"
                disabled={!enabled || sending || picking}
                onClick={() => void attach()}
              >
                <Paperclip size={15} />
              </button>
              {!connected && (
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
              )}
              {connected ? (
                <Popover
                  label={
                    session.info?.models.find((m) => m.value === session.providerConfig?.model)
                      ?.displayName ??
                    session.providerConfig?.model ??
                    'Modelo'
                  }
                  icon={Sparkles}
                  title="Modelo"
                >
                  {(close) => (
                    <>
                      <button
                        disabled={working}
                        onClick={() => {
                          void chooseModel('default');
                          close();
                        }}
                      >
                        Predeterminado
                      </button>
                      {(session.info?.models ?? []).map((m) => (
                        <button
                          key={m.value}
                          disabled={working}
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
              ) : claude ? (
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
                        <CodexCatalogStatus session={session} run={run} compact />
                      </>
                    )}
                  </Popover>
                  <Popover
                    label={mode?.name ?? 'Permisos'}
                    icon={mode && NOTABLE_MODES.has(mode.id) ? ShieldAlert : ShieldCheck}
                    text={mode && NOTABLE_MODES.has(mode.id) ? mode.name : undefined}
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
                    label={effortName ?? 'Esfuerzo'}
                    icon={Gauge}
                    text={effortName}
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
                  {(() => {
                    const label = codexPermissionLabel(session.codexConfig);
                    const full = label === 'Acceso total';
                    return (
                      <Popover
                        label={label}
                        icon={full ? ShieldAlert : ShieldCheck}
                        text={label}
                        title="Permisos de Codex"
                      >
                        {(close) => (
                          <>
                            {codexPermissionModes.map((m) => (
                              <button
                                key={m.name}
                                className={
                                  m.sandbox === session.codexConfig?.sandbox &&
                                  m.approvalPolicy === session.codexConfig?.approvalPolicy
                                    ? 'on'
                                    : ''
                                }
                                aria-pressed={
                                  m.sandbox === session.codexConfig?.sandbox &&
                                  m.approvalPolicy === session.codexConfig?.approvalPolicy
                                }
                                onClick={async () => {
                                  const result = await run({
                                    type: 'configureCodex',
                                    sessionId: session.id,
                                    config: {
                                      sandbox: m.sandbox,
                                      approvalPolicy: m.approvalPolicy,
                                    },
                                  });
                                  if (result) close();
                                }}
                              >
                                <strong>{m.name}</strong>
                                <small>{m.hint}</small>
                              </button>
                            ))}
                            <small className="codex-permission-timing">
                              Se aplica al siguiente mensaje. Una acción pendiente se autoriza en su
                              propia solicitud.
                            </small>
                          </>
                        )}
                      </Popover>
                    );
                  })()}
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
                        text={session.codexConfig?.effort}
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
          </div>
          {working && !draft.trim() && !images.length ? (
            <button
              className="send stop"
              title="Interrumpir (Esc)"
              aria-label="Interrumpir"
              onClick={() => run({ type: 'interrupt', sessionId: session.id })}
            >
              <Square size={9} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send"
              title="Enviar (↵)"
              aria-label="Enviar"
              disabled={!enabled || sending || picking || (!draft.trim() && !images.length)}
              onClick={send}
            >
              <CornerDownLeft size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-footer">
        {footerStartRef && <div className="composer-footer-start" ref={footerStartRef} />}
        <div className="task-signature" aria-label="Cuenta y contexto">
          {accountControl ?? (
            <span className="task-signature-account" title={`Cuenta: ${accountName}`}>
              {accountName}
            </span>
          )}
          {/* Everything else waits behind the context ring: one hover, one quiet card. */}
          <span className="footer-insight" tabIndex={0} aria-describedby={insightId}>
            <ContextGauge
              percent={context !== undefined && Number.isFinite(context) ? context : undefined}
            />
            <span className="footer-insight-card" role="tooltip" id={insightId}>
              <span className="insight-row">
                <span>Modelo</span>
                <strong className="task-signature-model">{signature}</strong>
              </span>
              <span className="insight-row" title={tokenDetail}>
                <span>Tokens</span>
                <strong className="task-signature-tokens">
                  ↑{tokens ? compactTokens(tokens.input) : '—'} ↓
                  {tokens ? compactTokens(tokens.output) : '—'}
                </strong>
              </span>
              <span className="insight-row">
                <span>Contexto</span>
                <strong>
                  {context !== undefined && Number.isFinite(context)
                    ? `${Math.round(context)}%${
                        session.stats?.contextTokens && session.stats?.contextMax
                          ? ` · ${compactTokens(session.stats.contextTokens)} de ${compactTokens(session.stats.contextMax)}`
                          : ''
                      }`
                    : '—'}
                </strong>
              </span>
              {usageDetail}
            </span>
          </span>
        </div>
        {footerControl}
      </div>
    </div>
  );
}
function TodoList({
  todos,
}: {
  todos: { content: string; status: string; activeForm?: string }[];
}) {
  return (
    <ul className="todos">
      {todos.map((t, k) => (
        <li key={k} className={t.status}>
          <span className={`todo-mark ${t.status}`} aria-hidden="true" />
          <span className="sr-only">
            {t.status === 'completed'
              ? 'Hecha: '
              : t.status === 'in_progress'
                ? 'En curso: '
                : 'Pendiente: '}
          </span>
          {t.status === 'in_progress' ? t.activeForm || t.content : t.content}
        </li>
      ))}
    </ul>
  );
}
export function TodoPanel({
  todos,
  defaultOpen = false,
}: {
  todos: NonNullable<Session['todos']>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <div className="todo-panel">
      <button
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <ListTodo size={13} />
        <span className="todo-title">
          Tareas · {done}/{todos.length}
        </span>
        <span className="todo-progress" aria-hidden="true">
          <i style={{ width: `${todos.length ? (done / todos.length) * 100 : 0}%` }} />
        </span>
        {!open && current && (
          <span className="todo-current" title={current.activeForm || current.content}>
            {current.activeForm || current.content}
          </span>
        )}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div id={id}>
          <TodoList todos={todos} />
        </div>
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

/** Running tasks reported by the provider, shared by full chat and grid. */
export function ExecutionPanel({ session }: { session: Session }) {
  const agents = session.subagents ?? [];
  if (!agents.length) return null;
  return (
    <details className="execution-panel">
      <summary>
        <Bot size={13} aria-hidden="true" />
        <span className="execution-count">
          {agents.length} {agents.length === 1 ? 'agente' : 'agentes'}
        </span>
        <span className="execution-current" title={agents[0].description || 'Trabajando'}>
          {agents[0].description || 'Trabajando'}
        </span>
        <ChevronRight size={12} className="execution-chevron" aria-hidden="true" />
      </summary>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id}>
            <strong>{agent.description || 'Agente'}</strong>
            {agent.summary && agent.summary.trim() !== agent.description?.trim() && (
              <span>{agent.summary}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PendingMessages({
  session,
  run,
  recover,
}: {
  session: Session;
  run: (action: Action) => Promise<any>;
  recover: (text: string, attachments: Attachment[]) => void;
}) {
  if (!session.pendingInputs?.length) return null;
  return (
    <div className="pending-messages" aria-label="Mensajes pendientes" aria-live="polite">
      {session.pendingInputs.map((message) => (
        <div key={message.id} className={message.status}>
          <span title={message.error || message.text}>
            <small>
              {message.status === 'failed'
                ? 'No enviado'
                : message.status === 'sending'
                  ? 'Enviando'
                  : 'Pendiente'}
            </small>
            {message.text || message.attachments.map((a) => a.name).join(', ')}
          </span>
          {message.status === 'failed' && (
            <button
              type="button"
              title={message.error}
              aria-label="Recuperar mensaje"
              onClick={async () => {
                if (
                  await run({
                    type: 'cancelPendingInput',
                    sessionId: session.id,
                    messageId: message.id,
                  })
                )
                  recover(message.text, message.attachments);
              }}
            >
              <Undo2 size={12} />
            </button>
          )}
          <button
            type="button"
            disabled={message.status === 'sending'}
            aria-label="Cancelar mensaje pendiente"
            onClick={() =>
              void run({ type: 'cancelPendingInput', sessionId: session.id, messageId: message.id })
            }
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
