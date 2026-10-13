import React, { useState, useEffect } from 'react';
import { ChevronDown, LockKeyhole } from 'lucide-react';
import type { Profile, ProfileDefinition } from './shared';
import { providerKind, type ApiUsage, type SessionStats, isCodex } from './shared';
import { currentUsageWindow, type SubscriptionUsage } from './subscription-usage';

export function UsageSwitcher({
  profiles,
  profile,
  usage,
  apiUsage,
  stats,
  disabled,
  locked = false,
  change,
}: {
  profiles: ProfileDefinition[];
  profile: Profile;
  usage?: SubscriptionUsage;
  apiUsage?: ApiUsage;
  stats?: SessionStats;
  disabled: boolean;
  locked?: boolean;
  change: (p: Profile) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const kind = providerKind(profile);
  const api = kind === 'openrouter';
  const gemini = kind === 'gemini';
  const cost =
    stats && (stats.costReported || stats.costEstimated)
      ? `$${stats.cost.toLocaleString('es-ES', { maximumFractionDigits: 5 })}${stats.costEstimated ? ' aprox.' : ''}`
      : '—';
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
        aria-label={
          api ? `Coste de la conversación: ${cost}` : gemini ? 'Consumo de Gemini' : label
        }
        title={
          api
            ? `Coste acumulado de esta conversación. Crédito restante de la clave: ${apiUsage?.remaining === undefined ? 'no disponible' : '$' + apiUsage.remaining}.`
            : gemini
              ? 'Google no comunica una cuota restante por ACP. El chat muestra los datos de uso disponibles.'
              : remaining === undefined
                ? reason
                : `${remaining}% restante del límite ${period}`
        }
      >
        <span className="usage-period">
          {api ? 'API' : gemini ? 'Google' : codex ? 'Semanal' : '5 h'}
        </span>
        <span className="usage-value">
          {api ? cost : gemini ? '—' : remaining === undefined ? '—' : `${remaining}%`}
        </span>
      </span>
    </div>
  );
}
