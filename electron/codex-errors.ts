export function codexRpcError(message: string, code: number): Error {
  if (
    /workspace routing discovery failed|error sending request for url|failed to fetch codex rate limits/i.test(
      message,
    )
  )
    return new Error(
      'Codex no pudo conectar con ChatGPT. Comprueba la conexión y la autenticación del proxy o VPN, y vuelve a intentar. Este error no confirma que se haya cerrado tu sesión.',
    );
  const hint = code === -32601 ? ' Esta función no está disponible en esta versión de Codex.' : '';
  return new Error(`${message} (RPC ${code}).${hint}`);
}
