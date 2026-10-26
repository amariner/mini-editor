import { useEffect, useRef, useState } from 'react';

export const SENTENCE_PAUSE = 1200;
const segmenter = new Intl.Segmenter('es', { granularity: 'sentence' });

// Keep Markdown structures whole: code, links and emphasis must not flash unfinished.
export function sentenceEnds(text: string, finished: boolean): number[] {
  const ends: number[] = [];
  let fence = '';
  let offset = 0;
  let inlineCode = false;
  let brackets = 0;
  let emphasis = false;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) {
        fence = '';
        ends.push(offset + line.length);
      }
      offset += line.length;
      continue;
    }
    if (!fence) {
      for (const part of segmenter.segment(line.replace(/[*_~`]/g, ' '))) {
        const value = line.slice(part.index, part.index + part.segment.length);
        for (let i = 0; i < value.length; i++) {
          if (value[i] === '\\') {
            i++;
            continue;
          }
          if (value[i] === '`') inlineCode = !inlineCode;
          if (inlineCode) continue;
          if (value[i] === '[' || value[i] === '(') brackets++;
          if (value[i] === ']' || value[i] === ')') brackets = Math.max(0, brackets - 1);
          if (value.slice(i, i + 2) === '**') {
            emphasis = !emphasis;
            i++;
          }
        }
        if (
          !inlineCode &&
          !brackets &&
          !emphasis &&
          /(?:[.!?。！？][”’"')\]*_]*\s*|\n)$/.test(value)
        )
          ends.push(offset + part.index + value.length);
      }
    }
    offset += line.length;
  }
  if (finished && ends.at(-1) !== text.length) ends.push(text.length);
  return ends.filter((end) => end > 0);
}

export function useCalmText(text: string, pending: boolean) {
  const [shown, setShown] = useState('');
  const [immediate, setImmediate] = useState(false);
  const nextAt = useRef(Date.now() + SENTENCE_PAUSE);
  const finalAt = useRef<number | undefined>(undefined);
  const visible = text.startsWith(shown)
    ? shown
    : text.startsWith(shown.trimEnd())
      ? shown.trimEnd()
      : '';
  useEffect(() => {
    if (pending) finalAt.current = undefined;
    else finalAt.current ??= Date.now();
    if (immediate || visible === text) return;
    const end = sentenceEnds(text, !pending).find((end) => end > visible.length);
    if (end === undefined) return;
    const timer = setTimeout(
      () => {
        // Long completed answers remain accessible without a lengthy playback queue.
        const flush = !pending && Date.now() - finalAt.current! >= 4800;
        setShown(text.slice(0, flush ? text.length : end));
        nextAt.current = Date.now() + SENTENCE_PAUSE;
      },
      Math.max(0, nextAt.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [text, pending, visible, immediate]);
  return { visible: immediate ? text : visible, reveal: () => setImmediate(true) };
}
