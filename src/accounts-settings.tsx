import { accountPalette, suggestedAccountColor } from './account-color';
import { LocalAccountSettings } from './local-account-settings';
import { ProviderAccountSettings } from './provider-account-settings';
import { providerNames, type ProviderKind } from './shared';
import { NetworkSettings } from './network-settings';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import {
  LogIn,
  LogOut,
  RefreshCw,
  X,
  Plus,
  Leaf,
  Trash2,
  SlidersHorizontal,
  Check,
  RotateCcw,
  FolderOpen,
  UserRound,
  Palette,
  Globe,
  Star,
  Cable,
  AppWindow,
} from 'lucide-react';
import {
  defaultOptimization,
  savingLevels,
  type Action,
  type Profile,
  type Snapshot,
  type TokenOptimization,
} from './shared';
import { compatibleRuntime } from './runtime';
import { TerminalView } from './lazy-terminal';
import { sessionIsLive as live } from './session-tabs';
import { InterfaceSettings, useInterfacePreferences } from './interface-settings';

const McpSettings = lazy(() =>
  import('./mcp-settings').then((module) => ({ default: module.McpSettings })),
);
const ApplicationsPanel = lazy(() =>
  import('./applications-panel').then((module) => ({ default: module.ApplicationsPanel })),
);
type SettingsTab = 'accounts' | 'interface' | 'network' | 'connections' | 'applications';
const settingsTabs: SettingsTab[] = [
  'accounts',
  'connections',
  'applications',
  'interface',
  'network',
];

