import { defaultOptimization, type ModelInfo, type TokenOptimization } from '../src/shared';

const policies = [
  '',
  'Responde con brevedad, sin repetir la petición ni resumir dos veces. Conserva los detalles que el usuario solicite.',
  'Prioriza una respuesta directa y breve. Decide con supuestos razonables en cambios reversibles. Acota búsquedas y salidas de herramientas; reutiliza lo ya leído. Evita planes y comprobaciones repetidos.',
  'Salida muy escueta, directa y esquemática: por defecto 1–3 viñetas cortas y un máximo orientativo de 60 palabras. Sin introducción, recapitulación, explicaciones obvias ni pregunta de cierre. Para preguntas simples, una frase. Menciona solo resultado, verificación o bloqueo relevante. Amplía únicamente si lo exige la petición, el código solicitado o la corrección. Decide pronto en cambios reversibles, acota herramientas y reutiliza evidencia.',
];
export function savingInstructions(level: TokenOptimization['level']) {
  return level
    ? `${policies[level]} Completa la tarea y las verificaciones necesarias. Respeta permisos y requisitos; amplía la respuesta si el usuario lo pide. No sacrifiques corrección por brevedad.`
    : '';
}
type Complexity = 'simple' | 'normal' | 'complex' | 'continuation';
export function requestComplexity(text: string, images: boolean, hasHistory: boolean): Complexity {
  const value = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (
    images ||
    value.length > 1800 ||
    /arquitect|architecture|migraci|migrat|seguridad|security|autentic|authentication|concurr|produccion|production|refactor|vulnerab|auditor|redisen|redesign/.test(
      value,
    )
  )
    return 'complex';
  if (
    hasHistory &&
    (value.length < 60 || /^(continua|continue|sigue|hazlo|do it|si\b|yes\b)/.test(value))
  )
    return 'continuation';
  if (
    value.length < 350 &&
    /^(hola\b|hello\b|gracias\b|thanks\b|traduce\b|translate\b|resume\b|summarize\b|renombra\b|rename\b|corrige (la |esta )?(errata|ortografia)|cambia (el |la )?(color|texto|titulo)|change (the )?(color|text|title))/.test(
      value,
    )
  )
    return 'simple';
  return 'normal';
}
function modelTier(model: ModelInfo): Complexity | undefined {
  const name = `${model.value} ${model.displayName}`.toLowerCase();
  if (/haiku|luna|spark|\bmini\b|\bnano\b/.test(name)) return 'simple';
  if (/opus|astra|\bmax\b|\bpro\b/.test(name)) return 'complex';
  if (/sonnet|\bsol\b|terra|gpt-\d/.test(name)) return 'normal';
}
const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function turnOptimization(input: {
  preferences?: TokenOptimization;
  text: string;
  images?: boolean;
  hasHistory?: boolean;
  planning?: boolean;
  models: ModelInfo[];
  baseModel: string;
  baseEffort?: string;
  previousModel?: string;
  previousEffort?: string;
}) {
  const pref = input.preferences ?? defaultOptimization;
  const complexity = input.planning
    ? 'complex'
    : requestComplexity(input.text, !!input.images, !!input.hasHistory);
  let model = input.baseModel;
  let reason = 'Modelo manual';
  if (pref.autoModel) {
    if (complexity === 'continuation') {
      model = input.models.some((m) => m.value === input.previousModel)
        ? input.previousModel!
        : model;
      reason = 'Continuación: conserva el modelo anterior';
    } else {
      const candidate = input.models.find((m) => modelTier(m) === complexity);
      if (candidate) {
        model = candidate.value;
        reason = {
          simple: 'Petición sencilla',
          normal: 'Petición general',
          complex: 'Petición compleja o con imágenes',
        }[complexity];
      } else reason = 'Sin una alternativa reconocida en el catálogo; conserva el modelo manual';
    }
  }
  const selected = input.models.find(
    (m) => m.value === model || (model === 'default' && m.isDefault),
  );
  const supported = selected?.supportedEffortLevels ?? [];
  const changedModel = model !== input.baseModel;
  let effort = changedModel ? selected?.defaultEffort : input.baseEffort;
  if (pref.autoModel && complexity === 'continuation' && model === input.previousModel)
    effort = input.previousEffort;
  if (effort && supported.length && !supported.includes(effort)) effort = selected?.defaultEffort;
  if (
    pref.level >= 2 &&
    supported.length &&
    complexity !== 'complex' &&
    complexity !== 'continuation'
  ) {
    const target = pref.level === 3 && complexity === 'simple' ? 'low' : 'medium';
    const cap = effortOrder.indexOf(target);
    const before = effort ? effortOrder.indexOf(effort) : -1;
    // Never increase an explicitly lower effort, and never send an unsupported value.
    const ceiling = before >= 0 ? Math.min(before, cap) : cap;
    effort =
      [...effortOrder]
        .slice(0, ceiling + 1)
        .reverse()
        .find((e) => supported.includes(e)) ?? effort;
  }
  return { model, effort, reason, level: pref.level, autoModel: pref.autoModel };
}
