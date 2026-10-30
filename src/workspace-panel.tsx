import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  File,
  FileCode,
  FileDiff,
  Folder,
  FolderOpen,
  Info,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Search,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import type { Action, Session } from './shared';
import type { GitSnapshot } from './git-types';
import type {
  WorkspaceFilesResult,
  WorkspaceFileResult,
  WorkspaceDiffResult,
} from './workspace-files';
import { actionError } from './runtime';
import { navigateTabs } from './tab-keyboard';
import { highlight } from './highlight';
import { parseWorkspaceDiff } from './workspace-diff';

export type WorkspacePanelView = 'details' | 'files' | 'changes';
export type WorkspaceView = WorkspacePanelView;
type Resource<T> = { scope: string; key: string; data?: T; error?: string; loading: boolean };
const basename = (path: string) => path.split('/').at(-1) || path;
const dirname = (path: string) => path.split('/').slice(0, -1).join('/');
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
    : `${(bytes / (bytes < 1024 ** 2 ? 1024 : 1024 ** 2)).toLocaleString('es-ES', { maximumFractionDigits: 1 })} ${bytes < 1024 ** 2 ? 'KB' : 'MB'}`;
const isStaged = (file: GitSnapshot['files'][number]) => ![' ', '?'].includes(file.index);
const isUnstaged = (file: GitSnapshot['files'][number]) =>
  file.conflict || file.index === '?' || ![' ', '?'].includes(file.worktree);
const stateLabel = (file: GitSnapshot['files'][number], staged: boolean) => {
  if (file.conflict) return 'Conflicto';
  const code = staged ? file.index : file.index === '?' ? '?' : file.worktree;
  return (
    (
      {
        '?': 'Nuevo',
        A: 'Nuevo',
        D: 'Eliminado',
        M: 'Modificado',
        R: 'Renombrado',
        C: 'Copiado',
        T: 'Tipo cambiado',
      } as Record<string, string>
    )[code] ?? 'Cambio'
  );
};

const stateCode = (file: GitSnapshot['files'][number], staged: boolean) =>
  file.conflict ? '!' : staged ? file.index : file.index === '?' ? 'A' : file.worktree;
const stateTone = (code: string) =>
  code === '!' ? 'conflict' : code === 'A' ? 'added' : code === 'D' ? 'deleted' : '';

/** Ellipsis at the start: a long path still shows its file name and copies as one line. */
function PathLabel({ path }: { path: string }) {
  const folder = dirname(path);
  return (
    <span className="workspace-path" dir="rtl" title={path}>
      <bdi dir="ltr">
        {folder && <span>{folder}/</span>}
        <strong>{basename(path)}</strong>
      </bdi>
    </span>
  );
}

