import React from 'react';
/**
 * Tiny syntax highlighter: one generic tokenizer plus per-language comment rules.
 * No grammars or dependencies; very large blocks stay as plain text.
 */
const LIMIT = 24000;
const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const KEYWORDS = words(`
  abstract as assert async await break case catch chan class const continue def default defer del
  delete do elif else enum except export extends false False final finally fn for from func function
  go goto if impl implements import in instanceof interface is lambda let loop map match mod module
  mut namespace new nil none None not null of or override package pass private protected pub public
  raise range readonly return select self Self static struct super switch this throw throws trait
  true True try type typeof undefined unless use val var void when where while with yield`);
const SQL = words(`
  add all alter and as asc begin between by case column commit create cross default delete desc
  distinct drop else end exists foreign from full group having if in index inner insert into is join
  key left like limit not null offset on or order outer primary references right rollback select set
  table then union unique update values view when where with`);
const SHELL = words('sh bash zsh shell console terminal fish');
const HASH = new Set([
  ...SHELL,
  ...words('py python rb ruby yaml yml toml dockerfile docker make makefile r perl ini conf env'),
  ...words('gitignore nix elixir ex coffee'),
]);
const MARKUP = words('html xml svg vue md markdown');
const C_LIKE_OFF = new Set([...HASH, ...MARKUP, ...words('sql json lua haskell hs')]);
const BACKTICK = words('js jsx javascript mjs cjs ts tsx typescript');
export const isShell = (lang: string) => SHELL.has(lang.toLowerCase());
function tokenizer(lang: string) {
  const comments: string[] = [];
  if (!C_LIKE_OFF.has(lang)) comments.push('//[^\\n]*', '/\\*[\\s\\S]*?\\*/');
  if (HASH.has(lang)) comments.push('(?<![\\w$\\]"\'])#[^\\n]*');
  if (lang === 'sql' || lang === 'lua' || lang === 'haskell' || lang === 'hs')
    comments.push('--[^\\n]*');
  if (MARKUP.has(lang)) comments.push('<!--[\\s\\S]*?-->');
  const strings = [`"(?:\\\\.|[^"\\\\\\n])*"`, `'(?:\\\\.|[^'\\\\\\n])*'`];
  if (BACKTICK.has(lang)) strings.push('`(?:\\\\.|[^`\\\\])*`');
  return new RegExp(
    [
      `(${comments.join('|') || '(?!)'})`,
      `(${strings.join('|')})`,
      '(\\b0x[\\da-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
      '([A-Za-z_$][\\w$]*)',
    ].join('|'),
    'g',
  );
}
// Commands, flags, variables and quoted arguments are the landmarks in shell snippets.
const SHELL_TOKENS =
  /((?<=^|\s)#.*$)|("(?:\\.|[^"\\])*"|'[^']*')|(\$\{?[A-Za-z_][\w]*\}?)|((?<=^\s*(?:\$\s+)?|(?:\||&&|;|\(|\$\()\s*)(?:sudo\s+)?[A-Za-z_./~][\w./~+@:-]*)|((?<=\s)--?[A-Za-z][\w-]*=?)/g;
function shell(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  code.split('\n').forEach((line, row) => {
    if (row) out.push('\n');
    let last = 0,
      m: RegExpExecArray | null,
      i = 0;
    SHELL_TOKENS.lastIndex = 0;
    while ((m = SHELL_TOKENS.exec(line))) {
      if (!m[0]) {
        SHELL_TOKENS.lastIndex++;
        continue;
      }
      if (m.index > last) out.push(line.slice(last, m.index));
      const cls = m[1] ? 'tk-c' : m[2] ? 'tk-s' : m[3] ? 'tk-v' : m[4] ? 'tk-f' : 'tk-o';
      out.push(
        <span className={cls} key={`${row}:${i++}`}>
          {m[0]}
        </span>,
      );
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
  });
  return out;
}
function diff(code: string): React.ReactNode[] {
  return code.split('\n').map((line, i, all) => {
    const cls = line.startsWith('@@')
      ? 'tk-k'
      : line.startsWith('+')
        ? 'tk-add'
        : line.startsWith('-')
          ? 'tk-del'
          : undefined;
    const text = i < all.length - 1 ? line + '\n' : line;
    return cls ? (
      <span className={cls} key={i}>
        {text}
      </span>
    ) : (
      text
    );
  });
}
export function highlight(code: string, rawLang = ''): React.ReactNode {
  const lang = rawLang.toLowerCase();
  if (!code || code.length > LIMIT) return code;
  if (lang === 'diff' || lang === 'patch') return diff(code);
  if (SHELL.has(lang)) return shell(code);
  if (!lang || /^(text|txt|plain|plaintext|output|log|md|mdx|markdown)$/.test(lang)) return code;
  const re = tokenizer(lang);
  const out: React.ReactNode[] = [];
  let last = 0,
    m: RegExpExecArray | null,
    i = 0;
  while ((m = re.exec(code))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    let cls: string | undefined;
    if (m[1]) cls = 'tk-c';
    else if (m[2])
      cls = /^\s*:(?!:)/.test(code.slice(re.lastIndex, re.lastIndex + 4)) ? 'tk-p' : 'tk-s';
    else if (m[3]) cls = 'tk-n';
    else {
      const w = m[4];
      if (lang === 'sql' ? SQL.has(w.toLowerCase()) : KEYWORDS.has(w)) cls = 'tk-k';
      else if (code[re.lastIndex] === '(') cls = 'tk-f';
      else if (/^[A-Z][a-z0-9]+[A-Za-z0-9]*$/.test(w) && lang !== 'json') cls = 'tk-t';
    }
    if (!cls) continue;
    if (m.index > last) out.push(code.slice(last, m.index));
    out.push(
      <span className={cls} key={i++}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
