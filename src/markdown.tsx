import React, { createContext, memo, useContext, useState } from 'react';
import {
  Check,
  Copy,
  Info,
  Lightbulb,
  OctagonAlert,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react';
import { highlight, isShell } from './highlight';
/**
 * Small, safe Markdown renderer: no HTML pass-through. Links never navigate the window;
 * they go through the chat actions (integrated browser, project files, terminal).
 */
export interface ChatActions {
  /** Project folder, to show paths relative to it. */
  root?: string;
  openUrl?(url: string): void;
  openPath?(path: string): void;
  runCommand?(command: string): void;
  showChanges?(): void;
  reuse?(text: string): void;
}
export const ChatActionsContext = createContext<ChatActions>({});
export const useChatActions = () => useContext(ChatActionsContext);

export type LinkTarget = { kind: 'url' | 'path'; value: string };
export function linkTarget(raw: string): LinkTarget | undefined {
  const target = raw.trim();
  if (/^https?:\/\/\S+$/i.test(target)) return { kind: 'url', value: target };
  if (/^file:\/\//i.test(target)) {
    try {
      return { kind: 'path', value: decodeURI(target.replace(/^file:\/\//i, '')) };
    } catch {
      return undefined;
    }
  }
  if (target.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(target)) return undefined;
  return /^[\w.~/@-][^\s<>"]*$/.test(target) ? { kind: 'path', value: target } : undefined;
}
export function Link({ target, children }: { target: LinkTarget; children: React.ReactNode }) {
  const actions = useChatActions();
  const open = target.kind === 'url' ? actions.openUrl : actions.openPath;
  if (!open)
    return (
      <span className="md-link" title={target.value}>
        {children}
      </span>
    );
  const activate = () => open(target.value);
  return (
    <a
      className={`md-link ${target.kind}`}
      role="link"
      tabIndex={0}
      title={
        target.kind === 'url' ? `${target.value} · Abrir en el navegador integrado` : target.value
      }
      onClick={(e) => {
        e.preventDefault();
        activate();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          activate();
        }
      }}
    >
      {children}
    </a>
  );
}
// Backslash escapes become private-use characters so the inline grammar ignores them.
const escapeMarks = (s: string) =>
  s.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)));
const restoreMarks = (s: string, raw = false) =>
  s.replace(
    /[\ue000-\ue07f]/g,
    (c) => (raw ? '\\' : '') + String.fromCharCode(c.charCodeAt(0) - 0xe000),
  );
const INLINE = new RegExp(
  [
    '(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)', // 1-2 code span
    '\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*', // 3 bold
    '(?<![\\w])__(?=\\S)([\\s\\S]*?\\S)__(?!\\w)', // 4 bold
    '~~(?=\\S)([\\s\\S]*?\\S)~~', // 5 strikethrough
    '\\*(?=[^\\s*])((?:\\*\\*[^*\\n]+\\*\\*|[^*\\n])*?[^\\s*])\\*(?!\\*)', // 6 italic
    '(?<![\\w])_(?=[^\\s_])([^_\\n]*?[^\\s_])_(?!\\w)', // 7 italic
    '\\[((?:[^\\[\\]\\n]|\\[[^\\]\\n]*\\])+)\\]\\(\\s*<?([^()\\s<>]+(?:\\([^()\\s]*\\)[^()\\s<>]*)*)>?(?:\\s+"[^"\\n]*")?\\s*\\)', // 8-9 link
    '<(https?:\\/\\/[^>\\s]+)>', // 10 autolink
    '(https?:\\/\\/[^\\s<>"`]*[^\\s<>"`.,;:!?\'()\\[\\]{}*_~])', // 11 bare URL
  ].join('|'),
  'g',
);
function text(s: string, key: string): React.ReactNode[] {
  const lines = restoreMarks(s).split('\n');
  return lines.flatMap((line, i) => (i ? [<br key={`${key}-br${i}`} />, line] : [line]));
}
export function inline(source: string, prefix = 'i'): React.ReactNode[] {
  const s = escapeMarks(source);
  const out: React.ReactNode[] = [];
  let last = 0,
    n = 0,
    m: RegExpExecArray | null;
  const re = new RegExp(INLINE.source, 'g');
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...text(s.slice(last, m.index), `${prefix}t${n}`));
    const key = `${prefix}${n++}`;
    if (m[2] !== undefined) {
      const code = restoreMarks(m[2], true).replace(/\n/g, ' ');
      out.push(
        <code key={key}>{/^ .* $/.test(code) && code.trim() ? code.slice(1, -1) : code}</code>,
      );
    } else if (m[3] !== undefined || m[4] !== undefined)
      out.push(<strong key={key}>{inline(restoreMarks(m[3] ?? m[4], true), key)}</strong>);
    else if (m[5] !== undefined)
      out.push(<del key={key}>{inline(restoreMarks(m[5], true), key)}</del>);
    else if (m[6] !== undefined || m[7] !== undefined)
      out.push(<em key={key}>{inline(restoreMarks(m[6] ?? m[7], true), key)}</em>);
    else {
      const label = m[8] !== undefined ? inline(restoreMarks(m[8], true), key) : undefined;
      const href = restoreMarks(m[9] ?? m[10] ?? m[11]);
      const target = linkTarget(href);
      out.push(
        target ? (
          <Link key={key} target={target}>
            {label ?? href}
          </Link>
        ) : (
          <span key={key} className="md-link-text" title={href}>
            {label ?? href}
          </span>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...text(s.slice(last), `${prefix}t${n}`));
  return out;
}
function commandText(code: string) {
  const lines = code.replace(/\s+$/, '').split('\n');
  const prompted = lines.filter((l) => l.trim()).every((l) => /^\s*\$\s/.test(l));
  return (prompted ? lines.map((l) => l.replace(/^\s*\$\s/, '')) : lines).join('\n');
}
export function CodeBlock({ code, lang = '' }: { code: string; lang?: string }) {
  const actions = useChatActions();
  const [copied, setCopied] = useState(false);
  const runnable = isShell(lang) && !!actions.runCommand && !!code.trim();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable: the code stays selectable */
    }
  };
  return (
    <div className={`md-code ${code.includes('\n') ? 'multiline' : 'single'}`}>
      <div className="md-code-bar">
        {lang && <span className="md-lang">{lang}</span>}
        {runnable && (
          <button
            className="md-code-action"
            aria-label="Pegar en la terminal"
            title="Pegar en la terminal del proyecto · Revísalo y pulsa ↵ para ejecutarlo"
            onClick={() => actions.runCommand!(commandText(code))}
          >
            <SquareTerminal size={13} />
          </button>
        )}
        <button
          className={`md-code-action ${copied ? 'done' : ''}`}
          aria-label={copied ? 'Copiado' : 'Copiar código'}
          title={copied ? 'Copiado' : 'Copiar'}
          onClick={() => void copy()}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}
const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const CALLOUTS: Record<string, { label: string; icon: typeof Info }> = {
  NOTE: { label: 'Nota', icon: Info },
  TIP: { label: 'Consejo', icon: Lightbulb },
  IMPORTANT: { label: 'Importante', icon: Info },
  WARNING: { label: 'Atención', icon: TriangleAlert },
  CAUTION: { label: 'Precaución', icon: OctagonAlert },
};
const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
function cells(line: string) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}
const isTableStart = (lines: string[], i: number) =>
  lines[i].includes('|') &&
  i + 1 < lines.length &&
  lines[i + 1].includes('-') &&
  (lines[i + 1].includes('|') || cells(lines[i]).length > 1) &&
  SEPARATOR.test(lines[i + 1]);
