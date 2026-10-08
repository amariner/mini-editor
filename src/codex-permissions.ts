import type { CodexConfig } from './shared';
import { codexApprovals, codexSandboxes, defaultCodexConfig } from './shared';

/** Choose access and prompting together; disabling prompts alone never grants access. */
export const codexPermissionModes = [
  {
    name: 'Solo lectura',
    hint: 'Consulta archivos. Pide permiso para escribir o salir del sandbox.',
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
  },
  {
    name: 'Preguntar antes de actuar',
    hint: 'Edita el proyecto; pide aprobación para comandos que no sean de confianza.',
    sandbox: 'workspace-write',
    approvalPolicy: 'untrusted',
  },
  {
    name: 'Trabajar en el proyecto',
    hint: 'Edita y ejecuta en el proyecto. Puede pedir acceso adicional; la red está restringida.',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  },
  {
    name: 'Acceso total',
    hint: 'Puede escribir fuera del proyecto y acceder a la red, sin pedir aprobación.',
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
  },
] satisfies {
  name: string;
  hint: string;
  sandbox: CodexConfig['sandbox'];
  approvalPolicy: CodexConfig['approvalPolicy'];
}[];

export function codexPermissionLabel(config?: CodexConfig) {
  const c = config ?? defaultCodexConfig;
  return (
    codexPermissionModes.find(
      (m) => m.sandbox === c.sandbox && m.approvalPolicy === c.approvalPolicy,
    )?.name ??
    `${codexSandboxes.find((m) => m.id === c.sandbox)?.name} · ${codexApprovals.find((m) => m.id === c.approvalPolicy)?.name}`
  );
}

export type ApprovalChoice = {
  decision: 'accept' | 'always' | 'decline';
  label: string;
  hint: string;
};
export function codexApprovalChoices(
  method: string,
  params: Record<string, any>,
): ApprovalChoice[] {
  if (method === 'item/permissions/requestApproval')
    return [
      {
        decision: 'accept',
        label: 'Permitir durante esta tarea',
        hint: 'Concede solo los accesos solicitados hasta que termine el turno.',
      },
      {
        decision: 'always',
        label: 'Permitir durante este chat',
        hint: 'Concede esos mismos accesos durante esta sesión.',
      },
      { decision: 'decline', label: 'Rechazar', hint: 'No concede ningún acceso adicional.' },
    ];
  if (method === 'mcpServer/elicitation/request')
    return [
      { decision: 'decline', label: 'Rechazar', hint: 'Esta solicitud MCP aún no es compatible.' },
    ];
  const available: unknown[] = params.availableDecisions ?? ['accept', 'decline'];
  const choices: ApprovalChoice[] = [];
  if (available.includes('accept'))
    choices.push({
      decision: 'accept',
      label: 'Permitir una vez',
      hint: 'Autoriza únicamente esta acción.',
    });
  if (available.includes('acceptForSession'))
    choices.push({
      decision: 'always',
      label: 'Permitir durante este chat',
      hint: 'El servidor conserva esta autorización durante la sesión.',
    });
  if (available.includes('decline'))
    choices.push({
      decision: 'decline',
      label: 'Rechazar',
      hint: 'Impide esta acción; Codex puede buscar otra alternativa.',
    });
  else if (available.includes('cancel'))
    choices.push({
      decision: 'decline',
      label: 'Cancelar tarea',
      hint: 'Cancela el turno actual.',
    });
  return choices;
}
