import React, { useState, useEffect } from 'react';
import { ChevronDown, LockKeyhole } from 'lucide-react';
import type { Profile, ProfileDefinition } from './shared';
import { providerKind, type ApiUsage, type SessionStats, isCodex } from './shared';
import { currentUsageWindow, resetCountdown, type SubscriptionUsage } from './subscription-usage';

/** Account picker for the composer footer; consumption lives in the context hover card. */
export function UsageSwitcher({
  profiles,
  profile,
  disabled,
  locked = false,
  change,
}: {
  profiles: ProfileDefinition[];
  profile: Profile;
  disabled: boolean;
  locked?: boolean;
  change: (p: Profile) => void;
}) {
  return (
    <div
      className={`account-switcher usage-switcher${locked ? ' locked' : ''}`}
      aria-label="Cuenta del chat"
    >
      <div
        className="usage-account"
        title={
          locked
            ? 'Este chat ya ha comenzado. Abre otra pestaña para cambiar de cuenta.'
            : 'Cuenta de este chat · Se puede cambiar antes del primer mensaje'
        }
      >
        <select
          aria-label="Cuenta del chat"
          disabled={disabled || locked}
          value={profile}
          onChange={(e) => change(e.target.value as Profile)}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {locked ? (
          <LockKeyhole size={11} aria-hidden="true" />
        ) : (
          <ChevronDown size={11} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

/** Subscription window (or API cost) as a labelled bar for the footer hover card. */
export function UsageWindowDetail({
  profile,
  usage,
  apiUsage,
  stats,
}: {
  profile: Profile;
  usage?: SubscriptionUsage;
  apiUsage?: ApiUsage;
  stats?: SessionStats;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const kind = providerKind(profile);
  const codex = isCodex(profile);
  if (['openrouter', 'opencode'].includes(kind)) {
    const cost =
      stats && (stats.costReported || stats.costEstimated)
        ? `$${stats.cost.toLocaleString('es-ES', { maximumFractionDigits: 5 })}${stats.costEstimated ? ' aprox.' : ''}`
        : '—';
    return (
      <div className="usage-window">
        <div className="usage-window-head">
          <span>Coste de la conversación</span>
          <strong>{cost}</strong>
        </div>
        <small>
          Crédito restante:{' '}
          {apiUsage?.remaining === undefined ? 'no disponible' : '$' + apiUsage.remaining}
        </small>
      </div>
    );
  }
  if (kind === 'gemini')
    return (
      <div className="usage-window">
        <div className="usage-window-head">
          <span>Consumo</span>
          <strong>—</strong>
        </div>
        <small>Google no comunica una cuota restante.</small>
      </div>
    );
  const window = currentUsageWindow(usage, codex ? '7 días' : '5 h', now);
  const used = window ? Math.round(Math.max(0, Math.min(100, window.usedPercent))) : undefined;
  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span>{codex ? 'Franja semanal' : 'Franja de 5 h'}</span>
        <strong>{used === undefined ? '—' : `${100 - used}% libre`}</strong>
      </div>
      <div className="usage-window-track" aria-hidden="true">
        <i
          style={{ width: `${used ?? 0}%` }}
          className={used !== undefined && used >= 80 ? 'high' : ''}
        />
      </div>
      <small>
        {window
          ? resetCountdown(window.resetsAt, now)
          : (usage?.unavailable ?? 'Esperando datos de la suscripción.')}
      </small>
    </div>
  );
}
