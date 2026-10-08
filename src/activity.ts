import type { Block, Message } from './shared';
/** Pure projections of agent work: step kinds, Spanish summaries, line diffs and file changes. */
export type ToolBlock = Extract<Block, { type: 'tool_use' }>;
export type StepKind =
  | 'command'
  | 'read'
  | 'search'
  | 'list'
  | 'edit'
  | 'create'
  | 'web'
  | 'agent'
  | 'todo'
  | 'browser'
  | 'coordinate'
  | 'plan'
  | 'question'
  | 'skill'
  | 'tool';
export interface Step {
  id: string;
  kind: StepKind;
  name: string;
  /** Main target: command, file, pattern, URL… */
  label: string;
  /** Human description given by the agent, when different from the label. */
  detail?: string;
  running: boolean;
  error: boolean;
  /** Non-zero exit code; only an explicit failure status makes it an error. */
  exit?: number;
  ms?: number;
  added?: number;
  removed?: number;
  files?: string[];
  block?: ToolBlock;
  message?: Message;
}
const KINDS: Record<string, StepKind> = {
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  KillBash: 'command',
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'list',
  LS: 'list',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'create',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent',
  TodoWrite: 'todo',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  AskUserQuestion: 'question',
  Skill: 'skill',
  mcp__agent_desk__browser: 'browser',
  mcp__agent_desk__coordinate: 'coordinate',
};
export const toolKind = (name: string): StepKind => KINDS[name] ?? 'tool';
export function shortPath(p: unknown, root?: string) {
  if (typeof p !== 'string') return '';
  if (root && (p === root || p.startsWith(root.endsWith('/') ? root : root + '/')))
    return p.slice(root.length).replace(/^\/+/, '') || '.';
  return p.replace(/^\/Users\/[^/]+/, '~');
}
const firstLine = (s: unknown) =>
  typeof s === 'string' ? s.trim().split('\n')[0].slice(0, 200) : '';
