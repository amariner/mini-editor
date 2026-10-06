import React, { useState, useEffect } from 'react';
import type { Profile, ProfileDefinition } from './shared';
import { limitingWindow, resetCountdown, type SubscriptionUsage } from './subscription-usage';
export function UsageSwitcher({
  profiles,
  profile,
  label,
  usage,
  disabled,
  change,
}: {
  profiles: ProfileDefinition[];
  profile: Profile;
  label: (p: ProfileDefinition) => string;
  usage?: SubscriptionUsage;
  disabled: boolean;
  change: (p: Profile) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);
  const window = limitingWindow(usage, now);
  const details = usage?.windows
    .map((w) => `${w.label}: ${w.usedPercent}% consumido · ${resetCountdown(w.resetsAt, now)}`)
    .join('\n');
  const reason =
    usage?.unavailable ??
    (usage?.windows.length
      ? 'Esperando una lectura actualizada del proveedor.'
      : 'Esperando datos oficiales de la suscripción.');
  return (
    <div
      className="account-switcher usage-switcher"
      title={window ? `Límite general más consumido; las cuotas no se suman.\n${details}` : reason}
    >
      {window && (
        <span
          className="usage-fill"
          aria-hidden="true"
          style={{ width: `${Math.min(100, window.usedPercent)}%` }}
        />
      )}
      <select
        aria-label="Cuenta del proyecto"
        disabled={disabled}
        value={profile}
        onChange={(e) => change(e.target.value as Profile)}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {label(p)}
          </option>
        ))}
      </select>
      <span className="usage-caption" aria-label="Uso de la suscripción">
        {window
          ? `${Math.round(window.usedPercent)}% usado · ${window.label} · ${resetCountdown(window.resetsAt, now)}`
          : 'Uso no disponible'}
      </span>
    </div>
  );
}
