import React from 'react';
/** Small, safe Markdown renderer: no HTML pass-through, links are shown but never navigated. */
function inline(text: string, key = 0): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0,
    m: RegExpExecArray | null,
    i = key;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (s.startsWith('`')) out.push(<code key={i++}>{s.slice(1, -1)}</code>);
    else if (s.startsWith('**'))
      out.push(<strong key={i++}>{inline(s.slice(2, -2), i * 50)}</strong>);
    else if (s.startsWith('*') || s.startsWith('_'))
      out.push(<em key={i++}>{inline(s.slice(1, -1), i * 50)}</em>);
    else {
      const t = /\[([^\]]+)\]\(([^)]+)\)/.exec(s)!;
      out.push(
        <span className="md-link" title={t[2]} key={i++}>
          {t[1]}
        </span>,
      );
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0,
    k = 0;
  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      nodes.push(<p key={k++}>{inline(paragraph.join(' '))}</p>);
      paragraph.length = 0;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      nodes.push(
        <pre className="md-code" key={k++}>
          {fence[1] && <span className="md-lang">{fence[1]}</span>}
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 2, 6);
      nodes.push(React.createElement(`h${level}`, { key: k++ }, inline(heading[2])));
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        i++;
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
        )
          item += ' ' + lines[i++].trim();
        const task = /^\[([ xX])\]\s+/.exec(item);
        items.push(
          <li key={items.length} className={task ? 'md-task' : ''}>
            {task && <span className={`md-check ${task[1] !== ' ' ? 'on' : ''}`} />}
            {inline(task ? item.slice(task[0].length) : item)}
          </li>,
        );
      }
      nodes.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]))
        body.push(lines[i++].replace(/^\s*>\s?/, ''));
      nodes.push(
        <blockquote key={k++}>
          <Markdown text={body.join('\n')} />
        </blockquote>,
      );
      continue;
    }
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])
    ) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i]
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim());
        if (!/^:?-{2,}/.test(cells[0])) rows.push(cells);
        i++;
      }
      nodes.push(
        <table key={k++}>
          <thead>
            <tr>
              {rows[0]?.map((c, j) => (
                <th key={j}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((r, j) => (
              <tr key={j}>
                {r.map((c, x) => (
                  <td key={x}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      nodes.push(<hr key={k++} />);
      i++;
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
  return <div className="md">{nodes}</div>;
}
