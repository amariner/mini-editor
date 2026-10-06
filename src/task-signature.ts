import { isCodex, type Session, type TokenOptimization } from './shared';

export function signatureModel(s: Session, optimization: TokenOptimization, hasDraft: boolean) {
  const active = ['working', 'waiting', 'stopping'].includes(s.status);
  if (optimization.autoModel && !active && (hasDraft || !s.optimization)) return 'Auto';
  const manual = isCodex(s.profile) ? s.codexConfig?.model : s.config?.model;
  const value = (active || optimization.autoModel ? s.optimization?.model : undefined) ?? manual;
  const models = s.info?.models ?? [];
  const selected =
    value && value !== 'default'
      ? value
      : (models.find((m) => m.isDefault)?.value ?? s.info?.model);
  return models.find((m) => m.value === selected)?.displayName ?? selected ?? 'Por defecto';
}

export function reportedTokens(s: Session) {
  const stats = s.stats;
  // Older Claude sessions stored confirmed totals without the explicit flag.
  if (
    !stats ||
    !(
      stats.tokensReported ||
      (!isCodex(s.profile) && stats.turns > 0 && (stats.inputTokens > 0 || stats.outputTokens > 0))
    )
  )
    return;
  if (![stats.inputTokens, stats.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0))
    return;
  return { input: stats.inputTokens, output: stats.outputTokens };
}

export function compactTokens(n: number) {
  if (n < 1000) return String(n);
  const divisor = n >= 1_000_000 ? 1_000_000 : 1000;
  return (
    (n / divisor).toLocaleString('es-ES', { maximumFractionDigits: 1 }) +
    (divisor === 1000 ? 'k' : 'M')
  );
}
