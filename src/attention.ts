import type { Approval, Session } from './shared';
import { lastTurnChanges, type TurnChanges } from './supervision';

export type AttentionKind = 'permission' | 'question' | 'error' | 'delivery' | 'completed';
export interface AttentionItem {
  session: Session;
  kind: AttentionKind;
  label: string;
  detail: string;
  /** Number of requests behind the first one, without duplicating the chat in the queue. */
  requests?: number;
  changes?: TurnChanges;
}

const line = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 220) : '';

function approvalItem(session: Session, approval: Approval): AttentionItem {
  const question =
    approval.tool === 'AskUserQuestion' || approval.method === 'item/tool/requestUserInput';
  const input = approval.input ?? approval.params;
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return {
    session,
    kind: question ? 'question' : 'permission',
    label: question ? 'Necesita tu respuesta' : 'Permiso pendiente',
    detail: question
      ? line(questions[0]?.question) || 'Abre el chat para responder.'
      : line(approval.title) ||
        line(approval.reason ?? approval.params.reason) ||
        line(input?.description) ||
        line(input?.command) ||
        line(approval.blockedPath ?? input?.file_path ?? input?.path) ||
        'Revisa la solicitud antes de continuar.',
    requests: session.approvals.length,
  };
}

/**
 * A review queue across providers. Only explicit runtime states create blockers;
 * completed replies must be newer than a known read position and the last user message.
 * Unknown read positions are treated as history, so opening the app does not create alerts.
 */
export function attentionItems(
  sessions: Session[],
  seen: Readonly<Record<string, number>>,
  unreadCompleted: ReadonlySet<string> = new Set(),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const session of sessions) {
    if (session.mode === 'terminal' || session.status === 'terminal') continue;
    if (session.approvals.length) {
      items.push(approvalItem(session, session.approvals[0]));
      continue;
    }
    if (session.status === 'waiting') {
      items.push({
        session,
        kind: 'question',
        label: 'Necesita tu respuesta',
        detail: line(session.activity) || 'Abre el chat para continuar.',
      });
      continue;
    }
    if (session.status === 'error' || session.error) {
      items.push({
        session,
        kind: 'error',
        label: 'Revisar error',
        detail: line(session.error) || 'El agente no pudo continuar.',
      });
      continue;
    }
    const failed = session.pendingInputs?.find((input) => input.status === 'failed');
    if (failed) {
      items.push({
        session,
        kind: 'delivery',
        label: 'Mensaje sin enviar',
        detail:
          line(failed.error) || line(failed.text) || 'Revisa el mensaje pendiente en el chat.',
      });
      continue;
    }
    if (session.status !== 'ready' && session.status !== 'stopped') continue;
    // A streaming reply may finish in the same message the user saw before leaving.
    // The host records that completion transition independently of message count.
    const read = unreadCompleted.has(session.id)
      ? 0
      : (seen[session.id] ?? session.messages.length);
    let lastUser = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === 'user') {
        lastUser = i;
        break;
      }
    }
    for (let i = session.messages.length - 1; i >= Math.max(read, lastUser + 1); i--) {
      const message = session.messages[i];
      if (message.role !== 'assistant' || message.kind === 'error') continue;
      const text = message.blocks
        ? message.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ')
        : message.text;
      if (!text.trim()) continue;
      items.push({
        session,
        kind: 'completed',
        label: 'Respuesta sin leer',
        detail: line(text),
        changes: lastTurnChanges(session),
      });
      break;
    }
  }
  const priority: Record<AttentionKind, number> = {
    permission: 0,
    question: 0,
    error: 1,
    delivery: 1,
    completed: 2,
  };
  // Stable ordering within each level keeps streaming updates from moving targets under a click.
  return items.sort((a, b) => priority[a.kind] - priority[b.kind]);
}

export const attentionPendingCount = (items: AttentionItem[]) =>
  items.filter((item) => item.kind !== 'completed').length;
