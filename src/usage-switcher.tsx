import React, { useState, useEffect } from 'react';
import { ChevronDown, LockKeyhole } from 'lucide-react';
import type { Profile, ProfileDefinition } from './shared';
import { isCodex } from './shared';
import { currentUsageWindow, type SubscriptionUsage } from './subscription-usage';

export function UsageSwitcher({
  profiles,
  profile,
  usage,
  disabled,
  locked = false,
  change,
}: {
  profiles: ProfileDefinition[];
  profile: Profile;
  usage?: SubscriptionUsage;
  disabled: boolean;
  locked?: boolean;
  change: (p: Profile) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const codex = isCodex(profile);
  const window = currentUsageWindow(usage, codex ? '7 días' : '5 h', now);
  const remaining = window
    ? Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))
    : undefined;
  const period = codex ? 'semanal' : 'de 5 horas';
  const reason = usage?.unavailable ?? 'Esperando datos oficiales actualizados de la suscripción.';
  const label = `Disponible ${period}: ${remaining === undefined ? 'no disponible' : `${remaining}%`}`;
  return (
    <div
      className={`account-switcher usage-switcher${locked ? ' locked' : ''}`}
      aria-label="Cuenta y disponibilidad del chat"
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
      <span
        className="usage-remaining"
        aria-label={label}
        title={remaining === undefined ? reason : `${remaining}% restante del límite ${period}`}
      >
        <span className="usage-period">{codex ? 'Semanal' : '5 h'}</span>
        <span className="usage-value">{remaining === undefined ? '—' : `${remaining}%`}</span>
      </span>
    </div>
  );
}