// Memoized: Git polling re-renders the panel, never the highlighted lines.
const TextContent = React.memo(function TextContent({ file }: { file: WorkspaceFileResult }) {
  const lines = useMemo(() => file.content.split('\n'), [file.content]);
  const [limit, setLimit] = useState(1000);
  const language = file.language ?? file.path.split('.').at(-1) ?? '';
  if (file.binary)
    return (
      <div className="workspace-panel-empty">
        <File size={26} />
        <strong>Archivo binario</strong>
        <p>Ábrelo en su aplicación para ver el contenido.</p>
      </div>
    );
  return (
    <>
      {file.truncated && (
        <p className="workspace-panel-notice" role="status">
          Vista parcial: este archivo supera el límite de lectura.
        </p>
      )}
      <div
        className="workspace-code"
        role="region"
        aria-label={`Contenido de ${file.path}`}
        tabIndex={0}
      >
        <table>
          <tbody>
            {lines.slice(0, limit).map((line, index) => (
              <tr key={index}>
                <td className="workspace-line-number" aria-hidden="true">
                  {index + 1}
                </td>
                <td className="workspace-line-code">
                  <code>
                    {file.content.length <= 24000 ? highlight(line, language) : line || ' '}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length > limit && (
        <button className="workspace-load-more" onClick={() => setLimit((value) => value + 1000)}>
          Mostrar más líneas ({limit} de {lines.length})
        </button>
      )}
    </>
  );
});

const DiffContent = React.memo(function DiffContent({ diff }: { diff: WorkspaceDiffResult }) {
  const lines = useMemo(
    () =>
      parseWorkspaceDiff(diff.patch).filter(
        (line) => line.kind !== 'meta' || !/^(diff --git |index |--- |\+\+\+ )/.test(line.text),
      ),
    [diff.patch],
  );
  const [limit, setLimit] = useState(1000);
  if (diff.binary)
    return (
      <div className="workspace-panel-empty">
        <FileDiff size={26} />
        <strong>Cambio binario</strong>
        <p>Git registra el cambio, pero no hay una comparación de texto.</p>
      </div>
    );
  if (!diff.patch)
    return (
      <div className="workspace-panel-empty">
        <Check size={24} />
        <p>Sin diferencias en esta selección.</p>
      </div>
    );
  return (
    <>
      {diff.truncated && (
        <p className="workspace-panel-notice" role="status">
          Diff parcial: el archivo supera el límite de visualización.
        </p>
      )}
      <div
        className="workspace-code workspace-diff"
        role="region"
        aria-label={`Cambios de ${diff.path}`}
        tabIndex={0}
      >
        <table>
          <tbody>
            {lines.slice(0, limit).map((line, index) => (
              <tr key={index} className={`workspace-diff-${line.kind}`}>
                <td className="workspace-line-number" aria-hidden="true">
                  {line.before ?? ''}
                </td>
                <td className="workspace-line-number" aria-hidden="true">
                  {line.after ?? ''}
                </td>
                <td
                  className="workspace-diff-sign"
                  aria-label={
                    line.kind === 'added'
                      ? 'Añadida'
                      : line.kind === 'removed'
                        ? 'Eliminada'
                        : undefined
                  }
                >
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
                </td>
                <td className="workspace-line-code">
                  <code>{line.text || ' '}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length > limit && (
        <button className="workspace-load-more" onClick={() => setLimit((value) => value + 1000)}>
          Mostrar más líneas ({limit} de {lines.length})
        </button>
      )}
    </>
  );
});

export function WorkspacePanel({
  project,
  session,
  git,
  gitError,
  view,
  onViewChange,
  onClose,
  onRefresh,
  openFile,
  onOpenExternal,
  invoke,
  disabled = false,
  details,
}: {
  project: { id: string; name: string; path: string };
  session?: Session;
  git?: GitSnapshot;
  gitError?: string;
  view: WorkspacePanelView;
  onViewChange: (view: WorkspacePanelView) => void;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  openFile?: { path: string; key: number };
  onOpenExternal: (path: string) => void;
  invoke: (action: Action) => Promise<any>;
  disabled?: boolean;
  details?: React.ReactNode;
}) {
  const id = useId();
  const scope = `${project.id}:${session?.id ?? ''}:${session?.worktree?.cwd ?? project.path}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const api = useRef(invoke);
  api.current = invoke;
  const [directory, setDirectory] = useState('');
  const [selectionScope, setSelectionScope] = useState(scope);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [selectedDiff, setSelectedDiff] = useState('');
  const [staged, setStaged] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState<Resource<WorkspaceFilesResult>>();
  const [file, setFile] = useState<Resource<WorkspaceFileResult>>();
  const [diff, setDiff] = useState<Resource<WorkspaceDiffResult>>();
  const [mutation, setMutation] = useState(false);
  const [message, setMessage] = useState('');
  const [mutationError, setMutationError] = useState('');
  const mutationBusy = useRef(false);
  const base = { projectId: project.id, ...(session ? { sessionId: session.id } : {}) };
  const latestBase = useRef(base);
  latestBase.current = base;

  useEffect(() => {
    setSelectionScope(scope);
    setDirectory('');
    setQuery('');
    setSearch('');
    setSelectedFile('');
    setSelectedDiff('');
    setListing(undefined);
    setFile(undefined);
    setDiff(undefined);
    setMessage('');
    setMutationError('');
  }, [scope]);
  useEffect(() => {
    if (!openFile?.path) return;
    setSelectedFile(openFile.path);
    setQuery('');
    setSearch('');
  }, [scope, openFile?.key, openFile?.path]);
  // The dock switches views without the panel's own tabs: a filter never leaks between views.
  useEffect(() => {
    setQuery('');
    setSearch('');
    setMutationError('');
  }, [view]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const listingKey = `${directory}:${search}`;
  useEffect(() => {
    if (selectionScope !== scope || view !== 'files' || disabled) return;
    let cancelled = false;
    setListing((previous) => ({
      scope,
      key: listingKey,
      data: previous?.scope === scope && previous.key === listingKey ? previous.data : undefined,
      loading: true,
    }));
    api.current({ type: 'workspaceFiles', ...latestBase.current, directory, query: search }).then(
      (data: WorkspaceFilesResult) => {
        if (!cancelled && currentScope.current === scope)
          setListing({ scope, key: listingKey, data, loading: false });
      },
      (error) => {
        if (!cancelled && currentScope.current === scope)
          setListing({ scope, key: listingKey, loading: false, error: actionError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, selectionScope, view, directory, search, refresh, disabled]);

  useEffect(() => {
    if (selectionScope !== scope || view !== 'files' || !selectedFile || disabled) return;
    let cancelled = false;
    setFile((previous) => ({
      scope,
      key: selectedFile,
      data: previous?.scope === scope && previous.key === selectedFile ? previous.data : undefined,
      loading: true,
    }));
    api.current({ type: 'workspaceFile', ...latestBase.current, path: selectedFile }).then(
      (data: WorkspaceFileResult) => {
        if (!cancelled && currentScope.current === scope)
          setFile({ scope, key: selectedFile, data, loading: false });
      },
      (error) => {
        if (!cancelled && currentScope.current === scope)
          setFile({ scope, key: selectedFile, loading: false, error: actionError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, selectionScope, view, selectedFile, refresh, disabled]);

  const changedFiles = useMemo(
    () => (git?.files ?? []).filter(staged ? isStaged : isUnstaged),
    [git?.files, staged],
  );
  const visibleChanges = useMemo(
    () =>
      changedFiles.filter((entry) =>
        entry.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [changedFiles, query],
  );
  const activeDiffPath = changedFiles.some((entry) => entry.path === selectedDiff)
    ? selectedDiff
    : (visibleChanges[0]?.path ?? changedFiles[0]?.path ?? '');
  const diffKey = `${staged}:${activeDiffPath}`;
  useEffect(() => {
    if (selectionScope !== scope || view !== 'changes' || !activeDiffPath || disabled) return;
    let cancelled = false;
    setDiff((previous) => ({
      scope,
      key: diffKey,
      data: previous?.scope === scope && previous.key === diffKey ? previous.data : undefined,
      loading: true,
    }));
    api
      .current({ type: 'workspaceDiff', ...latestBase.current, path: activeDiffPath, staged })
      .then(
        (data: WorkspaceDiffResult) => {
          if (!cancelled && currentScope.current === scope)
            setDiff({ scope, key: diffKey, data, loading: false });
        },
        (error) => {
          if (!cancelled && currentScope.current === scope)
            setDiff({ scope, key: diffKey, loading: false, error: actionError(error) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [scope, selectionScope, view, activeDiffPath, staged, refresh, git, disabled]);

  const listState = listing?.scope === scope && listing.key === listingKey ? listing : undefined;
  const fileState = file?.scope === scope && file.key === selectedFile ? file : undefined;
  const diffState = diff?.scope === scope && diff.key === diffKey ? diff : undefined;
  const selectedChange = changedFiles.find((entry) => entry.path === activeDiffPath);
  const displayPath = view === 'files' ? (fileState?.data?.path ?? selectedFile) : activeDiffPath;
  const resource = view === 'files' ? fileState : diffState;
  const refreshAll = async () => {
    setRefresh((value) => value + 1);
    setMutationError('');
    try {
      await onRefresh();
    } catch (error) {
      setMutationError(actionError(error));
    }
  };
  const prepare = async () => {
    if (!activeDiffPath || disabled || mutationBusy.current) return;
    mutationBusy.current = true;
    setMutation(true);
    setMutationError('');
    setMessage('');
    const capturedScope = scope;
    try {
      await api.current({
        type: 'workspaceStage',
        ...latestBase.current,
        path: activeDiffPath,
        staged: !staged,
      });
      if (currentScope.current !== capturedScope) return;
      setMessage(staged ? 'Archivo quitado de preparados.' : 'Archivo preparado.');
      setRefresh((value) => value + 1);
      await onRefresh();
    } catch (error) {
      if (currentScope.current === capturedScope) setMutationError(actionError(error));
    } finally {
      mutationBusy.current = false;
      setMutation(false);
    }
  };
  const switchView = (next: WorkspacePanelView) => {
    setQuery('');
    setSearch('');
    setMutationError('');
    onViewChange(next);
  };
  const contentId = `${id}-content`;
  const root = listState?.data?.root ?? session?.worktree?.cwd ?? project.path;
  return (
    <section
      className={`workspace-panel ${view === 'changes' ? 'diff-panel' : ''}`}
      aria-label="Panel de trabajo"
    >
      <header className="workspace-panel-header">
        <div
          className="workspace-panel-tabs"
          role="tablist"
          aria-label="Vistas del panel de trabajo"
        >
          {(
            [
              ['details', 'Detalles', Info],
              ['files', 'Archivos', FolderOpen],
              ['changes', 'Cambios', FileDiff],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              id={`${id}-${value}`}
              role="tab"
              aria-selected={view === value}
              aria-controls={contentId}
              tabIndex={view === value ? 0 : -1}
              onKeyDown={navigateTabs}
              onClick={() => switchView(value)}
            >
              <Icon size={14} />
              <span>{label}</span>
              {value === 'changes' && !!git?.files?.length && <small>{git.files.length}</small>}
            </button>
          ))}
        </div>
        <button
          className="workspace-panel-icon"
          aria-label="Cerrar panel de trabajo"
          title="Cerrar panel"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div
        id={contentId}
        role="tabpanel"
        aria-labelledby={`${id}-${view}`}
        className="workspace-panel-content"
      >
        {view === 'details' ? (
          <div className="workspace-panel-details">
            {details ?? (
              <div className="workspace-panel-empty">
                <Info size={24} />
                <p>Abre un chat para ver sus detalles.</p>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="workspace-panel-toolbar">
              {view === 'changes' ? (
                <select
                  aria-label="Cambios a revisar"
                  value={staged ? 'staged' : 'unstaged'}
                  onChange={(event) => {
                    setStaged(event.target.value === 'staged');
                    setSelectedDiff('');
                    setMessage('');
                  }}
                >
                  <option value="unstaged">
                    Sin preparar · {(git?.files ?? []).filter(isUnstaged).length}
                  </option>
                  <option value="staged">
                    Preparados · {(git?.files ?? []).filter(isStaged).length}
                  </option>
                </select>
              ) : (
                <span className="workspace-panel-location" title={root}>
                  <Folder size={13} />
                  {project.name}
                </span>
              )}
              {view === 'changes' && git?.branch && (
                <span className="workspace-panel-branch" title={git.branch}>
                  {git.branch}
                </span>
              )}
              <button
                className="workspace-panel-icon"
                disabled={disabled || mutation}
                aria-label="Actualizar archivos y cambios"
                title="Actualizar"
                onClick={() => void refreshAll()}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            {disabled ? (
              <div className="workspace-panel-empty">
                <p>Actualiza la aplicación para usar el panel de archivos.</p>
              </div>
            ) : view === 'changes' && gitError ? (
              <div className="workspace-panel-empty" role="alert">
                <p>{gitError}</p>
                <button onClick={() => void refreshAll()}>Reintentar</button>
              </div>
            ) : view === 'changes' && !git ? (
              <div className="workspace-panel-empty" role="status">
                <LoaderCircle className="workspace-panel-spinner" size={20} />
                <p>Consultando cambios…</p>
              </div>
            ) : view === 'changes' && !git?.repository ? (
              <div className="workspace-panel-empty">
                <FolderOpen size={24} />
                <p>Esta carpeta no usa Git.</p>
                <button onClick={() => switchView('files')}>Ver archivos</button>
              </div>
            ) : (
              <>
                <div className="workspace-panel-body">
                  <nav
                    className="workspace-file-list"
                    aria-label={view === 'files' ? 'Archivos del proyecto' : 'Archivos cambiados'}
                  >
                    <label className="workspace-file-search">
                      <Search size={13} />
                      <input
                        aria-label={
                          view === 'files' ? 'Buscar archivos' : 'Filtrar archivos cambiados'
                        }
                        placeholder={view === 'files' ? 'Buscar archivos…' : 'Filtrar archivos…'}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                      {query && (
                        <button
                          className="workspace-panel-icon"
                          aria-label="Limpiar búsqueda de archivos"
                          onClick={() => setQuery('')}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </label>
                    {view === 'files' && directory && !query && (
                      <button
                        className="workspace-directory-up"
                        onClick={() => setDirectory(dirname(directory))}
                        title={directory}
                      >
                        <ArrowLeft size={13} />
                        <span>{basename(directory)}</span>
                      </button>
                    )}
                    <div className="workspace-file-rows">
                      {view === 'files' ? (
                        <>
                          {listState?.loading && (
                            <p className="workspace-list-note" role="status">
                              Cargando archivos…
                            </p>
                          )}
                          {listState?.error && (
                            <div className="workspace-list-note" role="alert">
                              <p>{listState.error}</p>
                              <button onClick={() => setRefresh((value) => value + 1)}>
                                Reintentar
                              </button>
                            </div>
                          )}
                          {listState?.data?.entries.map((entry) => (
                            <button
                              key={entry.path}
                              className={`workspace-file-row ${entry.kind === 'file' && selectedFile === entry.path ? 'selected' : ''}`}
                              aria-current={
                                entry.kind === 'file' && selectedFile === entry.path
                                  ? 'true'
                                  : undefined
                              }
                              title={entry.path}
                              onClick={() => {
                                if (entry.kind === 'directory') {
                                  setDirectory(entry.path);
                                  setQuery('');
                                  setSearch('');
                                } else setSelectedFile(entry.path);
                              }}
                            >
                              {entry.kind === 'directory' ? (
                                <Folder size={14} />
                              ) : (
                                <FileCode size={14} />
                              )}
                              <span>
                                {entry.name}
                                {query && dirname(entry.path) && (
                                  <small>{dirname(entry.path)}</small>
                                )}
                              </span>
                              {entry.kind === 'directory' && <ChevronRight size={12} />}
                            </button>
                          ))}
                          {!listState?.loading &&
                            !listState?.error &&
                            !listState?.data?.entries.length && (
                              <p className="workspace-list-note">
                                {query ? 'No se encontraron archivos.' : 'Carpeta vacía.'}
                              </p>
                            )}
                          {listState?.data?.truncated && (
                            <p className="workspace-list-note">
                              Hay más archivos. Afina la búsqueda.
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          {visibleChanges.map((entry) => (
                            <button
                              key={entry.path}
                              className={`workspace-file-row ${activeDiffPath === entry.path ? 'selected' : ''} ${entry.conflict ? 'conflict' : ''}`}
                              aria-current={activeDiffPath === entry.path ? 'true' : undefined}
                              title={`${entry.path} · ${stateLabel(entry, staged)}`}
                              onClick={() => setSelectedDiff(entry.path)}
                            >
                              <FileDiff size={14} />
                              <span>
                                {basename(entry.path)}
                                <small>{dirname(entry.path)}</small>
                              </span>
                              <em
                                className={stateTone(stateCode(entry, staged))}
                                aria-label={stateLabel(entry, staged)}
                              >
                                {stateCode(entry, staged)}
                              </em>
                            </button>
                          ))}
                          {!visibleChanges.length && (
                            <p className="workspace-list-note">
                              {query
                                ? 'No hay coincidencias.'
                                : staged
                                  ? 'Nada preparado.'
                                  : 'No hay cambios sin preparar.'}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </nav>
                  <div className="workspace-file-viewer">
                    {displayPath ? (
                      <>
                        <div className="workspace-file-heading">
                          <PathLabel path={displayPath} />
                          <div>
                            {view === 'changes' && diffState?.data && (
                              <button
                                className="workspace-panel-icon"
                                aria-label="Ver archivo completo"
                                title="Ver archivo completo"
                                onClick={() => {
                                  setSelectedFile(diffState.data!.filePath ?? activeDiffPath);
                                  switchView('files');
                                }}
                              >
                                <FileCode size={14} />
                              </button>
                            )}
                            <button
                              className="workspace-panel-icon"
                              aria-label="Abrir archivo fuera de la app"
                              title="Abrir fuera de la app"
                              onClick={() =>
                                onOpenExternal(
                                  view === 'changes'
                                    ? (diffState?.data?.filePath ?? displayPath)
                                    : (fileState?.data?.path ?? displayPath),
                                )
                              }
                            >
                              <SquareArrowOutUpRight size={13} />
                            </button>
                          </div>
                        </div>
                        {(resource?.loading && !resource.data) || !resource ? (
                          <div className="workspace-panel-empty" role="status">
                            <LoaderCircle className="workspace-panel-spinner" size={20} />
                            <p>{view === 'files' ? 'Leyendo archivo…' : 'Cargando diferencias…'}</p>
                          </div>
                        ) : resource.error ? (
                          <div className="workspace-panel-empty" role="alert">
                            <p>{resource.error}</p>
                            <button onClick={() => setRefresh((value) => value + 1)}>
                              Reintentar
                            </button>
                          </div>
                        ) : view === 'files' && fileState?.data ? (
                          <TextContent key={fileState.data.path} file={fileState.data} />
                        ) : diffState?.data ? (
                          <DiffContent key={diffKey} diff={diffState.data} />
                        ) : null}
                      </>
                    ) : (
                      <div className="workspace-panel-empty">
                        {view === 'files' ? (
                          <>
                            <FileCode size={28} />
                            <strong>Explora tu proyecto</strong>
                            <p>Elige un archivo para leerlo junto al chat.</p>
                          </>
                        ) : (
                          <>
                            <Check size={25} />
                            <strong>{staged ? 'Nada preparado' : 'Todo revisado'}</strong>
                            <p>
                              {staged
                                ? 'Prepara archivos para incluirlos en el próximo commit.'
                                : 'No hay cambios sin preparar en esta carpeta.'}
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <footer className="workspace-panel-footer">
                  <span
                    role={mutationError ? 'alert' : 'status'}
                    className={mutationError ? 'error' : ''}
                  >
                    {mutationError ||
                      message ||
                      (view === 'files'
                        ? fileState?.data
                          ? `${fileSize(fileState.data.size)} · Solo lectura`
                          : 'Solo lectura'
                        : `${changedFiles.length} ${changedFiles.length === 1 ? 'archivo' : 'archivos'}`)}
                  </span>
                  {view === 'changes' && activeDiffPath && (
                    <button
                      disabled={
                        mutation || disabled || !!selectedChange?.conflict || !!diffState?.error
                      }
                      title={
                        selectedChange?.conflict
                          ? 'Resuelve el conflicto antes de preparar el archivo.'
                          : undefined
                      }
                      onClick={() => void prepare()}
                    >
                      {mutation ? (
                        <LoaderCircle className="workspace-panel-spinner" size={13} />
                      ) : staged ? (
                        <Minus size={13} />
                      ) : (
                        <Plus size={13} />
                      )}
                      {staged ? 'Quitar de preparados' : 'Preparar archivo'}
                    </button>
                  )}
                </footer>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
