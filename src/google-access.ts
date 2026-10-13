export const googleMigrationURL = 'https://antigravity.google/docs/cli/gcli-migration/';
export const googleClientUnavailable =
  'Google ha retirado el acceso de este cliente para Gemini Code Assist de uso personal. Esta conexión de Agent Desk no puede utilizar esa cuenta. Google indica migrar a Antigravity; esa integración todavía no está disponible en Agent Desk.';

export function isGoogleClientUnavailable(message: string) {
  return (
    message === googleClientUnavailable ||
    /this client is no longer supported for Gemini Code Assist for individuals/i.test(message)
  );
}
