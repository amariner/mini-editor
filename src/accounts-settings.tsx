import { NetworkSettings } from './network-settings';
import React, { useEffect, useState } from 'react';
import { LogIn, LogOut, RefreshCw, X, Plus, Leaf, Trash2 } from 'lucide-react';
import {
  defaultOptimization,
  savingLevels,
  type Action,
  type Profile,
  type Snapshot,
  type TokenOptimization,
} from './shared';
import { compatibleRuntime } from './runtime';
import { TerminalView, live } from './terminal';
import { InterfaceSettings, useInterfacePreferences } from './interface-settings';

export function AccountsSettings({
  state,
  run,
  close,
  onError,
  appearance,
}: {
  state: Snapshot;
  run: (action: Action) => Promise<any>;
  close: () => void;
  onError: (error: string) => void;
  appearance: ReturnType<typeof useInterfacePreferences>;
}) {
  const [tab, setTab] = useState<'accounts' | 'interface' | 'network'>('accounts');
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
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState<'claude' | 'codex'>('claude');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Profile>();
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
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">
          <h2>Ajustes</h2>
          <button aria-label="Cerrar ajustes" onClick={close}>
            <X size={17} />
          </button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="Secciones de ajustes">
          {(['accounts', 'interface', 'network'] as const).map((id) => (
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
                const sections = ['accounts', 'interface', 'network'] as const;
                const index = sections.indexOf(id);
                const next =
                  e.key === 'Home'
                    ? sections[0]
                    : e.key === 'End'
                      ? sections[2]
                      : sections[(index + (e.key === 'ArrowRight' ? 1 : 2)) % sections.length];
                setTab(next);
                document.getElementById(`settings-tab-${next}`)?.focus();
              }}
            >
              {id === 'accounts' ? 'Cuentas' : id === 'interface' ? 'Interfaz' : 'Red'}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="settings-panel-network"
          aria-labelledby="settings-tab-network"
          hidden={tab !== 'network'}
        >
          {tab === 'network' && (
            <NetworkSettings snapshot={state.proxy} compatible={compatible} run={run} />
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
              disabled={!compatible || creating}
              onClick={() => setAdding((v) => !v)}
              aria-label="Añadir cuenta"
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
                  const result = await run({
                    type: 'addAccount',
                    kind: newKind,
                    name: newName.trim() || undefined,
                  });
                  if (result) {
                    setAdding(false);
                    setNewName('');
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
                  aria-label="Proveedor de la nueva cuenta"
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value as 'claude' | 'codex')}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">ChatGPT · Codex</option>
                </select>
              </label>
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
              <div>
                <button type="submit" disabled={creating}>
                  Crear perfil
                </button>
                <button type="button" onClick={() => setAdding(false)}>
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
                              ? 'Conectada'
                              : account?.status === 'signedOut'
                                ? 'Sin sesión'
                                : 'Estado sin verificar';
              const disabled = !compatible || !!busy || !state.tools[p.kind];
              return (
                <section className="account-card" key={p.id} aria-label={`Cuenta ${p.name}`}>
                  <div className="account-heading">
                    <div>
                      <strong>{p.name}</strong>
                      <small>
                        {p.kind === 'codex' ? 'ChatGPT · Codex' : 'Claude.ai · Claude Code'}
                      </small>
                    </div>
                    <span className={`account-status ${account?.status ?? ''}`}>{status}</span>
                  </div>
                  {account?.label && (
                    <div className="account-identity">
                      {account.label}
                      {account.plan ? ` · ${account.plan}` : ' · Plan no disponible'}
                    </div>
                  )}
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
                  {!state.tools[p.kind] && (
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
                      {running(p.id).length} sesiones abiertas con este perfil.
                    </p>
                  )}
                  <div className="account-actions">
                    <button disabled={disabled} onClick={() => request(p.id, 'accountLogin')}>
                      <LogIn size={14} />
                      {account?.status === 'signedIn' ? 'Cambiar cuenta' : 'Iniciar sesión'}
                    </button>
                    <button disabled={disabled} onClick={() => request(p.id, 'accountLogout')}>
                      <LogOut size={14} />
                      Cerrar sesión
                    </button>
                    <button
                      aria-label={`Actualizar estado de ${p.name}`}
                      disabled={disabled}
                      onClick={() => void run({ type: 'accountRefresh', profile: p.id })}
                    >
                      <RefreshCw size={14} />
                    </button>
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
                    <fieldset
                      className="token-settings"
                      disabled={!compatible || savingProfile !== undefined}
                    >
                      <label className="token-saving" title="Ahorro de tokens">
                        <Leaf size={13} aria-hidden="true" />
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
                    {account?.cancellable && (
                      <button onClick={() => void run({ type: 'accountCancel', profile: p.id })}>
                        Cancelar acceso
                      </button>
                    )}
                  </div>

                  {busy === 'signingIn' && p.kind === 'codex' && (
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
            <section
              className="account-confirm"
              role="alertdialog"
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
                      void run({ type: action.type, profile: action.profile, stopSessions: true });
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
          )}
          <details className="account-tools">
            <summary>Herramientas y datos locales</summary>
            {(['claude', 'codex'] as const).map((tool) => (
              <div className="tool-setting" key={tool}>
                <strong>{tool === 'claude' ? 'Claude Code' : 'Codex app-server'}</strong>
                <code>{state.tools[tool] ?? 'No encontrado'}</code>
                <button onClick={() => void run({ type: 'chooseBinary', tool })}>
                  Seleccionar ejecutable
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