const startsBlock = (lines: string[], i: number) =>
  FENCE.test(lines[i]) ||
  HEADING.test(lines[i]) ||
  RULE.test(lines[i]) ||
  QUOTE.test(lines[i]) ||
  ITEM.test(lines[i]) ||
  isTableStart(lines, i);
function list(lines: string[], start: number, prefix: string) {
  const first = ITEM.exec(lines[start])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: React.ReactNode[] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const content = base + m[2].length + Math.max(1, Math.min(m[3].length, 4));
    const body = [m[4]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > base) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      const nested = ITEM.exec(line);
      if (nested && nested[1].length <= base) break;
      if (indentOf(line) > base) {
        body.push(line.slice(Math.min(indentOf(line), content)));
        i++;
        continue;
      }
      if (startsBlock(lines, i)) break;
      body.push(line.trim()); // lazy continuation
      i++;
    }
    const task = /^\[([ xX])\]\s+/.exec(body[0]);
    if (task) body[0] = body[0].slice(task[0].length);
    const key = `${prefix}-${items.length}`;
    items.push(
      <li key={key} className={task ? 'md-task' : undefined}>
        {task && <span className={`md-check ${task[1] !== ' ' ? 'on' : ''}`} aria-hidden="true" />}
        {task && <span className="sr-only">{task[1] !== ' ' ? 'Hecho: ' : 'Pendiente: '}</span>}
        {blocks(body, key, true)}
      </li>,
    );
  }
  const node = ordered ? (
    <ol key={prefix} start={parseInt(first[2], 10) !== 1 ? parseInt(first[2], 10) : undefined}>
      {items}
    </ol>
  ) : (
    <ul key={prefix}>{items}</ul>
  );
  return { node, next: i };
}
function blocks(source: string[], prefix: string, tight = false): React.ReactNode[] {
  const lines = source.map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)));
  const nodes: React.ReactNode[] = [];
  const paragraph: string[] = [];
  let i = 0,
    k = 0;
  const key = () => `${prefix}.${k++}`;
  const flush = () => {
    if (!paragraph.length) return;
    const content = inline(paragraph.join('\n'), key());
    nodes.push(
      tight && !nodes.length ? (
        <React.Fragment key={key()}>{content}</React.Fragment>
      ) : (
        <p key={key()}>{content}</p>
      ),
    );
    paragraph.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const [, indent, mark, lang] = fence;
      const body: string[] = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(`^\\s{0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).test(lines[i])
      )
        body.push(lines[i++].replace(new RegExp(`^ {0,${indent.length}}`), ''));
      i++;
      nodes.push(<CodeBlock key={key()} code={body.join('\n')} lang={lang} />);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      nodes.push(
        React.createElement(`h${heading[1].length}`, { key: key() }, inline(heading[2], key())),
      );
      i++;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      nodes.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (ITEM.test(line) && (ITEM.exec(line)![4].trim() || !paragraph.length)) {
      flush();
      const { node, next } = list(lines, i, key());
      nodes.push(node);
      i = next;
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      const callout = /^\[!(\w+)\]\s*$/.exec(body[0] ?? '');
      const kind = callout && CALLOUTS[callout[1].toUpperCase()];
      if (kind) {
        const Icon = kind.icon;
        nodes.push(
          <div key={key()} className={`md-callout ${callout![1].toLowerCase()}`}>
            <div className="md-callout-title">
              <Icon size={13} />
              {kind.label}
            </div>
            {blocks(body.slice(1), key())}
          </div>,
        );
      } else nodes.push(<blockquote key={key()}>{blocks(body, key())}</blockquote>);
      continue;
    }
    if (isTableStart(lines, i)) {
      flush();
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : undefined,
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim())
        rows.push(cells(lines[i++]));
      const id = key();
      nodes.push(
        <div className="md-table" key={id}>
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={align[j] ? { textAlign: align[j] } : undefined}>
                    {inline(c, `${id}h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y}>
                  {head.map((_, x) => (
                    <td key={x} style={align[x] ? { textAlign: align[x] } : undefined}>
                      {inline(r[x] ?? '', `${id}r${y}c${x}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    paragraph.push(line.trim());
    i++;
  }
  flush();
  return nodes;
}
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text.replace(/\r\n?/g, '\n').split('\n'), 'b')}</div>;
});
