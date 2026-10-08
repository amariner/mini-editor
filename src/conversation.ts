import type { Block, Message, Session } from './shared';

export type ConversationEntry =
  | { type: 'message'; id: string; message: Message }
  | {
      type: 'response';
      id: string;
      messages: Message[];
      pending: boolean;
      answer?: Message;
      work: Message[];
      steps: number;
      errors: number;
    };

export function working(session: Session) {
  return (
    ['starting', 'working', 'waiting', 'stopping'].includes(session.status) ||
    session.approvals.length > 0
  );
}
function toolCounts(blocks: Block[] = []): { steps: number; errors: number } {
  return blocks.reduce(
    (count, block) => {
      if (block.type !== 'tool_use') return count;
      const children = toolCounts(block.children);
      return {
        steps: count.steps + 1 + children.steps,
        errors: count.errors + Number(!!block.isError) + children.errors,
      };
    },
    { steps: 0, errors: 0 },
  );
}
// Codex items carry their own status (an exit code alone may be expected, like grep's 1).
const toolFailed = (m: Message) =>
  m.kind === 'error' || m.tool?.status === 'failed' || m.tool?.status === 'declined';
function response(
  messages: Message[],
  pending: boolean,
): Extract<ConversationEntry, { type: 'response' }> {
  // Projection only: original messages, tools and reasoning remain available in the log.
  let candidate = -1;
  let lastToolMessage = -1;
  let lastToolBlock = -1;
  messages.forEach((message, index) => {
    if (message.role === 'tool') {
      lastToolMessage = index;
      lastToolBlock = -1;
    }
    if (message.role !== 'assistant') return;
    if (message.blocks) {
      message.blocks.forEach((block, blockIndex) => {
        if (block.type === 'tool_use') {
          lastToolMessage = index;
          lastToolBlock = blockIndex;
        }
        if (block.type === 'text' && block.text.trim()) candidate = index;
      });
    } else if (message.text.trim()) candidate = index;
  });
  let answer: Message | undefined;
  const work = messages.flatMap((message, index) => {
    if (pending || index !== candidate || index < lastToolMessage) return [message];
    if (!message.blocks) {
      answer = message;
      return [];
    }
    const visible = message.blocks.filter(
      (block, i) =>
        block.type === 'text' &&
        block.text.trim() &&
        (index > lastToolMessage || i > lastToolBlock),
    );
    if (!visible.length) return [message];
    answer = { ...message, blocks: visible };
    const hidden = message.blocks.filter((block) => !visible.includes(block));
    return hidden.length ? [{ ...message, blocks: hidden }] : [];
  });
  const counts = messages.reduce(
    (count, message) => {
      const blocks = toolCounts(message.blocks);
      return {
        steps: count.steps + blocks.steps + Number(message.role === 'tool'),
        errors:
          count.errors + blocks.errors + Number(message.role === 'tool' && toolFailed(message)),
      };
    },
    { steps: 0, errors: 0 },
  );
  return { type: 'response', id: messages[0].id, messages, pending, answer, work, ...counts };
}
export function conversationEntries(session: Session): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  let batch: Message[] = [];
  const flush = (pending: boolean) => {
    if (batch.length) entries.push(response(batch, pending));
    batch = [];
  };
  for (const message of session.messages) {
    if (message.role === 'assistant' || message.role === 'tool') batch.push(message);
    else {
      flush(false);
      entries.push({ type: 'message', id: message.id, message });
    }
  }
  flush(['working', 'waiting'].includes(session.status) || session.approvals.length > 0);
  return entries;
}
export function currentActivity(session: Session) {
  const tail = conversationEntries(session).at(-1);
  return tail?.type === 'response' && tail.pending ? tail : undefined;
}
