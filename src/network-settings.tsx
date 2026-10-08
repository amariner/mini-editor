import React, { useState } from 'react';
import { defaultProxy, type ProxySnapshot, type ProxyUpdate } from './proxy-types';
import type { Action } from './shared';

export function NetworkSettings({
  snapshot,
  compatible,
  run,
}: {
  snapshot?: ProxySnapshot;
  compatible: boolean;
  run: (action: Action) => Promise<any>;
}) {
  const [draft, setDraft] = useState({ ...defaultProxy, ...snapshot });
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const edit = (patch: Partial<typeof draft>) => {
    setDraft((v) => ({ ...v, ...patch }));
    setResult(undefined);
  };
  const config = (): ProxyUpdate => ({
    mode: draft.mode,
    protocol: draft.protocol,
    host: draft.host.trim(),
    port: draft.port,
    username: draft.username,
    caFile: draft.caFile,
    ...(password ? { password } : {}),
    clearPassword,
  });
  const execute = async (action: Action) => {
    setBusy(true);
    setResult(undefined);
    try {
      return await run(action);
    } finally {
      setBusy(false);
    }
  };
  const manual = draft.mode === 'manual';
  return (
    <form
      className="network-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        const saved = await execute({ type: 'saveProxy', config: config() });
        if (saved) {
          setPassword('');
          setClearPassword(false);
          setResult(saved);
        }
      }}
    >
      <h3>Proxy corporativo</h3>
      <p className="muted">
        Configura la conexión de Claude, ChatGPT y el navegador integrado. El navegador externo de
        inicio de sesión conserva sus ajustes del sistema.
      </p>
      {snapshot?.error && <p className="error">{snapshot.error}</p>}
      <label>
        Conexión
        <select
          aria-label="Modo de proxy"
          value={draft.mode}
          disabled={!compatible || busy}
          onChange={(e) => edit({ mode: e.target.value as 'system' | 'manual' })}
        >
          <option value="system">Configuración del sistema / proveedor</option>
          <option value="manual">Proxy manual</option>
        </select>
      </label>
      <button
        type="button"
        disabled={!compatible || busy}
        onClick={async () => {
          const detected = await execute({ type: 'detectProxy' });
          if (detected) {
            edit({ ...detected, mode: 'manual' });
            setPassword('');
            setClearPassword(false);
          }
        }}
      >
        Detectar proxy del sistema
      </button>
      <fieldset disabled={!manual || !compatible || busy}>
        <legend>Servidor</legend>
        <div className="proxy-endpoint">
          <label>
            Protocolo
            <select
              aria-label="Protocolo del proxy"
              value={draft.protocol}
              onChange={(e) => edit({ protocol: e.target.value as 'http' | 'https' })}
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </select>
          </label>
          <label>
            Servidor
            <input
              aria-label="Servidor del proxy"
              placeholder="proxy.empresa.local"
              value={draft.host}
              onChange={(e) => edit({ host: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              required={manual}
            />
          </label>
          <label>
            Puerto
            <input
              aria-label="Puerto del proxy"
              type="number"
              min={1}
              max={65535}
              value={draft.port || ''}
              onChange={(e) => edit({ port: Number(e.target.value) })}
              required={manual}
            />
          </label>
        </div>
        <p className="muted">Autenticación básica (opcional)</p>
        <div className="proxy-auth">
          <label>
            Usuario
            <input
              aria-label="Usuario del proxy"
              value={draft.username}
              onChange={(e) => edit({ username: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Contraseña
            <input
              aria-label="Contraseña del proxy"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setClearPassword(false);
                setResult(undefined);
              }}
              autoComplete="new-password"
              placeholder={
                snapshot?.hasPassword ? 'Guardada · deja vacío para conservarla' : 'Opcional'
              }
            />
          </label>
        </div>
        {snapshot?.hasPassword && (
          <label className="proxy-checkbox">
            <input
              type="checkbox"
              checked={clearPassword}
              onChange={(e) => {
                setClearPassword(e.target.checked);
                setPassword('');
              }}
            />
            Eliminar contraseña guardada
          </label>
        )}
        <p className="muted">
          La contraseña se guarda cifrada en este equipo. No se reutiliza al cambiar de servidor,
          puerto o usuario.
        </p>
        {snapshot?.secureStorage === false && (
          <p className="muted">
            El almacenamiento seguro no está disponible; no se podrá guardar una contraseña.
          </p>
        )}
      </fieldset>
      <label>
        Certificado CA corporativo (PEM, opcional)
        <div className="proxy-certificate">
          <input
            aria-label="Certificado CA corporativo"
            value={draft.caFile}
            readOnly
            placeholder="Certificados de confianza predeterminados"
          />
          <button
            type="button"
            disabled={!compatible || busy}
            onClick={async () => {
              const file = await execute({ type: 'chooseProxyCertificate' });
              if (file) edit({ caFile: file });
            }}
          >
            Elegir…
          </button>
          {draft.caFile && (
            <button
              type="button"
              disabled={!compatible || busy}
              onClick={() => edit({ caFile: '' })}
            >
              Quitar
            </button>
          )}
        </div>
      </label>
      <p className="muted">
        El PEM se aplica a Claude y Codex. El navegador integrado utiliza los certificados de
        confianza del sistema. Las conexiones locales se mantienen fuera del proxy.
      </p>
      <div className="proxy-actions">
        <button type="submit" disabled={!compatible || busy}>
          {busy ? 'Procesando…' : 'Guardar configuración'}
        </button>
        {(['codex', 'claude'] as const).map((provider) => (
          <button
            key={provider}
            type="button"
            disabled={!compatible || busy || !manual || !draft.host}
            onClick={async () => {
              const tested = await execute({ type: 'testProxy', config: config(), provider });
              if (tested) setResult(tested);
            }}
          >
            Probar {provider === 'codex' ? 'ChatGPT' : 'Claude'}
          </button>
        ))}
      </div>
      {result && (
        <p role="status" className={result.ok ? 'muted' : 'error'}>
          {result.message}
        </p>
      )}
    </form>
  );
}
