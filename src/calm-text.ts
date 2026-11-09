import { useEffect, useRef, useState } from 'react';

export const SENTENCE_PAUSE = 450;
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
    // An unmatched mark never spans paragraphs: one stray "(" or "`" must not freeze the reply.
    brackets = 0;
    if (!line.trim()) inlineCode = emphasis = false;
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

/** Longest prefix of `text` that ends on a sentence boundary and fits within `limit`. */
function sentencePrefix(text: string, limit: number) {
  const ends = sentenceEnds(text, false).filter((end) => end <= limit);
  return text.slice(0, ends.at(-1) ?? 0);
}
/**
 * Streams complete sentences at a calm pace. Every complete sentence available at each beat
 * appears together, so the reply never falls behind the model; once the turn finishes the whole
 * text is shown at once — nothing stays hidden behind the animation.
 */
export function useCalmText(text: string, pending: boolean) {
  const [shown, setShown] = useState('');
  const nextAt = useRef(0);
  const visible = !pending
    ? text
    : text.startsWith(shown)
      ? shown
      : sentencePrefix(text, shown.length);
  useEffect(() => {
    if (!pending || visible === text) return;
    const end = sentenceEnds(text, false).at(-1);
    if (end === undefined || end <= visible.length) return;
    const timer = setTimeout(
      () => {
        setShown(text.slice(0, end));
        nextAt.current = Date.now() + SENTENCE_PAUSE;
      },
      Math.max(0, nextAt.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [text, pending, visible]);
  return { visible };
}
