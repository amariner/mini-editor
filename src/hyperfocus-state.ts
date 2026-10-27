import type { Session } from './shared';
import { conversationEntries } from './conversation';

/** A projection only: neither hidden history nor provider configuration is changed. */
export function hyperfocusTurn(session: Session) {
  let start = session.messages.length - 1;
  while (start >= 0 && session.messages[start].role !== 'user') start--;
  const user = start >= 0 ? session.messages[start] : undefined;
  // Until a turn finishes, text may still be commentary followed by tools.
  // Never substitute that commentary (or the previous turn's answer) for a final answer.
  const pending =
    ['starting', 'working', 'waiting', 'stopping'].includes(session.status) ||
    session.approvals.length > 0;
  const entries = pending
    ? []
    : conversationEntries({
        ...session,
        messages: session.messages.slice(Math.max(0, start + 1)),
      });
  const response = entries.reverse().find((entry) => entry.type === 'response' && entry.answer);
  const answer = response?.type === 'response' ? response.answer : undefined;
  return {
    user,
    pending,
    answer: answer?.blocks
      ? answer.blocks
          .flatMap((block) =>
            block.type === 'text' && block.text.trim() ? [block.text.trim()] : [],
          )
          .join('\n\n')
      : (answer?.text ?? ''),
  };
}
