export function browserURL(value: string): string {
  const text = value.trim();
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^(about|file|data|javascript):/i.test(text)
      ? text
      : `http://${text}`,
  );
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Usa una dirección http:// o https:// sin credenciales en la URL.');
  return url.href;
}

/** Restart authentication in the external browser, without transferring OAuth state/code. */
export function isAuthenticationURL(value: string) {
  try {
    const url = new URL(value);
    return (
      url.hostname === 'accounts.google.com' ||
      /\/(?:api\/auth|oauth2?|authorize|authorization|signin|login|callback)(?:\/|$)/i.test(
        url.pathname,
      ) ||
      (url.searchParams.has('code') && url.searchParams.has('state'))
    );
  } catch {
    return false;
  }
}
export function externalBrowserURL(value: string, source?: string) {
  const url = browserURL(value);
  if (!isAuthenticationURL(url)) return url;
  return new URL(browserURL(source || url)).origin + '/';
}
export const browserPartition = (projectId?: string) =>
  `persist:desk-browser-${projectId ?? 'personal'}`;
