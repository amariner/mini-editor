export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: number;
}
export interface SubscriptionUsage {
  windows: UsageWindow[];
  checkedAt: number;
  unavailable?: string;
}
const percent = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const epoch = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
export function codexUsage(data: any, now = Date.now()): SubscriptionUsage {
  const buckets = data?.rateLimitsByLimitId;
  const bucket = buckets
    ? (buckets.codex ?? (Object.keys(buckets).length === 1 ? Object.values(buckets)[0] : undefined))
    : data?.rateLimits;
  const windows: UsageWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = (bucket as any)?.[key];
    if (!percent(w?.usedPercent)) continue;
    const mins = w.windowDurationMins;
    const label =
      mins === 10080
        ? '7 días'
        : mins >= 60
          ? `${mins / 60} h`
          : mins > 0
            ? `${mins} min`
            : key === 'primary'
              ? 'Principal'
              : 'Secundario';
    windows.push({ label, usedPercent: w.usedPercent, resetsAt: epoch(w.resetsAt) });
  }
  return {
    windows,
    checkedAt: now,
    unavailable: windows.length ? undefined : 'Codex no comunica una cuota general disponible.',
  };
}
export function claudeUsage(data: any, now = Date.now()): SubscriptionUsage {
  const windows: UsageWindow[] = [];
  if (data?.rate_limits_available) {
    for (const [key, label] of [
      ['five_hour', '5 h'],
      ['seven_day', '7 días'],
      ['seven_day_oauth_apps', '7 días · apps'],
    ]) {
      const w = data.rate_limits?.[key];
      if (!percent(w?.utilization)) continue;
      const reset = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
      windows.push({
        label,
        usedPercent: w.utilization,
        resetsAt: Number.isFinite(reset) ? reset : undefined,
      });
    }
  }
  return {
    windows,
    checkedAt: now,
    unavailable: windows.length
      ? undefined
      : 'Claude no comunica límites de suscripción para esta sesión.',
  };
}
export function limitingWindow(usage: SubscriptionUsage | undefined, now: number) {
  if (!usage || now - usage.checkedAt > 180000) return undefined;
  // Never invent a zero after a reset: wait for a new provider reading.
  if (usage.windows.some((w) => w.resetsAt !== undefined && w.resetsAt <= now)) return undefined;
  return [...usage.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
}
export function currentUsageWindow(
  usage: SubscriptionUsage | undefined,
  label: string,
  now: number,
) {
  if (!usage || now - usage.checkedAt > 180000) return undefined;
  return usage.windows.find(
    (w) => w.label === label && (w.resetsAt === undefined || w.resetsAt > now),
  );
}
export function resetCountdown(reset: number | undefined, now: number) {
  if (!reset) return 'Reinicio no disponible';
  const minutes = Math.max(0, Math.ceil((reset - now) / 60000));
  if (!minutes) return 'Actualizando cuota…';
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    mins = minutes % 60;
  return `Reinicio en ${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${mins}m`;
}
