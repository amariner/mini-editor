import React, { useState, useEffect } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import type { Profile, ProfileDefinition } from './shared';
import { isCodex } from './shared';
import { currentUsageWindow, resetCountdown, type SubscriptionUsage } from './subscription-usage';
export function UsageSwitcher({
  profiles,
  profile,
  usage,
  disabled,
  change,
}: {
  profiles: ProfileDefinition[];
  profile: Profile;
  usage?: SubscriptionUsage;
  disabled: boolean;
  change: (p: Profile) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);
  const fiveHour = currentUsageWindow(usage, '5 h', now);
  const weekly = currentUsageWindow(usage, '7 días', now);
  const resetWindow = isCodex(profile) ? weekly : fiveHour;
  const resetLabel = isCodex(profile) ? 'semanal' : 'de 5 horas';
  const countdown = resetWindow?.resetsAt
    ? resetCountdown(resetWindow.resetsAt, now).replace('Reinicio en ', '')
    : '—';
  const reason =
    usage?.unavailable ??
    (usage?.windows.length
      ? 'Esperando una lectura actualizada del proveedor.'
      : 'Esperando datos oficiales de la suscripción.');
  return (
    <div className="account-switcher usage-switcher" aria-label="Cuenta y consumo">
      <div className="usage-account">
        <select
          aria-label="Cuenta del proyecto"
          disabled={disabled}
          value={profile}
          onChange={(e) => change(e.target.value as Profile)}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ChevronDown size={11} aria-hidden="true" />
      </div>
      <div className="usage-quotas" aria-label="Uso de la suscripción">
        {[
          { key: '5h', name: '5 horas', window: fiveHour },
          { key: '7d', name: 'semanal', window: weekly },
        ].map(({ key, name, window }) => (
          <span
            key={key}
            className="usage-quota"
            aria-label={`Consumo ${name}: ${window ? `${Math.round(window.usedPercent)}%` : 'no disponible'}`}
            title={
              window ? `${Math.round(window.usedPercent)}% del límite ${name} consumido` : reason
            }
          >
            <span className="usage-period">{key}</span>
            <span className="usage-value">
              {window ? `${Math.round(window.usedPercent)}%` : '—'}
            </span>
            <span className="usage-track" aria-hidden="true">
              {window && (
                <span
                  className="usage-fill"
                  style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                />
              )}
            </span>
          </span>
        ))}
      </div>
      <span
        className="usage-reset"
        aria-label={`Renovación ${resetLabel}: ${countdown === '—' ? 'no disponible' : `en ${countdown}`}`}
        title={countdown === '—' ? reason : `El límite ${resetLabel} se renueva en ${countdown}`}
      >
        <RotateCcw size={11} aria-hidden="true" />
        <span>{countdown}</span>
      </span>
    </div>
  );
}