export function AccountsSettings({
  state,
  run,
  runLocal = run,
  close,
  onError,
  appearance,
  onOpenFreebuff,
  initialTab = 'accounts',
  connectionSessionId,
}: {
  state: Snapshot;
  run: (action: Action) => Promise<any>;
  runLocal?: (action: Action) => Promise<any>;
  close: () => void;
  onError: (error: string) => void;
  appearance: ReturnType<typeof useInterfacePreferences>;
  onOpenFreebuff?: () => Promise<void>;
  initialTab?: SettingsTab;
  connectionSessionId?: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleAccount = (id: string) =>
    setExpanded((previous) => ({ ...previous, [id]: !previous[id] }));
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const [confirmation, setConfirmation] = useState<{
    profile: Profile;
    type: 'accountLogin' | 'accountLogout' | 'removeAccount';
  }>();
  const accountProfiles = state.profiles ?? [];
  const [optimizationDrafts, setOptimizationDrafts] = useState<
    Partial<Record<Profile, TokenOptimization>>
  >({});
  const [savingProfile, setSavingProfile] = useState<Profile>();
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultDraft, setDefaultDraft] = useState<Profile>();
  const saveOptimization = async (profile: Profile, optimization: TokenOptimization) => {
    setSavingProfile(profile);
    const before = optimizationDrafts[profile];
    setOptimizationDrafts((d) => ({ ...d, [profile]: optimization }));
    try {
      const result = await run({ type: 'configureOptimization', profile, optimization });
      if (!result) setOptimizationDrafts((d) => ({ ...d, [profile]: before }));
    } catch (error) {
      setOptimizationDrafts((d) => ({ ...d, [profile]: before }));
      onError((error as Error).message);
    } finally {
      setSavingProfile(undefined);
    }
  };
  const [colorDrafts, setColorDrafts] = useState<Partial<Record<Profile, string>>>({});
  const [savingColor, setSavingColor] = useState<Profile>();
  const saveColor = async (profile: Profile, color: string | null) => {
    if (savingColor) return;
    setSavingColor(profile);
    try {
      const result = await run({ type: 'setAccountColor', profile, color });
      if (result) setColorDrafts((v) => ({ ...v, [profile]: undefined }));
    } finally {
      setSavingColor(undefined);
    }
  };
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<ProviderKind | 'freebuff'>('claude');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Profile>();
  const [removingFreebuff, setRemovingFreebuff] = useState(false);
  const compatible = compatibleRuntime(state);
  useEffect(() => {
    if (compatible)
      for (const p of accountProfiles)
        if (!state.accounts?.[p.id]?.busy) void run({ type: 'accountRefresh', profile: p.id });
  }, []);
  const running = (profile: Profile) =>
    state.sessions.filter((s) => s.profile === profile && live(s));
  const request = (profile: Profile, type: 'accountLogin' | 'accountLogout') => {
    if (type === 'accountLogout' || running(profile).length) setConfirmation({ profile, type });
    else void run({ type, profile, stopSessions: false });
  };
  return (
    <div className="overlay" onClick={close}>
      <section
        className="modal account-settings"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Escape belongs to the official login terminal (Claude Code menus, readline).
            if ((event.target as HTMLElement).closest?.('.xterm')) return;
            event.stopPropagation();
            if (confirmation) setConfirmation(undefined);
            else if (adding && (event.target as HTMLElement).closest?.('.add-account-form')) {
              setAdding(false);
              document.querySelector<HTMLElement>('[data-add-account]')?.focus();
            } else close();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <div className="modal-title">
            <h2>Ajustes</h2>
            <button title="Cerrar ajustes" aria-label="Cerrar ajustes" onClick={close}>
              <X size={17} />
            </button>
          </div>
          <div className="settings-tabs" role="tablist" aria-label="Secciones de ajustes">
            {settingsTabs.map((id) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                role="tab"
                aria-selected={tab === id}
                aria-controls={`settings-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                  e.preventDefault();
                  const sections = settingsTabs;
                  const index = sections.indexOf(id);
                  const next =
                    e.key === 'Home'
                      ? sections[0]
                      : e.key === 'End'
                        ? sections[sections.length - 1]
                        : sections[
                            (index + (e.key === 'ArrowRight' ? 1 : sections.length - 1)) %
                              sections.length
                          ];
                  setTab(next);
                  document.getElementById(`settings-tab-${next}`)?.focus();
                }}
              >
                {id === 'accounts' ? (
                  <UserRound size={15} aria-hidden="true" />
                ) : id === 'connections' ? (
                  <Cable size={15} aria-hidden="true" />
                ) : id === 'interface' ? (
                  <Palette size={15} aria-hidden="true" />
                ) : id === 'applications' ? (
                  <AppWindow size={15} aria-hidden="true" />
                ) : (
                  <Globe size={15} aria-hidden="true" />
                )}
                {id === 'accounts'
                  ? 'Cuentas'
                  : id === 'connections'
                    ? 'Conexiones'
                    : id === 'interface'
                      ? 'Interfaz'
                      : id === 'applications'
                        ? 'Aplicaciones'
                        : 'Red'}
              </button>
            ))}
          </div>
        </div>
        <div
          role="tabpanel"
          id="settings-panel-applications"
          aria-labelledby="settings-tab-applications"
          hidden={tab !== 'applications'}
        >
          {tab === 'applications' && (
            <Suspense
              fallback={
                <p className="muted" role="status">
                  Buscando aplicaciones…
                </p>
              }
            >
              <ApplicationsPanel
                snapshot={state.applications}
                compatible={compatible}
                run={runLocal}
              />
            </Suspense>
          )}
        </div>
        <div
          role="tabpanel"
          id="settings-panel-connections"
          aria-labelledby="settings-tab-connections"
          hidden={tab !== 'connections'}
        >
          {tab === 'connections' && (
            <Suspense
              fallback={
                <p className="muted" role="status">
                  Cargando conexiones…
                </p>
              }
            >
              <McpSettings
                state={state}
                run={runLocal}
                compatible={compatible}
                connectionSessionId={connectionSessionId}
              />
            </Suspense>
          )}
        </div>
        <div
          role="tabpanel"
          id="settings-panel-network"
          aria-labelledby="settings-tab-network"
          hidden={tab !== 'network'}
        >
          {tab === 'network' && (
            <NetworkSettings snapshot={state.proxy} compatible={compatible} run={runLocal} />
          )}
        </div>
        <div
          role="tabpanel"
          id="settings-panel-interface"
          aria-labelledby="settings-tab-interface"
          hidden={tab !== 'interface'}
        >
          <InterfaceSettings
            preferences={appearance.preferences}
            update={appearance.update}
            theme={state.theme}
            setTheme={compatible ? (theme) => void run({ type: 'setTheme', theme }) : undefined}
          />
        </div>
        <div
          role="tabpanel"
          id="settings-panel-accounts"
          aria-labelledby="settings-tab-accounts"
          hidden={tab !== 'accounts'}
        >
          <div className="accounts-section-heading">
            <h3>Cuentas</h3>
            <button
              data-add-account
              disabled={!compatible || creating}
              onClick={() => setAdding((v) => !v)}
              aria-label="Añadir cuenta"
              aria-expanded={adding}
            >
              <Plus size={14} /> Añadir cuenta
            </button>
          </div>
          {adding && (
            <form
              className="add-account-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setCreating(true);
                try {
                  const result = await run(
                    newKind === 'freebuff'
                      ? { type: 'setFreebuffEnabled', enabled: true }
                      : { type: 'addAccount', kind: newKind, name: newName.trim() || undefined },
                  );
                  if (result) {
                    setAdding(false);
                    setNewName('');
                    setNewKind('claude');
                    if (newKind === 'local')
                      setExpanded((previous) => ({ ...previous, [result.id]: true }));
                    if (newKind !== 'freebuff')
                      void run({ type: 'accountRefresh', profile: result.id });
                  }
                } finally {
                  setCreating(false);
                }
              }}
            >
              <label>
                Proveedor
                <select
                  autoFocus
                  aria-label="Proveedor de la nueva cuenta"
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value as ProviderKind | 'freebuff')}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">ChatGPT · Codex</option>
                  <option value="local">Local · En este ordenador</option>
                  <option value="openrouter">OpenRouter · API</option>
                  <option value="opencode">OpenCode · Console</option>
                  <option value="gemini">Google · Gemini</option>
                  {!state.freebuffEnabled && <option value="freebuff">Freebuff · CLI</option>}
                </select>
              </label>
              {newKind !== 'freebuff' && (
                <label>
                  Nombre
                  <input
                    aria-label="Nombre de la nueva cuenta"
                    placeholder="Opcional · Personal, Trabajo…"
                    value={newName}
                    maxLength={40}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </label>
              )}
              <div>
                <button type="submit" disabled={creating}>
                  {newKind === 'freebuff' ? 'Añadir Freebuff' : 'Crear perfil'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    document.querySelector<HTMLElement>('[data-add-account]')?.focus();
                  }}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
          <div className="account-list">
            {!accountProfiles.length && (
              <p className="muted">No hay cuentas. Pulsa «Añadir cuenta» para crear la primera.</p>
            )}
            {accountProfiles.map((p) => {
              const account = state.accounts?.[p.id];
              const optimization =
                optimizationDrafts[p.id] ?? p.optimization ?? defaultOptimization;
              const busy = removing === p.id ? 'removing' : account?.busy;
              const status =
                busy === 'removing'
                  ? 'Eliminando cuenta…'
                  : busy === 'checking'
                    ? 'Comprobando cuenta…'
                    : busy === 'verifying'
                      ? 'Validando cuenta…'
                      : busy === 'signingIn'
                        ? account?.loginStarting
                          ? 'Iniciando Claude Code…'
                          : 'Completa el acceso oficial'
                        : busy === 'signingOut'
                          ? 'Cerrando sesión…'
                          : busy === 'cancelling'
                            ? 'Cancelando…'
                            : account?.status === 'signedIn'
                              ? p.kind === 'local'
                                ? 'Disponible'
                                : 'Conectada'
                              : account?.status === 'signedOut'
                                ? p.kind === 'local'
                                  ? 'Sin modelos'
                                  : 'Sin sesión'
                                : 'Estado sin verificar';
              const disabled =
                !compatible ||
                !!busy ||
                (p.kind !== 'local' &&
                  p.kind !== 'openrouter' &&
                  p.kind !== 'opencode' &&
                  !state.tools[p.kind]);
              const loginLabel =
                p.kind === 'opencode'
                  ? account?.status === 'signedIn'
                    ? 'Cambiar cuenta en el navegador'
                    : 'Iniciar sesión en el navegador'
                  : p.kind === 'gemini' && /[/\\]agy(?:\.exe)?$/.test(state.tools.gemini ?? '')
                    ? account?.status === 'signedIn'
                      ? 'Verificar conexión Google'
                      : 'Conectar Google con Antigravity'
                    : account?.status === 'signedIn'
                      ? 'Cambiar cuenta'
                      : p.kind === 'gemini'
                        ? 'Iniciar sesión con Google'
                        : 'Iniciar sesión';
              return (
                <section className="account-card" key={p.id} aria-label={`Cuenta ${p.name}`}>
                  <div className="account-heading">
                    <div>
                      <strong>
                        {p.name}
                        {(defaultDraft ?? state.defaultProfile ?? accountProfiles[0]?.id) ===
                          p.id && (
                          <Star
                            className="account-default-mark"
                            size={11}
                            role="img"
                            aria-label="Cuenta predeterminada"
                          >
                            <title>Predeterminada para chats nuevos</title>
                          </Star>
                        )}
                      </strong>
                      <small>
                        {p.kind === 'codex'
                          ? 'ChatGPT · Codex'
                          : p.kind === 'claude'
                            ? 'Claude.ai · Claude Code'
                            : providerNames[p.kind]}
                      </small>
                    </div>
                    <div className="account-heading-actions">
                      <span
                        className={`account-status ${busy ? 'busy' : (account?.status ?? '')}`}
                        title={status}
                      >
                        {status}
                      </span>
                      {p.kind !== 'openrouter' && p.kind !== 'local' && (
                        <button
                          className={`account-login ${account?.status === 'signedIn' ? 'is-connected' : ''}`}
                          title={loginLabel}
                          aria-label={loginLabel}
                          disabled={disabled}
                          onClick={() => request(p.id, 'accountLogin')}
                        >
                          <LogIn size={14} />
                          <span className="action-label">{loginLabel}</span>
                        </button>
                      )}
                      {p.kind === 'openrouter' && account?.status !== 'signedIn' && (
                        <button
                          className="account-login"
                          disabled={!compatible || !!busy}
                          onClick={() => setExpanded((previous) => ({ ...previous, [p.id]: true }))}
                        >
                          <LogIn size={14} aria-hidden="true" /> Conectar
                        </button>
                      )}
                      <button
                        aria-label={`Actualizar estado de ${p.name}`}
                        title={`Actualizar estado de ${p.name}`}
                        disabled={disabled}
                        onClick={() => void run({ type: 'accountRefresh', profile: p.id })}
                      >
                        <RefreshCw size={14} />
                      </button>
                      <button
                        className="account-options-trigger"
                        data-account-options={p.id}
                        aria-label={`Opciones de ${p.name}`}
                        title={`Opciones de ${p.name}`}
                        aria-expanded={!!expanded[p.id] || !!account?.loginCode}
                        aria-controls={`account-options-${p.id}`}
                        onClick={() => toggleAccount(p.id)}
                      >
                        <SlidersHorizontal size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  {account?.label && (
                    <div className="account-identity">
                      {account.label}
                      {account.plan ? ` · ${account.plan}` : ''}
                    </div>
                  )}

                  {p.kind !== 'local' &&
                    p.kind !== 'openrouter' &&
                    p.kind !== 'opencode' &&
                    !state.tools[p.kind] && (
                      <p className="muted">Selecciona el ejecutable para conectar esta cuenta.</p>
                    )}
                  {account?.loginStarting && (
                    <p className="muted" role="status">
                      Claude puede tardar hasta un minuto en abrir el acceso en el navegador. Puedes
                      cancelar mientras arranca.
                    </p>
                  )}
                  {account?.error && (
                    <p className="account-error" role="alert">
                      {account.error}
                    </p>
                  )}
                  {running(p.id).length > 0 && (
                    <p className="muted">
                      {running(p.id).length}{' '}
                      {running(p.id).length === 1 ? 'sesión abierta' : 'sesiones abiertas'}
                    </p>
                  )}
                  {account?.cancellable && (
                    <button onClick={() => void run({ type: 'accountCancel', profile: p.id })}>
                      Cancelar acceso
                    </button>
                  )}
                  <div
                    id={`account-options-${p.id}`}
                    className="account-options"
                    hidden={!expanded[p.id] && !account?.loginCode}
                  >
                    <div className="account-color-setting">
                      <label>
                        Color en Multichat
                        <select
                          aria-label={`Color de ${p.name}`}
                          value={colorDrafts[p.id] ?? p.color ?? suggestedAccountColor(p.id)}
                          disabled={!compatible || !!savingColor || busy === 'removing'}
                          onChange={(e) =>
                            setColorDrafts((v) => ({ ...v, [p.id]: e.target.value }))
                          }
                        >
                          {p.color && !accountPalette.some((entry) => entry.color === p.color) && (
                            <option value={p.color}>Personalizado actual</option>
                          )}
                          {accountPalette.map((entry) => (
                            <option key={entry.color} value={entry.color}>
                              {entry.name}
                              {entry.color === suggestedAccountColor(p.id) ? ' · Sugerido' : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div
                        className="account-color-palette"
                        role="group"
                        aria-label={`Paleta de ${p.name}`}
                      >
                        {accountPalette.map((entry) => (
                          <button
                            key={entry.color}
                            type="button"
                            aria-label={`${entry.name} para ${p.name}`}
                            title={`${entry.name}${entry.color === suggestedAccountColor(p.id) ? ' · Sugerido' : ''}`}
                            aria-pressed={
                              (colorDrafts[p.id] ?? p.color ?? suggestedAccountColor(p.id)) ===
                              entry.color
                            }
                            style={
                              {
                                backgroundColor: `var(--account-${entry.token})`,
                                '--swatch': entry.color,
                              } as React.CSSProperties
                            }
                            disabled={!compatible || !!savingColor || busy === 'removing'}
                            onClick={() => setColorDrafts((v) => ({ ...v, [p.id]: entry.color }))}
                          />
                        ))}
                      </div>
                      <button
                        disabled={
                          !compatible ||
                          !!savingColor ||
                          !colorDrafts[p.id] ||
                          colorDrafts[p.id] === p.color ||
                          busy === 'removing'
                        }
                        aria-label="Guardar color"
                        title="Guardar color"
                        onClick={() => void saveColor(p.id, colorDrafts[p.id]!)}
                      >
                        <Check size={14} aria-hidden="true" />
                      </button>
                      <button
                        disabled={
                          !compatible ||
                          !!savingColor ||
                          (!p.color && !colorDrafts[p.id]) ||
                          busy === 'removing'
                        }
                        aria-label="Restablecer color sugerido"
                        title="Restablecer color sugerido"
                        onClick={() => void saveColor(p.id, null)}
                      >
                        <RotateCcw size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <label className="default-account-option">
                      <input
                        type="radio"
                        name="default-account"
                        aria-label={`Usar ${p.name} como cuenta predeterminada`}
                        checked={
                          (defaultDraft ?? state.defaultProfile ?? accountProfiles[0]?.id) === p.id
                        }
                        disabled={!compatible || savingDefault || busy === 'removing'}
                        onChange={async () => {
                          setSavingDefault(true);
                          setDefaultDraft(p.id);
                          try {
                            await run({ type: 'setDefaultAccount', profile: p.id });
                          } finally {
                            setSavingDefault(false);
                            setDefaultDraft(undefined);
                          }
                        }}
                      />
                      Predeterminada para chats nuevos
                    </label>
                    {(p.kind === 'claude' || p.kind === 'codex') && (
                      <fieldset
                        className="token-settings"
                        disabled={!compatible || savingProfile !== undefined}
                      >
                        <label className="token-saving" title="Ahorro de tokens">
                          <Leaf size={13} aria-hidden="true" />
                          <span>Ahorro</span>
                          <select
                            aria-label="Ahorro de tokens"
                            value={optimization.level}
                            onChange={(e) =>
                              void saveOptimization(p.id, {
                                ...optimization,
                                level: Number(e.target.value) as TokenOptimization['level'],
                              })
                            }
                          >
                            {savingLevels.map((level) => (
                              <option key={level.value} value={level.value}>
                                {level.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="token-auto">
                          <span>Modelo auto</span>
                          <input
                            type="checkbox"
                            role="switch"
                            checked={optimization.autoModel}
                            onChange={(e) =>
                              void saveOptimization(p.id, {
                                ...optimization,
                                autoModel: e.target.checked,
                              })
                            }
                          />
                        </label>
                      </fieldset>
                    )}
                    {p.kind === 'local' && (
                      <LocalAccountSettings
                        profile={p}
                        run={runLocal}
                        disabled={!compatible || !!busy}
                      />
                    )}
                    {['openrouter', 'opencode', 'gemini'].includes(p.kind) && (
                      <ProviderAccountSettings
                        profile={p}
                        account={account}
                        disabled={!compatible || !!busy}
                        run={run}
                        antigravity={/[/\\]agy(?:\.exe)?$/.test(state.tools.gemini ?? '')}
                      />
                    )}
                    <div className="account-actions account-secondary-actions">
                      {p.kind !== 'local' && (
                        <button disabled={disabled} onClick={() => request(p.id, 'accountLogout')}>
                          <LogOut size={14} />
                          {p.kind === 'gemini' &&
                          /[/\\]agy(?:\.exe)?$/.test(state.tools.gemini ?? '')
                            ? 'Desvincular de Agent Desk'
                            : 'Cerrar sesión'}
                        </button>
                      )}
                      <button
                        className="danger-ghost"
                        disabled={
                          !compatible ||
                          !!removing ||
                          (!!busy && busy !== 'checking' && !account?.cancellable)
                        }
                        onClick={() => setConfirmation({ profile: p.id, type: 'removeAccount' })}
                        aria-label={`Eliminar cuenta ${p.name}`}
                      >
                        <Trash2 size={14} /> Eliminar cuenta
                      </button>
                    </div>
                  </div>
                  {busy === 'signingIn' && (p.kind === 'codex' || p.kind === 'gemini') && (
                    <p className="muted">
                      Continúa en el navegador. Puedes cerrar Ajustes y volver aquí mientras
                      completas el acceso.
                    </p>
                  )}
                  {account?.terminalId && !account.loginStarting && (
                    <div className="account-terminal">
                      <TerminalView
                        session={{
                          id: account.terminalId,
                          status: busy === 'signingIn' ? 'terminal' : 'stopped',
                        }}
                        visible
                        onError={onError}
                      />
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          {confirmation && (
            <div className="account-confirm-overlay" onClick={() => setConfirmation(undefined)}>
              <section
                onClick={(event) => event.stopPropagation()}
                className="account-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-label={
                  confirmation.type === 'removeAccount'
                    ? 'Confirmar eliminación de cuenta'
                    : 'Confirmar cambio de cuenta'
                }
              >
                <strong>
                  {confirmation.type === 'removeAccount'
                    ? 'Eliminar cuenta'
                    : confirmation.type === 'accountLogout'
                      ? 'Cerrar sesión de'
                      : 'Cambiar el acceso de'}{' '}
                  {accountProfiles.find((p) => p.id === confirmation.profile)?.name}
                </strong>
                <p>
                  {running(confirmation.profile).length
                    ? 'Se detendrán estas sesiones antes de continuar:'
                    : confirmation.type === 'removeAccount'
                      ? 'Se quitarán esta cuenta y sus conversaciones de Agent Desk.'
                      : 'Se actualizará únicamente la autenticación de este perfil.'}
                </p>
                {running(confirmation.profile).map((s) => (
                  <div key={s.id}>
                    {state.projects.find((p) => p.id === s.projectId)?.name} · {s.title}
                  </div>
                ))}
                <p className="muted">
                  {confirmation.type === 'removeAccount'
                    ? 'Se cancelará cualquier acceso pendiente. La carpeta local del perfil y una copia de sus conversaciones se enviarán a la Papelera. Los proyectos, sus archivos y las demás cuentas se conservan. Tu cuenta del proveedor no se elimina.'
                    : 'Las conversaciones y los archivos se conservan.'}
                </p>
                <div className="modal-actions">
                  <button onClick={() => setConfirmation(undefined)}>Cancelar</button>
                  <button
                    className="danger"
                    onClick={async () => {
                      const action = confirmation;
                      setConfirmation(undefined);
                      if (action.type === 'removeAccount') {
                        setRemoving(action.profile);
                        try {
                          await run({
                            type: 'removeAccount',
                            profile: action.profile,
                            confirmed: true,
                          });
                        } catch (error) {
                          onError((error as Error).message);
                        } finally {
                          setRemoving(undefined);
                        }
                      } else
                        void run({
                          type: action.type,
                          profile: action.profile,
                          stopSessions: true,
                        });
                    }}
                  >
                    {confirmation.type === 'removeAccount'
                      ? 'Confirmar eliminación'
                      : confirmation.type === 'accountLogout'
                        ? 'Confirmar cierre de sesión'
                        : 'Detener y continuar'}
                  </button>
                </div>
              </section>
            </div>
          )}
          {state.freebuffEnabled && (
            <section className="account-card freebuff-card" aria-label="Freebuff CLI">
              <h3>Freebuff · terminal oficial</h3>
              <p>
                Inicia sesión y elige los modelos desde Freebuff. Se abre en el proyecto
                seleccionado y utiliza la misma cuenta local que su CLI.
              </p>
              <p className="muted">
                Los modelos, límites, permisos y avisos de datos se muestran en Freebuff. Sus
                conversaciones permanecen en la CLI; no se añaden al chat ni al selector de modelos
                de Agent Desk.
              </p>
              <button
                disabled={
                  !compatible || !state.tools.freebuff || !state.selectedProject || !onOpenFreebuff
                }
                onClick={() => void onOpenFreebuff?.()}
              >
                Abrir Freebuff en este proyecto
              </button>
              {!state.selectedProject && (
                <p className="muted">Selecciona un proyecto para abrir Freebuff.</p>
              )}
              {!state.tools.freebuff && (
                <p className="muted">
                  Instala la CLI oficial con <code>npm install -g freebuff</code> y selecciona su
                  ejecutable debajo.
                </p>
              )}
              <button
                className="danger-ghost"
                disabled={!compatible || removingFreebuff}
                onClick={async () => {
                  setRemovingFreebuff(true);
                  try {
                    await run({ type: 'setFreebuffEnabled', enabled: false });
                  } finally {
                    setRemovingFreebuff(false);
                  }
                }}
              >
                <Trash2 size={14} /> {removingFreebuff ? 'Quitando Freebuff…' : 'Quitar Freebuff'}
              </button>
              <p className="muted">
                Al quitarlo se cierran sus terminales abiertas. Tu cuenta y los datos de la CLI se
                conservan.
              </p>
            </section>
          )}
          <details className="account-tools">
            <summary>Herramientas y datos locales</summary>
            {(['claude', 'codex', 'gemini', 'freebuff'] as const)
              .filter((tool) =>
                tool === 'freebuff'
                  ? state.freebuffEnabled
                  : accountProfiles.some((p) => p.kind === tool),
              )
              .map((tool) => (
                <div className="tool-setting" key={tool}>
                  <strong>
                    {tool === 'claude'
                      ? 'Claude Code'
                      : tool === 'gemini'
                        ? 'Google · Antigravity / Gemini CLI'
                        : tool === 'freebuff'
                          ? 'Freebuff CLI'
                          : 'Codex app-server'}
                  </strong>
                  <code>{state.tools[tool] ?? 'No encontrado'}</code>
                  <button
                    title="Seleccionar ejecutable"
                    aria-label={`Seleccionar ejecutable de ${tool === 'claude' ? 'Claude Code' : tool === 'codex' ? 'Codex' : tool === 'gemini' ? 'Google' : 'Freebuff'}`}
                    onClick={() => void run({ type: 'chooseBinary', tool })}
                  >
                    <FolderOpen size={15} aria-hidden="true" />
                  </button>
                </div>
              ))}
            <h3>Datos locales</h3>
            <code>{state.dataDir}</code>
          </details>
        </div>
      </section>
    </div>
  );
}
