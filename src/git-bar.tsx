import React, { useEffect, useRef, useState } from 'react';
import { GitBranch, RefreshCw, ChevronDown, Check, Upload, Download } from 'lucide-react';
import type { GitOperation, GitSnapshot } from './git-types';
import { actionError } from './runtime';
import { ProjectMark } from './project-mark';

export function GitBar({
  project,
  state,
  error,
  expandedDiff,
  onDiff,
  refresh,
  compatible,
  locked,
}: {
  project: { id: string; name: string; path: string };
  state?: GitSnapshot;
  error: string;
  expandedDiff: boolean;
  onDiff: () => void;
  refresh: () => Promise<void>;
  compatible: boolean;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const run = async (operation: GitOperation, value?: string) => {
    if (inFlight.current || !compatible) return;
    inFlight.current = true;
    setBusy(operation);
    setFailure('');
    setNotice('');
    try {
      await window.desk.invoke({ type: 'gitOperation', projectId: project.id, operation, value });
      if (!mounted.current) return;
      if (operation === 'commit') setMessage('');
      if (operation === 'create') setBranch('');
      setNotice(
        {
          stage: 'Cambios preparados.',
          unstage: 'Cambios retirados de preparación.',
          commit: 'Commit creado.',
          fetch: 'Referencias remotas actualizadas.',
          pull: 'Cambios descargados.',
          push: 'Rama enviada al remoto.',
          switch: 'Rama cambiada.',
          create: 'Rama creada y seleccionada.',
        }[operation],
      );
    } catch (e) {
      if (mounted.current) setFailure(actionError(e));
    } finally {
      if (mounted.current) {
        await refresh();
        setBusy(undefined);
      }
      inFlight.current = false;
    }
  };
  const reload = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy('refresh');
    try {
      await refresh();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(undefined);
    }
  };
  const disabled = !!busy || !compatible || locked;
  const dirty = !!state?.files?.length;
  const counts = state?.counts;
  return (
    <div className="git-context">
      <div className="git-summary" aria-label="Resumen de cambios del proyecto">
        <button
          className="git-summary-project"
          aria-label="Cambios de Git"
          onClick={onDiff}
          aria-expanded={expandedDiff}
          title="Ver archivos y diferencias"
        >
          <ProjectMark identity={project.path} />
          <span>{project.name}</span>
        </button>
        <button
          className="git-branch-toggle"
          aria-label="Gestionar ramas y Git"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <GitBranch size={13} />
          <span>
            {error
              ? 'Error de Git'
              : !state
                ? 'Consultando…'
                : !state.repository
                  ? 'Sin repositorio Git'
                  : state.branch}
          </span>
          <ChevronDown size={12} />
        </button>
        {state?.repository && (
          <>
            <span className={`git-state-label ${counts?.conflicts ? 'has-conflicts' : ''}`}>
              {counts?.conflicts
                ? `${counts.conflicts} conflictos`
                : dirty
                  ? `${state.files.length} archivos`
                  : 'Sin cambios'}
            </span>
            {state.upstream && (
              <span
                className="git-sync-counts"
                title={`${state.upstream} · Según la última consulta del remoto`}
              >
                ↑{state.ahead ?? '—'} ↓{state.behind ?? '—'}
              </span>
            )}
            {state.lines && (
              <button
                className="git-summary-lines"
                onClick={onDiff}
                aria-label={`Ver cambios: ${state.lines.added} líneas añadidas y ${state.lines.removed} eliminadas`}
                title="Cambios preparados y sin preparar. No incluye archivos sin seguimiento ni binarios."
              >
                <span className="git-added">+{state.lines.added}</span>
                <span className="git-removed">−{state.lines.removed}</span>
              </button>
            )}
          </>
        )}
        <button
          aria-label="Actualizar estado de Git"
          title="Actualizar estado local"
          disabled={!!busy}
          onClick={() => void reload()}
        >
          <RefreshCw size={13} className={busy ? 'spinner' : ''} />
        </button>
      </div>
      {open && (
        <section className="git-workflow" aria-label="Flujo de Git">
          {error ? (
            <p role="alert">{error}</p>
          ) : !state ? (
            <p>Consultando Git…</p>
          ) : !state.repository ? (
            <p>
              Esta carpeta no pertenece a un repositorio Git. Abre un repositorio o inicialízalo
              desde la terminal.
            </p>
          ) : (
            <>
              {locked && (
                <p className="muted">Detén los agentes de este repositorio para modificar Git.</p>
              )}
              {!compatible && (
                <p className="muted">Actualiza la aplicación para activar estas acciones.</p>
              )}
              <section className="git-step">
                <h4>1 · Rama</h4>
                <div className="git-step-controls">
                  <select
                    aria-label="Rama local"
                    value={state.detached ? '' : state.branch}
                    disabled={disabled || dirty}
                    onChange={(e) => void run('switch', e.target.value)}
                  >
                    {state.detached && <option value="">{state.branch} · separado</option>}
                    {state.branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!disabled && !dirty && branch.trim()) void run('create', branch.trim());
                    }}
                  >
                    <input
                      aria-label="Nombre de nueva rama"
                      placeholder="Nueva rama…"
                      maxLength={200}
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      disabled={disabled || dirty}
                    />
                    <button disabled={disabled || dirty || !branch.trim()}>Crear rama</button>
                  </form>
                </div>
                {dirty && (
                  <p className="muted">Haz commit de los cambios antes de cambiar de rama.</p>
                )}
                {state.unborn && <p className="muted">Esta rama todavía no tiene commits.</p>}
              </section>
              <section className="git-step">
                <h4>2 · Cambios</h4>
                <p className="git-counts">
                  {counts?.staged ?? 0} preparados · {counts?.unstaged ?? 0} sin preparar ·{' '}
                  {counts?.untracked ?? 0} nuevos
                  {counts?.conflicts ? ` · ${counts.conflicts} conflictos` : ''}
                </p>
                <div className="git-step-controls">
                  <button disabled={disabled || !dirty} onClick={() => void run('stage')}>
                    Preparar todos
                  </button>
                  <button
                    disabled={disabled || !counts?.staged}
                    onClick={() => void run('unstage')}
                  >
                    Retirar preparados
                  </button>
                  <button onClick={onDiff}>Ver diferencias</button>
                </div>
                {!!counts?.conflicts && (
                  <p className="git-error">
                    Resuelve los conflictos en los archivos y prepara el resultado.
                  </p>
                )}
                {state.diffError && <p className="muted">{state.diffError}</p>}
                <ul className="git-file-list">
                  {state.files.map((file) => (
                    <li key={file.path}>
                      <code title={file.path}>{file.path}</code>
                      <span>
                        {file.conflict
                          ? 'Conflicto'
                          : file.index === '?'
                            ? 'Nuevo'
                            : `${file.index !== ' ' ? 'Preparado' : ''}${file.index !== ' ' && file.worktree !== ' ' ? ' · ' : ''}${file.worktree !== ' ' ? 'Modificado' : ''}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="git-step">
                <h4>3 · Commit</h4>
                <form
                  className="git-step-controls"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!disabled && counts?.staged && !counts.conflicts && message.trim())
                      void run('commit', message);
                  }}
                >
                  <input
                    aria-label="Mensaje del commit"
                    value={message}
                    maxLength={4000}
                    placeholder="Describe los cambios…"
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={disabled}
                  />
                  <button
                    disabled={disabled || !counts?.staged || !!counts?.conflicts || !message.trim()}
                  >
                    <Check size={13} /> Crear commit
                  </button>
                </form>
              </section>
              <section className="git-step">
                <h4>4 · Sincronización</h4>
                <p className="muted">
                  {state.upstream
                    ? `${state.upstream} · ${state.ahead ?? '—'} por subir · ${state.behind ?? '—'} por bajar`
                    : state.remote
                      ? `Sin publicar · remoto ${state.remote}`
                      : 'Sin remoto configurado.'}
                </p>
                <div className="git-step-controls">
                  <button
                    disabled={!!busy || !compatible || !state.remote}
                    onClick={() => void run('fetch')}
                  >
                    <RefreshCw size={13} /> Consultar remoto
                  </button>
                  <button
                    disabled={disabled || dirty || !state.upstream}
                    onClick={() => void run('pull')}
                    title="Descargar solo si puede avanzar sin fusionar"
                  >
                    <Download size={13} /> Bajar cambios
                  </button>
                  <button
                    disabled={
                      disabled ||
                      !state.remote ||
                      state.detached ||
                      state.unborn ||
                      !!counts?.conflicts
                    }
                    onClick={() => void run('push')}
                  >
                    <Upload size={13} /> {state.upstream ? 'Subir commits' : 'Publicar rama'}
                  </button>
                </div>
                <p className="muted">
                  Consulta el remoto para actualizar los contadores. No se fuerza la subida ni se
                  fusionan ramas automáticamente.
                </p>
              </section>
              {!!state.commits.length && (
                <details className="git-history">
                  <summary>Últimos commits</summary>
                  {state.commits.map((c) => (
                    <div key={c.hash}>
                      <code>{c.hash}</code> {c.subject}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          {busy && <p role="status">Operación de Git en curso…</p>}
          {failure && (
            <p className="git-error" role="alert">
              {failure}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </section>
      )}
    </div>
  );
}
