import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, linkTarget } from '../src/markdown';
import { highlight } from '../src/highlight';
const html = (text: string) => renderToStaticMarkup(React.createElement(Markdown, { text }));
const tokens = (code: string, lang: string) =>
  renderToStaticMarkup(React.createElement('code', null, highlight(code, lang)));

test('markdown en línea: código, énfasis, tachado y snake_case sin cursivas', () => {
  const out = html('Usa `origin/main`, **negrita con `x`**, *cursiva*, ~~no~~ y some_var_name.');
  assert.match(out, /<code>origin\/main<\/code>/);
  assert.match(out, /<strong>negrita con <code>x<\/code><\/strong>/);
  assert.match(out, /<em>cursiva<\/em>/);
  assert.match(out, /<del>no<\/del>/);
  assert.match(out, /some_var_name/);
  assert.doesNotMatch(out, /<em>var<\/em>/);
  assert.match(html('\\*literal\\* y `a\\*b`'), /\*literal\* y <code>a\\\*b<\/code>/);
});
test('enlaces: web y rutas se distinguen; esquemas peligrosos quedan como texto', () => {
  assert.deepEqual(linkTarget('https://example.com/a'), {
    kind: 'url',
    value: 'https://example.com/a',
  });
  assert.deepEqual(linkTarget('docs/wiki/a.md'), { kind: 'path', value: 'docs/wiki/a.md' });
  assert.deepEqual(linkTarget('file:///tmp/a%20b.ts'), { kind: 'path', value: '/tmp/a b.ts' });
  assert.equal(linkTarget('javascript:alert(1)'), undefined);
  assert.equal(linkTarget('#ancla'), undefined);
  const out = html(
    'Mira [la guía](docs/guia.md), http://localhost:5173/app. y [x](javascript:alert(1))',
  );
  assert.match(out, /title="docs\/guia\.md">la guía<\/span>/);
  assert.match(out, /title="http:\/\/localhost:5173\/app">http:\/\/localhost:5173\/app<\/span>\./);
  assert.match(out, /class="md-link-text" title="javascript:alert\(1\)"/);
});
test('el texto nunca se interpreta como HTML', () => {
  const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<script>|<img/);
  assert.match(out, /&lt;script&gt;/);
});
test('listas anidadas, numeración inicial y tareas', () => {
  const out = html(
    '- uno\n  - dos\n    1. tres\n- cuatro\n\n3. c\n4. d\n\n- [x] hecho\n- [ ] pendiente',
  );
  assert.match(
    out,
    /<ul><li>uno<ul><li>dos<ol><li>tres<\/li><\/ol><\/li><\/ul><\/li><li>cuatro<\/li><\/ul>/,
  );
  assert.match(out, /<ol start="3"><li>c<\/li><li>d<\/li><\/ol>/);
  assert.match(out, /md-check on/);
  assert.match(out, /Pendiente: <\/span>pendiente/);
});
test('bloques de código, también sin cerrar mientras llega el streaming', () => {
  const out = html('Antes\n\n```bash\nnpm test --watch\n');
  assert.match(out, /class="md-lang">bash/);
  assert.match(out, /<span class="tk-f">npm<\/span> test <span class="tk-o">--watch<\/span>/);
  assert.match(html('~~~\nplano\n~~~'), /<pre><code>plano<\/code><\/pre>/);
});
test('tablas con alineación y barras escapadas; avisos de GitHub', () => {
  const out = html('| A | B |\n|:-:|--:|\n| x \\| y | 2 |');
  assert.match(out, /<th style="text-align:center">A<\/th>/);
  assert.match(out, /<td style="text-align:center">x \| y<\/td>/);
  assert.match(
    html('> [!TIP]\n> Usa **pnpm**.'),
    /md-callout tip.*Consejo.*<strong>pnpm<\/strong>/,
  );
  assert.match(html('> cita'), /<blockquote><p>cita<\/p><\/blockquote>/);
});
test('saltos de línea simples se conservan como en la terminal', () => {
  assert.match(html('Línea 1\nLínea 2'), /<p>Línea 1<br\/>Línea 2<\/p>/);
  assert.match(html('Texto\n---\nmás'), /<hr\/>/);
});
test('resaltado ligero: palabras clave, cadenas, comentarios y comandos', () => {
  const ts = tokens("const a = 'x'; // nota\nfunction f() { return 42 }", 'ts');
  assert.match(ts, /<span class="tk-k">const<\/span>/);
  assert.match(ts, /<span class="tk-s">&#x27;x&#x27;<\/span>/);
  assert.match(ts, /<span class="tk-c">\/\/ nota<\/span>/);
  assert.match(ts, /<span class="tk-f">f<\/span>/);
  assert.match(ts, /<span class="tk-n">42<\/span>/);
  assert.match(tokens('{"a": 1}', 'json'), /<span class="tk-p">&quot;a&quot;<\/span>/);
  assert.match(tokens('# hola\nx = None', 'python'), /tk-c">#.*tk-k">None/s);
  assert.match(
    tokens('$ git push --force $HOME | grep x', 'sh'),
    /tk-f">git<.*tk-o">--force<.*tk-v">\$HOME<.*tk-f">grep</s,
  );
  assert.equal(tokens('if this is prose', 'md'), '<code>if this is prose</code>');
  assert.match(tokens('+añadido\n-quitado', 'diff'), /tk-add">\+añadido\n<.*tk-del">-quitado/s);
});
