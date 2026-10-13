/** Read the response without speaking Markdown punctuation or link destinations. */
export function speechText(source: string) {
  return source
    .replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/!?\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|\s*$/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\|/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function speechChunks(text: string, size = 240) {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let end = rest.lastIndexOf(' ', size);
    if (end <= 0) end = size;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
type ReaderState = { id?: string; status: 'idle' | 'reading' | 'error'; error?: string };
const idle: ReaderState = { status: 'idle' };
export class ResponseReader {
  private state: ReaderState = idle;
  private listeners = new Set<() => void>();
  private generation = 0;
  private engine?: SpeechSynthesis;
  private utterance?: SpeechSynthesisUtterance;
  constructor(
    private getEngine = () => window.speechSynthesis,
    private createUtterance = (text: string) => new SpeechSynthesisUtterance(text),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: ReaderState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  stop(id?: string) {
    if (id && this.state.id !== id) return;
    this.generation++;
    this.utterance = undefined;
    this.engine?.cancel();
    this.update(idle);
  }
  start(id: string, source: string) {
    this.stop();
    const generation = this.generation;
    const fail = () => {
      if (this.generation !== generation) return;
      this.generation++;
      this.utterance = undefined;
      this.engine?.cancel();
      this.update({
        id,
        status: 'error',
        error: 'No se pudo leer la respuesta. Comprueba la voz del sistema y vuelve a intentarlo.',
      });
    };
    try {
      const engine = this.getEngine();
      if (!engine) {
        fail();
        return;
      }
      this.engine = engine;
      const chunks = speechChunks(speechText(source));
      if (!chunks.length) return;
      const voices = engine.getVoices().filter((voice) => voice.localService);
      const voice =
        voices.find((v) => v.lang === 'es-ES') ?? voices.find((v) => v.lang.startsWith('es'));
      let index = 0;
      const next = () => {
        if (this.generation !== generation) return;
        if (index === chunks.length) {
          this.utterance = undefined;
          this.update(idle);
          return;
        }
        try {
          const utterance = this.createUtterance(chunks[index++]);
          this.utterance = utterance; // Keep the native utterance alive until it finishes.
          utterance.lang = 'es-ES';
          if (voice) utterance.voice = voice;
          utterance.onend = next;
          utterance.onerror = fail;
          engine.speak(utterance);
        } catch {
          fail();
        }
      };
      this.update({ id, status: 'reading' });
      next();
    } catch {
      fail();
    }
  }
}
export const responseReader = new ResponseReader();
