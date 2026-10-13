import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseReader, speechChunks, speechText } from '../src/read-aloud';

test('el lector conserva el texto de respuestas largas y elimina marcas y destinos Markdown', () => {
  assert.equal(
    speechText('# Resultado\n\n**Listo**: [informe](docs/informe.pdf).\n- Revisa `ventas.csv`.'),
    'Resultado Listo: informe. Revisa ventas.csv.',
  );
  const long = 'Esta es una respuesta larga que debe leerse entera. '.repeat(100).trim();
  const chunks = speechChunks(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 240));
  assert.equal(chunks.join(' '), long);
});
function fixture() {
  const spoken: SpeechSynthesisUtterance[] = [];
  let cancellations = 0;
  const voice = { name: 'Mónica', lang: 'es-ES', localService: true };
  const engine = {
    cancel() {
      cancellations++;
    },
    getVoices() {
      return [voice];
    },
    speak(utterance: SpeechSynthesisUtterance) {
      spoken.push(utterance);
    },
  } as unknown as SpeechSynthesis;
  const reader = new ResponseReader(
    () => engine,
    (text) => ({ text }) as SpeechSynthesisUtterance,
  );
  return { reader, spoken, voice, cancellations: () => cancellations };
}
test('solo se lee una respuesta: reemplazo, parada, finalización y eventos tardíos', () => {
  const { reader, spoken, voice, cancellations } = fixture();
  reader.start('first', 'Una frase. '.repeat(50));
  assert.equal(reader.getSnapshot().status, 'reading');
  assert.equal(spoken[0].voice, voice);
  spoken[0].onend?.({} as SpeechSynthesisEvent);
  assert.equal(spoken.length, 2);
  reader.start('second', 'Respuesta nueva.');
  assert.equal(cancellations(), 1);
  assert.equal(reader.getSnapshot().id, 'second');
  spoken[1].onend?.({} as SpeechSynthesisEvent);
  spoken[1].onerror?.({} as SpeechSynthesisErrorEvent);
  assert.equal(spoken.length, 3);
  assert.equal(reader.getSnapshot().id, 'second');
  reader.stop('first'); // Unmounting another response must not stop this one.
  assert.equal(reader.getSnapshot().status, 'reading');
  spoken[2].onend?.({} as SpeechSynthesisEvent);
  assert.equal(reader.getSnapshot().status, 'idle');
  reader.start('third', 'Otra respuesta.');
  reader.stop('third');
  assert.equal(reader.getSnapshot().status, 'idle');
  spoken[3].onend?.({} as SpeechSynthesisEvent);
  assert.equal(spoken.length, 4);
});
test('errores de voz se muestran y permiten volver a intentarlo', () => {
  const { reader, spoken } = fixture();
  reader.start('first', 'Hola');
  spoken[0].onerror?.({} as SpeechSynthesisErrorEvent);
  assert.equal(reader.getSnapshot().status, 'error');
  assert.ok(reader.getSnapshot().error);
  reader.start('first', 'Hola');
  assert.equal(reader.getSnapshot().status, 'reading');
});
