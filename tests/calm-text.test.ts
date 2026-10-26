import test from 'node:test';
import assert from 'node:assert/strict';
import { sentenceEnds } from '../src/calm-text';
const first = (text: string, done = false) => text.slice(0, sentenceEnds(text, done)[0] ?? 0);
test('waits for complete sentences; preserves final text without punctuation', () => {
  assert.equal(first('Todavía escribiendo'), '');
  assert.equal(first('Listo. Otra frase incompleta'), 'Listo. ');
  assert.equal(first('Última frase', true), 'Última frase');
  assert.deepEqual(sentenceEnds('Uno. Dos. Tres.', true), [5, 10, 15]);
});
test('does not break paths, decimals, inline code, links or bold', () => {
  for (const value of [
    'Versión 1.25',
    'Mira src/main.ts',
    'Usa `npm. test',
    'Mira [el archivo. ',
    '**Aviso. ',
  ])
    assert.equal(first(value), '');
  assert.equal(first('Usa `npm test`. Después'), 'Usa `npm test`. ');
  assert.equal(first('**Listo.** Siguiente'), '**Listo.** ');
});
test('list rows and closed code blocks arrive whole', () => {
  assert.equal(first('- Corregido\n- Pendiente'), '- Corregido\n');
  assert.equal(first('```ts\nconst x = 1;\n'), '');
  const code = '```ts\nconst x = 1;\n```\n';
  assert.equal(first(code + 'Después'), code);
  assert.equal(first('```ts\nconst x = 1;', true), '```ts\nconst x = 1;');
});