function fallbackLabel(input: any) {
  if (!input || typeof input !== 'object') return '';
  const value = Object.values(input).find((v) => typeof v === 'string');
  return firstLine(value);
}
export function lines(text: string) {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}
export type DiffLine = { type: ' ' | '+' | '-'; text: string };
/** Line diff of two snippets (LCS); large inputs degrade to replace-all. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after ? after.replace(/\n$/, '').split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ type: ' ', text }));
  const n = endA - start,
    m = endB - start;
  if (n * m > 160000) {
    for (let i = start; i < endA; i++) out.push({ type: '-', text: a[i] });
    for (let j = start; j < endB; j++) out.push({ type: '+', text: b[j] });
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] =
          a[start + i] === b[start + j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ type: ' ', text: a[start + i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: '-', text: a[start + i++] });
      else out.push({ type: '+', text: b[start + j++] });
    }
    while (i < n) out.push({ type: '-', text: a[start + i++] });
    while (j < m) out.push({ type: '+', text: b[start + j++] });
  }
  for (let i = endA; i < a.length; i++) out.push({ type: ' ', text: a[i] });
  return out;
}
export function diffCounts(diff: DiffLine[]) {
  return diff.reduce(
    (c, l) => ({
      added: c.added + Number(l.type === '+'),
      removed: c.removed + Number(l.type === '-'),
    }),
    { added: 0, removed: 0 },
  );
}
/** Counts of a unified diff; whole-file additions may arrive without +/- markers. */
export function unifiedCounts(diff: string, kind = 'update') {
  let added = 0,
    removed = 0,
    marked = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('@@')) marked = true;
    else if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  if (!added && !removed && !marked && diff.trim()) {
    if (kind === 'add') added = lines(diff);
    if (kind === 'delete') removed = lines(diff);
  }
  return { added, removed };
}
export function editStats(b: ToolBlock) {
  const i = b.input ?? {};
  if (b.name === 'Edit') return diffCounts(lineDiff(i.old_string ?? '', i.new_string ?? ''));
  if (b.name === 'MultiEdit')
    return (Array.isArray(i.edits) ? i.edits : []).reduce(
      (c: { added: number; removed: number }, e: any) => {
        const d = diffCounts(lineDiff(e?.old_string ?? '', e?.new_string ?? ''));
        return { added: c.added + d.added, removed: c.removed + d.removed };
      },
      { added: 0, removed: 0 },
    );
  if (b.name === 'Write') return { added: lines(String(i.content ?? '')), removed: 0 };
  if (b.name === 'NotebookEdit')
    return i.edit_mode === 'delete'
      ? { added: 0, removed: 0 }
      : { added: lines(String(i.new_source ?? '')), removed: 0 };
  return undefined;
}
export function stepFromBlock(b: ToolBlock, root?: string): Step {
  const i = b.input ?? {};
  const kind = toolKind(b.name);
  const base = {
    id: b.id,
    kind,
    name: b.name,
    running: !b.done,
    error: !!b.isError,
    ms: b.ms,
    block: b,
  };
  switch (kind) {
    case 'command': {
      const command = firstLine(i.command) || firstLine(i.bash_id ?? i.shell_id);
      return { ...base, label: command, detail: firstLine(i.description) || undefined };
    }
    case 'read':
      return { ...base, label: shortPath(i.file_path ?? i.notebook_path, root) };
    case 'search':
      return {
        ...base,
        label: firstLine(i.pattern),
        detail: i.path ? shortPath(i.path, root) : i.glob ? String(i.glob) : undefined,
      };
    case 'list':
      return {
        ...base,
        label: firstLine(i.pattern) || shortPath(i.path, root),
        detail: i.pattern && i.path ? shortPath(i.path, root) : undefined,
      };
    case 'edit':
    case 'create': {
      const file = i.file_path ?? i.notebook_path;
      return {
        ...base,
        label: shortPath(file, root),
        files: typeof file === 'string' ? [file] : [],
        ...editStats(b),
      };
    }
    case 'web':
      return { ...base, label: firstLine(i.url ?? i.query) };
    case 'agent':
      return {
        ...base,
        label: firstLine(i.description) || firstLine(i.prompt),
        detail: typeof i.subagent_type === 'string' ? i.subagent_type : undefined,
      };
    case 'todo': {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const done = todos.filter((t: any) => t?.status === 'completed').length;
      return { ...base, label: `${done}/${todos.length} completadas` };
    }
    case 'browser':
      return { ...base, label: [i.action, i.url ?? i.text ?? ''].filter(Boolean).join(' · ') };
    case 'coordinate':
      return { ...base, label: [i.action, ...(i.paths ?? [])].filter(Boolean).join(' · ') };
    case 'plan':
      return { ...base, label: b.name === 'EnterPlanMode' ? 'Modo plan' : 'Plan listo' };
    case 'question':
      return {
        ...base,
        label: firstLine(Array.isArray(i.questions) ? i.questions[0]?.question : ''),
      };
    case 'skill':
      return { ...base, label: firstLine(i.skill ?? i.command) };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(b.name);
      return {
        ...base,
        label: mcp ? `${mcp[1]} · ${mcp[2]}` : b.name,
        detail: fallbackLabel(i) || undefined,
      };
    }
  }
}
/** Codex items (and legacy flat tool messages) as steps. */
export function stepFromMessage(m: Message, root?: string): Step {
  const t = m.tool;
  const running = t?.status === 'inProgress';
  const error = t ? t.status === 'failed' || t.status === 'declined' : m.kind === 'error';
  const base = { id: m.id, name: t?.kind ?? 'tool', running, error, ms: t?.durationMs, message: m };
  if (!t) {
    const head = m.text.split('\n')[0];
    return /^\$ /.test(head)
      ? { ...base, kind: 'command', label: head.slice(2) }
      : { ...base, kind: 'tool', label: head.slice(0, 200) };
  }
  if (t.kind === 'command') {
    const actions = t.actions ?? [];
    const only = (type: string) => actions.length > 0 && actions.every((a) => a.type === type);
    if (only('read'))
      return {
        ...base,
        kind: 'read',
        label: actions.map((a) => shortPath(a.path, root)).join(', '),
        detail: t.command,
      };
    if (only('search'))
      return {
        ...base,
        kind: 'search',
        label: actions[0].query ?? t.command ?? '',
        detail: t.command,
      };
    if (only('listFiles'))
      return {
        ...base,
        kind: 'list',
        label: shortPath(actions[0].path, root) || '.',
        detail: t.command,
      };
    return {
      ...base,
      kind: 'command',
      label: firstLine(t.command),
      exit: t.exitCode !== undefined && t.exitCode !== 0 ? t.exitCode : undefined,
    };
  }
  if (t.kind === 'edit') {
    const files = t.files ?? [];
    const counts = files.reduce(
      (c, f) => {
        const d = unifiedCounts(f.diff, f.kind);
        return { added: c.added + d.added, removed: c.removed + d.removed };
      },
      { added: 0, removed: 0 },
    );
    return {
      ...base,
      kind: files.length && files.every((f) => f.kind === 'add') ? 'create' : 'edit',
      label: files.map((f) => shortPath(f.path, root)).join(', '),
      files: files.map((f) => f.path),
      ...counts,
    };
  }
  if (t.kind === 'web') return { ...base, kind: 'web', label: t.query ?? '' };
  const browser = t.server === 'agent_desk' && t.tool === 'browser';
  return {
    ...base,
    kind: browser
      ? 'browser'
      : t.server === 'agent_desk' && t.tool === 'coordinate'
        ? 'coordinate'
        : 'tool',
    label: browser ? 'Navegador' : `${t.server} · ${t.tool}`,
  };
}
export type WorkItem =
  | { type: 'step'; step: Step }
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string; streaming: boolean };
/** Flatten work messages into the order the agent produced them. */
export function workItems(messages: Message[], root?: string): WorkItem[] {
  const out: WorkItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ type: 'step', step: stepFromMessage(m, root) });
    else if (m.role === 'assistant' && m.blocks)
      m.blocks.forEach((b, k) => {
        if (b.type === 'tool_use') out.push({ type: 'step', step: stepFromBlock(b, root) });
        else if (b.type === 'thinking')
          out.push({ type: 'thinking', id: `${m.id}:${k}`, text: b.text, streaming: !b.final });
        else if (b.text.trim()) out.push({ type: 'text', id: `${m.id}:${k}`, text: b.text });
      });
    else if (m.role === 'assistant' && m.text.trim())
      out.push({ type: 'text', id: m.id, text: m.text });
  }
  return out;
}
export function stepsOf(messages: Message[], root?: string) {
  return workItems(messages, root).flatMap((w) => (w.type === 'step' ? [w.step] : []));
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function joinSpanish(parts: string[]) {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
}
/** "Leyó 3 archivos, ejecutó 2 comandos y editó 1 archivo" — the shape of the work, not its log. */
export function summarize(steps: Step[]) {
  const unique = (kinds: StepKind[]) =>
    new Set(
      steps
        .filter((s) => kinds.includes(s.kind))
        .flatMap((s) => (s.files?.length ? s.files : [s.label || s.id])),
    ).size;
  const count = (kinds: StepKind[]) => steps.filter((s) => kinds.includes(s.kind)).length;
  // Narrative order; when space runs out, changes and commands win over exploration.
  const parts: { text: string; rank: number }[] = [];
  const add = (n: number, rank: number, text: string) => n && parts.push({ text, rank });
  const read = unique(['read']);
  add(read, 4, `leyó ${plural(read, 'archivo', 'archivos')}`);
  const search = count(['search', 'list']);
  add(search, 5, search === 1 ? 'hizo 1 búsqueda' : `hizo ${search} búsquedas`);
  const commands = count(['command']);
  add(commands, 3, `ejecutó ${plural(commands, 'comando', 'comandos')}`);
  const edited = unique(['edit']);
  add(edited, 1, `editó ${plural(edited, 'archivo', 'archivos')}`);
  const created = unique(['create']);
  add(created, 2, `creó ${plural(created, 'archivo', 'archivos')}`);
  const web = count(['web']);
  add(web, 6, web === 1 ? 'consultó la web' : `hizo ${web} consultas web`);
  const browser = count(['browser']);
  add(browser, 6, `usó el navegador${browser > 1 ? ` (${browser} acciones)` : ''}`);
  const agents = count(['agent']);
  add(agents, 6, `lanzó ${plural(agents, 'subagente', 'subagentes')}`);
  const skills = count(['skill']);
  add(skills, 7, `usó ${plural(skills, 'skill', 'skills')}`);
  const tools = count(['tool']);
  add(tools, 7, `usó ${plural(tools, 'herramienta', 'herramientas')}`);
  if (!parts.length) {
    if (count(['plan'])) add(1, 8, 'preparó un plan');
    else if (count(['todo'])) add(1, 8, 'actualizó las tareas');
    else if (count(['question'])) add(1, 8, 'te hizo una pregunta');
    else if (count(['coordinate'])) add(1, 8, 'coordinó el trabajo');
  }
  let shown = parts.map((p) => p.text);
  if (parts.length > 4) {
    const keep = new Set([...parts].sort((a, b) => a.rank - b.rank).slice(0, 3));
    shown = [...parts.filter((p) => keep.has(p)).map((p) => p.text), 'más'];
  }
  const text = joinSpanish(shown);
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}
export function duration(ms?: number) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
export interface FileChange {
  path: string;
  added: number;
  removed: number;
  created: boolean;
}
/** Files touched in a turn, merged by path, in first-touched order. */
export function fileChanges(messages: Message[]): FileChange[] {
  const files = new Map<string, FileChange>();
  const touch = (path: string, added: number, removed: number, created: boolean) => {
    const f = files.get(path) ?? { path, added: 0, removed: 0, created };
    f.added += added;
    f.removed += removed;
    files.set(path, f);
  };
  const visit = (blocks: Block[] = []) => {
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      visit(b.children);
      if (b.isError || !b.done) continue;
      const kind = toolKind(b.name);
      const file = b.input?.file_path ?? b.input?.notebook_path;
      if ((kind === 'edit' || kind === 'create') && typeof file === 'string') {
        const s = editStats(b) ?? { added: 0, removed: 0 };
        touch(file, s.added, s.removed, kind === 'create' && !files.has(file));
      }
    }
  };
  for (const m of messages) {
    if (m.role === 'assistant') visit(m.blocks);
    else if (m.tool?.kind === 'edit' && m.tool.status === 'completed')
      for (const f of m.tool.files ?? []) {
        const c = unifiedCounts(f.diff, f.kind);
        touch(f.path, c.added, c.removed, f.kind === 'add');
      }
  }
  return [...files.values()];
}
