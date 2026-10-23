/** Flat forms from MCP servers are untrusted; accept only fields we can render and validate. */
export interface McpFormField {
  key: string;
  title: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required: boolean;
  options?: { value: string; label: string }[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
}
const unsupported = () =>
  new Error(
    'Este servidor solicita un formulario que todavía no podemos mostrar. Puedes rechazarlo y continuar en el chat.',
  );
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function mcpElicitationUrl(params: Record<string, any>) {
  if (params.mode !== 'url' || typeof params.url !== 'string') throw unsupported();
  const url = new URL(params.url);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('La dirección solicitada por el servidor no es válida.');
  return url.href;
}
export function mcpElicitationFields(params: Record<string, any>): McpFormField[] {
  if (params.mode && params.mode !== 'form') throw unsupported();
  const schema = params.requestedSchema;
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties ?? {}))
    throw unsupported();
  if (
    Object.keys(schema).some(
      (key) =>
        ![
          'type',
          'properties',
          'required',
          'title',
          'description',
          'additionalProperties',
          '$schema',
        ].includes(key),
    )
  )
    throw unsupported();
  const properties = Object.entries(schema.properties ?? {});
  if (
    properties.length > 50 ||
    (schema.required &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (key: unknown) => typeof key !== 'string' || !Object.hasOwn(schema.properties ?? {}, key),
        )))
  )
    throw unsupported();
  return properties.map(([key, raw]) => {
    if (!object(raw) || ['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 200)
      throw unsupported();
    if (!['string', 'number', 'integer', 'boolean', 'array'].includes(raw.type))
      throw unsupported();
    const allowed = [
      'type',
      'title',
      'description',
      'default',
      'enum',
      'enumNames',
      'oneOf',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'format',
      'items',
      'minItems',
      'maxItems',
      'uniqueItems',
    ];
    if (Object.keys(raw).some((name) => !allowed.includes(name))) throw unsupported();
    if (raw.format && !['email', 'uri', 'date', 'date-time'].includes(raw.format))
      throw unsupported();
    const field: McpFormField = {
      key,
      title: typeof raw.title === 'string' ? raw.title : key,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      type: raw.type,
      required: schema.required?.includes(key) ?? false,
    };
    for (const name of [
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ] as const) {
      if (
        raw[name] !== undefined &&
        (!Number.isFinite(raw[name]) ||
          (name !== 'minimum' &&
            name !== 'maximum' &&
            (!Number.isInteger(raw[name]) || raw[name] < 0)))
      )
        throw unsupported();
      if (raw[name] !== undefined) field[name] = raw[name];
    }
    if (
      raw.type === 'array' &&
      (!object(raw.items) ||
        (raw.items.type !== 'string' && !(raw.items.type === undefined && raw.items.anyOf)) ||
        Object.keys(raw.items).some(
          (name) => !['type', 'enum', 'enumNames', 'oneOf', 'anyOf'].includes(name),
        ))
    )
      throw unsupported();
    const options = raw.type === 'array' ? raw.items : raw;
    if (options.enum) {
      if (
        !Array.isArray(options.enum) ||
        options.enum.length > 200 ||
        options.enum.some((v: unknown) => typeof v !== 'string')
      )
        throw unsupported();
      field.options = options.enum.map((value: string, index: number) => ({
        value,
        label: typeof options.enumNames?.[index] === 'string' ? options.enumNames[index] : value,
      }));
    } else if (options.oneOf || options.anyOf) {
      const choices = options.oneOf ?? options.anyOf;
      if (
        !Array.isArray(choices) ||
        choices.length > 200 ||
        choices.some(
          (v: unknown) =>
            !object(v) ||
            typeof v.const !== 'string' ||
            Object.keys(v).some((k) => !['const', 'title'].includes(k)),
        )
      )
        throw unsupported();
      field.options = choices.map((v: any) => ({
        value: v.const,
        label: typeof v.title === 'string' ? v.title : v.const,
      }));
    }
    if (
      (raw.type === 'array' && !field.options) ||
      (field.options && !['string', 'array'].includes(raw.type))
    )
      throw unsupported();
    field.format = raw.format;
    return field;
  });
}
export function mcpElicitationResult(
  params: Record<string, any>,
  decision: 'accept' | 'always' | 'decline',
  answers: Record<string, string> = {},
) {
  if (decision === 'decline') return { action: 'decline' as const, content: null };
  if (decision !== 'accept') throw new Error('Esta solicitud solo se puede aceptar una vez.');
  if (params.mode === 'url') {
    mcpElicitationUrl(params);
    return { action: 'accept' as const, content: null };
  }
  const values: [string, string | number | boolean | string[]][] = [];
  for (const field of mcpElicitationFields(params)) {
    const value = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    if (value === undefined || value === '') {
      if (field.required) throw new Error(`Completa «${field.title}».`);
      continue;
    }
    if (typeof value !== 'string' || value.length > 10000)
      throw new Error(`Revisa el valor de «${field.title}».`);
    const invalid = () => new Error(`Revisa el valor de «${field.title}».`);
    let parsed: string | number | boolean | string[] = value;
    if (field.type === 'boolean') {
      if (!['true', 'false'].includes(value)) throw invalid();
      parsed = value === 'true';
    } else if (field.type === 'number' || field.type === 'integer') {
      parsed = Number(value);
      if (
        !value.trim() ||
        !Number.isFinite(parsed) ||
        (field.type === 'integer' && !Number.isInteger(parsed)) ||
        (field.minimum !== undefined && parsed < field.minimum) ||
        (field.maximum !== undefined && parsed > field.maximum)
      )
        throw invalid();
    } else if (field.type === 'array') {
      try {
        parsed = JSON.parse(value);
      } catch {
        throw invalid();
      }
      if (
        !Array.isArray(parsed) ||
        parsed.some((v) => typeof v !== 'string' || !field.options?.some((o) => o.value === v)) ||
        new Set(parsed).size !== parsed.length ||
        parsed.length < (field.minItems ?? 0) ||
        parsed.length > (field.maxItems ?? 200)
      )
        throw invalid();
    } else {
      if (
        value.length < (field.minLength ?? 0) ||
        value.length > (field.maxLength ?? 10000) ||
        (field.options && !field.options.some((o) => o.value === value))
      )
        throw invalid();
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw invalid();
      if (field.format === 'uri') {
        try {
          new URL(value);
        } catch {
          throw invalid();
        }
      }
      if (
        field.format === 'date' &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value)
      )
        throw invalid();
      if (
        field.format === 'date-time' &&
        (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
      )
        throw invalid();
    }
    values.push([field.key, parsed]);
  }
  return { action: 'accept' as const, content: Object.fromEntries(values) };
}
