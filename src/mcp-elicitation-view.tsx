import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import type { Action, Approval, Session } from './shared';
import {
  mcpElicitationFields,
  mcpElicitationResult,
  mcpElicitationUrl,
  type McpFormField,
} from './mcp-elicitation';

export function McpElicitation({
  approval,
  session,
  run,
  index = 0,
  total = 1,
}: {
  approval: Approval;
  session: Session;
  run: (action: Action) => Promise<any>;
  /** Position among the chat's pending requests, as in the permission cards. */
  index?: number;
  total?: number;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body)
      container.current
        ?.querySelector<HTMLElement>('input, select, button:not(:disabled)')
        ?.focus({ preventScroll: true });
  }, []);
  const params = approval.params;
  const answer = (key: string) => (Object.hasOwn(answers, key) ? answers[key] : '');
  let fields: McpFormField[] = [],
    url: string | undefined,
    unsupported = '';
  try {
    if (params.mode === 'url') url = mcpElicitationUrl(params);
    else fields = mcpElicitationFields(params);
  } catch (e) {
    unsupported = (e as Error).message;
  }
  let valid = !unsupported;
  try {
    mcpElicitationResult(params, 'accept', answers);
  } catch {
    valid = false;
  }
  const decide = async (decision: 'accept' | 'decline') => {
    setError('');
    setBusy(true);
    try {
      await run({
        type: 'approve',
        sessionId: session.id,
        requestId: approval.id,
        decision,
        answers: decision === 'accept' ? answers : undefined,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section ref={container} className="approval" aria-label="Solicitud MCP">
      <div className="approval-title">
        <ShieldAlert size={15} />
        <strong>{String(params.serverName || 'Un servidor MCP')} necesita tu respuesta</strong>
        {total > 1 && (
          <span className="approval-count">
            {index + 1} de {total}
          </span>
        )}
      </div>
      {params.message && <p>{String(params.message)}</p>}
      {unsupported && <p role="alert">{unsupported}</p>}
      {url ? (
        <>
          <p className="muted">
            Abre el servicio y completa los pasos que te solicite. Después vuelve a este chat.
          </p>
          <p style={{ overflowWrap: 'anywhere' }}>{url}</p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await run({
                  type: 'openMcpElicitation',
                  sessionId: session.id,
                  requestId: approval.id,
                });
                if (result?.ok) setOpened(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <ExternalLink size={14} />
            Abrir en el navegador
          </button>
        </>
      ) : (
        fields.map((field) => (
          <label className="field" key={field.key}>
            {field.title}
            {field.required ? ' *' : ''}
            {field.description && <small className="muted">{field.description}</small>}
            {field.type === 'boolean' ? (
              <select
                value={answer(field.key)}
                disabled={busy}
                onChange={(e) => setAnswers({ ...answers, [field.key]: e.target.value })}
              >
                <option value="">Selecciona una respuesta</option>
                <option value="true">Sí</option>
                <option value="false">No</option>
              </select>
            ) : field.options ? (
              <select
                multiple={field.type === 'array'}
                value={
                  field.type === 'array' ? JSON.parse(answer(field.key) || '[]') : answer(field.key)
                }
                disabled={busy}
                onChange={(e) =>
                  setAnswers({
                    ...answers,
                    [field.key]:
                      field.type === 'array'
                        ? JSON.stringify(Array.from(e.target.selectedOptions, (o) => o.value))
                        : e.target.value,
                  })
                }
              >
                {field.type !== 'array' && <option value="">Selecciona una respuesta</option>}
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={
                  field.type === 'number' || field.type === 'integer'
                    ? 'number'
                    : field.format === 'email'
                      ? 'email'
                      : field.format === 'date'
                        ? 'date'
                        : 'text'
                }
                step={field.type === 'integer' ? 1 : 'any'}
                min={field.minimum}
                max={field.maximum}
                minLength={field.minLength}
                maxLength={field.maxLength ?? 10000}
                required={field.required}
                value={answer(field.key)}
                disabled={busy}
                onChange={(e) => setAnswers({ ...answers, [field.key]: e.target.value })}
              />
            )}
          </label>
        ))
      )}
      {error && <p role="alert">{error}</p>}
      <div className="approval-actions">
        {!unsupported && (
          <button
            className="primary"
            disabled={busy || !valid || (!!url && !opened)}
            onClick={() => void decide('accept')}
          >
            {url
              ? 'He completado los pasos'
              : fields.length
                ? 'Enviar respuesta'
                : 'Permitir una vez'}
          </button>
        )}
        <button className="danger-ghost" disabled={busy} onClick={() => void decide('decline')}>
          Rechazar
        </button>
        <button
          className="quiet"
          onClick={() => void run({ type: 'interrupt', sessionId: session.id })}
        >
          Interrumpir
        </button>
      </div>
    </section>
  );
}
