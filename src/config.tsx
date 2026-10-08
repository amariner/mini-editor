import { CodexCatalogStatus } from './codex-catalog';
import React, { useState } from 'react';
import { X, Plus, Trash2, TerminalSquare, LogIn, RefreshCw } from 'lucide-react';
import type { ClaudeConfig, CodexConfig, Session } from './shared';
import {
  codexApprovals,
  codexSandboxes,
  defaultClaudeConfig,
  defaultCodexConfig,
  efforts,
  permissionModes,
} from './shared';
import type { Run } from './chat';
function Tiles<T extends string>({
  options,
  value,
  onChange,
  small,
}: {
  options: { id: T; name: string; hint?: string }[];
  value: T | undefined;
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`tiles ${small ? 'small' : ''}`}>
      {options.map((o) => (
        <button
          key={o.id}
          className={`tile ${o.id === value ? 'on' : ''}`}
          onClick={() => onChange(o.id)}
        >
          <span className="tile-title">{o.name}</span>
          {o.hint && <span className="tile-desc">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}
function TagList({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText('');
  };
  return (
    <div className="taglist">
      <div className="tags">
        {value.map((v) => (
          <span className="tag" key={v}>
            {v}
            <button
              aria-label={`Quitar ${v}`}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-add">
        <input
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button onClick={add} aria-label="Añadir">
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}
export function ConfigPanel({
  session,
  run,
  close,
  live,
  onLogin,
  onTerminal,
}: {
  session: Session;
  run: Run;
  close: () => void;
  live: boolean;
  onLogin: () => void;
  onTerminal: () => void;
}) {
  const c: ClaudeConfig = { ...defaultClaudeConfig, ...(session.config ?? {}) };
  const set = (patch: Partial<ClaudeConfig>) =>
    run({ type: 'configure', sessionId: session.id, config: patch });
  const info = session.info;
  const models = info?.models.length
    ? info.models.map((m) => ({ id: m.value, name: m.displayName, hint: m.description }))
    : [
        { id: 'default', name: 'Por defecto', hint: 'Recomendado por Claude Code.' },
        { id: 'opus', name: 'Opus' },
        { id: 'fable', name: 'Fable' },
        { id: 'sonnet', name: 'Sonnet' },
        { id: 'haiku', name: 'Haiku' },
      ];
  const number = (v: string) => (v.trim() ? Number(v) : undefined);
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <strong>Configuración</strong>
        <button aria-label="Cerrar configuración" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <div className="drawer-body">
        {session.notice && (
          <div className="notice">
            {session.notice}
            {live && (
              <button
                onClick={async () => {
                  await run({ type: 'stop', sessionId: session.id });
                  await run({ type: 'start', sessionId: session.id });
                }}
              >
                <RefreshCw size={13} />
                Reabrir ahora
              </button>
            )}
          </div>
        )}
        <section>
          <h4>Modelo</h4>
          <Tiles options={models} value={c.model} onChange={(model) => set({ model })} />
          <label className="field">
            Modelo de reserva si el principal está saturado
            <input
              placeholder="p. ej. sonnet"
              defaultValue={c.fallbackModel ?? ''}
              onBlur={(e) => set({ fallbackModel: e.target.value.trim() || undefined })}
            />
          </label>
        </section>
        <section>
          <h4>Permisos</h4>
          <Tiles
            options={permissionModes}
            value={c.permissionMode}
            onChange={(permissionMode) =>
              set({
                permissionMode,
                ...(permissionMode === 'bypassPermissions' ? { allowBypass: true } : {}),
              })
            }
          />
          <h5>Reglas de herramientas</h5>
          <TagList
            value={c.allowedTools}
            onChange={(allowedTools) => set({ allowedTools })}
            placeholder="Permitir siempre, p. ej. Bash(npm test) o Read"
          />
          <TagList
            value={c.disallowedTools}
            onChange={(disallowedTools) => set({ disallowedTools })}
            placeholder="Prohibir, p. ej. WebSearch o Bash(rm *)"
          />
          {info?.tools.length ? (
            <details className="tool-list">
              <summary>{info.tools.length} herramientas disponibles</summary>
              <div className="tags">
                {info.tools.map((t) => (
                  <button
                    key={t}
                    className={`tag ${c.disallowedTools.includes(t) ? 'off' : ''}`}
                    title={
                      c.disallowedTools.includes(t)
                        ? 'Volver a permitir'
                        : 'Prohibir en esta sesión'
                    }
                    onClick={() =>
                      set({
                        disallowedTools: c.disallowedTools.includes(t)
                          ? c.disallowedTools.filter((x) => x !== t)
                          : [...c.disallowedTools, t],
                      })
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
            </details>
          ) : null}
          <h5>Directorios adicionales</h5>
          <div className="tags">
            {c.additionalDirectories.map((d) => (
              <span className="tag" key={d} title={d}>
                {d.split('/').filter(Boolean).slice(-2).join('/')}
                <button
                  aria-label={`Quitar ${d}`}
                  onClick={() =>
                    set({ additionalDirectories: c.additionalDirectories.filter((x) => x !== d) })
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <button
              className="tag add"
              onClick={() => run({ type: 'chooseDirectory', sessionId: session.id })}
            >
              <Plus size={12} />
              Añadir carpeta
            </button>
          </div>
        </section>
        <section>
          <h4>Razonamiento</h4>
          <Tiles
            small
            options={[{ id: undefined as any, name: 'Auto' }, ...efforts]}
            value={c.effort}
            onChange={(effort) => set({ effort: (effort as any) ?? undefined })}
          />
          <Tiles
            small
            options={[
              { id: 'adaptive', name: 'Adaptativo' },
              { id: 'enabled', name: 'Con presupuesto' },
              { id: 'disabled', name: 'Desactivado' },
            ]}
            value={c.thinking}
            onChange={(thinking) => set({ thinking })}
          />
          {c.thinking === 'enabled' && (
            <label className="field">
              Presupuesto de tokens de razonamiento
              <input
                type="number"
                min={1024}
                defaultValue={c.thinkingBudget ?? 8000}
                onBlur={(e) => set({ thinkingBudget: number(e.target.value) ?? 8000 })}
              />
            </label>
          )}
          <label className="switch">
            <input
              type="checkbox"
              checked={c.thinkingDisplay === 'summarized'}
              onChange={(e) =>
                set({ thinkingDisplay: e.target.checked ? 'summarized' : 'omitted' })
              }
            />
            Mostrar resumen del razonamiento
          </label>
        </section>
        <section>
          <h4>Límites</h4>
          <div className="two">
            <label className="field">
              Máximo de turnos
              <input
                type="number"
                min={1}
                placeholder="Sin límite"
                defaultValue={c.maxTurns ?? ''}
                onBlur={(e) => set({ maxTurns: number(e.target.value) })}
              />
            </label>
            <label className="field">
              Presupuesto (USD)
              <input
                type="number"
                min={0.01}
                step={0.5}
                placeholder="Sin límite"
                defaultValue={c.maxBudgetUsd ?? ''}
                onBlur={(e) => set({ maxBudgetUsd: number(e.target.value) })}
              />
            </label>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={c.fileCheckpointing}
              onChange={(e) => set({ fileCheckpointing: e.target.checked })}
            />
            Puntos de control de archivos
            <small>Guarda copias para poder deshacer cambios desde Claude Code.</small>
          </label>
        </section>
        <section>
          <h4>Instrucciones</h4>
          <textarea
            placeholder="Se añaden al prompt de sistema de Claude Code para esta sesión…"
            defaultValue={c.appendSystemPrompt}
            onBlur={(e) => set({ appendSystemPrompt: e.target.value })}
          />
          <h5>Fuentes de ajustes de Claude Code</h5>
          <div className="tiles small">
            {(
              [
                ['user', 'Usuario (perfil)'],
                ['project', 'Proyecto (.claude/settings.json)'],
                ['local', 'Local (settings.local.json)'],
              ] as const
            ).map(([id, name]) => (
              <button
                key={id}
                className={`tile ${c.settingSources.includes(id) ? 'on' : ''}`}
                onClick={() =>
                  set({
                    settingSources: c.settingSources.includes(id)
                      ? c.settingSources.filter((x) => x !== id)
                      : [...c.settingSources, id],
                  })
                }
              >
                <span className="tile-title">{name}</span>
              </button>
            ))}
          </div>
          <small className="muted">
            Las fuentes de proyecto pueden definir hooks, permisos y proveedores. El perfil se
            mantiene aislado en cualquier caso.
          </small>
        </section>
        <section>
          <h4>Entorno</h4>
          <dl className="facts">
            <dt>Cuenta</dt>
            <dd>{session.account ?? 'Sin conectar'}</dd>
            <dt>Claude Code</dt>
            <dd>{info?.version ?? '—'}</dd>
            <dt>Sesión</dt>
            <dd className="mono">{session.reference}</dd>
            <dt>Estilo de salida</dt>
            <dd>{info?.outputStyle ?? '—'}</dd>
            <dt>Skills</dt>
            <dd>{info?.skills.length ? info.skills.join(', ') : '—'}</dd>
            <dt>Plugins</dt>
            <dd>{info?.plugins.length ? info.plugins.join(', ') : '—'}</dd>
            <dt>Agentes</dt>
            <dd>{info?.agents.length ? info.agents.join(', ') : '—'}</dd>
          </dl>
          <h5>Servidores MCP</h5>
          {info?.mcpServers.length ? (
            <ul className="mcp">
              {info.mcpServers.map((m) => (
                <li key={m.name}>
                  <i className={`dot ${m.status}`} />
                  <span>{m.name}</span>
                  <small>
                    {m.status}
                    {m.tools ? ` · ${m.tools} herramientas` : ''}
                    {m.error ? ` · ${m.error}` : ''}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <small className="muted">
              Se configuran en el perfil aislado con la CLI oficial (claude mcp add).
            </small>
          )}
          <div className="drawer-actions">
            <button onClick={onLogin}>
              <LogIn size={14} />
              Gestionar cuenta en Ajustes
            </button>
            <button onClick={onTerminal}>
              <TerminalSquare size={14} />
              Terminal oficial
            </button>
            <button
              className="danger-ghost"
              onClick={() =>
                set({
                  ...defaultClaudeConfig,
                  model: c.model,
                })
              }
            >
              <Trash2 size={14} />
              Restablecer
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}
export function CodexConfigPanel({
  session,
  run,
  close,
  live,
}: {
  session: Session;
  run: Run;
  close: () => void;
  live: boolean;
}) {
  const c: CodexConfig = { ...defaultCodexConfig, ...(session.codexConfig ?? {}) };
  const set = (patch: Partial<CodexConfig>) =>
    run({ type: 'configureCodex', sessionId: session.id, config: patch });
  const models = session.info?.models ?? [];
  const current = models.find((m) => (c.model === 'default' ? m.isDefault : m.value === c.model));
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <strong>Configuración de Codex</strong>
        <button aria-label="Cerrar configuración" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <div className="drawer-body">
        {session.notice && (
          <div className="notice">
            {session.notice}
            {live && (
              <button
                onClick={async () => {
                  await run({ type: 'stop', sessionId: session.id });
                  await run({ type: 'start', sessionId: session.id });
                }}
              >
                <RefreshCw size={13} />
                Reabrir ahora
              </button>
            )}
          </div>
        )}
        <section>
          <h4>Modelo</h4>
          <Tiles
            options={[
              { id: 'default', name: 'Por defecto', hint: 'El de tu cuenta de ChatGPT.' },
              ...models.map((m) => ({ id: m.value, name: m.displayName, hint: m.description })),
            ]}
            value={c.model}
            onChange={(model) => set({ model, effort: undefined })}
          />
          <CodexCatalogStatus session={session} run={run} />
          {current?.supportedEffortLevels?.length ? (
            <>
              <h5>Esfuerzo de razonamiento</h5>
              <Tiles
                small
                options={[
                  { id: undefined as any, name: 'Por defecto' },
                  ...current.supportedEffortLevels.map((e) => ({ id: e, name: e })),
                ]}
                value={c.effort}
                onChange={(effort) => set({ effort: (effort as any) ?? undefined })}
              />
            </>
          ) : null}
        </section>
        <section>
          <h4>Aprobaciones</h4>
          <Tiles
            options={codexApprovals}
            value={c.approvalPolicy}
            onChange={(approvalPolicy) => set({ approvalPolicy })}
          />
          <h5>Sandbox</h5>
          <Tiles
            options={codexSandboxes}
            value={c.sandbox}
            onChange={(sandbox) => set({ sandbox })}
          />
          {c.sandbox === 'danger-full-access' && c.approvalPolicy === 'never' && (
            <small className="muted warn">
              Sin sandbox y sin aprobaciones: Codex puede ejecutar cualquier acción en tu equipo.
            </small>
          )}
        </section>
        <section>
          <h4>Estilo</h4>
          <Tiles
            small
            options={[
              { id: 'none', name: 'Neutro' },
              { id: 'friendly', name: 'Cercano' },
              { id: 'pragmatic', name: 'Pragmático' },
            ]}
            value={c.personality}
            onChange={(personality) => set({ personality })}
          />
          <h5>Instrucciones del desarrollador</h5>
          <textarea
            placeholder="Instrucciones adicionales para el hilo de Codex…"
            defaultValue={c.developerInstructions}
            onBlur={(e) => set({ developerInstructions: e.target.value })}
          />
        </section>
        <section>
          <h4>Entorno</h4>
          <dl className="facts">
            <dt>Cuenta</dt>
            <dd>{session.account ?? 'Sin conectar'}</dd>
            <dt>Hilo</dt>
            <dd className="mono">{session.reference ?? '—'}</dd>
            <dt>Proveedor</dt>
            <dd>OpenAI · ChatGPT</dd>
          </dl>
          <div className="drawer-actions">
            {!session.account && live && (
              <button onClick={() => run({ type: 'login', sessionId: session.id })}>
                <LogIn size={14} />
                Gestionar cuenta en Ajustes
              </button>
            )}
            <button className="danger-ghost" onClick={() => set({ ...defaultCodexConfig })}>
              <Trash2 size={14} />
              Restablecer
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}
